// =============================================================================
// Status model (feedback [16][17][27][41][45]). Two tracks, both DERIVED from the
// existing publish columns (no read-contract change):
//   * location entities (qmi/communities/floor_plans): published + coming_soon
//       → Draft / Coming Soon / Live  ("Coming Soon" = on the site, coming-soon state)
//   * blogs: published + publish_date → Draft / Scheduled / Published
//       ("Scheduled" is derived from a future publish_date; not directly settable)
//   * promotions: active → Draft / Live
//   * testimonials: the existing `status` text column (Live / Draft)
// One generic setStatus() server action writes the right columns per gate.
// =============================================================================

import type { EntityKey } from './entities';

export type StatusGate = 'location' | 'blog' | 'promotion' | 'testimonial' | null;

/** Which status track an entity uses (null = no publish gate: cities/collections/images). */
export function statusGate(key: EntityKey): StatusGate {
  switch (key) {
    case 'qmi':
    case 'communities':
    case 'floor_plans':
      return 'location';
    case 'blogs':
      return 'blog';
    case 'promotions':
      return 'promotion';
    case 'testimonials':
      return 'testimonial';
    default:
      return null;
  }
}

export const LOCATION_STATUS = ['Draft', 'Coming Soon', 'Live'];
export const BLOG_STATUS = ['Draft', 'Published']; // 'Scheduled' is display-only (future date)
export const PROMOTION_STATUS = ['Draft', 'Live'];
export const TESTIMONIAL_STATUS = ['Live', 'Draft'];

/** Options the operator can pick in the status control. */
export function statusOptions(gate: StatusGate): string[] {
  switch (gate) {
    case 'location':
      return LOCATION_STATUS;
    case 'blog':
      return BLOG_STATUS;
    case 'promotion':
      return PROMOTION_STATUS;
    case 'testimonial':
      return TESTIMONIAL_STATUS;
    default:
      return [];
  }
}

export interface StatusInputs {
  published?: boolean;
  comingSoon?: boolean;
  active?: boolean;
  status?: string | null;
  publishDate?: string | null;
  /** ISO 'now' for the blog Scheduled check (pass once per request). */
  now?: string;
}

/** Display status from raw column values. */
export function deriveStatus(gate: StatusGate, v: StatusInputs): string {
  switch (gate) {
    case 'location':
      if (!v.published) return 'Draft';
      return v.comingSoon ? 'Coming Soon' : 'Live';
    case 'blog':
      if (!v.published) return 'Draft';
      if (v.publishDate && v.now && v.publishDate > v.now) return 'Scheduled';
      return 'Published';
    case 'promotion':
      return v.active ? 'Live' : 'Draft';
    case 'testimonial':
      return v.status && v.status !== '' ? v.status : 'Live'; // unset → live (legacy)
    default:
      return '';
  }
}

/** Column patch (snake_case keys) for a chosen status — the write side of setStatus. */
export function statusPatch(gate: StatusGate, status: string): Record<string, unknown> {
  switch (gate) {
    case 'location':
      if (status === 'Draft') return { published: false, coming_soon: false };
      if (status === 'Coming Soon') return { published: true, coming_soon: true };
      return { published: true, coming_soon: false };
    case 'blog':
      return { published: status === 'Published' };
    case 'promotion':
      return { active: status === 'Live' };
    case 'testimonial':
      return { status };
    default:
      return {};
  }
}

/** Visual tone for a status badge/dot. */
export function statusTone(status: string): 'live' | 'pending' | 'draft' {
  if (status === 'Live' || status === 'Published') return 'live';
  if (status === 'Coming Soon' || status === 'Scheduled') return 'pending';
  return 'draft';
}
