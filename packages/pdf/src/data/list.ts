import type { PlanCardData } from '../templates/components';
import { renditionUrl } from './shared';
import { loadPromoResolver, type ResolvedPromo } from './promotions';

export type ListKind = 'locations' | 'qmis' | 'plans';

/** A Quick Move-In home rendered as a card in the QMI grid. */
export interface QmiCardData {
  id: string;
  community: string;
  city: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  availability: string;
  address: string;
  lot: string;
  estMonthly: number | null;
  price: number | null;
  imageUrl: string;
  promo: ResolvedPromo | null;
}

export interface ListData {
  citySlug: string;
  cityName: string;
  kind: ListKind;
  isMaster: boolean;       // true for the all-cities master "Quick Move-In Homes" doc
  cards: PlanCardData[];   // locations / plans
  qmis: QmiCardData[];     // qmis
  templateBgUrl?: string;  // branded full-page template artwork (qmis grid renders over it)
}

// The Quick Move-In Homes one-pager artwork (logo + contact + green band header, website +
// disclaimer + equal-housing footer). Cards are laid over the empty middle region.
const QMI_TEMPLATE_PNG = 'https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/pdf-templates/quick-move-in-homes.png';

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const str = (v: unknown): string => (v == null ? '' : String(v));

/** Airtable attachment fields arrive as a JSON array `[{url,filename}]`; pull the first url. */
function attachmentUrl(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const first = Array.isArray(j) ? j[0] : j;
      return str(first?.url);
    } catch { return ''; }
  }
  return s; // already a plain URL
}

export async function loadListData(db: D1Database, citySlug: string, kind: ListKind, imgProxyBase?: string): Promise<ListData | null> {
  // Card images go through the worker's /img resizer (Cloudflare Image Resizing) on the
  // ORIGINAL image — reliable (originals always exist; w600 renditions are incomplete) and
  // small (Chrome re-encodes embedded images, so source pixel size is the file-size lever).
  const cardImage = (src: string): string => {
    if (!src) return '';
    return imgProxyBase ? `${imgProxyBase.replace(/\/$/, '')}/img?w=300&u=${encodeURIComponent(src)}` : src;
  };
  const isMaster = citySlug === 'all';
  let cityId: string | null = null;
  let cityName = '';
  if (!isMaster) {
    const city = await db.prepare(`SELECT id, city_name FROM cities WHERE slug=?`).bind(citySlug).first<any>();
    if (!city) return null;
    cityId = String(city.id);
    cityName = str(city.city_name);
  }

  if (kind === 'qmis') {
    // The home elevation shown on each card is the QMI's floor-plan render (fp.image_url has
    // w600 renditions). QMI image_url is empty in current data; featured_image (home-specific)
    // exists for only a couple. Prefer fp.image_url, then featured_image, then the QMI image.
    const sql =
      `SELECT v.id, v.community_id, v.city_id, v.community, v.city, v.address, v.lot_number,
              v.price, v.estimated_monthly_price AS emp,
              v.total_square_footage AS sqft, v.bedroom_count AS beds, v.bathroom_count AS baths,
              v.availability_text, v.move_in_date, v.available_now,
              v.featured_image, v.image_url AS qmi_img, fp.image_url AS fp_img
         FROM v_public_qmi v
         LEFT JOIN floor_plans fp ON fp.id = v.floor_plan_id
        ${isMaster ? '' : 'WHERE v.city_id = ?'}
        ORDER BY ${isMaster ? 'v.city, v.community, v.price' : 'v.community, v.price'}`;
    const stmt = db.prepare(sql);
    const rows = ((isMaster ? await stmt.all<any>() : await stmt.bind(cityId).all<any>()).results) ?? [];

    const resolve = await loadPromoResolver(db);
    const qmis: QmiCardData[] = rows.map((r) => ({
      id: String(r.id),
      community: str(r.community),
      city: str(r.city),
      beds: num(r.beds),
      baths: num(r.baths),
      sqft: num(r.sqft),
      availability:
        str(r.availability_text) ||
        (r.available_now ? 'Available Now' : (str(r.move_in_date) ? `Available ${str(r.move_in_date)}` : '')),
      address: str(r.address),
      lot: str(r.lot_number),
      estMonthly: num(r.emp),
      price: num(r.price),
      imageUrl: cardImage(str(r.fp_img) || attachmentUrl(r.featured_image) || str(r.qmi_img)),
      promo: resolve(
        r.community_id ? String(r.community_id) : null,
        r.city_id ? String(r.city_id) : null,
        String(r.id),
      ),
    }));
    // Use the full-resolution template artwork (no downscale) so the logo + fine print stay
    // crisp; it's mostly white space so it compresses well.
    const templateBgUrl = QMI_TEMPLATE_PNG;
    return { citySlug, cityName, kind, isMaster, cards: [], qmis, templateBgUrl };
  }

  // locations / plans — per-city only (no master variant).
  if (isMaster) return null;
  let rows: any[] = [];
  if (kind === 'locations') {
    rows = ((await db.prepare(`SELECT id, name, featured_image_url img, price_from price FROM communities WHERE city_id=? AND published=1 ORDER BY name`).bind(cityId).all<any>()).results) ?? [];
  } else {
    rows = ((await db.prepare(`SELECT DISTINCT fp.id, fp.name, fp.image_url img, fp.starting_price price, fp.total_square_footage sqft, fp.bedroom_max beds, fp.bathroom_max baths, fp.car_garage_count garage, fp.stories_count stories FROM floor_plans fp JOIN qmi q ON q.synced_floor_plan_id=fp.id WHERE COALESCE(q.override_city_id,q.synced_city_id)=? AND fp.published=1`).bind(cityId).all<any>()).results) ?? [];
  }
  const cards: PlanCardData[] = rows.map((r) => ({
    id: String(r.id), name: String(r.name ?? ''), price: num(r.price), sqft: num(r.sqft),
    beds: num(r.beds), baths: num(r.baths), garage: num(r.garage), stories: num(r.stories),
    imageUrl: renditionUrl(String(r.img ?? ''), 'w600'),
  }));
  return { citySlug, cityName, kind, isMaster, cards, qmis: [] };
}
