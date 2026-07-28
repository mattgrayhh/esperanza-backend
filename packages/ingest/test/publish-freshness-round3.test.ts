// =============================================================================
// Review round 3 (2026-07-28) — the orderings the run counter alone does NOT close,
// plus the harness bug that was hiding one of them.
//
// Each describe() below is named for the exact counterexample the reviewer reproduced
// at head 35ca757, so a future change that reintroduces one fails with its own name.
//
// The headline finding: a monotonic counter can only refuse an intent that arrives
// LATE. It cannot retract one that arrived on time and was correct when it ran. That
// case needs the newer decision to actively unpublish — which is safe to automate only
// for inventory this pipeline published itself, hence the provenance check.
// =============================================================================

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { freshDb, d1, setRunSeq, seedIngestPublish } from './helpers.js';
import { applyMessage, INGEST_ACTOR, type ConsumerEnv, type D1Like } from '../src/consumer.js';
import { loadExistingQmis } from '../src/index.js';
import { diff, type ExistingQmi, type Lookups } from '../src/diff.js';
import type { SnowflakeQmiRow } from '../src/snowflake.js';

const QMI_ID = 'recR3';
const KEY = '002PG00000291';
/** Stand-in for the audit_log.id of the ingest publish flip a retraction is undoing. */
const AUDIT_ID = 4242;
const IMAGE = 'https://img.hazardhouse.ai/qmi/2133-sand-lane.jpg';

function seed(over: { published?: number; stage?: string | null; moveIn?: string | null } = {}) {
  const db = freshDb();
  db.prepare(
    `INSERT INTO qmi (id, eci_key, housenumber, synced_address, published,
                      synced_construction_stage, synced_move_in_date, image_url)
     VALUES (?, ?, '2133', '2133 Sand Lane', ?, ?, ?, ?)`
  ).run(
    QMI_ID,
    KEY,
    over.published ?? 0,
    over.stage === undefined ? 'Buyer Sign Off' : over.stage,
    over.moveIn ?? null,
    IMAGE
  );
  return db;
}

const publishedOf = (db: Database.Database) =>
  (db.prepare(`SELECT published FROM qmi WHERE id = ?`).get(QMI_ID) as { published: number }).published;

const auditCount = (db: Database.Database) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n;

function emptyLookups(): Lookups {
  return {
    communityByName: new Map(),
    floorPlanByName: new Map(),
    cityByName: new Map(),
  } as unknown as Lookups;
}

// ── SEQ_BUMP_AFTER_READ ──────────────────────────────────────────────────────────
describe('SEQ_BUMP_AFTER_READ — a producer run starts between the check and the write', () => {
  it('refuses the publish, because the sequence is compared inside the flip statement', async () => {
    const db = seed();
    setRunSeq(db, 1);
    const base = d1(db);

    // Stand in for run 2 starting in the window the consumer cannot see: bump the
    // counter at the moment the batch is submitted, i.e. AFTER every read the publish
    // path made. Under a sequence checked only in a preceding SELECT this published.
    const racing: D1Like = {
      prepare: base.prepare.bind(base),
      async batch(statements: unknown[]) {
        setRunSeq(db, 2);
        return base.batch(statements);
      },
    };
    const env = { DB: racing } as unknown as ConsumerEnv;

    await applyMessage(env, {
      kind: 'qmi.publish',
      snowflakeKey: KEY,
      qmiId: QMI_ID,
      runSeq: 1,
      expect: { stage: 'Buyer Sign Off', moveIn: null },
    });

    expect(publishedOf(db)).toBe(0);
    expect(auditCount(db)).toBe(0); // and no audit row claiming a flip that never happened
    db.close();
  });
});

// ── CACHED_DATA_SEQ ──────────────────────────────────────────────────────────────
describe('CACHED_DATA_SEQ — a batch-scoped sequence snapshot older than the DB counter', () => {
  it('refuses a stale unpublish even though the cached context says it is current', async () => {
    const db = seed({ published: 1 });
    setRunSeq(db, 2); // run 2 is what D1 actually holds
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    // The batch read the counter when it was still 1 and carries that snapshot. The
    // message is stamped 1, so against the SNAPSHOT it looks perfectly current — which
    // is exactly how a stale unpublish used to get applied.
    await applyMessage(
      env,
      { kind: 'qmi.unpublish', snowflakeKey: KEY, qmiId: QMI_ID, runSeq: 1 },
      { currentRunSeq: 1 }
    );

    expect(publishedOf(db)).toBe(1); // the home a newer run re-listed stays up
    db.close();
  });
});

// ── FUTURE_SEQ ───────────────────────────────────────────────────────────────────
describe('FUTURE_SEQ — a sequence the counter has never issued', () => {
  it('refuses to publish on a seq ahead of the counter', async () => {
    const db = seed();
    setRunSeq(db, 1);
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    await applyMessage(env, {
      kind: 'qmi.publish',
      snowflakeKey: KEY,
      qmiId: QMI_ID,
      runSeq: 9,
      expect: { stage: 'Buyer Sign Off', moveIn: null },
    });

    expect(publishedOf(db)).toBe(0);
    db.close();
  });
});

// ── The counter cannot be read at all ────────────────────────────────────────────
describe('an unreadable run counter is retried, not silently dropped', () => {
  it('throws on a stamped intent when sync_run_seq is gone, so the queue redelivers it', async () => {
    const db = seed();
    db.prepare(`DROP TABLE sync_run_seq`).run();
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    // Dropping real feed data because of a transient D1 blip is a silent data-loss bug;
    // "I cannot tell" and "I know this is stale" must not share an outcome.
    await expect(
      applyMessage(env, {
        kind: 'qmi.upsert',
        snowflakeKey: KEY,
        qmiId: QMI_ID,
        values: { constructionStage: 'Under Roof' },
        isNew: false,
        slugSource: null,
        ratifiedSalesPrice: null,
        runSeq: 1,
      })
    ).rejects.toThrow(/cannot read sync_run_seq/);
    db.close();
  });
});

// ── HARNESS_ATOMICITY ────────────────────────────────────────────────────────────
describe('HARNESS_ATOMICITY — a failure AFTER the batch has started executing', () => {
  it('rolls the audit insert back when the qmi update fails mid-batch', async () => {
    const db = seed();
    setRunSeq(db, 1);
    // Fail on statement 2 (the UPDATE), not on prepare(). The previous harness could not
    // catch this: it started async run() calls inside the transaction and awaited them
    // after the commit, so statement 1 stayed committed and the batch looked atomic when
    // it was not. Dropping audit_log — what the old test did — fails during prepare(),
    // before the batch begins, and proves nothing about rollback.
    db.prepare(
      `CREATE TRIGGER qmi_publish_boom BEFORE UPDATE OF published ON qmi
       BEGIN SELECT RAISE(ABORT, 'simulated qmi update failure'); END`
    ).run();
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    await expect(
      applyMessage(env, {
        kind: 'qmi.publish',
        snowflakeKey: KEY,
        qmiId: QMI_ID,
        runSeq: 1,
        expect: { stage: 'Buyer Sign Off', moveIn: null },
      })
    ).rejects.toThrow(/simulated qmi update failure/);

    expect(publishedOf(db)).toBe(0);
    expect(auditCount(db)).toBe(0); // the audit row from statement 1 must NOT survive
    db.close();
  });
});

// ── PRIMARY BLOCKER: run 1 publishes validly, run 2 reports the home unready ──────
describe('the cross-run schedule no freshness rule can close', () => {
  const sfRow = (stage: string): SnowflakeQmiRow =>
    ({
      eciKey: KEY,
      houseNumber: '2133',
      address: '2133 Sand Lane',
      communityName: null,
      constructionStage: stage,
      moveInDate: null,
      ratifiedSalesPrice: null,
    }) as unknown as SnowflakeQmiRow;

  const live = (over: Partial<ExistingQmi>): ExistingQmi =>
    ({
      id: QMI_ID,
      eci_key: KEY,
      housenumber: '2133',
      published: 1,
      image_url: IMAGE,
      synced_construction_stage: 'Buyer Sign Off',
      synced_move_in_date: null,
      // A machine-published row always has the publish flip's audit id alongside the
      // flag — they are read from the same row (see loadExistingQmis).
      ...(over.machine_published === 1 ? { machine_publish_audit_id: AUDIT_ID } : {}),
      ...over,
    }) as ExistingQmi;

  it('retracts a home INGEST published once a newer run reports it unready', () => {
    // Run 1's publish was valid and committed. Run 2 now sees 'Build Pad'.
    const { messages, stats } = diff(
      [sfRow('Build Pad')],
      [],
      [live({ machine_published: 1 })],
      emptyLookups(),
      [],
      [],
      [],
      new Map(),
      false,
      '2026-07-28',
      2
    );

    // Round 4 split this out of qmi.unpublish: the sold/removed path stays unconditional,
    // the drift retraction carries what it needs to re-verify itself at delivery.
    const un = messages.find((m) => m.kind === 'qmi.retract');
    expect(un).toBeDefined();
    expect(un!.kind === 'qmi.retract' && un!.qmiId).toBe(QMI_ID);
    expect(un!.kind === 'qmi.retract' && un!.runSeq).toBe(2); // sequenced, like every intent
    expect(un!.kind === 'qmi.retract' && un!.publishAuditId).toBe(AUDIT_ID);
    expect(un!.kind === 'qmi.retract' && un!.expect).toEqual({ stage: 'Build Pad', moveIn: null });
    expect(messages.find((m) => m.kind === 'qmi.unpublish')).toBeUndefined();
    expect(stats.qmisDriftUnpublished).toBe(1);
    expect(stats.qmisPublishedDrifted).toBe(0); // not merely reported — acted on
  });

  it('does NOT retract a home a HUMAN published — it only reports it', () => {
    const { messages, stats } = diff(
      [sfRow('Build Pad')],
      [],
      [live({ machine_published: 0 })],
      emptyLookups(),
      [],
      [],
      [],
      new Map(),
      false,
      '2026-07-28',
      2
    );

    expect(messages.find((m) => m.kind === 'qmi.retract')).toBeUndefined();
    expect(stats.qmisDriftUnpublished).toBe(0);
    expect(stats.qmisPublishedDrifted).toBe(1);
    expect(stats.driftedPublishedIds).toEqual([QMI_ID]);
  });

  it('leaves a still-ready machine-published home alone', () => {
    const { messages, stats } = diff(
      [sfRow('Buyer Sign Off')],
      [],
      [live({ machine_published: 1 })],
      emptyLookups(),
      [],
      [],
      [],
      new Map(),
      false,
      '2026-07-28',
      2
    );

    expect(messages.find((m) => m.kind === 'qmi.retract')).toBeUndefined();
    expect(stats.qmisDriftUnpublished).toBe(0);
    expect(stats.qmisPublishedDrifted).toBe(0);
  });

  it('the retraction actually lands, and is attributed to ingest', async () => {
    const db = seed({ published: 1, stage: 'Build Pad' });
    setRunSeq(db, 2);
    // The flip being retracted has to exist for the consumer to compare against it.
    const publishAuditId = seedIngestPublish(db, QMI_ID);
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    await applyMessage(env, {
      kind: 'qmi.retract',
      snowflakeKey: KEY,
      qmiId: QMI_ID,
      runSeq: 2,
      expect: { stage: 'Build Pad', moveIn: null },
      publishAuditId,
    });

    expect(publishedOf(db)).toBe(0);
    const row = db
      .prepare(`SELECT actor, action, new_value FROM audit_log WHERE entity_id = ? AND action = 'unpublish'`)
      .get(QMI_ID) as { actor: string; action: string; new_value: string };
    expect(row).toEqual({ actor: INGEST_ACTOR, action: 'unpublish', new_value: '0' });
    db.close();
  });
});

// ── Provenance, read from the real schema ────────────────────────────────────────
describe('machine_published provenance', () => {
  it('is 1 only when the LAST published-flip was ingest, and 0 for the pre-attribution backlog', async () => {
    const db = seed({ published: 1 });
    db.prepare(
      `INSERT INTO qmi (id, eci_key, housenumber, synced_address, published)
       VALUES ('recHUMAN', '002PG00000999', '9', '9 Human Way', 1)`
    ).run();
    db.prepare(
      `INSERT INTO qmi (id, eci_key, housenumber, synced_address, published)
       VALUES ('recBACKLOG', '002PG00000888', '8', '8 Backlog Rd', 1)`
    ).run();

    const audit = db.prepare(
      `INSERT INTO audit_log (entity, entity_id, field, action, old_value, new_value, actor, at)
       VALUES ('qmi', ?, 'published', ?, ?, ?, ?, ?)`
    );
    // Machine published it, and nobody has touched it since.
    audit.run(QMI_ID, 'publish', '0', '1', INGEST_ACTOR, '2026-07-20T00:00:00.000Z');
    // Machine published it, then a HUMAN re-published it later — the newest flip wins, so
    // this is human-owned and the drift leg must leave it alone.
    audit.run('recHUMAN', 'publish', '0', '1', INGEST_ACTOR, '2026-07-20T00:00:00.000Z');
    audit.run('recHUMAN', 'publish', '0', '1', 'matt@hazard.house', '2026-07-25T00:00:00.000Z');
    // recBACKLOG has no published audit row at all — the ~101-home cleanup shape.

    const rows = await loadExistingQmis(d1(db));
    const by = new Map(rows.map((r) => [r.id, Number(r.machine_published)]));

    expect(by.get(QMI_ID)).toBe(1);
    expect(by.get('recHUMAN')).toBe(0);
    expect(by.get('recBACKLOG')).toBe(0);

    // The audit id travels with the flag, from the SAME row, so the consumer can
    // re-verify ownership against the exact flip the producer judged (round 4).
    const ids = new Map(rows.map((r) => [r.id, r.machine_publish_audit_id ?? null]));
    const ingestFlip = db
      .prepare(`SELECT id FROM audit_log WHERE entity_id = ? AND action = 'publish'`)
      .get(QMI_ID) as { id: number };
    expect(Number(ids.get(QMI_ID))).toBe(ingestFlip.id);
    expect(ids.get('recBACKLOG')).toBeNull(); // nothing to point at → nothing to retract
    db.close();
  });
});
