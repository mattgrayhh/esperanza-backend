// =============================================================================
// (b) Promo resolution specificity: qmi > community > city > global; active +
//     date-window filtering; lowest-sort_order tie-break. Tests the pure
//     resolveEffectivePromo helper AND cross-checks the documented SQL against
//     the schema (promotion_targets shape).
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  resolveEffectivePromo,
  type PromoLike,
  type PromoTargetLike,
} from '../lib/promo.js';
import { freshDb } from './helpers.js';

const NOW = '2026-05-30';

function promo(id: string, extra: Partial<PromoLike> = {}): PromoLike {
  // gate column renamed active→published in migration 0005 (PromoLike.published).
  return { id, published: 1, sort_order: 0, start_date: null, end_date: null, banner_text: `banner-${id}`, ...extra };
}

const ctx = { qmiId: 'recQMI1', communityId: 'recComm1', cityId: 'recCity1' };

describe('resolveEffectivePromo — specificity', () => {
  it('qmi target beats community, city, and global', () => {
    const promos = [promo('pGlobal'), promo('pCity'), promo('pComm'), promo('pQmi')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pGlobal', target_type: 'global', target_id: null },
      { promotion_id: 'pCity', target_type: 'city', target_id: 'recCity1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pQmi');
  });

  it('community beats city and global when no qmi target matches', () => {
    const promos = [promo('pGlobal'), promo('pCity'), promo('pComm')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pGlobal', target_type: 'global', target_id: null },
      { promotion_id: 'pCity', target_type: 'city', target_id: 'recCity1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pComm');
  });

  it('city beats global', () => {
    const promos = [promo('pGlobal'), promo('pCity')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pGlobal', target_type: 'global', target_id: null },
      { promotion_id: 'pCity', target_type: 'city', target_id: 'recCity1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pCity');
  });

  it('falls back to global when nothing more specific matches', () => {
    const promos = [promo('pGlobal')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pGlobal', target_type: 'global', target_id: null },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pGlobal');
  });

  it('returns null when no target matches the context', () => {
    const promos = [promo('pOther')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pOther', target_type: 'community', target_id: 'recOTHER' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)).toBeNull();
  });

  it('community endpoint does NOT match a qmi-scoped promo (scope leak guard)', () => {
    // a community page passes only community + city ids, never a qmiId
    const communityCtx = { communityId: 'recComm1', cityId: 'recCity1' };
    const promos = [promo('pQmi'), promo('pComm')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
    ];
    expect(resolveEffectivePromo('community', communityCtx, promos, targets, NOW)?.id).toBe('pComm');
  });
});

describe('resolveEffectivePromo — floor_plan targeting + cascade', () => {
  // a QMI carries its floor plan id, so a plan-targeted promo cascades onto it.
  const ctxFP = { qmiId: 'recQMI1', communityId: 'recComm1', floorPlanId: 'recFP1', cityId: 'recCity1' };

  it('a floor_plan promo cascades onto a QMI built on that plan', () => {
    const promos = [promo('pGlobal'), promo('pFP')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pGlobal', target_type: 'global', target_id: null },
      { promotion_id: 'pFP', target_type: 'floor_plan', target_id: 'recFP1' },
    ];
    expect(resolveEffectivePromo('qmi', ctxFP, promos, targets, NOW)?.id).toBe('pFP');
  });

  it('community beats floor_plan (a place is more specific than a plan)', () => {
    const promos = [promo('pComm'), promo('pFP')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
      { promotion_id: 'pFP', target_type: 'floor_plan', target_id: 'recFP1' },
    ];
    expect(resolveEffectivePromo('qmi', ctxFP, promos, targets, NOW)?.id).toBe('pComm');
  });

  it('floor_plan beats city and global', () => {
    const promos = [promo('pGlobal'), promo('pCity'), promo('pFP')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pGlobal', target_type: 'global', target_id: null },
      { promotion_id: 'pCity', target_type: 'city', target_id: 'recCity1' },
      { promotion_id: 'pFP', target_type: 'floor_plan', target_id: 'recFP1' },
    ];
    expect(resolveEffectivePromo('qmi', ctxFP, promos, targets, NOW)?.id).toBe('pFP');
  });

  it('qmi still beats floor_plan', () => {
    const promos = [promo('pQmi'), promo('pFP')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
      { promotion_id: 'pFP', target_type: 'floor_plan', target_id: 'recFP1' },
    ];
    expect(resolveEffectivePromo('qmi', ctxFP, promos, targets, NOW)?.id).toBe('pQmi');
  });

  it('a floor-plan page matches its own plan promo but NOT a qmi/community promo (scope leak guard)', () => {
    // a floor-plan page passes only floorPlanId — never qmi/community/city ids.
    const fpCtx = { floorPlanId: 'recFP1' };
    const promos = [promo('pQmi'), promo('pComm'), promo('pFP')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
      { promotion_id: 'pFP', target_type: 'floor_plan', target_id: 'recFP1' },
    ];
    expect(resolveEffectivePromo('qmi', fpCtx, promos, targets, NOW)?.id).toBe('pFP');
  });

  it('a community page does NOT match a floor_plan promo (no floorPlanId in ctx)', () => {
    const communityCtx = { communityId: 'recComm1', cityId: 'recCity1' };
    const promos = [promo('pFP'), promo('pComm')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pFP', target_type: 'floor_plan', target_id: 'recFP1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
    ];
    expect(resolveEffectivePromo('community', communityCtx, promos, targets, NOW)?.id).toBe('pComm');
  });
});

describe('resolveEffectivePromo — tie-break by lowest sort_order', () => {
  it('lowest sort_order wins among equally specific promos', () => {
    const promos = [
      promo('pA', { sort_order: 5 }),
      promo('pB', { sort_order: 1 }),
      promo('pC', { sort_order: 3 }),
    ];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pA', target_type: 'community', target_id: 'recComm1' },
      { promotion_id: 'pB', target_type: 'community', target_id: 'recComm1' },
      { promotion_id: 'pC', target_type: 'community', target_id: 'recComm1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pB');
  });

  it('equal sort_order falls back to lowest id (deterministic)', () => {
    const promos = [promo('pZ', { sort_order: 0 }), promo('pA', { sort_order: 0 })];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pZ', target_type: 'global', target_id: null },
      { promotion_id: 'pA', target_type: 'global', target_id: null },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pA');
  });

  it('specificity dominates sort_order (a lower-sort city promo still loses to a qmi promo)', () => {
    const promos = [promo('pCity', { sort_order: 0 }), promo('pQmi', { sort_order: 99 })];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pCity', target_type: 'city', target_id: 'recCity1' },
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pQmi');
  });
});

describe('resolveEffectivePromo — active + date-window filtering', () => {
  it('skips inactive promos', () => {
    const promos = [promo('pQmi', { published: 0 }), promo('pComm')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
    ];
    // pQmi is more specific but inactive → pComm wins
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pComm');
  });

  it('skips promos whose window has not started', () => {
    const promos = [promo('pQmi', { start_date: '2026-06-01' }), promo('pComm')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pComm');
  });

  it('skips expired promos (end_date enforced — fixes the legacy never-expire bug)', () => {
    const promos = [promo('pQmi', { end_date: '2026-05-01' }), promo('pComm')];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
      { promotion_id: 'pComm', target_type: 'community', target_id: 'recComm1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pComm');
  });

  it('honors an in-window promo (start <= now <= end)', () => {
    const promos = [promo('pQmi', { start_date: '2026-05-01', end_date: '2026-12-31' })];
    const targets: PromoTargetLike[] = [
      { promotion_id: 'pQmi', target_type: 'qmi', target_id: 'recQMI1' },
    ];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pQmi');
  });

  it('a promo with no targets reaches nobody', () => {
    const promos = [promo('pOrphan')];
    expect(resolveEffectivePromo('qmi', ctx, promos, [], NOW)).toBeNull();
  });
});

describe('promo resolution backed by the real schema (end-to-end against D1 SQL)', () => {
  it('the documented resolution SQL returns the most-specific active in-window promo', () => {
    const db = freshDb();
    // seed promos
    const insP = db.prepare(
      `INSERT INTO promotions (id, title, banner_text, sort_order, start_date, end_date, published)
       VALUES (@id, @title, @banner, @sort, @start, @end, @active)`
    );
    insP.run({ id: 'pGlobal', title: 'G', banner: 'g', sort: 0, start: null, end: null, active: 1 });
    insP.run({ id: 'pCity', title: 'C', banner: 'c', sort: 0, start: null, end: null, active: 1 });
    insP.run({ id: 'pComm', title: 'CM', banner: 'cm', sort: 0, start: null, end: null, active: 1 });
    insP.run({ id: 'pQmi', title: 'Q', banner: 'q', sort: 0, start: '2026-01-01', end: '2026-12-31', active: 1 });

    const insT = db.prepare(
      `INSERT INTO promotion_targets (promotion_id, target_type, target_id) VALUES (?, ?, ?)`
    );
    insT.run('pGlobal', 'global', null);
    insT.run('pCity', 'city', 'recCity1');
    insT.run('pComm', 'community', 'recComm1');
    insT.run('pQmi', 'qmi', 'recQMI1');

    // the canonical SQL from views.sql (effective promo for a QMI)
    const sql = `
      SELECT p.id
      FROM promotions p
      JOIN promotion_targets t ON t.promotion_id = p.id
      WHERE p.published = 1
        AND (p.start_date IS NULL OR p.start_date = '' OR p.start_date <= @now)
        AND (p.end_date   IS NULL OR p.end_date   = '' OR p.end_date   >= @now)
        AND (
             (t.target_type = 'qmi'       AND t.target_id = @qmi)
          OR (t.target_type = 'community' AND t.target_id = @comm)
          OR (t.target_type = 'city'      AND t.target_id = @city)
          OR (t.target_type = 'global')
        )
      ORDER BY
        CASE t.target_type WHEN 'qmi' THEN 0 WHEN 'community' THEN 1 WHEN 'city' THEN 2 WHEN 'global' THEN 3 END ASC,
        p.sort_order ASC, p.id ASC
      LIMIT 1`;
    const row = db.prepare(sql).get({ now: NOW, qmi: 'recQMI1', comm: 'recComm1', city: 'recCity1' }) as { id: string };
    expect(row.id).toBe('pQmi');

    // SQL and the JS helper agree
    const promos = db.prepare('SELECT * FROM promotions').all() as PromoLike[];
    const targets = db.prepare('SELECT * FROM promotion_targets').all() as PromoTargetLike[];
    expect(resolveEffectivePromo('qmi', ctx, promos, targets, NOW)?.id).toBe('pQmi');
    db.close();
  });

  it('migration 0014 lets promotion_targets hold a floor_plan target, and it cascades to a QMI', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO promotions (id, title, banner_text, sort_order, start_date, end_date, published)
       VALUES (@id, @title, @banner, @sort, @start, @end, @active)`
    ).run({ id: 'pFP', title: 'FP', banner: 'fp', sort: 0, start: null, end: null, active: 1 });

    // The widened CHECK (migration 0014) must accept target_type='floor_plan'.
    expect(() =>
      db
        .prepare(`INSERT INTO promotion_targets (promotion_id, target_type, target_id) VALUES (?, ?, ?)`)
        .run('pFP', 'floor_plan', 'recFP1')
    ).not.toThrow();

    const promos = db.prepare('SELECT * FROM promotions').all() as PromoLike[];
    const targets = db.prepare('SELECT * FROM promotion_targets').all() as PromoTargetLike[];
    const ctxFP = { qmiId: 'recQMI1', communityId: 'recComm1', floorPlanId: 'recFP1', cityId: 'recCity1' };
    expect(resolveEffectivePromo('qmi', ctxFP, promos, targets, NOW)?.id).toBe('pFP');
    db.close();
  });
});
