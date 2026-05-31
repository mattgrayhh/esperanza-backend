// =============================================================================
// esperanza-cf — pure promo resolution. Migration Plan v2, Promotions targeting.
//
// resolveEffectivePromo() picks the single promotion that applies to an entity:
//   specificity  qmi > community > city > global
//   then         lowest sort_order
//   then         lowest id (deterministic final tie-break)
//   filtered by  active === true AND date window [start_date, end_date] contains `now`
//
// Pure + dependency-free so it's trivially unit-testable and reusable by the api
// Worker (which fetches the candidate promos + targets from D1 and calls this).
// Mirrors the documented SQL in views.sql.
// =============================================================================

export type PromoTargetType = 'global' | 'city' | 'community' | 'qmi';

/** Minimal promotion shape the resolver needs (the api Worker passes full rows). */
export interface PromoLike {
  id: string;
  /** integer 0/1 or boolean — coerced to boolean. */
  active: number | boolean;
  /** YYYY-MM-DD (lexicographically comparable). null/'' = open-ended. */
  start_date?: string | null;
  end_date?: string | null;
  /** lower = higher priority on tie. */
  sort_order?: number | null;
  [k: string]: unknown;
}

export interface PromoTargetLike {
  promotion_id: string;
  target_type: PromoTargetType;
  /** null only when target_type === 'global'. */
  target_id?: string | null;
}

/** The entity we're resolving a promo for. Omitted ids simply don't match that scope. */
export interface ResolveContext {
  qmiId?: string | null;
  communityId?: string | null;
  cityId?: string | null;
}

/** Lower number = more specific. */
const SPECIFICITY: Record<PromoTargetType, number> = {
  qmi: 0,
  community: 1,
  city: 2,
  global: 3,
};

function isActive(p: PromoLike): boolean {
  return p.active === true || p.active === 1;
}

/**
 * Date-window check. `now` is a YYYY-MM-DD string (caller-supplied so the result
 * is deterministic and timezone decisions live at the edge). Empty/null bounds
 * are open-ended. Comparison is lexical, which is correct for zero-padded ISO dates.
 */
function inDateWindow(p: PromoLike, now: string): boolean {
  const start = p.start_date ?? '';
  const end = p.end_date ?? '';
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

/**
 * The most-specific target_type by which a promo matches the given context.
 * Returns undefined if none of the promo's targets match the context.
 */
function bestMatchType(
  targets: PromoTargetLike[],
  ctx: ResolveContext
): PromoTargetType | undefined {
  let best: PromoTargetType | undefined;
  for (const t of targets) {
    let matches = false;
    switch (t.target_type) {
      case 'global':
        matches = true;
        break;
      case 'city':
        matches = !!ctx.cityId && t.target_id === ctx.cityId;
        break;
      case 'community':
        matches = !!ctx.communityId && t.target_id === ctx.communityId;
        break;
      case 'qmi':
        matches = !!ctx.qmiId && t.target_id === ctx.qmiId;
        break;
    }
    if (matches) {
      if (best === undefined || SPECIFICITY[t.target_type] < SPECIFICITY[best]) {
        best = t.target_type;
      }
    }
  }
  return best;
}

/**
 * Resolve the single effective promotion for an entity.
 *
 * @param _entity  'qmi' | 'community' | 'city' — informational; the actual scope
 *                 is driven by which ids are present in `ctx`. (A community page
 *                 passes only communityId+cityId so qmi-targeted promos can't leak.)
 * @param ctx      the entity's own id + its community/city lineage.
 * @param promos   candidate promotions (the api Worker fetches all, or active-only).
 * @param targets  all promotion_targets rows for those promos.
 * @param now      YYYY-MM-DD used for the date-window filter (defaults to UTC today).
 * @returns the winning PromoLike, or null when nothing applies.
 */
export function resolveEffectivePromo<P extends PromoLike>(
  _entity: 'qmi' | 'community' | 'city',
  ctx: ResolveContext,
  promos: readonly P[],
  targets: readonly PromoTargetLike[],
  now: string = new Date().toISOString().slice(0, 10)
): P | null {
  // index targets by promotion_id
  const byPromo = new Map<string, PromoTargetLike[]>();
  for (const t of targets) {
    const arr = byPromo.get(t.promotion_id);
    if (arr) arr.push(t);
    else byPromo.set(t.promotion_id, [t]);
  }

  type Candidate = { promo: P; specificity: number };
  const candidates: Candidate[] = [];

  for (const p of promos) {
    if (!isActive(p)) continue;
    if (!inDateWindow(p, now)) continue;
    const tgts = byPromo.get(p.id);
    if (!tgts || tgts.length === 0) continue; // a promo with no target reaches nobody
    const matchType = bestMatchType(tgts, ctx);
    if (matchType === undefined) continue;
    candidates.push({ promo: p, specificity: SPECIFICITY[matchType] });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.specificity !== b.specificity) return a.specificity - b.specificity; // qmi>community>city>global
    const sa = a.promo.sort_order ?? 0;
    const sb = b.promo.sort_order ?? 0;
    if (sa !== sb) return sa - sb; // lowest sort_order wins
    return a.promo.id < b.promo.id ? -1 : a.promo.id > b.promo.id ? 1 : 0; // deterministic
  });

  return candidates[0]!.promo;
}
