import { attachmentUrl } from './shared';
import type { FloorPlanData } from './floorplan';
import { loadFloorPlanData } from './floorplan';

export interface QmiData {
  id: string; address: string; community: string; city: string; lot: string;
  price: number | null; estMonthly: number | null;
  statusHeadline: string; completion: string; heroImageUrl: string;
  totalSqft: number | null; livingSqft: number | null; beds: number | null; baths: number | null; garage: number | null; stories: number | null;
  description: string; features: string[];
  floorPlanId: string | null;
  floorPlan?: FloorPlanData | null;
}
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const str = (v: unknown): string => (v == null ? '' : String(v));

export async function loadQmiData(
  db: D1Database,
  qmiId: string,
  opts: { appendFloorPlanPages: boolean; imgProxyBase?: string },
): Promise<QmiData | null> {
  const q = await db.prepare(`SELECT * FROM v_public_qmi WHERE id = ?`).bind(qmiId).first<any>();
  if (!q) return null;
  const floorPlanId = opts.appendFloorPlanPages ? (q.floor_plan_id ? String(q.floor_plan_id) : null) : null;
  const floorPlan = floorPlanId ? await loadFloorPlanData(db, floorPlanId) : null;

  // Hero: prefer the home-specific photo, fall back to the floor-plan elevation render
  // (most QMIs have no image_url/featured_image — fp_image is what's populated). Route through
  // the worker's /img resizer (Cloudflare Image Resizing) so Chrome embeds a small file.
  const heroSrc = attachmentUrl(q.featured_image) || str(q.image_url) || attachmentUrl(q.fp_image);
  const heroImageUrl = heroSrc
    ? (opts.imgProxyBase ? `${opts.imgProxyBase.replace(/\/$/, '')}/img?w=1000&u=${encodeURIComponent(heroSrc)}` : heroSrc)
    : '';

  const availabilityText = str(q.availability_text);
  const moveIn = str(q.move_in_date);
  const availableNow = !!q.available_now;
  // Green-box headline (short status) and the "Est. Completion Date" line share a source; both
  // render only when there's something to say (sparse data → the chrome quietly collapses).
  const statusHeadline = availableNow ? 'Available Now!' : (availabilityText || (moveIn ? `Coming ${moveIn}` : ''));
  const completion = availabilityText || moveIn || (availableNow ? 'Available now!' : '');

  return {
    id: String(q.id), address: str(q.address), community: str(q.community), city: str(q.city), lot: str(q.lot_number),
    price: num(q.price), estMonthly: num(q.estimated_monthly_price),
    statusHeadline, completion, heroImageUrl,
    totalSqft: num(q.total_square_footage), livingSqft: num(q.living_square_footage),
    beds: num(q.bedroom_count), baths: num(q.bathroom_count), garage: num(q.car_garage_count), stories: num(q.stories ?? q.stories_count),
    description: str(q.description),
    features: str(q.upgrades).split(/\r?\n/).map((s) => s.replace(/^[-•]\s*/, '').trim()).filter(Boolean),
    floorPlanId,
    floorPlan,
  };
}
