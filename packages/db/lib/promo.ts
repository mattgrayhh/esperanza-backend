// =============================================================================
// esperanza-cf — pure promo resolution. Migration Plan v2, Promotions targeting.
//
// resolveEffectivePromo() picks the single promotion that applies to an entity:
//   specificity  qmi > community > city > global
//   then         lowest sort_order
//   then         lowest id (deterministic final tie-break)
//   filtered by  published === true AND date window [start_date, end_date] contains `now`
//
// Pure + dependency-free so it's trivially unit-testable and reusable by the api
// Worker (which fetches the candidate promos + targets from D1 and calls this).
// Mirrors the documented SQL in views.sql.
// =============================================================================

export type PromoTargetType = 'global' | 'city' | 'community' | 'qmi' | 'floor_plan';

/** Minimal promotion shape the resolver needs (the api Worker passes full rows). */
export interface PromoLike {
  id: string;
  /** publish gate (renamed from `active` in migration 0005). integer 0/1 or boolean. */
  published: number | boolean;
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
  /**
   * The floor plan the entity is built on / is. A QMI passes its resolved floor
   * plan id here so a plan-targeted promo CASCADES onto the home; a floor-plan
   * page passes its own id. Community/city pages omit it (a community offers many
   * plans, so no single plan promo should leak onto it).
   */
  floorPlanId?: string | null;
  cityId?: string | null;
  /**
   * 0030 operator tie-break: when several promotions apply, this one wins — but
   * ONLY if it is itself an eligible candidate (published, in window, and one of
   * its targets matches this context). A stale/bogus preference is ignored, so a
   * preference can narrow the outcome but never invent one.
   */
  preferredPromoId?: string | null;
}

/**
 * Lower number = more specific. floor_plan sits between community and city: a
 * community (a physical place) is more specific than the product line (a plan
 * offered across many communities), which is in turn more specific than a city.
 */
const SPECIFICITY: Record<PromoTargetType, number> = {
  qmi: 0,
  community: 1,
  floor_plan: 2,
  city: 3,
  global: 4,
};

function isActive(p: PromoLike): boolean {
  return p.published === true || p.published === 1;
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
      case 'floor_plan':
        matches = !!ctx.floorPlanId && t.target_id === ctx.floorPlanId;
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
  const candidates = applicablePromos(ctx, promos, targets, now);
  if (candidates.length === 0) return null;

  // Operator tie-break (0030) beats specificity/sort_order — but only among real candidates.
  if (ctx.preferredPromoId) {
    const preferred = candidates.find((p) => p.id === ctx.preferredPromoId);
    if (preferred) return preferred;
  }

  return candidates[0]!;
}

/**
 * ALL eligible promotions for an entity, in resolution order (winner first,
 * ignoring any preference). Powers the admin "Preferred Incentive" picker and
 * the overlap warnings — resolveEffectivePromo() returns only the winner.
 */
export function applicablePromos<P extends PromoLike>(
  ctx: ResolveContext,
  promos: readonly P[],
  targets: readonly PromoTargetLike[],
  now: string = new Date().toISOString().slice(0, 10)
): P[] {
  const byPromo = new Map<string, PromoTargetLike[]>();
  for (const t of targets) {
    const arr = byPromo.get(t.promotion_id);
    if (arr) arr.push(t);
    else byPromo.set(t.promotion_id, [t]);
  }
  const candidates: Array<{ promo: P; specificity: number }> = [];
  for (const p of promos) {
    if (!isActive(p)) continue;
    if (!inDateWindow(p, now)) continue;
    const tgts = byPromo.get(p.id);
    if (!tgts || tgts.length === 0) continue;
    const matchType = bestMatchType(tgts, ctx);
    if (matchType === undefined) continue;
    candidates.push({ promo: p, specificity: SPECIFICITY[matchType] });
  }
  candidates.sort((a, b) => {
    if (a.specificity !== b.specificity) return a.specificity - b.specificity;
    const sa = a.promo.sort_order ?? 0;
    const sb = b.promo.sort_order ?? 0;
    if (sa !== sb) return sa - sb;
    return a.promo.id < b.promo.id ? -1 : a.promo.id > b.promo.id ? 1 : 0;
  });
  return candidates.map((c) => c.promo);
}

/** Published QMI row shape for promo→community indexing (api Worker / tests). */
export interface QmiPromoContext {
  id: string;
  communityId: string | null;
  floorPlanId: string | null;
  cityId: string | null;
}

/**
 * Communities that have at least one published QMI whose effective promotion is
 * `promoId` (same resolution as listing cards). Used for incentive landing pages
 * so empty or wrong-scope communities are not advertised.
 */
export function communitiesByPromoFromPublishedQmi<P extends PromoLike>(
  promos: readonly P[],
  targets: readonly PromoTargetLike[],
  qmis: readonly QmiPromoContext[],
  now: string = new Date().toISOString().slice(0, 10)
): Map<string, string[]> {
  const byPromo = new Map<string, Set<string>>();
  for (const q of qmis) {
    if (!q.communityId) continue;
    const winner = resolveEffectivePromo(
      'qmi',
      {
        qmiId: q.id,
        communityId: q.communityId,
        floorPlanId: q.floorPlanId,
        cityId: q.cityId,
      },
      promos,
      targets,
      now
    );
    if (!winner) continue;
    let set = byPromo.get(winner.id);
    if (!set) {
      set = new Set();
      byPromo.set(winner.id, set);
    }
    set.add(q.communityId);
  }
  const out = new Map<string, string[]>();
  for (const [promoId, set] of byPromo) {
    out.set(promoId, [...set]);
  }
  return out;
}
