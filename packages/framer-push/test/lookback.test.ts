// =============================================================================
// Lookback-window selector test. Inserts rows with updated_at inside and outside
// the 30-minute window across multiple tables and asserts the cron producer
// enqueues exactly the recently-changed ids (and nothing stale).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, d1, insertRow } from './helpers.js';
import { lookbackCutoffIso, CRON_LOOKBACK_MINUTES, changedIdsSql } from '../src/lookback.js';
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
  it('uses a 30-minute default window', () => {
    expect(CRON_LOOKBACK_MINUTES).toBe(30);
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
});
