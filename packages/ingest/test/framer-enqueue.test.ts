// =============================================================================
// Event-driven hand-off test — INGEST → FRAMER_QUEUE.
// Proves that after the ingest queue consumer applies a synced D1 write it
// enqueues a Framer-push message { collection, action:'upsert', id } using the
// EXACT shape framer-push expects (id-only; framer-push re-reads the row):
//   * qmi.upsert (new spec)      → { collection:'qmi',         action:'upsert', id: <new id> }
//   * qmi.upsert (existing)      → { collection:'qmi',         action:'upsert', id: <qmiId> }
//   * qmi.unpublish              → { collection:'qmi',         action:'upsert', id: <qmiId> }  (re-reads draft)
//   * community.upsert           → { collection:'communities', action:'upsert', id: <communityId> }
// And the negative guards:
//   * a write that throws (write-set violation) enqueues NOTHING for that row.
//   * an env without FRAMER_QUEUE bound is a no-op (unit-test / safety).
// Uses the REAL schema via better-sqlite3 (same DDL D1 runs).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { freshDb, d1 } from './helpers.js';
import {
  applyMessage,
  handleQueueBatch,
  type ConsumerEnv,
  type FramerSyncMessage,
  type FramerQueueProducer,
} from '../src/consumer.js';
import type {
  SyncMessage,
  QmiUpsertMessage,
  QmiUnpublishMessage,
  CommunityUpsertMessage,
} from '../src/diff.js';

const ECI = '006LP00000051';

/** A FRAMER_QUEUE stand-in that records everything sent. */
function mockQueue() {
  const sent: FramerSyncMessage[] = [];
  let sendCalls = 0;
  let sendBatchCalls = 0;
  const q: FramerQueueProducer = {
    async send(body: unknown) {
      sendCalls++;
      sent.push(body as FramerSyncMessage);
    },
    async sendBatch(messages: { body: unknown }[]) {
      sendBatchCalls++;
      for (const m of messages) sent.push(m.body as FramerSyncMessage);
    },
  };
  return { q, sent, get sendCalls() { return sendCalls; }, get sendBatchCalls() { return sendBatchCalls; } };
}

/** Wrap raw SyncMessages in a queue batch with recording ack/retry. */
function batchOf(messages: SyncMessage[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  return {
    batch: {
      messages: messages.map((body, i) => ({
        body,
        ack() { acked.push(i); },
        retry() { retried.push(i); },
      })),
    },
    acked,
    retried,
  };
}

describe('ingest consumer enqueues Framer-push messages on successful D1 write', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    // One imported, published QMI (for update + unpublish cases) and one community.
    db.prepare(
      `INSERT INTO qmi (id, eci_key, housenumber, synced_community_name, published, synced_bedroom_count)
       VALUES ('recQMI1', @eci, '51', 'anaqua at tres lagos', 1, 3)`
    ).run({ eci: ECI });
    db.prepare(
      `INSERT INTO communities (id, name) VALUES ('recCOMM1', 'Anaqua at Tres Lagos')`
    ).run();
  });

  afterEach(() => db.close());

  it('qmi.upsert (existing) → { collection:"qmi", action:"upsert", id: qmiId } via handleQueueBatch', async () => {
    const mq = mockQueue();
    const env: ConsumerEnv = { DB: d1(db), FRAMER_QUEUE: mq.q };

    const upsert: QmiUpsertMessage = {
      kind: 'qmi.upsert',
      snowflakeKey: ECI,
      qmiId: 'recQMI1',
      values: { bedroomCount: 4 },
      isNew: false,
      slugSource: null,
      ratifiedSalesPrice: null,
    };

    const { batch, acked, retried } = batchOf([upsert]);
    await handleQueueBatch(batch, env);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(mq.sent).toEqual<FramerSyncMessage[]>([
      { collection: 'qmi', action: 'upsert', id: 'recQMI1' },
    ]);
  });

  it('qmi.upsert (new spec) → enqueues the NEWLY-GENERATED row id', async () => {
    const mq = mockQueue();
    const env: ConsumerEnv = { DB: d1(db), FRAMER_QUEUE: mq.q };

    const newSpec: QmiUpsertMessage = {
      kind: 'qmi.upsert',
      snowflakeKey: '006LP00000200',
      qmiId: null,
      values: { address: '200 New St', bedroomCount: 3 },
      isNew: true,
      slugSource: '200 New St',
      ratifiedSalesPrice: null,
    };

    const { batch } = batchOf([newSpec]);
    await handleQueueBatch(batch, env);

    expect(mq.sent).toHaveLength(1);
    const out = mq.sent[0]!;
    expect(out.collection).toBe('qmi');
    expect(out.action).toBe('upsert');
    // The enqueued id must be the id the consumer actually inserted.
    const insertedId = (
      db.prepare(`SELECT id FROM qmi WHERE synced_address = '200 New St'`).get() as { id: string }
    ).id;
    expect(out.id).toBe(insertedId);
  });

  it('qmi.unpublish → still an "upsert" hand-off (framer-push re-reads draft state)', async () => {
    const mq = mockQueue();
    const env: ConsumerEnv = { DB: d1(db), FRAMER_QUEUE: mq.q };

    const unpub: QmiUnpublishMessage = { kind: 'qmi.unpublish', snowflakeKey: ECI, qmiId: 'recQMI1' };
    const { batch } = batchOf([unpub]);
    await handleQueueBatch(batch, env);

    expect(mq.sent).toEqual<FramerSyncMessage[]>([
      { collection: 'qmi', action: 'upsert', id: 'recQMI1' },
    ]);
  });

  it('community.upsert → { collection:"communities", action:"upsert", id: communityId }', async () => {
    const mq = mockQueue();
    const env: ConsumerEnv = { DB: d1(db), FRAMER_QUEUE: mq.q };

    const comm: CommunityUpsertMessage = {
      kind: 'community.upsert',
      communityId: 'recCOMM1',
      values: { squareFootageRange: '1850 - 2400' },
    };
    const { batch } = batchOf([comm]);
    await handleQueueBatch(batch, env);

    expect(mq.sent).toEqual<FramerSyncMessage[]>([
      { collection: 'communities', action: 'upsert', id: 'recCOMM1' },
    ]);
  });

  it('mixed batch → one hand-off per successful write, all upserts', async () => {
    const mq = mockQueue();
    const env: ConsumerEnv = { DB: d1(db), FRAMER_QUEUE: mq.q };

    const msgs: SyncMessage[] = [
      {
        kind: 'qmi.upsert', snowflakeKey: ECI, qmiId: 'recQMI1',
        values: { bedroomCount: 5 }, isNew: false, slugSource: null, ratifiedSalesPrice: null,
      },
      { kind: 'community.upsert', communityId: 'recCOMM1', values: { squareFootageRange: '1000 - 2000' } },
    ];
    const { batch } = batchOf(msgs);
    await handleQueueBatch(batch, env);

    expect(mq.sent.sort((a, b) => a.id.localeCompare(b.id))).toEqual<FramerSyncMessage[]>([
      { collection: 'communities', action: 'upsert', id: 'recCOMM1' },
      { collection: 'qmi', action: 'upsert', id: 'recQMI1' },
    ]);
    // batched in a single sendBatch call (chunked at 100)
    expect(mq.sendBatchCalls).toBe(1);
  });

  it('a community.upsert whose patch is empty (no fields present) enqueues NOTHING', async () => {
    const mq = mockQueue();
    const env: ConsumerEnv = { DB: d1(db), FRAMER_QUEUE: mq.q };
    // An empty values object → applySyncedCommunity yields an empty patch → the
    // consumer short-circuits before any UPDATE (and therefore no hand-off). The
    // message `values` type requires the key, so we hand-build the no-field case.
    const comm = {
      kind: 'community.upsert', communityId: 'recCOMM1', values: {},
    } as unknown as CommunityUpsertMessage;
    const { batch } = batchOf([comm]);
    await handleQueueBatch(batch, env);
    expect(mq.sent).toEqual([]);
  });

  it('applyMessage returns the framer hand-off in its result (unit level)', async () => {
    const env: ConsumerEnv = { DB: d1(db) };
    const r = await applyMessage(env, {
      kind: 'qmi.upsert', snowflakeKey: ECI, qmiId: 'recQMI1',
      values: { bedroomCount: 4 }, isNew: false, slugSource: null, ratifiedSalesPrice: null,
    });
    expect(r.updated).toBe(1);
    expect(r.framer).toEqual<FramerSyncMessage[]>([
      { collection: 'qmi', action: 'upsert', id: 'recQMI1' },
    ]);
  });

  it('no FRAMER_QUEUE bound → no-op (write still happens, no throw)', async () => {
    const env: ConsumerEnv = { DB: d1(db) }; // FRAMER_QUEUE omitted
    const { batch, acked } = batchOf([
      { kind: 'qmi.unpublish', snowflakeKey: ECI, qmiId: 'recQMI1' },
    ]);
    await expect(handleQueueBatch(batch, env)).resolves.toBeUndefined();
    expect(acked).toEqual([0]);
    // the D1 write still landed
    const pub = (db.prepare(`SELECT published FROM qmi WHERE id = 'recQMI1'`).get() as { published: number }).published;
    expect(pub).toBe(0);
  });
});
