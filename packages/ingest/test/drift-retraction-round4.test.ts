// =============================================================================
// Review round 4 (2026-07-28) — the readiness-drift retraction leg.
//
// Round 3's fix made the drift leg emit a sequenced unpublish for inventory INGEST
// published. Round 4 found that the provenance check lived ONLY in the producer's
// snapshot: the emitted message was an ordinary qmi.unpublish, and at delivery the write
// compare-and-set on `published = 1` plus the run sequence and NOTHING ELSE. Both of the
// schedules below therefore landed at head caaa0ff.
//
// They are same-RUN races, which is why no sequence number can see them: the counter is
// identical at emit and at delivery. Only re-deciding at the write closes them, so the
// retraction now carries the state it judged and the id of the flip it is undoing, and
// both are predicates on the mutating statement (retractCas).
//
// Each describe() is named for the exact counterexample, so a regression fails by name.
// =============================================================================

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { freshDb, d1, setRunSeq, seedIngestPublish, seedPublishAudit } from './helpers.js';
import { applyMessage, INGEST_ACTOR, type ConsumerEnv } from '../src/consumer.js';
import { diff, type ExistingQmi, type Lookups } from '../src/diff.js';
import type { SnowflakeQmiRow } from '../src/snowflake.js';
import { addDays, todayIsoDate } from '../src/availability.js';

const QMI_ID = 'recR4';
const KEY = '002PG00000292';
const IMAGE = 'https://img.hazardhouse.ai/qmi/2133-sand-lane.jpg';
const HUMAN = 'matt@hazard.house';
const RUN = 7;

/** A live home whose stage has regressed out of the horizon — the drift shape. */
function seedDrifted(
  over: { stage?: string | null; override?: string | null; moveIn?: string | null } = {}
) {
  const db = freshDb();
  db.prepare(
    `INSERT INTO qmi (id, eci_key, housenumber, synced_address, published,
                      synced_construction_stage, override_construction_stage,
                      synced_move_in_date, image_url)
     VALUES (?, ?, '2133', '2133 Sand Lane', 1, ?, ?, ?, ?)`
  ).run(
    QMI_ID,
    KEY,
    over.stage === undefined ? 'Build Pad' : over.stage,
    over.override ?? null,
    over.moveIn ?? null,
    IMAGE
  );
  setRunSeq(db, RUN);
  return db;
}

const publishedOf = (db: Database.Database) =>
  (db.prepare(`SELECT published FROM qmi WHERE id = ?`).get(QMI_ID) as { published: number }).published;

const unpublishAudits = (db: Database.Database) =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'unpublish'`)
      .get(QMI_ID) as { n: number }
  ).n;

/** The retraction the producer would have emitted for this home. */
const retract = (
  publishAuditId: number,
  expect_: { stage: string | null; moveIn: string | null } = { stage: 'Build Pad', moveIn: null }
) =>
  ({
    kind: 'qmi.retract' as const,
    snowflakeKey: KEY,
    qmiId: QMI_ID,
    runSeq: RUN,
    expect: expect_,
    publishAuditId,
  });

// ── HUMAN_REPUBLISH_RACE ─────────────────────────────────────────────────────────
describe('HUMAN_REPUBLISH_RACE — a human unpublishes and republishes before delivery', () => {
  it('refuses to retract, because the newest publish flip is no longer ingest’s', async () => {
    const db = seedDrifted();
    // What the producer saw: ingest owns the publication.
    const machineFlip = seedIngestPublish(db, QMI_ID);
    // What happens before the intent lands — a PERSON takes it down and puts it back.
    // published ends at 1, and a run-sequence CAS cannot tell this from no change at all.
    seedPublishAudit(db, QMI_ID, { actor: HUMAN, action: 'unpublish', at: '2026-07-28T10:00:00.000Z' });
    seedPublishAudit(db, QMI_ID, { actor: HUMAN, action: 'publish', at: '2026-07-28T10:05:00.000Z' });

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(machineFlip));

    // The home a human put live stays live — the ownership boundary the policy promises.
    expect(publishedOf(db)).toBe(1);
    // And no audit row claiming a retraction that never happened.
    expect(unpublishAudits(db)).toBe(1); // only the human's own, seeded above
    db.close();
  });

  it('still retracts when ingest itself republished after a human took it down', async () => {
    // The mirror case, to prove the guard is an ownership test and not just "any newer
    // audit row blocks forever". Ingest published LAST, so the retraction is symmetric.
    const db = seedDrifted();
    seedIngestPublish(db, QMI_ID, '2026-07-20T00:00:00.000Z');
    seedPublishAudit(db, QMI_ID, { actor: INGEST_ACTOR, action: 'unpublish', at: '2026-07-21T00:00:00.000Z' });
    const newest = seedIngestPublish(db, QMI_ID, '2026-07-22T00:00:00.000Z');

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(newest));

    expect(publishedOf(db)).toBe(0);
    db.close();
  });

  it('refuses when a human unpublished after the flip, even with no republish audit row', async () => {
    // Defence in depth for a publish path that does not audit. None exists today
    // (togglePublished always audits), but if one is added, the newest-publish-row test
    // silently stops seeing it. A human unpublish newer than the flip is enough to refuse.
    const db = seedDrifted();
    const machineFlip = seedIngestPublish(db, QMI_ID);
    seedPublishAudit(db, QMI_ID, { actor: HUMAN, action: 'unpublish', at: '2026-07-28T10:00:00.000Z' });
    // …and something put it back without recording itself. The row is live again.

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(1);
    db.close();
  });
});

// ── ADMIN_READY_OVERRIDE_RACE ────────────────────────────────────────────────────
describe('ADMIN_READY_OVERRIDE_RACE — an admin makes the home ready before delivery', () => {
  it('refuses to retract a home that is publish-ready at delivery', async () => {
    // Producer judged it on 'Build Pad'. An admin then overrides the stage to a ready one,
    // which is exactly how a human says "show this home".
    const db = seedDrifted({ stage: 'Build Pad', override: 'Buyer Sign Off' });
    const machineFlip = seedIngestPublish(db, QMI_ID);

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(1);
    expect(unpublishAudits(db)).toBe(0);
    db.close();
  });

  it('refuses when the CLOCK alone made the home ready, with the values unchanged', async () => {
    // The one case the compare-and-set structurally cannot see. isPublishReady is
    // `moveIn <= today + 120 days`, so a home beyond the horizon drifts INTO readiness as
    // time passes — no column changes, so every value predicate still matches. The
    // producer judged this unready when the date was further out than the horizon; by
    // delivery it is inside it. Only re-running the readiness rule at delivery refuses it,
    // which is why that check is not merely a nicer log line.
    const moveIn = addDays(todayIsoDate(), 60); // comfortably inside the 120-day horizon
    const db = seedDrifted({ stage: 'Build Pad', moveIn });
    const machineFlip = seedIngestPublish(db, QMI_ID);

    await applyMessage(
      { DB: d1(db) } as unknown as ConsumerEnv,
      retract(machineFlip, { stage: 'Build Pad', moveIn })
    );

    expect(publishedOf(db)).toBe(1);
    expect(unpublishAudits(db)).toBe(0);
    db.close();
  });

  it('refuses when the effective stage moved to another UNREADY value', async () => {
    // Readiness alone is not the test — the row must still hold what was judged. A stage
    // that moved 'Build Pad' → 'EPO Review Meeting' is still unready, but it is a
    // different decision than the one this intent carries, so the CAS must refuse it and
    // let the next run re-decide on current data.
    const db = seedDrifted({ stage: 'EPO Review Meeting' });
    const machineFlip = seedIngestPublish(db, QMI_ID);

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(1);
    expect(unpublishAudits(db)).toBe(0);
    db.close();
  });
});

// ── The same two races, but landing INSIDE the write window ──────────────────────
// The tests above stage their interference BEFORE delivery, so the consumer's reads see
// it and return early. That leaves the compare-and-set itself unproven: mutation-testing
// retractCas showed every test above still passing with the state predicate disabled,
// because the TypeScript re-check was doing the work.
//
// Which is the whole lesson of rounds 2 and 3 — a check in a preceding READ cannot close
// a window that opens after it. So these two drive the change at batch time, i.e. after
// every read the retraction path made, exactly as SEQ_BUMP_AFTER_READ does for publish.
// Only a predicate on the mutating statement can refuse them.
describe('the retraction re-decides INSIDE the write, not just before it', () => {
  /** Run the change at batch submission — after every read, before the write commits. */
  const racingDb = (db: Database.Database, duringWrite: () => void) => {
    const base = d1(db);
    return {
      prepare: base.prepare.bind(base),
      async batch(statements: unknown[]) {
        duringWrite();
        return base.batch(statements);
      },
    } as unknown as ConsumerEnv['DB'];
  };

  it('refuses when an admin makes the home ready between the read and the write', async () => {
    const db = seedDrifted();
    const machineFlip = seedIngestPublish(db, QMI_ID);
    const DB = racingDb(db, () => {
      db.prepare(`UPDATE qmi SET override_construction_stage = 'Buyer Sign Off' WHERE id = ?`).run(QMI_ID);
    });

    await applyMessage({ DB } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(1);
    expect(unpublishAudits(db)).toBe(0); // and no audit row for a retraction that did not happen
    db.close();
  });

  it('refuses when a human republishes between the read and the write', async () => {
    const db = seedDrifted();
    const machineFlip = seedIngestPublish(db, QMI_ID);
    const DB = racingDb(db, () => {
      seedPublishAudit(db, QMI_ID, { actor: HUMAN, action: 'publish', at: '2026-07-28T11:00:00.000Z' });
    });

    await applyMessage({ DB } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(1);
    expect(unpublishAudits(db)).toBe(0);
    db.close();
  });
});

// ── The happy path and the fail-closed paths ─────────────────────────────────────
describe('drift retraction — applies only with state AND ownership intact', () => {
  it('retracts, and attributes the retraction to ingest', async () => {
    const db = seedDrifted();
    const machineFlip = seedIngestPublish(db, QMI_ID);

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(0);
    const row = db
      .prepare(
        `SELECT actor, action, old_value, new_value FROM audit_log
          WHERE entity_id = ? AND action = 'unpublish'`
      )
      .get(QMI_ID) as Record<string, string>;
    expect(row).toEqual({ actor: INGEST_ACTOR, action: 'unpublish', old_value: '1', new_value: '0' });
    db.close();
  });

  it('refuses a stale retraction from an older run', async () => {
    const db = seedDrifted();
    const machineFlip = seedIngestPublish(db, QMI_ID);
    setRunSeq(db, RUN + 1); // a newer run has started

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(1);
    db.close();
  });

  it('refuses a legacy intent carrying no expected state or publish audit id', async () => {
    // A pre-round-4 drift message in flight across the deploy. It must NOT fall back to an
    // unconditional flip — that unguarded write is the bug this file exists for.
    const db = seedDrifted();
    seedIngestPublish(db, QMI_ID);
    const legacy = { kind: 'qmi.retract', snowflakeKey: KEY, qmiId: QMI_ID, runSeq: RUN };

    await applyMessage(
      { DB: d1(db) } as unknown as ConsumerEnv,
      legacy as unknown as Parameters<typeof applyMessage>[1]
    );

    expect(publishedOf(db)).toBe(1);
    expect(unpublishAudits(db)).toBe(0);
    db.close();
  });

  it('refuses when the flip it names is not the newest publish on the home', async () => {
    // Pointing at an OLD ingest flip when a newer one exists means the intent was decided
    // against superseded history. Exact identity, not "an ingest row exists somewhere".
    const db = seedDrifted();
    const old = seedIngestPublish(db, QMI_ID, '2026-07-20T00:00:00.000Z');
    seedPublishAudit(db, QMI_ID, { actor: INGEST_ACTOR, action: 'unpublish', at: '2026-07-21T00:00:00.000Z' });
    seedIngestPublish(db, QMI_ID, '2026-07-22T00:00:00.000Z');

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(old));

    expect(publishedOf(db)).toBe(1);
    db.close();
  });

  it('is a no-op on a home that is already down', async () => {
    const db = seedDrifted();
    const machineFlip = seedIngestPublish(db, QMI_ID);
    db.prepare(`UPDATE qmi SET published = 0 WHERE id = ?`).run(QMI_ID);

    await applyMessage({ DB: d1(db) } as unknown as ConsumerEnv, retract(machineFlip));

    expect(publishedOf(db)).toBe(0);
    expect(unpublishAudits(db)).toBe(0); // no audit row for a flip that did not happen
    db.close();
  });
});

// ── Producer side ────────────────────────────────────────────────────────────────
describe('the producer emits a retraction only when it can prove what it is undoing', () => {
  const sfRow = (stage: string) =>
    ({
      eciKey: KEY,
      houseNumber: '2133',
      communityName: 'Palo Alto Groves',
      address: '2133 Sand Lane',
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
      ...over,
    }) as ExistingQmi;

  const lookups = (): Lookups => ({
    cityByName: new Map(),
    communityByName: new Map(),
    floorPlanByName: new Map(),
    validCities: new Set(),
    validCommunities: new Set(),
    validFloorPlans: new Set(),
  });

  const run = (row: ExistingQmi) =>
    diff([sfRow('Build Pad')], [], [row], lookups(), [], [], [], new Map(), false, '2026-07-28', RUN);

  it('reports rather than retracts when the publish flip id is missing', () => {
    // machine_published = 1 implies the flip exists, but without its id the consumer has
    // nothing to compare against — so fall through to report-only rather than emit an
    // intent that cannot prove ownership at delivery.
    const { messages, stats } = run(live({ machine_published: 1, machine_publish_audit_id: null }));

    expect(messages.find((m) => m.kind === 'qmi.retract')).toBeUndefined();
    expect(stats.qmisDriftUnpublished).toBe(0);
    expect(stats.qmisPublishedDrifted).toBe(1);
    expect(stats.driftedPublishedIds).toEqual([QMI_ID]);
  });

  it('carries the judged values and the flip id when it can', () => {
    const { messages } = run(live({ machine_published: 1, machine_publish_audit_id: 991 }));

    const m = messages.find((x) => x.kind === 'qmi.retract');
    expect(m).toBeDefined();
    expect(m!.kind === 'qmi.retract' && m!.publishAuditId).toBe(991);
    expect(m!.kind === 'qmi.retract' && m!.expect).toEqual({ stage: 'Build Pad', moveIn: null });
    expect(m!.kind === 'qmi.retract' && m!.runSeq).toBe(RUN);
  });
});
