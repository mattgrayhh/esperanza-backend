// =============================================================================
// Lookback-window selector test. Inserts rows with updated_at inside and outside
// the 30-minute window across multiple tables and asserts the cron producer
// enqueues exactly the recently-changed ids (and nothing stale).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, d1, insertRow } from './helpers.js';
import {
  lookbackCutoffIso,
  CRON_LOOKBACK_MINUTES,
  FULL_RECONCILE_MINUTES,
  resolveLookbackMinutes,
  changedIdsSql,
} from '../src/lookback.js';
import { collectChangedMessages } from '../src/index.js';
import type { Env } from '../src/index.js';
import type { FramerSyncMessage } from '../src/types.js';

const NOW = Date.parse('2026-05-30T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function envFor(db: ReturnType<typeof freshDb>): Env {
  // Only DB is exercised by collectChangedMessages.
  return { DB: d1(db) } as unknown as Env;
}

describe('lookbackCutoffIso', () => {
  it('computes now - minutes as an ISO string', () => {
    expect(lookbackCutoffIso(NOW, 30)).toBe('2026-05-30T11:30:00.000Z');
  });
  it('defaults to a 25h (1500-minute) nightly-backstop window', () => {
    expect(CRON_LOOKBACK_MINUTES).toBe(1500);
  });
  it('a 1500-minute window reaches >24h back', () => {
    // 1500 min = 25h → cutoff is the prior day, ensuring a full 24h is re-scanned.
    expect(lookbackCutoffIso(NOW, CRON_LOOKBACK_MINUTES)).toBe('2026-05-29T11:00:00.000Z');
  });
});

describe('resolveLookbackMinutes (env override → default)', () => {
  it('falls back to the 1500-min default when unset/blank', () => {
    expect(resolveLookbackMinutes(undefined)).toBe(1500);
    expect(resolveLookbackMinutes(null)).toBe(1500);
    expect(resolveLookbackMinutes('')).toBe(1500);
  });
  it('falls back when non-positive or non-numeric', () => {
    expect(resolveLookbackMinutes('0')).toBe(1500);
    expect(resolveLookbackMinutes('-10')).toBe(1500);
    expect(resolveLookbackMinutes('abc')).toBe(1500);
  });
  it('honors a positive override (wrangler vars are strings)', () => {
    expect(resolveLookbackMinutes('2880')).toBe(2880); // 48h
    expect(resolveLookbackMinutes(45)).toBe(45);
  });
});

describe('changedIdsSql', () => {
  it('targets the table backing each key and orders by updated_at', () => {
    expect(changedIdsSql('qmi')).toContain('FROM qmi');
    expect(changedIdsSql('floor_plans')).toContain('FROM floor_plans');
    expect(changedIdsSql('qmi')).toContain('updated_at >= ?');
    expect(changedIdsSql('qmi')).toContain('ORDER BY updated_at ASC');
  });
});

describe('cron lookback selector (collectChangedMessages)', () => {
  it('enqueues only rows updated within the window, across tables', async () => {
    const db = freshDb();

    // QMI: one recent (5 min ago) + one stale (45 min ago).
    insertRow(db, 'qmi', { id: 'recQMIfresh01', published: 1, updated_at: iso(NOW - 5 * MIN) });
    insertRow(db, 'qmi', { id: 'recQMIstale01', published: 1, updated_at: iso(NOW - 45 * MIN) });

    // Communities: one recent right at the edge (29 min) + one just past (31 min).
    insertRow(db, 'communities', {
      id: 'recCOMfresh01',
      name: 'Tres Lagos',
      updated_at: iso(NOW - 29 * MIN),
    });
    insertRow(db, 'communities', {
      id: 'recCOMstale01',
      name: 'Old Place',
      updated_at: iso(NOW - 31 * MIN),
    });

    // Blogs: one recent.
    insertRow(db, 'blogs', { id: 'recBLOGfresh1', title: 'Hi', updated_at: iso(NOW - 1 * MIN) });

    const env = envFor(db);
    const messages = await collectChangedMessages(env, NOW, 30);

    const ids = messages.map((m) => m.id).sort();
    expect(ids).toEqual(['recBLOGfresh1', 'recCOMfresh01', 'recQMIfresh01']);

    // every message is an upsert keyed to the right collection
    const byId = new Map(messages.map((m) => [m.id, m] as const));
    expect(byId.get('recQMIfresh01')).toMatchObject<Partial<FramerSyncMessage>>({
      collection: 'qmi',
      action: 'upsert',
    });
    expect(byId.get('recCOMfresh01')?.collection).toBe('communities');
    expect(byId.get('recBLOGfresh1')?.collection).toBe('blogs');

    // stale rows are excluded
    expect(ids).not.toContain('recQMIstale01');
    expect(ids).not.toContain('recCOMstale01');
  });

  it('returns nothing when no row changed in the window', async () => {
    const db = freshDb();
    insertRow(db, 'qmi', { id: 'recOLD', published: 1, updated_at: iso(NOW - 120 * MIN) });
    const messages = await collectChangedMessages(envFor(db), NOW, 30);
    expect(messages).toEqual([]);
  });

  it('nightly default window (env-resolved, 25h) catches a full day and excludes >25h', async () => {
    const db = freshDb();
    const HR = 60 * MIN;
    // Within the 25h window: 20h ago + 24h ago.
    insertRow(db, 'qmi', { id: 'recQMI20h', published: 1, updated_at: iso(NOW - 20 * HR) });
    insertRow(db, 'communities', { id: 'recCOM24h', name: 'Lagos', updated_at: iso(NOW - 24 * HR) });
    // Just past the 25h window: 26h ago — must be excluded.
    insertRow(db, 'blogs', { id: 'recBLOG26h', title: 'Old', updated_at: iso(NOW - 26 * HR) });

    // No explicit minutes → resolves from env.CRON_LOOKBACK_MINUTES (unset → 1500 = 25h default).
    const env = { DB: d1(db) } as unknown as Env;
    const messages = await collectChangedMessages(env, NOW);
    const ids = messages.map((m) => m.id).sort();
    expect(ids).toEqual(['recCOM24h', 'recQMI20h']);
    expect(ids).not.toContain('recBLOG26h');
  });

  it('weekly FULL_RECONCILE_MINUTES re-enqueues rows the 25h backstop excludes', async () => {
    const db = freshDb();
    const HR = 60 * MIN;
    // A row stale 60 days — far past the 25h backstop, so it has aged out of every
    // nightly window (this is the silent-staleness case the weekly full reconcile fixes).
    insertRow(db, 'qmi', { id: 'recQMIancient', published: 1, updated_at: iso(NOW - 60 * 24 * HR) });
    const env = { DB: d1(db) } as unknown as Env;

    // 25h backstop: excluded.
    expect((await collectChangedMessages(env, NOW)).map((m) => m.id)).not.toContain('recQMIancient');
    // Weekly full reconcile window: included.
    const full = await collectChangedMessages(env, NOW, FULL_RECONCILE_MINUTES);
    expect(full.map((m) => m.id)).toContain('recQMIancient');
  });

  it('respects a CRON_LOOKBACK_MINUTES env override', async () => {
    const db = freshDb();
    const HR = 60 * MIN;
    insertRow(db, 'qmi', { id: 'recQMI20h', published: 1, updated_at: iso(NOW - 20 * HR) });
    insertRow(db, 'qmi', { id: 'recQMI2h', published: 1, updated_at: iso(NOW - 2 * HR) });
    // Narrow the window to 3h via the env var: only the 2h row qualifies.
    const env = { DB: d1(db), CRON_LOOKBACK_MINUTES: '180' } as unknown as Env;
    const messages = await collectChangedMessages(env, NOW);
    expect(messages.map((m) => m.id)).toEqual(['recQMI2h']);
  });
});
