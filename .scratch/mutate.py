#!/usr/bin/env python3
"""Apply one precise source mutation, so a guard can be disabled WITHOUT breaking the
SQL or changing bind arity. A mutation that breaks syntax makes tests fail for the wrong
reason and proves nothing about whether the tests can catch the guard's absence."""
import subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MUTATIONS = {
    # Ownership: the flip-identity predicate always true (1 bind kept).
    "ownership-identity": (
        "packages/ingest/src/consumer.ts",
        """ AND (SELECT a.id FROM audit_log a
               WHERE a.entity = 'qmi' AND a.entity_id = qmi.id
                 AND a.field = 'published' AND a.action = 'publish'
               ORDER BY a.id DESC LIMIT 1) = ?`""",
        """ AND ? IS NOT NULL`""",
    ),
    # Ownership: the "someone else touched it since" predicate always true (2 binds kept).
    "ownership-newer-toucher": (
        "packages/ingest/src/consumer.ts",
        """ AND NOT EXISTS (SELECT 1 FROM audit_log a
                          WHERE a.entity = 'qmi' AND a.entity_id = qmi.id
                            AND a.field = 'published' AND a.id > ? AND a.actor <> ?)`""",
        """ AND ? IS NOT NULL AND ? IS NOT NULL`""",
    ),
    # State: the effective stage/date equality always true (2 binds kept).
    "state-cas": (
        "packages/ingest/src/consumer.ts",
        """ AND COALESCE(NULLIF(TRIM(override_construction_stage), ''), NULLIF(TRIM(synced_construction_stage), '')) IS ?` +
      ` AND COALESCE(NULLIF(TRIM(override_move_in_date), ''), NULLIF(TRIM(synced_move_in_date), '')) IS ?` +
      ` AND (SELECT a.id FROM audit_log a""",
        """ AND (? IS NULL OR 1 = 1)` +
      ` AND (? IS NULL OR 1 = 1)` +
      ` AND (SELECT a.id FROM audit_log a""",
    ),
    # The self-interference claim: drop the action filter from the ownership subquery, so
    # it also sees the retraction's OWN audit insert.
    "action-filter": (
        "packages/ingest/src/consumer.ts",
        """                 AND a.field = 'published' AND a.action = 'publish'
               ORDER BY a.id DESC LIMIT 1) = ?`""",
        """                 AND a.field = 'published'
               ORDER BY a.id DESC LIMIT 1) = ?`""",
    ),
    # The TypeScript readiness re-check (is it redundant against the CAS?).
    "ts-readiness-recheck": (
        "packages/ingest/src/consumer.ts",
        "  if (isPublishReady(stage, moveIn)) {",
        "  if (false && isPublishReady(stage, moveIn)) {",
    ),
    # Fail-closed on a legacy intent with no expect/publishAuditId.
    "fail-closed-legacy": (
        "packages/ingest/src/consumer.ts",
        "  if (!msg.expect || !Number.isFinite(Number(msg.publishAuditId))) {",
        "  if (false) {",
    ),
}

name = sys.argv[1]
rel, old, new = MUTATIONS[name]
p = ROOT / rel
src = p.read_text()
if src.count(old) != 1:
    print(f"MUTATION {name}: anchor matched {src.count(old)} times — aborting")
    sys.exit(2)
p.write_text(src.replace(old, new))

r = subprocess.run(
    ["npx", "vitest", "run", "test/drift-retraction-round4.test.ts", "test/publish-freshness-round3.test.ts"],
    cwd=ROOT / "packages/ingest", capture_output=True, text=True,
)
line = [l.strip() for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith("Tests ")]
subprocess.run(["git", "checkout", "--", rel], cwd=ROOT, check=True)
print(f"{name:26} {line[-1] if line else 'NO RESULT (mutation broke the build)'}")
