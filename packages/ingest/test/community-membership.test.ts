// =============================================================================
// deriveMembershipUpdates — floor-plan community membership from cep pairs.
// Additive union of (existing names → ids), (existing community_ids), (cep ids);
// recompute names/ids/count; only emit changed rows.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { deriveMembershipUpdates } from '../src/community-membership.js';

const COMMS = [
  { id: 'c1', name: 'Anaqua at Tres Lagos' },
  { id: 'c2', name: 'Silos at La Sienna' },
  { id: 'c3', name: 'Sapphire at La Sienna' },
];

describe('deriveMembershipUpdates', () => {
  it('adds a cep-priced community that was never hand-picked (the reported bug)', () => {
    // Plan is in c1 by manual pick; cep also prices it in c2 (Silos) → add c2.
    const updates = deriveMembershipUpdates(
      [{ id: 'fp1', communities: 'Anaqua at Tres Lagos', community_ids: 'c1', community_count: 1 }],
      [{ floorPlanId: 'fp1', communityId: 'c2' }],
      COMMS
    );
    expect(updates).toEqual([
      {
        id: 'fp1',
        communities: 'Anaqua at Tres Lagos, Silos at La Sienna', // name-sorted
        communityIds: 'c1, c2', // id-sorted, ", "-joined
        communityCount: 2,
      },
    ]);
  });

  it('self-heals a names↔ids mismatch: ids have a community the names CSV is missing', () => {
    // The ids-only backfill state: community_ids has c2 but communities (names) doesn't.
    // Recompute makes names mirror ids even with no cep pair for this plan.
    const updates = deriveMembershipUpdates(
      [{ id: 'fp1', communities: 'Sapphire at La Sienna', community_ids: 'c2, c3', community_count: 1 }],
      [],
      COMMS
    );
    expect(updates[0]).toEqual({
      id: 'fp1',
      communities: 'Sapphire at La Sienna, Silos at La Sienna',
      communityIds: 'c2, c3',
      communityCount: 2,
    });
  });

  it('never drops a manual pick that has no cep row (additive only)', () => {
    // c1 is a manual pick with no cep pair; cep adds c3. c1 survives.
    const updates = deriveMembershipUpdates(
      [{ id: 'fp1', communities: 'Anaqua at Tres Lagos', community_ids: 'c1', community_count: 1 }],
      [{ floorPlanId: 'fp1', communityId: 'c3' }],
      COMMS
    );
    expect(updates[0]!.communityIds).toBe('c1, c3');
  });

  it('is a no-op at steady state (comma-SPACE stored, already complete) → no churn', () => {
    const updates = deriveMembershipUpdates(
      [{ id: 'fp1', communities: 'Anaqua at Tres Lagos, Silos at La Sienna', community_ids: 'c1, c2', community_count: 2 }],
      [{ floorPlanId: 'fp1', communityId: 'c2' }, { floorPlanId: 'fp1', communityId: 'c1' }],
      COMMS
    );
    expect(updates).toEqual([]);
  });

  it('drops an id that no longer resolves to a real community (rename/delete)', () => {
    const updates = deriveMembershipUpdates(
      [{ id: 'fp1', communities: 'Ghost', community_ids: 'cX, c1', community_count: 2 }],
      [],
      COMMS
    );
    expect(updates[0]).toEqual({
      id: 'fp1',
      communities: 'Anaqua at Tres Lagos',
      communityIds: 'c1',
      communityCount: 1,
    });
  });
});
