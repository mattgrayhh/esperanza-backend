# Scalable Promotions — Activation Runbook (post-merge)

Run AFTER the PR merges to master and CI deploys the changed workers.

1. Apply the migration to remote D1:
   `wrangler d1 migrations apply esperanza --remote`
   (Confirms columns pdf_url + rate_override and rebuilds v_public_promotions.)

2. Reseed field_definitions on remote (surfaces the new admin fields + pins
   promotions.pdf_url → framer_type 'link'):
   `npx tsx packages/db/scripts/seed-field-definitions.ts --remote`

3. Create the Framer fields on the Promotions collection (framer-push POST /schema):
   `curl -X POST "$FRAMER_PUSH_URL/schema" -H "Authorization: Bearer $WEBHOOK_TOKEN" \
     -H 'content-type: application/json' -d '{"keys":["promotions"]}'`
   Verify the Promotions collection now has `pdf` (Link) + `rate` (string) fields.
   ⚠ The live Framer `pdf` field MUST be Link type or addItems aborts the batch.

4. Re-push all promotions:
   `curl -X POST "$FRAMER_PUSH_URL/backfill?keys=promotions" \
     -H "Authorization: Bearer $WEBHOOK_TOKEN" --max-time 300`
   Verify via sync_log (NOT the curl exit) — transient "Connection closed" with
   +0 rows is harmless; confirm a success row landed.

5. Confirm marketing has set the company-wide Incentive Rate at /settings/site
   (if incentive_rate is unset, promos with no override emit an empty rate — by design).

6. Operator (Framer canvas): bind the new `pdf` + `rate` fields on the promo card /
   relevant components. (No code change — Framer-side binding only.)
