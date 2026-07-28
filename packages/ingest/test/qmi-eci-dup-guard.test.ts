// =============================================================================
// eci_key duplicate guard (0025). Real incident: 4122 Westway Court was inserted
// TWICE with the same eci_key 003HC00000046 when the diff missed the existing
// row. eci_key is the DM_HOUSE natural key — a create message whose eci_key
// already exists in D1 must route to the UPDATE path against that row, never
// insert a second one. Uses the REAL schema via better-sqlite3 (same harness as
// siblings).
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { freshDb, d1 } from './helpers.js';
import { applyMessage, type ConsumerEnv } from '../src/consumer.js';
import type { QmiUpsertMessage } from '../src/diff.js';

const ECI = '003HC00000046';

function createMsg(over: Partial<QmiUpsertMessage> = {}): QmiUpsertMessage {
  return {
    kind: 'qmi.upsert',
    runSeq: 1,
    snowflakeKey: ECI,
    qmiId: null,
    values: { eciKey: ECI, address: '4122 Westway Court' },
    isNew: true,
    slugSource: '4122 Westway Court',
    ratifiedSalesPrice: 300990,
    ...over,
  };
}

let db: Database.Database;
let env: ConsumerEnv;

beforeEach(() => {
  db = freshDb();
  env = { DB: d1(db) } as unknown as ConsumerEnv;
});

describe('qmi eci_key duplicate guard', () => {
  it('a second isNew message with the same eci_key updates the existing row instead of inserting', async () => {
    const first = await applyMessage(env, createMsg());
    expect(first.created).toBe(1);

    const second = await applyMessage(
      env,
      createMsg({ ratifiedSalesPrice: 310990, values: { eciKey: ECI, address: '4122 Westway Court' } })
    );
    expect(second.created).toBe(0);

    const rows = db.prepare('SELECT id, synced_price FROM qmi WHERE eci_key = ?').all(ECI) as Array<{
      id: string;
      synced_price: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.synced_price).toBe(310990); // second message applied as an UPDATE
  });

  it('a create with no eci_key still inserts (guard only fires on the natural key)', async () => {
    const res = await applyMessage(env, createMsg({ values: { address: 'No Key Home' }, snowflakeKey: '' }));
    expect(res.created).toBe(1);
  });
});
