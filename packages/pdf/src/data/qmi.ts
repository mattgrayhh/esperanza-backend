import { renditionUrl } from './shared';

export interface QmiData {
  id: string; address: string; community: string; price: number | null; estMonthly: number | null;
  completion: string; heroImageUrl: string;
  totalSqft: number | null; livingSqft: number | null; beds: number | null; baths: number | null; garage: number | null; stories: number | null;
  description: string; features: string[];
  floorPlanId: string | null;
}
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const str = (v: unknown): string => (v == null ? '' : String(v));

export async function loadQmiData(db: D1Database, qmiId: string, opts: { appendFloorPlanPages: boolean }): Promise<QmiData | null> {
  const q = await db.prepare(`SELECT * FROM v_public_qmi WHERE id = ?`).bind(qmiId).first<any>();
  if (!q) return null;
  return {
    id: String(q.id), address: str(q.address), community: str(q.community),
    price: num(q.price), estMonthly: num(q.estimated_monthly_price),
    completion: str(q.availability_text) || str(q.move_in_date) || (q.available_now ? 'Available now!' : ''),
    heroImageUrl: renditionUrl(str(q.image_url), 'w2000'),
    totalSqft: num(q.total_square_footage), livingSqft: num(q.living_square_footage),
    beds: num(q.bedroom_count), baths: num(q.bathroom_count), garage: num(q.car_garage_count), stories: num(q.stories ?? q.stories_count),
    description: str(q.description),
    features: str(q.upgrades).split(/\r?\n/).map((s) => s.replace(/^[-•]\s*/, '').trim()).filter(Boolean),
    floorPlanId: opts.appendFloorPlanPages ? (q.floor_plan_id ? String(q.floor_plan_id) : null) : null,
  };
}
