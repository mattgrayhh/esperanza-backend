// =============================================================================
// Attribution for machine publish / unpublish (incident 2026-07-28).
//
// The ingest writes sync_log; the admin's edit history reads audit_log. A sync-driven
// publish therefore left no actor and no row anywhere the admin surfaces, so when the
// auto-publish leg put ~150 homes live the marketing team saw "published, but this was
// not published by me" with no way to find out who did it.
//
// Every machine flip of `published` must now record itself in audit_log under a machine
// actor — and must NOT record anything when the guarded UPDATE was a no-op, since an
// audit row for a write that did not happen is a lie in the history.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, d1 } from './helpers.js';
import { applyMessage, INGEST_ACTOR, type ConsumerEnv } from '../src/consumer.js';

const QMI_ID = 'recAUDIT1';

function seedQmi(published: number) {
  const db = freshDb();
  db.prepare(
    `INSERT INTO qmi (id, eci_key, housenumber, synced_address, published)
     VALUES (?, '002PG00000290', '2133', '2133 Sand Lane', ?)`
  ).run(QMI_ID, published);
  return db;
}

type AuditRow = { entity: string; field: string; action: string; actor: string; old_value: string; new_value: string };
const audit = (db: ReturnType<typeof freshDb>) =>
  db.prepare(`SELECT entity, field, action, actor, old_value, new_value FROM audit_log`).all() as AuditRow[];

describe('machine publish/unpublish attribution', () => {
  it('a machine publish records an audit_log row with the machine actor', async () => {
    const db = seedQmi(0);
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    await applyMessage(env, { kind: 'qmi.publish', snowflakeKey: '002PG00000290', qmiId: QMI_ID });

    expect(db.prepare(`SELECT published FROM qmi WHERE id = ?`).get(QMI_ID)).toEqual({ published: 1 });
    expect(audit(db)).toEqual([
      {
        entity: 'qmi',
        field: 'published',
        action: 'publish',
        actor: INGEST_ACTOR,
        old_value: '0',
        new_value: '1',
      },
    ]);
    db.close();
  });

  it('a machine unpublish records an audit_log row too', async () => {
    const db = seedQmi(1);
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    await applyMessage(env, { kind: 'qmi.unpublish', snowflakeKey: '002PG00000290', qmiId: QMI_ID });

    expect(db.prepare(`SELECT published FROM qmi WHERE id = ?`).get(QMI_ID)).toEqual({ published: 0 });
    const rows = audit(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'unpublish', actor: INGEST_ACTOR, old_value: '1', new_value: '0' });
    db.close();
  });

  it('a no-op publish (already live) writes NO audit row', async () => {
    const db = seedQmi(1); // already published — the guarded UPDATE changes nothing
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    await applyMessage(env, { kind: 'qmi.publish', snowflakeKey: '002PG00000290', qmiId: QMI_ID });

    expect(audit(db)).toEqual([]);
    db.close();
  });

  it('a no-op unpublish (already hidden) writes NO audit row', async () => {
    const db = seedQmi(0);
    const env = { DB: d1(db) } as unknown as ConsumerEnv;

    await applyMessage(env, { kind: 'qmi.unpublish', snowflakeKey: '002PG00000290', qmiId: QMI_ID });

    expect(audit(db)).toEqual([]);
    db.close();
  });

  it('an audit_log failure never fails the publish itself', async () => {
    const db = seedQmi(0);
    const env = { DB: d1(db) } as unknown as ConsumerEnv;
    db.exec('DROP TABLE audit_log');

    // The publish is the real work; telemetry must not be able to undo it.
    await expect(
      applyMessage(env, { kind: 'qmi.publish', snowflakeKey: '002PG00000290', qmiId: QMI_ID })
    ).resolves.toBeDefined();
    expect(db.prepare(`SELECT published FROM qmi WHERE id = ?`).get(QMI_ID)).toEqual({ published: 1 });
    db.close();
  });
});
