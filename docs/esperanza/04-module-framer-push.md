# 04 — Module: framer-push (D1 → Framer)

**Worker:** `esperanza-framer-push` · **Package:** `packages/framer-push`

This worker copies D1 rows into the **Framer CMS** so they appear on the public site. It's
the trickiest module because of how Framer's "managed collection" field types interact with
what we send. **Read the field-type section carefully — it's the source of most "my change
didn't show up / a whole collection stopped updating" incidents.**

---

## What Framer is, here

The public website is built in **Framer**. Framer has a built-in CMS with "collections"
(one per content type) and "items" (rows). Our Framer project is **managed by API** —
framer-push owns the schema and the data. The project id is **`t47CBg6stJkC8hsPgamo`**.

Because the collections are **API-managed**, you **cannot change a field's type by hand in
the Framer UI** — you must do it through this worker's `/schema` endpoint (below).

---

## Three ways it runs

| Path | Trigger | Use |
|---|---|---|
| **Queue consumer** (primary) | drains `esperanza-framer-queue` | every admin write + ingest change enqueues `{collection, action, id}`; consumer re-reads the full row from D1 and upserts it into Framer. Fast, low-latency. |
| **Cron backstop** | `0 9 * * *` daily | re-push anything `updated_at` within ~25h (`CRON_LOOKBACK_MINUTES=1500`). Catches missed events. Idempotent. |
| **HTTP endpoints** (manual) | you, with curl | backfill a whole collection, or re-type fields. See below. |

For upserts the consumer re-reads the **full** row by id (the message only carries the id),
so it's idempotent. Unpublished rows are pushed with `draft:true` (hidden, not deleted);
rows missing from D1 are removed from Framer. `publish()` + `deploy()` run **once per
batch**, not per item.

---

## ★ The #1 rule: code changes need a backfill

Deploying a mapping change to this worker does **not** update the live site on its own. The
new mapper only runs when something triggers a push. After you deploy a mapping/field
change, you almost always must run a manual **backfill** to re-push existing rows:

```bash
# Re-push specific collections after a deploy:
curl -X POST "https://<framer-push-worker-url>/backfill?keys=qmi,communities" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN"
```

The nightly cron only looks back 25h, so it won't re-push older rows that didn't change.

---

## The HTTP endpoints

All require `Authorization: Bearer $WEBHOOK_TOKEN` and are POST-only.

### `POST /backfill?keys=<collection>[,<collection>]`
Reads **all** rows of each collection from D1, dedupes slugs, chunks (50 at a time),
upserts to Framer, removes orphaned Framer items with no D1 match, then publishes &
deploys. `keys` defaults to all nine. Valid keys: `floor_plans`, `qmi`, `communities`,
`collections`, `images`, `blogs`, `promotions`, `cities`, `testimonials`.

```bash
curl -X POST "https://<worker>/backfill?keys=qmi" -H "Authorization: Bearer $WEBHOOK_TOKEN"
```

> ⚠️ **Large collections need a longer client timeout.** QMI is ~350 rows and can take
> minutes. A default curl times out around 150s and you'll see "Connection closed" with the
> worker still finishing. Use `--max-time 500`. **Don't trust the curl exit code** — verify
> in `sync_log` (below). A dropped connection with 0 reported rows is usually harmless.

### `POST /schema`
Re-types existing Framer fields (or creates missing ones), then re-pushes the collection so
values repopulate in the new type. This is the **only** way to change a Framer field type.

```bash
curl -X POST "https://<worker>/schema" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" -H "Content-Type: application/json" \
  -d '{"collection":"qmi","fields":[{"key":"move_in_date","framer_type":"string","label":"Move-In Date"}]}'
```

### `POST /cron`  — run the nightly lookback now.
### `POST /<collection>`  — webhook receiver / targeted enqueue (e.g. `/qmi`); add `?sync=true` to push synchronously instead of enqueueing.

---

## How a D1 row becomes a Framer item

**Files:** `src/collections.ts` (per-collection SQL + `map()`), `src/type-overrides.ts`
(type coercion), `src/consumer.ts` (`buildItem` orchestration).

1. Each collection has a SQL projection that selects the columns it needs (resolving
   `COALESCE(override_*, synced_*)` and aliasing to friendly names).
2. The collection's `map(row)` reads those columns and emits a `fieldData` object keyed by
   the **Framer field id** (snake_case, by convention), each value wrapped with its type:
   `str(...)`, `num(...)`, `linkIf(...)`, image, `formattedText`, etc.
3. `applyTypeOverrides` (next section) re-wraps any value whose type must be coerced to
   match the live Framer field.
4. The consumer upserts the item (keyed by record id).

Example (floor plans):
```
SQL:    COALESCE(override_bedroom_min, synced_bedroom_min) AS bedroom_min
map():  bedroom_count_minimum: nIf(row['bedroom_min'])
emits:  { bedroom_count_minimum: { type:'number', value:3 } }
        → the Framer field id must be exactly 'bedroom_count_minimum'
```

---

## ★★ Field types must match, or the batch aborts

This is the concept that bites everyone.

- A Framer managed field has a **type** (string, number, boolean, image, link,
  formattedText, date, enum, array, …).
- We track the intended type for each field in the **`field_definitions.framer_type`**
  column. `applyTypeOverrides` coerces the mapper's output to that type.
- **If what we send does not match the field's actual type in Framer, the
  `addItems`/upsert call throws "InvalidValue" and ABORTS THE ENTIRE COLLECTION BATCH** —
  not just that one field, not just that one item. The error message names the *item*, not
  the offending field, which makes it confusing.

So the invariant is: **`field_definitions.framer_type` (D1) and the live Framer field type
must stay in sync.** To change a field's type you must:
1. Update (reseed) the `field_definitions.framer_type` value in D1 **first**, then
2. Call `POST /schema` to re-type the live Framer field and re-push.

Doing only one of the two leaves them mismatched and the next push aborts that collection.

`applyTypeOverrides` coercion rules (roughly): string/date/enum ← any non-empty scalar;
number ← finite numeric (else dropped); boolean ← true/false/1/0/yes/no (else dropped);
link/image ← a valid absolute `http(s)` URL (else dropped); array ← passthrough only. A
value that can't be coerced is **dropped** (the field is omitted) rather than aborting.

---

## ★ The merge gotcha (clearing a field)

`addItems` **merges** — fields you omit keep their previous Framer value. So if marketing
**clears** a field in the admin and the mapper simply omits the now-empty value, Framer
keeps the **stale** old value (it looks like the field "repopulated itself"). This is not a
D1 bug.

The fix already in place: to clear a field, the mapper must emit an **empty string**
(`str('')`) rather than omitting it — an explicit empty value propagates the clear. Keep
this in mind when writing new mappers: send complete `fieldData`, and emit `str('')` for
fields that should be clearable.

---

## ★ Verify with `sync_log`, not curl

Pushes happen asynchronously on the queue, so an HTTP 200 only means "accepted/enqueued,"
not "done." The truth is in the **`sync_log`** table (one row per batch, `source='framer'`):

```bash
npx wrangler d1 execute esperanza --remote --command \
  "SELECT started_at, status, notes, error_message FROM sync_log WHERE source='framer' ORDER BY started_at DESC LIMIT 10;"
```

- `status='success'` and `notes` shows expected counts (e.g. `qmi:+3/-0`) → good.
- A `deploy=deploy_…` token in `notes` means publish/deploy succeeded.
- `status='partial'`/`'error'` → read `error_message`; check the field-type rules above.

There is no per-record "did this one item push" query — only batch rows. To confirm a
specific item reached Framer, check the item in the Framer CMS (or via the unframer
tooling), not the HTTP response.

---

## Bindings & secrets (`wrangler.toml`)

| Binding/secret | Value | Purpose |
|---|---|---|
| `DB` | D1 `esperanza` | read rows to push |
| `FRAMER_QUEUE` (producer + consumer) | `esperanza-framer-queue` (DLQ `…-dlq`) | the push queue (batch 5, 5 retries) |
| `FRAMER_API_KEY` (secret) | Framer Token | auth to the Framer API |
| `FRAMER_PROJECT_URL` (secret) | `https://framer.com/projects/Esperanza-Homes--t47CBg6stJkC8hsPgamo-…` | which project (id = slug after `--`) |
| `WEBHOOK_TOKEN` (secret) | bearer | guards `/backfill`, `/schema`, `/cron`, `/<collection>` |
| `CRON_LOOKBACK_MINUTES` (var) | `1500` | nightly backstop window |

---

## Files you'd edit

| Goal | File |
|---|---|
| Add/change a field on a collection | `src/collections.ts` (SQL projection + `map()`), then `POST /schema` to create the Framer field, then `POST /backfill` |
| Change type coercion | `src/type-overrides.ts` |
| Change consumer/upsert/publish behavior | `src/consumer.ts` |
| Low-level Framer API calls | `src/framer.ts` |
| Schedule / lookback / bindings | `wrangler.toml` |

**Recipe — add a new field that shows on the site:**
1. Add the column + override/synced pair (if applicable) in `packages/db`; migrate.
2. Seed the admin field (`field_definitions` row) so marketing can edit it (doc 03).
3. Add it to the SQL + `map()` in `src/collections.ts`; set `framer_type` in
   `field_definitions`.
4. Deploy framer-push (merge to master).
5. `POST /schema` to create/re-type the Framer field (reseed D1 `framer_type` first).
6. `POST /backfill?keys=<collection>` to push existing rows.
7. Verify in `sync_log` and in the Framer CMS. Then bind the field on the Framer page
   (a Framer-UI / operator step).

---
**Next:** [05 — Module: PDF Generator](./05-module-pdf.md)
