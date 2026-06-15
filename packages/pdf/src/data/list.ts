import type { PlanCardData } from '../templates/components';
import { renditionUrl, attachmentUrl } from './shared';
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

export type ListScope = 'city' | 'community';

export async function loadListData(
  db: D1Database,
  scopeSlug: string,
  kind: ListKind,
  imgProxyBase?: string,
  scope: ListScope = 'city',
): Promise<ListData | null> {
  // Card images go through the worker's /img resizer (Cloudflare Image Resizing) on the
  // ORIGINAL image — reliable (originals always exist; w600 renditions are incomplete) and
  // small (Chrome re-encodes embedded images, so source pixel size is the file-size lever).
  const cardImage = (src: string): string => {
    if (!src) return '';
    return imgProxyBase ? `${imgProxyBase.replace(/\/$/, '')}/img?w=300&u=${encodeURIComponent(src)}` : src;
  };
  const isCommunity = scope === 'community';
  const isMaster = !isCommunity && scopeSlug === 'all';
  // scopeId = city id (city scope) or community id (community scope). cityName is the title
  // shown on the plans CoverBand (city name, or the community name for a community list).
  let cityId: string | null = null;
  let cityName = '';
  if (!isMaster) {
    if (isCommunity) {
      const c = await db.prepare(`SELECT id, name FROM communities WHERE slug=? AND published=1`).bind(scopeSlug).first<any>();
      if (!c) return null;
      cityId = String(c.id);
      cityName = str(c.name);
    } else {
      const city = await db.prepare(`SELECT id, city_name FROM cities WHERE slug=?`).bind(scopeSlug).first<any>();
      if (!city) return null;
      cityId = String(city.id);
      cityName = str(city.city_name);
    }
  }
  const citySlug = scopeSlug;

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
        ${isMaster ? '' : (isCommunity ? 'WHERE v.community_id = ?' : 'WHERE v.city_id = ?')}
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

  // locations / plans — per-city, plus an all-cities master variant (citySlug='all').
  // Master locations = every published community; master plans = every published floor plan
  // (the per-city plans list is gated on having a QMI in that city; the master is not).
  let rows: any[] = [];
  if (kind === 'locations') {
    rows = isMaster
      ? ((await db.prepare(`SELECT c.id, c.name, c.featured_image_url img, COALESCE(c.override_price_from, c.synced_price_from) price FROM communities c LEFT JOIN cities ci ON ci.id=c.city_id WHERE c.published=1 ORDER BY ci.city_name, c.name`).all<any>()).results) ?? []
      : ((await db.prepare(`SELECT id, name, featured_image_url img, COALESCE(override_price_from, synced_price_from) price FROM communities WHERE city_id=? AND published=1 ORDER BY name`).bind(cityId).all<any>()).results) ?? [];
  } else if (isCommunity) {
    // Community "Plan List" = every published floor plan offered in this community.
    // floor_plans.community_ids is a CSV of community rec-ids (migration 0016) — the same
    // linkage the Framer community page filters on with `community_ids Contains {id}`.
    rows = ((await db.prepare(`SELECT fp.id, fp.name, fp.image_url img, COALESCE(fp.override_starting_price, fp.synced_starting_price) price, COALESCE(fp.override_total_square_footage, fp.synced_total_square_footage) sqft, COALESCE(fp.override_bedroom_max, fp.synced_bedroom_max) beds, COALESCE(fp.override_bathroom_max, fp.synced_bathroom_max) baths, fp.car_garage_count garage, fp.stories_count stories FROM floor_plans fp WHERE fp.published=1 AND (','||COALESCE(fp.community_ids,'')||',') LIKE '%,'||?||',%' ORDER BY fp.name`).bind(cityId).all<any>()).results) ?? [];
  } else {
    rows = isMaster
      ? ((await db.prepare(`SELECT fp.id, fp.name, fp.image_url img, COALESCE(fp.override_starting_price, fp.synced_starting_price) price, COALESCE(fp.override_total_square_footage, fp.synced_total_square_footage) sqft, COALESCE(fp.override_bedroom_max, fp.synced_bedroom_max) beds, COALESCE(fp.override_bathroom_max, fp.synced_bathroom_max) baths, fp.car_garage_count garage, fp.stories_count stories FROM floor_plans fp WHERE fp.published=1 ORDER BY fp.name`).all<any>()).results) ?? []
      : ((await db.prepare(`SELECT DISTINCT fp.id, fp.name, fp.image_url img, COALESCE(fp.override_starting_price, fp.synced_starting_price) price, COALESCE(fp.override_total_square_footage, fp.synced_total_square_footage) sqft, COALESCE(fp.override_bedroom_max, fp.synced_bedroom_max) beds, COALESCE(fp.override_bathroom_max, fp.synced_bathroom_max) baths, fp.car_garage_count garage, fp.stories_count stories FROM floor_plans fp JOIN qmi q ON q.synced_floor_plan_id=fp.id WHERE COALESCE(q.override_city_id,q.synced_city_id)=? AND fp.published=1`).bind(cityId).all<any>()).results) ?? [];
  }
  const cards: PlanCardData[] = rows.map((r) => ({
    id: String(r.id), name: String(r.name ?? ''), price: num(r.price), sqft: num(r.sqft),
    beds: num(r.beds), baths: num(r.baths), garage: num(r.garage), stories: num(r.stories),
    imageUrl: renditionUrl(String(r.img ?? ''), 'w600'),
  }));
  return { citySlug, cityName, kind, isMaster, cards, qmis: [] };
}

// ---------------------------------------------------------------------------
// Filtered, on-demand lists — the "download the currently-filtered results"
// button on the Quick Move-Ins (/new-homes/available) and Floor Plans filter
// pages. Unbounded filter combinations → rendered on demand and cached in R2
// keyed by a hash of (kind + filters + dataHash); see index.ts /pdf/filtered.
// ---------------------------------------------------------------------------
export type FilteredKind = 'qmis' | 'plans';

export interface ListFilters {
  city?: string;        // city slug (qmis)
  community?: string;   // community name (qmis)
  collection?: string;  // floor-plan collection (plans)
  minBeds?: number;
  minBaths?: number;
  minPrice?: number;
  maxPrice?: number;
  minSqft?: number;
  maxSqft?: number;
  stories?: number;     // plans
  garage?: number;      // plans (car count)
  availableNow?: boolean; // qmis (status=available)
}

export async function loadFilteredListData(
  db: D1Database,
  kind: FilteredKind,
  f: ListFilters,
  imgProxyBase?: string,
): Promise<ListData> {
  const cardImage = (src: string): string => {
    if (!src) return '';
    return imgProxyBase ? `${imgProxyBase.replace(/\/$/, '')}/img?w=300&u=${encodeURIComponent(src)}` : src;
  };

  if (kind === 'qmis') {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (f.city) {
      const city = await db.prepare(`SELECT id FROM cities WHERE slug=?`).bind(f.city).first<any>();
      if (city) { where.push('v.city_id = ?'); binds.push(String(city.id)); }
      else { where.push('1 = 0'); } // unknown city slug → no results
    }
    if (f.community) { where.push('v.community = ?'); binds.push(f.community); }
    if (f.minBeds != null) { where.push('v.bedroom_count >= ?'); binds.push(f.minBeds); }
    if (f.minBaths != null) { where.push('v.bathroom_count >= ?'); binds.push(f.minBaths); }
    if (f.minPrice != null) { where.push('v.price >= ?'); binds.push(f.minPrice); }
    if (f.maxPrice != null) { where.push('v.price <= ?'); binds.push(f.maxPrice); }
    if (f.minSqft != null) { where.push('v.total_square_footage >= ?'); binds.push(f.minSqft); }
    if (f.maxSqft != null) { where.push('v.total_square_footage <= ?'); binds.push(f.maxSqft); }
    if (f.availableNow) { where.push('v.available_now = 1'); }
    const sql =
      `SELECT v.id, v.community_id, v.city_id, v.community, v.city, v.address, v.lot_number,
              v.price, v.estimated_monthly_price AS emp,
              v.total_square_footage AS sqft, v.bedroom_count AS beds, v.bathroom_count AS baths,
              v.availability_text, v.move_in_date, v.available_now,
              v.featured_image, v.image_url AS qmi_img, fp.image_url AS fp_img
         FROM v_public_qmi v
         LEFT JOIN floor_plans fp ON fp.id = v.floor_plan_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY v.city, v.community, v.price`;
    const rows = ((await db.prepare(sql).bind(...binds).all<any>()).results) ?? [];
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
    return { citySlug: 'filtered', cityName: '', kind: 'qmis', isMaster: false, cards: [], qmis, templateBgUrl: QMI_TEMPLATE_PNG };
  }

  // plans
  const where: string[] = ['fp.published = 1'];
  const binds: unknown[] = [];
  if (f.collection) { where.push('fp.collection = ?'); binds.push(f.collection); }
  if (f.minBeds != null) { where.push('COALESCE(fp.override_bedroom_max, fp.synced_bedroom_max) >= ?'); binds.push(f.minBeds); }
  if (f.minBaths != null) { where.push('COALESCE(fp.override_bathroom_max, fp.synced_bathroom_max) >= ?'); binds.push(f.minBaths); }
  if (f.minPrice != null) { where.push('COALESCE(fp.override_starting_price, fp.synced_starting_price) >= ?'); binds.push(f.minPrice); }
  if (f.maxPrice != null) { where.push('COALESCE(fp.override_starting_price, fp.synced_starting_price) <= ?'); binds.push(f.maxPrice); }
  if (f.minSqft != null) { where.push('COALESCE(fp.override_total_square_footage, fp.synced_total_square_footage) >= ?'); binds.push(f.minSqft); }
  if (f.maxSqft != null) { where.push('COALESCE(fp.override_total_square_footage, fp.synced_total_square_footage) <= ?'); binds.push(f.maxSqft); }
  if (f.stories != null) { where.push('fp.stories_count = ?'); binds.push(f.stories); }
  if (f.garage != null) { where.push('fp.car_garage_count = ?'); binds.push(f.garage); }
  const sql =
    `SELECT fp.id, fp.name, fp.image_url img,
            COALESCE(fp.override_starting_price, fp.synced_starting_price) price,
            COALESCE(fp.override_total_square_footage, fp.synced_total_square_footage) sqft,
            COALESCE(fp.override_bedroom_max, fp.synced_bedroom_max) beds,
            COALESCE(fp.override_bathroom_max, fp.synced_bathroom_max) baths,
            fp.car_garage_count garage, fp.stories_count stories
       FROM floor_plans fp
      WHERE ${where.join(' AND ')}
      ORDER BY fp.name`;
  const rows = ((await db.prepare(sql).bind(...binds).all<any>()).results) ?? [];
  const cards: PlanCardData[] = rows.map((r) => ({
    id: String(r.id), name: String(r.name ?? ''), price: num(r.price), sqft: num(r.sqft),
    beds: num(r.beds), baths: num(r.baths), garage: num(r.garage), stories: num(r.stories),
    imageUrl: renditionUrl(String(r.img ?? ''), 'w600'),
  }));
  return { citySlug: 'filtered', cityName: '', kind: 'plans', isMaster: false, cards, qmis: [] };
}
