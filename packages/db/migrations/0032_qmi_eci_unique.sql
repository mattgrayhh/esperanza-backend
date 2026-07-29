-- =============================================================================
-- 0032_qmi_eci_unique — one D1 QMI row per Snowflake DM_HOUSE natural key.
--
-- Four published ECI keys were duplicated by concurrent qmi.upsert deliveries on
-- 2026-07-27 (and one older unpublished key is also duplicated). Each pair shares
-- one public slug, so one published home was invisible. Keep the most recently
-- synced row deterministically; repoint durable history/render metadata; remove
-- the older copies; then make recurrence impossible at the database boundary.
--
-- D1 applies one migration transactionally. Cleanup and constraint therefore
-- cannot race the four-hour ingest: either all of this commits, or none of it does.
-- =============================================================================

-- Preserve history keyed to retired row ids. updated_at reflects the last ingest
-- state; created_at and id are deterministic tie-breaks.
UPDATE audit_log
   SET entity_id = (
     SELECT keeper.id
       FROM qmi keeper
      WHERE keeper.eci_key = (SELECT loser.eci_key FROM qmi loser WHERE loser.id = audit_log.entity_id)
      ORDER BY keeper.updated_at DESC, keeper.created_at DESC, keeper.id DESC
      LIMIT 1
   )
 WHERE entity = 'qmi'
   AND entity_id IN (
     SELECT loser.id
       FROM qmi loser
      WHERE loser.eci_key IS NOT NULL AND trim(loser.eci_key) <> ''
        AND loser.id <> (
          SELECT keeper.id FROM qmi keeper
           WHERE keeper.eci_key = loser.eci_key
           ORDER BY keeper.updated_at DESC, keeper.created_at DESC, keeper.id DESC
           LIMIT 1
        )
   );

-- A QMI normally has one render row keyed by slug. Repoint it to the chosen row.
UPDATE pdf_renders
   SET entity_id = (
     SELECT keeper.id
       FROM qmi keeper
      WHERE keeper.eci_key = (SELECT loser.eci_key FROM qmi loser WHERE loser.id = pdf_renders.entity_id)
      ORDER BY keeper.updated_at DESC, keeper.created_at DESC, keeper.id DESC
      LIMIT 1
   )
 WHERE type = 'qmi'
   AND entity_id IN (
     SELECT loser.id
       FROM qmi loser
      WHERE loser.eci_key IS NOT NULL AND trim(loser.eci_key) <> ''
        AND loser.id <> (
          SELECT keeper.id FROM qmi keeper
           WHERE keeper.eci_key = loser.eci_key
           ORDER BY keeper.updated_at DESC, keeper.created_at DESC, keeper.id DESC
           LIMIT 1
        )
   );

DELETE FROM qmi
 WHERE eci_key IS NOT NULL AND trim(eci_key) <> ''
   AND id <> (
     SELECT keeper.id FROM qmi keeper
      WHERE keeper.eci_key = qmi.eci_key
      ORDER BY keeper.updated_at DESC, keeper.created_at DESC, keeper.id DESC
      LIMIT 1
   );

DROP INDEX idx_qmi_eci_key;
CREATE UNIQUE INDEX idx_qmi_eci_key ON qmi(eci_key);
