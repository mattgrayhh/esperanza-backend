import type { PlanCardData } from '../templates/components';
import { renditionUrl } from './shared';

export type ListKind = 'locations' | 'qmis' | 'plans';
export interface ListData { citySlug: string; cityName: string; kind: ListKind; cards: PlanCardData[] }

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

export async function loadListData(db: D1Database, citySlug: string, kind: ListKind): Promise<ListData | null> {
  const city = await db.prepare(`SELECT id, city_name FROM cities WHERE slug=?`).bind(citySlug).first<any>();
  if (!city) return null;
  let rows: any[] = [];
  if (kind === 'locations') {
    rows = ((await db.prepare(`SELECT id, name, featured_image_url img, price_from price FROM communities WHERE city_id=? AND published=1 ORDER BY name`).bind(city.id).all<any>()).results) ?? [];
  } else if (kind === 'qmis') {
    rows = ((await db.prepare(`SELECT id, address AS name, image_url AS img, price, total_square_footage AS sqft, bedroom_count AS beds, bathroom_count AS baths, car_garage_count AS garage, stories AS stories FROM v_public_qmi WHERE city_id=?`).bind(city.id).all<any>()).results) ?? [];
  } else {
    rows = ((await db.prepare(`SELECT DISTINCT fp.id, fp.name, fp.image_url img, fp.starting_price price, fp.total_square_footage sqft, fp.bedroom_max beds, fp.bathroom_max baths, fp.car_garage_count garage, fp.stories_count stories FROM floor_plans fp JOIN qmi q ON q.synced_floor_plan_id=fp.id WHERE COALESCE(q.override_city_id,q.synced_city_id)=? AND fp.published=1`).bind(city.id).all<any>()).results) ?? [];
  }
  const cards: PlanCardData[] = rows.map((r) => ({
    id: String(r.id), name: String(r.name ?? ''), price: num(r.price), sqft: num(r.sqft),
    beds: num(r.beds), baths: num(r.baths), garage: num(r.garage), stories: num(r.stories),
    imageUrl: renditionUrl(String(r.img ?? ''), 'w600'),
  }));
  return { citySlug, cityName: String(city.city_name ?? ''), kind, cards };
}
