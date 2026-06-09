'use server';

// =============================================================================
// packages/admin — Server Actions. THE ONLY WRITE PATH.
//
// Every mutation in the admin goes through one of these actions. Each one obeys the
// cross-package write contract:
//   (1) write D1 via the PRIMARY session (read-your-writes — see lib/db.ts),
//   (2) insert an audit_log row (actor = Cloudflare Access identity),
//   (3) enqueue an esperanza-framer-queue message {collection, action:'upsert', id}
//       for the changed record so framer-push re-pushes it.
//
// QMI synced-field edits route through @esperanza/db/override (buildOverrideWrite /
// buildOverrideAudit). Plain fields are written directly. The publish toggle is the
// ONLY path that may set published=1 (admin-owns-1). Promotion targets are written
// replace-all into promotion_targets honoring the global-vs-id CHECK.
//
// These are server actions: they run in the Worker, are request-scoped, and read the
// identity from Cloudflare Access headers. They never trust client-supplied actor.
// =============================================================================

import { revalidatePath } from 'next/cache';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { eq } from 'drizzle-orm';
import { and, asc } from 'drizzle-orm';
import {
  promotions,
  promotionTargets,
  cities,
  communities,
  testimonials,
  images,
  auditLog,
  fieldDefinitions,
  type FieldDefinition,
  type NewAuditLogRow,
  type NewFieldDefinition,
  type NewPromotionTarget,
} from '@esperanza/db';
import {
  buildOverrideWrite,
  buildOverrideAudit,
} from '@esperanza/db/override';
import type { PromoTargetType } from '@esperanza/db/promo';
import { affectedRenderKeys } from '@esperanza/db/pdf-invalidate';
import { ensurePdfRender } from '@esperanza/db/pdf-ensure';
import { getDb, idColumn, type Db } from './db';
import { getCurrentUser, isAdmin } from './auth';
import { getEntity, isOverrideField, asOverridableEntity, type EntityKey } from './entities';
import { columnMapForEntity, coerceForColumn, toDrizzlePatch } from './fields';
import { publishGateColumn } from './field-config';
import { statusGate, statusPatch, deriveStatus } from './status';
import { resolveCustomFieldDefs, type CustomFieldDef } from './field-config-source';
import {
  isFieldType,
  isValidKeyShape,
  generateFieldKey,
  normalizeOptions,
  reservedKeysForEntity,
  FIELD_TYPE_META,
  type FieldType,
} from './field-builder';
import { isSettableFramerType } from './framer-types';
import {
  postSchema,
  type SchemaFieldRequest,
  type SchemaFieldResult,
} from './framer-push-client';
import { chunk, AUDIT_ROWS_PER_INSERT } from './audit-chunk';

// =============================================================================
// Shared post-write step: audit_log rows + enqueue framer push.
// =============================================================================

interface AuditInput {
  entity: string;
  entityId: string;
  field: string | null;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
}

/**
 * Insert audit rows and enqueue a single Framer push for the changed record. Call
 * AFTER the D1 write committed. `collection` must be a framer-push CollectionKey
 * (== EntityKey). Idempotent enqueue: the consumer re-reads the full row by id.
 */
async function postWrite(
  db: Db,
  collection: EntityKey,
  id: string,
  audits: AuditInput[]
): Promise<void> {
  if (audits.length > 0) {
    const rows: NewAuditLogRow[] = audits.map((a) => ({
      entity: a.entity,
      entityId: a.entityId,
      field: a.field,
      action: a.action,
      oldValue: a.oldValue,
      newValue: a.newValue,
      actor: a.actor,
    }));
    // D1 caps bound params at 100/query; each audit row binds 7. A big multi-field
    // save (e.g. 19 community fields = 133 params) would exceed it and throw, so insert
    // in chunks. See lib/audit-chunk.ts.
    for (const batch of chunk(rows, AUDIT_ROWS_PER_INSERT)) {
      await db.insert(auditLog).values(batch);
    }
  }

  const env = getCloudflareContext().env;
  await env.FRAMER_QUEUE.send({ collection, action: 'upsert', id });

  // Mark affected PDF brochures stale + enqueue re-renders (best-effort, event-driven freshness).
  try {
    const d1 = env.DB as unknown as D1Database | undefined;
    if (!d1) return; // no D1 binding (e.g. unit-test mock) — nothing to invalidate
    const q = async (sql: string, binds: unknown[]) => ((await d1.prepare(sql).bind(...(binds as any[])).all()).results ?? []) as any[];
    const r = async (sql: string, binds: unknown[]) => { await d1.prepare(sql).bind(...(binds as any[])).run(); };
    const keys = await affectedRenderKeys(q, collection, id);
    // Mark stale via RETURNING so we can collect the rows to enqueue without an extra SELECT.
    const toEnqueue: { type: string; slug: string }[] = [];
    for (const k of keys) {
      const res = k.type === 'list'
        ? await d1.prepare(`UPDATE pdf_renders SET status='stale' WHERE type='list' AND city_slug=? AND status<>'rendering' RETURNING type, slug`).bind(k.citySlug).all()
        : await d1.prepare(`UPDATE pdf_renders SET status='stale' WHERE type=? AND entity_id=? AND status<>'rendering' RETURNING type, slug`).bind(k.type, k.entityId).all();
      for (const row of (res.results ?? []) as any[]) toEnqueue.push({ type: row.type, slug: row.slug });
    }
    // Idempotently register a pdf_renders row + backfill the URL for newly-created /
    // synced entities so new records self-register without a manual seed run.
    const baseUrl = (env as any).PDF_PUBLIC_BASE_URL || (env as any).IMAGES_PUBLIC_BASE_URL || '';
    if (baseUrl) {
      await ensurePdfRender(q, r, collection, id, baseUrl);
    }
    // Also pick up the entity's own row (covers a brand-new entity just inserted by ensurePdfRender).
    const own = await d1.prepare(`SELECT type, slug FROM pdf_renders WHERE entity_id=? AND status<>'rendering'`).bind(id).all();
    for (const row of (own.results ?? []) as any[]) toEnqueue.push({ type: row.type, slug: row.slug });
    // Dedupe and enqueue.
    const seen = new Set<string>();
    for (const j of toEnqueue) {
      const key = `${j.type}/${j.slug}`;
      if (seen.has(key)) continue; seen.add(key);
      try { await (env as any).RENDER_Q?.send({ type: j.type, slug: j.slug, reason: 'edit' }); } catch {}
    }
  } catch (e) {
    console.error('[pdf-invalidate]', e);
  }
}

const toStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// =============================================================================
// saveEntity — generic upsert of editable fields for one record.
//
// formData carries the editable columns. For QMI:
//   - fields in QMI_OVERRIDABLE_FIELDS  → buildOverrideWrite (blank ⇒ revert to
//     synced; non-blank ⇒ pin override) + buildOverrideAudit.
//   - all other QMI fields              → plain column write + plain audit.
// For every other entity: all submitted fields are plain admin-owned columns.
//
// `published` is IGNORED here — it has its own dedicated action (togglePublished) so
// the "admin-owns-1" invariant lives in exactly one place.
// =============================================================================

// =============================================================================
// createEntity — insert a fresh admin-created record with a generated id and return it.
// New records start unpublished/draft (the publish toggle is the only path to live).
// Audits a `create` row and enqueues the framer push (it'll push as draft until set
// live). The generated id is prefixed `adm` to distinguish admin-created rows from the
// Airtable-seeded `rec` ids; the framer upsert key is just the id, so any value works.
// =============================================================================

export async function createEntity(
  entity: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const id = `adm${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const { db } = getDb();
  const at = new Date().toISOString();

  // Re-key to Drizzle property names (Drizzle .values()/.set() are keyed by JS props,
  // not physical column names — physical keys would be silently dropped).
  await db
    .insert(def.table)
    .values(toDrizzlePatch(def.key, { id, created_at: at, updated_at: at }) as never);

  await postWrite(db, def.key, id, [
    {
      entity: def.key,
      entityId: id,
      field: null,
      action: 'create',
      oldValue: null,
      newValue: id,
      actor,
    },
  ]);

  revalidatePath(`/admin/${def.segment}`);
  return { ok: true, id };
}

export async function saveEntity(
  entity: string,
  id: string,
  formData: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };
  if (!id) return { ok: false, error: 'Missing record id' };

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const { db } = getDb();
  const colMap = columnMapForEntity(def.key);
  // The publish-gate column (published | active | status) is written ONLY by its
  // dedicated toggle action so the publish/unpublish audit invariant lives in one
  // place. Skip it here even if the form submits it.
  const gate = publishGateColumn(def.key);
  const at = new Date().toISOString();

  // Phase B: CUSTOM fields (field_definitions rows with no real column) store their VALUES
  // in the row's `custom_fields` JSON blob. Resolve the entity's custom-field defs so we
  // can route those FormData entries into custom_fields (NEVER a real column). This is
  // purely ADDITIVE — real-column write logic below is unchanged.
  const customDefs = await resolveCustomFieldDefs(def.key);
  const customByKey = new Map<string, CustomFieldDef>(customDefs.map((d) => [d.key, d]));

  // Read the current row once (on the primary session) to compute audit old-values
  // and previous override values.
  const current = (await db
    .select()
    .from(def.table)
    .where(eq(idColumn(def.table), id))
    .limit(1)) as Array<Record<string, unknown>>;
  if (current.length === 0) return { ok: false, error: `${def.label} ${id} not found` };
  const row = current[0]!;

  const patch: Record<string, unknown> = {};
  const audits: AuditInput[] = [];

  // Accumulate custom-field writes, then merge into custom_fields once after the loop.
  // Drizzle's bare select() keys the row by the JS property (camelCase `customFields`);
  // read that first, falling back to the physical snake_case key.
  const existingCustom = parseCustomFieldsBlob(row['customFields'] ?? row['custom_fields']);
  const nextCustom: Record<string, unknown> = { ...existingCustom };
  const customAudits: AuditInput[] = [];
  let customChanged = false;

  for (const [field, rawValue] of formData.entries()) {
    // FormData values can be File (handled by uploadImage, not here) — skip.
    if (typeof rawValue !== 'string') continue;
    // The publish gate (published/active/status) has its own action; never set it here.
    if (field === 'published' || (gate && field === gate)) continue;

    // --- CUSTOM field (custom_fields-backed): merge into the JSON blob, not a column ---
    const customDef = customByKey.get(field);
    if (customDef) {
      // Reject expiring Airtable attachment URLs in custom values too (Decision-log #9).
      if (rawValue.includes('airtableusercontent.com')) {
        return { ok: false, error: `Refusing to store an Airtable attachment URL in ${field}` };
      }
      const coerced = coerceCustomValue(customDef.type, rawValue);
      const oldValue = existingCustom[field];
      if (toStr(oldValue) === toStr(coerced)) continue; // no-op
      if (coerced === null) {
        delete nextCustom[field]; // blank clears the key
      } else {
        nextCustom[field] = coerced;
      }
      customChanged = true;
      customAudits.push({
        entity: def.key,
        entityId: id,
        field,
        action: 'update',
        oldValue: toStr(oldValue),
        newValue: toStr(coerced),
        actor,
      });
      continue;
    }

    // Only accept fields we know how to map to a column.
    const col = colMap[field];

    // --- synced write-sets (qmi / communities / floor_plans): route through override.ts ---
    const overridableEntity = asOverridableEntity(def.key);
    if (overridableEntity && isOverrideField(def.key, field)) {
      const ofield = field;
      const value = rawValue === '' ? null : coerceForColumn(def.key, ofield, rawValue);
      const prevOverride = row[`override_${ofield}`];
      const writePatch = buildOverrideWrite(ofield, value, { actor, at });
      Object.assign(patch, writePatch);
      const auditRow = buildOverrideAudit(id, ofield, prevOverride, value, { actor, at }, overridableEntity);
      audits.push({
        entity: auditRow.entity,
        entityId: auditRow.entity_id,
        field: auditRow.field,
        action: auditRow.action,
        oldValue: auditRow.old_value,
        newValue: auditRow.new_value,
        actor: auditRow.actor,
      });
      continue;
    }

    // --- plain admin-owned column ---
    if (!col) continue; // unknown / non-editable field — ignore
    // Never persist an expiring Airtable attachment URL (Decision-log #9). Image
    // fields store STABLE R2 urls only; reject the airtable host on save.
    if (typeof rawValue === 'string' && rawValue.includes('airtableusercontent.com')) {
      return { ok: false, error: `Refusing to store an Airtable attachment URL in ${field}` };
    }
    const coerced = rawValue === '' ? null : coerceForColumn(def.key, field, rawValue);
    const oldValue = row[col.column];
    // Skip no-op writes so we don't spam audit_log.
    if (toStr(oldValue) === toStr(coerced)) continue;
    patch[col.column] = coerced;
    audits.push({
      entity: def.key,
      entityId: id,
      field,
      action: 'update',
      oldValue: toStr(oldValue),
      newValue: toStr(coerced),
      actor,
    });
  }

  // Fold the merged custom_fields blob into the SAME patch when any custom field changed,
  // so real-column and custom-field edits commit in one UPDATE. `custom_fields` is a real
  // (additive) column, so it re-keys through toDrizzlePatch like any other column.
  if (customChanged) {
    patch['custom_fields'] = JSON.stringify(nextCustom);
    audits.push(...customAudits);
  }

  if (Object.keys(patch).length === 0) {
    return { ok: true }; // nothing changed
  }

  patch['updated_at'] = at;

  // `patch` is keyed by PHYSICAL column names (col.column, override.ts's override_<f>,
  // custom_fields, updated_at). Drizzle .set() is keyed by JS property names — re-key or
  // every key is silently dropped (→ empty SET → invalid SQL). See lib/fields.toDrizzlePatch.
  await db
    .update(def.table)
    .set(toDrizzlePatch(def.key, patch) as never)
    .where(eq(idColumn(def.table), id));

  await postWrite(db, def.key, id, audits);

  revalidatePath(`/admin/${def.segment}/${id}`);
  revalidatePath(`/admin/${def.segment}`);
  return { ok: true };
}

// =============================================================================
// matchAndRenderQmi — assign a floor plan (+ optional synced-field overrides) to an
// unmatched draft and kick off the brochure PDF render. Reuses saveEntity for the
// write, so floor_plan_id routes through buildOverrideWrite, gets audited, enqueues
// the Framer push, and (via postWrite) ensures the pdf_renders row + enqueues a render
// — all unchanged. Then it flags that render 'pending' so the UI shows in-flight
// status. It does NOT publish; that stays the dedicated togglePublished step.
// =============================================================================
export async function matchAndRenderQmi(
  qmiId: string,
  input: { floorPlanId: string; overrides?: Record<string, string> }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!qmiId) return { ok: false, error: 'Missing record id' };
  if (!input.floorPlanId || input.floorPlanId.trim() === '') {
    return { ok: false, error: 'Choose a floor plan first' };
  }

  const fd = new FormData();
  fd.set('floor_plan_id', input.floorPlanId);
  for (const [k, v] of Object.entries(input.overrides ?? {})) {
    fd.set(k, v);
  }

  const res = await saveEntity('qmi', qmiId, fd);
  if (!res.ok) return res;

  // postWrite already ensured the pdf_renders row and enqueued a render. Flag it
  // 'pending' so the UI reflects an in-flight render (the PDF worker moves it to
  // 'rendering' then 'live'; in environments without RENDER_Q it simply stays
  // 'pending' rather than erroring).
  try {
    const d1 = getCloudflareContext().env.DB as unknown as D1Database | undefined;
    await d1
      ?.prepare(
        `UPDATE pdf_renders SET status='pending' WHERE type='qmi' AND entity_id=? AND status NOT IN ('rendering','live')`
      )
      .bind(qmiId)
      .run();
  } catch (e) {
    console.error('[matchAndRenderQmi:pending]', e);
  }

  revalidatePath('/qmi/new');
  revalidatePath('/qmi');
  return { ok: true };
}

// Read-only: poll a QMI's brochure render status (drives the "Pending → link" UI on the
// match page). Returns the pdf_renders status and the stable dynamic_pdf URL.
export async function getQmiRenderStatus(
  qmiId: string
): Promise<{ status: string | null; url: string | null }> {
  try {
    const d1 = getCloudflareContext().env.DB as unknown as D1Database | undefined;
    if (!d1) return { status: null, url: null };
    const pr = (await d1
      .prepare(`SELECT status FROM pdf_renders WHERE type='qmi' AND entity_id=? LIMIT 1`)
      .bind(qmiId)
      .first()) as { status: string | null } | null;
    const q = (await d1
      .prepare(`SELECT dynamic_pdf AS url FROM qmi WHERE id=? LIMIT 1`)
      .bind(qmiId)
      .first()) as { url: string | null } | null;
    return { status: pr?.status ?? null, url: q?.url ?? null };
  } catch {
    return { status: null, url: null };
  }
}

// =============================================================================
// Custom-field (custom_fields JSON) value helpers for saveEntity.
//
//   parseCustomFieldsBlob — read the row's custom_fields TEXT into a flat object (tolerant
//                           of NULL/blank/malformed → {}). The merge preserves keys for
//                           fields NOT present in this submit (other custom fields, or
//                           values written by a future builder UI), so a partial save can
//                           never wipe sibling custom values.
//   coerceCustomValue     — coerce a submitted string to the JS type its field-builder type
//                           implies (number/currency → number, bool → '1'/'0'/'true' →
//                           boolean, else string). Blank → null (the key is removed).
// =============================================================================

function parseCustomFieldsBlob(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || v.trim() === '') return {};
  try {
    const o = JSON.parse(v);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    return o as Record<string, unknown>;
  } catch {
    return {};
  }
}

function coerceCustomValue(type: string, raw: string): unknown {
  if (raw === '') return null;
  switch (type) {
    case 'number':
    case 'currency': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'on';
    default:
      return raw;
  }
}

// =============================================================================
// togglePublished — the ONLY path that sets published=1 (admin-owns-1).
//
// ingest force-0 on sold is enforced elsewhere (and tested). Here the admin may set
// 0 or 1. Only entities with a publish gate are accepted.
// =============================================================================

export async function togglePublished(
  entity: string,
  id: string,
  value: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };
  if (!def.publishable) return { ok: false, error: `${def.label} has no publish gate` };

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const { db } = getDb();
  const at = new Date().toISOString();

  const current = (await db
    .select()
    .from(def.table)
    .where(eq(idColumn(def.table), id))
    .limit(1)) as Array<Record<string, unknown>>;
  if (current.length === 0) return { ok: false, error: `${def.label} ${id} not found` };
  const wasPublished = Boolean(current[0]!['published']);

  await db
    .update(def.table)
    .set(toDrizzlePatch(def.key, { published: value, updated_at: at }) as never)
    .where(eq(idColumn(def.table), id));

  await postWrite(db, def.key, id, [
    {
      entity: def.key,
      entityId: id,
      field: 'published',
      action: value ? 'publish' : 'unpublish',
      oldValue: wasPublished ? '1' : '0',
      newValue: value ? '1' : '0',
      actor,
    },
  ]);

  revalidatePath(`/admin/${def.segment}/${id}`);
  revalidatePath(`/admin/${def.segment}`);
  return { ok: true };
}

// =============================================================================
// toggleActive — promotions' publish gate. Migration 0005 RENAMED the gate column
// `active` → `published` (uniform with every other entity); this writes that column.
// Kept as a distinct entry point for backward compatibility with the promotions
// toggle wiring; published=false → framer draft:true. Same audit contract as
// togglePublished.
// =============================================================================

export async function toggleActive(
  id: string,
  value: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: 'Missing promotion id' };
  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const { db } = getDb();
  const at = new Date().toISOString();
  const current = await db.select().from(promotions).where(eq(promotions.id, id)).limit(1);
  if (current.length === 0) return { ok: false, error: `Promotion ${id} not found` };
  const wasActive = Boolean((current[0]! as Record<string, unknown>)['published']);

  await db.update(promotions).set({ published: value, updatedAt: at }).where(eq(promotions.id, id));

  await postWrite(db, 'promotions', id, [
    {
      entity: 'promotions',
      entityId: id,
      field: 'published',
      action: value ? 'publish' : 'unpublish',
      oldValue: wasActive ? '1' : '0',
      newValue: value ? '1' : '0',
      actor,
    },
  ]);

  revalidatePath(`/admin/promotions/${id}`);
  revalidatePath(`/admin/promotions`);
  return { ok: true };
}

// =============================================================================
// setStatus — generic tri-state publish gate (feedback [16][17][27][41][45]). Maps a
// chosen status to the underlying columns per entity (see lib/status.ts):
//   location (qmi/communities/floor_plans): Draft/Coming Soon/Live → published+coming_soon
//   blog: Draft/Published → published (Scheduled is derived from publish_date)
//   promotion: Draft/Live → active   ·   testimonial: status text column
// Going to anything other than Draft is the 'publish' audit action.
// =============================================================================
export async function setStatus(
  entity: string,
  id: string,
  status: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };
  const gate = statusGate(def.key);
  if (!gate) return { ok: false, error: `${def.label} has no status gate` };

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const { db } = getDb();
  const at = new Date().toISOString();
  const current = (await db
    .select()
    .from(def.table)
    .where(eq(idColumn(def.table), id))
    .limit(1)) as Array<Record<string, unknown>>;
  if (current.length === 0) return { ok: false, error: `${def.label} ${id} not found` };
  const row = current[0]!;
  const oldStatus = deriveStatus(gate, {
    published: Boolean(row['published']),
    comingSoon: Boolean(row['comingSoon']),
    status: toStr(row['status']),
    publishDate: toStr(row['publishDate']) || null,
    now: at,
  });

  await db
    .update(def.table)
    .set(toDrizzlePatch(def.key, { ...statusPatch(gate, status), updated_at: at }) as never)
    .where(eq(idColumn(def.table), id));

  await postWrite(db, def.key, id, [
    {
      entity: def.key,
      entityId: id,
      field: 'status',
      action: status === 'Draft' ? 'unpublish' : 'publish',
      oldValue: oldStatus,
      newValue: status,
      actor,
    },
  ]);

  revalidatePath(`/admin/${def.segment}/${id}`);
  revalidatePath(`/admin/${def.segment}`);
  return { ok: true };
}

// =============================================================================
// setTestimonialStatus — testimonials' publish gate is a select, not a boolean.
// status === 'Draft' → framer draft:true; empty/other → live. Audit action mirrors
// the publish/unpublish contract (publish when leaving Draft, unpublish when entering).
// =============================================================================

export async function setTestimonialStatus(
  id: string,
  status: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: 'Missing testimonial id' };
  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const value = status === '' ? null : status;
  const { db } = getDb();
  const at = new Date().toISOString();
  const current = await db.select().from(testimonials).where(eq(testimonials.id, id)).limit(1);
  if (current.length === 0) return { ok: false, error: `Testimonial ${id} not found` };
  const old = (current[0]! as Record<string, unknown>)['status'];
  if (toStr(old) === toStr(value)) return { ok: true };

  await db.update(testimonials).set({ status: value, updatedAt: at }).where(eq(testimonials.id, id));

  await postWrite(db, 'testimonials', id, [
    {
      entity: 'testimonials',
      entityId: id,
      field: 'status',
      action: value === 'Draft' ? 'unpublish' : 'publish',
      oldValue: toStr(old),
      newValue: toStr(value),
      actor,
    },
  ]);

  revalidatePath(`/admin/testimonials/${id}`);
  revalidatePath(`/admin/testimonials`);
  return { ok: true };
}

// =============================================================================
// savePromotionTargets — replace-all the promotion_targets rows for one promo.
//
// scope describes the targeting:
//   { type: 'global' }                          → single row (target_type='global',
//                                                  target_id NULL)
//   { type: 'scoped', cities, communities, qmis }→ one row per id across the three
//                                                  target_types (city|community|qmi),
//                                                  each with a non-null target_id.
//
// The DB CHECK (promotion_targets_global_chk) enforces global⇒NULL and others⇒NOT
// NULL; we build rows accordingly. We DELETE all existing rows for the promo then
// INSERT the new set (replace-all), so deselected targets are removed.
// =============================================================================

export type PromoScope =
  | { type: 'global' }
  | { type: 'scoped'; cities?: string[]; communities?: string[]; qmis?: string[] };

export async function savePromotionTargets(
  promoId: string,
  scope: PromoScope
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!promoId) return { ok: false, error: 'Missing promotion id' };

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const { db } = getDb();
  const at = new Date().toISOString();

  // Verify the promo exists (FK-ish guard; D1/SQLite FKs may be off).
  const promo = await db.select().from(promotions).where(eq(promotions.id, promoId)).limit(1);
  if (promo.length === 0) return { ok: false, error: `Promotion ${promoId} not found` };

  // Build the new target rows.
  const rows: NewPromotionTarget[] = [];
  if (scope.type === 'global') {
    rows.push({ promotionId: promoId, targetType: 'global', targetId: null });
  } else {
    const add = (type: Exclude<PromoTargetType, 'global'>, ids?: string[]) => {
      for (const raw of ids ?? []) {
        const tid = raw.trim();
        if (tid) rows.push({ promotionId: promoId, targetType: type, targetId: tid });
      }
    };
    add('city', scope.cities);
    add('community', scope.communities);
    add('qmi', scope.qmis);
    if (rows.length === 0) {
      return { ok: false, error: 'Scoped targeting requires at least one city, community, or QMI' };
    }
  }

  // Replace-all: delete existing, insert new. (D1 has no multi-statement txn over the
  // Drizzle d1 driver here; run sequentially on the primary session.)
  await db.delete(promotionTargets).where(eq(promotionTargets.promotionId, promoId));
  if (rows.length > 0) await db.insert(promotionTargets).values(rows);

  // Touch the promotion so the framer lookback/queue sees it changed.
  await db.update(promotions).set({ updatedAt: at }).where(eq(promotions.id, promoId));

  const summary =
    scope.type === 'global'
      ? 'global'
      : rows.map((r) => `${r.targetType}:${r.targetId}`).join(',');

  await postWrite(db, 'promotions', promoId, [
    {
      entity: 'promotions',
      entityId: promoId,
      field: 'targets',
      action: 'set_targets',
      oldValue: null,
      newValue: summary,
      actor,
    },
  ]);

  revalidatePath(`/admin/promotions/${promoId}`);
  revalidatePath(`/admin/promotions`);
  return { ok: true };
}

// =============================================================================
// uploadImage — store the file in R2 IMAGES at <entity>/<id>/<filename>, then persist
// the STABLE public url into the row. NEVER stores a v5.airtableusercontent.com url.
//
// `field` is the column the url is written to (e.g. 'image_url', 'featured_image_url').
// Returns the stable url on success.
// =============================================================================

export async function uploadImage(
  entity: string,
  id: string,
  field: string,
  file: File
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };
  if (!id) return { ok: false, error: 'Missing record id' };
  if (!file || file.size === 0) return { ok: false, error: 'Empty file' };

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const colMap = columnMapForEntity(def.key);
  const col = colMap[field];
  if (!col) return { ok: false, error: `Field ${field} is not an editable column of ${def.label}` };

  const env = getCloudflareContext().env;
  const safeName = sanitizeFilename(file.name);
  const key = `${def.key}/${id}/${safeName}`;

  await env.IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  // Stable, content-addressable-ish public url. Base is a real CDN/R2 domain — never
  // an Airtable attachment host.
  const base = (env.IMAGES_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const url = `${base}/${key}`;
  if (url.includes('airtableusercontent.com')) {
    return { ok: false, error: 'Refusing to store an Airtable attachment URL' };
  }

  const { db } = getDb();
  const at = new Date().toISOString();
  const current = (await db
    .select()
    .from(def.table)
    .where(eq(idColumn(def.table), id))
    .limit(1)) as Array<Record<string, unknown>>;
  if (current.length === 0) return { ok: false, error: `${def.label} ${id} not found` };
  const oldValue = current[0]![col.column];

  await db
    .update(def.table)
    .set(toDrizzlePatch(def.key, { [col.column]: url, updated_at: at }) as never)
    .where(eq(idColumn(def.table), id));

  await postWrite(db, def.key, id, [
    {
      entity: def.key,
      entityId: id,
      field,
      action: 'upload_image',
      oldValue: toStr(oldValue),
      newValue: url,
      actor,
    },
  ]);

  revalidatePath(`/admin/${def.segment}/${id}`);
  return { ok: true, url };
}

// =============================================================================
// uploadBlockImage — upload a JSON-block image to R2 and return the stable url WITHOUT
// writing a DB column. The jsonBlocks editor stores the returned url as the block
// value, then saveCityBlocks persists the whole object. Key = <entity>/<id>/<slot>-<file>.
// Used for cities copy/venue image keys (live_in_image, *_image, image_0, …).
// =============================================================================

export async function uploadBlockImage(
  entity: string,
  id: string,
  slot: string,
  file: File
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };
  if (!id) return { ok: false, error: 'Missing record id' };
  if (!file || file.size === 0) return { ok: false, error: 'Empty file' };

  try {
    await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const env = getCloudflareContext().env;
  const safeSlot = sanitizeFilename(slot) || 'block';
  const safeName = sanitizeFilename(file.name);
  const key = `${def.key}/${id}/${safeSlot}-${safeName}`;

  await env.IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  const base = (env.IMAGES_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const url = `${base}/${key}`;
  if (url.includes('airtableusercontent.com')) {
    return { ok: false, error: 'Refusing to store an Airtable attachment URL' };
  }
  return { ok: true, url };
}

// =============================================================================
// uploadGalleryImage — upload one image to R2, returning its stable url WITHOUT
// immediately writing a DB column.  The ImageGalleryEditor accumulates uploaded
// URLs client-side and stores the entire JSON array via the normal saveEntity
// form submit (photo_gallery_json column).  Key = <entity>/<id>/gallery-<index>-<file>.
// =============================================================================

export async function uploadGalleryImage(
  entity: string,
  id: string,
  index: number,
  file: File
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };
  if (!id) return { ok: false, error: 'Missing record id' };
  if (!file || file.size === 0) return { ok: false, error: 'Empty file' };

  try {
    await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const env = getCloudflareContext().env;
  const safeName = sanitizeFilename(file.name);
  const key = `${def.key}/${id}/gallery-${index}-${safeName}`;

  await env.IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  const base = (env.IMAGES_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const url = `${base}/${key}`;
  if (url.includes('airtableusercontent.com')) {
    return { ok: false, error: 'Refusing to store an Airtable attachment URL' };
  }
  return { ok: true, url };
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned || `upload-${Date.now()}`;
}

// =============================================================================
// JSON-column editors — emit the EXACT shapes framer-push/src/collections.ts expects.
//
//   cities.city_copy_blocks_json  → flat { key -> value } object
//   cities.city_venue_blocks_json → flat { key -> value } object
//   communities.hoa_links_json    → array of { title, link }
//
// We assemble + JSON.stringify here (server-side) so a malformed client payload can't
// corrupt the shape. Blank/empty entries are dropped (the mapper drops absent keys).
// =============================================================================

/** cities: write both JSON block objects (flat key→value). */
export async function saveCityBlocks(
  id: string,
  copyBlocks: Record<string, string>,
  venueBlocks: Record<string, string>
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: 'Missing city id' };
  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const dropEmpty = (o: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && String(v).trim() !== ''));

  const copyJson = JSON.stringify(dropEmpty(copyBlocks));
  const venueJson = JSON.stringify(dropEmpty(venueBlocks));

  const { db } = getDb();
  const at = new Date().toISOString();
  const current = await db.select().from(cities).where(eq(cities.id, id)).limit(1);
  if (current.length === 0) return { ok: false, error: `City ${id} not found` };
  const prev = current[0]! as Record<string, unknown>;

  await db
    .update(cities)
    .set({ cityCopyBlocksJson: copyJson, cityVenueBlocksJson: venueJson, updatedAt: at })
    .where(eq(cities.id, id));

  await postWrite(db, 'cities', id, [
    {
      entity: 'cities',
      entityId: id,
      field: 'city_copy_blocks_json',
      action: 'update',
      oldValue: toStr(prev['city_copy_blocks_json']),
      newValue: copyJson,
      actor,
    },
    {
      entity: 'cities',
      entityId: id,
      field: 'city_venue_blocks_json',
      action: 'update',
      oldValue: toStr(prev['city_venue_blocks_json']),
      newValue: venueJson,
      actor,
    },
  ]);

  revalidatePath(`/admin/cities/${id}`);
  return { ok: true };
}

/** communities: write hoa_links_json as an array of {title, link}. */
export async function saveCommunityHoaLinks(
  id: string,
  links: Array<{ title: string; link: string }>
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: 'Missing community id' };
  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  // Drop rows with no title AND no link; keep the {title, link} shape exactly.
  const cleaned = links
    .map((l) => ({ title: (l.title ?? '').trim(), link: (l.link ?? '').trim() }))
    .filter((l) => l.title !== '' || l.link !== '');
  const json = JSON.stringify(cleaned);

  const { db } = getDb();
  const at = new Date().toISOString();
  const current = await db.select().from(communities).where(eq(communities.id, id)).limit(1);
  if (current.length === 0) return { ok: false, error: `Community ${id} not found` };
  const prev = current[0]! as Record<string, unknown>;

  await db.update(communities).set({ hoaLinksJson: json, updatedAt: at }).where(eq(communities.id, id));

  await postWrite(db, 'communities', id, [
    {
      entity: 'communities',
      entityId: id,
      field: 'hoa_links_json',
      action: 'update',
      oldValue: toStr(prev['hoa_links_json']),
      newValue: json,
      actor,
    },
  ]);

  revalidatePath(`/admin/communities/${id}`);
  return { ok: true };
}

// =============================================================================
// DIGITAL ASSET MANAGER (images library) actions.
//
// The IMAGES section is a DAM: operators upload a file and an images row is created
// whose file_url points at the STABLE r2.dev asset — they never type or see a URL.
//
// createImageAsset composes the EXISTING primitives in one server round-trip so the
// upload dropzone can create + populate a row atomically:
//   (1) INSERT a fresh `images` row (id prefixed `adm`, like createEntity),
//   (2) PUT the file to R2 IMAGES at images/<id>/<filename>,
//   (3) UPDATE the row's file_url to the stable r2.dev url,
//   (4) audit_log (create + upload_image) + FRAMER_QUEUE enqueue, then revalidate.
// It obeys every write-contract clause: getCurrentUser() attribution, getDb()
// first-primary session, postWrite() audit+enqueue, and it REJECTS airtable urls.
// =============================================================================

export async function createImageAsset(
  formData: FormData
): Promise<{ ok: true; id: string; url: string } | { ok: false; error: string }> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Empty file' };
  }

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const env = getCloudflareContext().env;
  const { db } = getDb();
  const at = new Date().toISOString();
  const id = `adm${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

  const safeName = sanitizeFilename(file.name);
  const key = `images/${id}/${safeName}`;
  const base = (env.IMAGES_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const url = `${base}/${key}`;
  // Stable R2 url only — an Airtable attachment host must never be stored.
  if (url.includes('airtableusercontent.com')) {
    return { ok: false, error: 'Refusing to store an Airtable attachment URL' };
  }

  // (1) insert the row with the file_url + a default slug derived from the filename.
  const slug = safeName.replace(/\.[^.]+$/, '') || id;
  await db
    .insert(images)
    .values(
      toDrizzlePatch('images', {
        id,
        slug,
        file_url: url,
        created_at: at,
        updated_at: at,
      }) as never
    );

  // (2) store the asset in R2.
  await env.IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  // (3)+(4) audit (create + upload_image) and enqueue one Framer push.
  await postWrite(db, 'images', id, [
    {
      entity: 'images',
      entityId: id,
      field: null,
      action: 'create',
      oldValue: null,
      newValue: id,
      actor,
    },
    {
      entity: 'images',
      entityId: id,
      field: 'file_url',
      action: 'upload_image',
      oldValue: null,
      newValue: url,
      actor,
    },
  ]);

  revalidatePath('/images');
  return { ok: true, id, url };
}

// =============================================================================
// deleteImageAsset — remove an images library row (and its R2 object, best-effort).
// Audits a `delete` row and enqueues the Framer push so the consumer removes it.
// =============================================================================

export async function deleteImageAsset(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: 'Missing image id' };

  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }

  const { db } = getDb();
  const current = await db.select().from(images).where(eq(images.id, id)).limit(1);
  if (current.length === 0) return { ok: false, error: `Image ${id} not found` };
  const oldUrl = toStr((current[0]! as Record<string, unknown>)['file_url']);

  // Best-effort delete of the R2 object (keyed images/<id>/<file>). We derive the key
  // from the stored stable url; failures here don't block the row delete.
  const env = getCloudflareContext().env;
  const base = (env.IMAGES_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (oldUrl && base && oldUrl.startsWith(base + '/')) {
    const key = oldUrl.slice(base.length + 1);
    try {
      await env.IMAGES.delete(key);
    } catch {
      // ignore — the DB row is the source of truth; orphan objects are harmless.
    }
  }

  await db.delete(images).where(eq(images.id, id));

  await postWrite(db, 'images', id, [
    {
      entity: 'images',
      entityId: id,
      field: null,
      action: 'delete',
      oldValue: oldUrl,
      newValue: null,
      actor,
    },
  ]);

  revalidatePath('/images');
  return { ok: true };
}

// =============================================================================
// FIELD BUILDER (Phase B) — field_definitions CRUD + reorder.
//
// These ADD to the write path; they DO NOT enqueue a Framer push (Framer schema sync
// is Phase C). Each obeys the in-repo write conventions:
//   (1) gate on the Auth.js session role === 'admin' (Full-Admin only; isAdmin()),
//   (2) attribute via getCurrentUser() and write an audit_log row for the change,
//   (3) write D1 via the PRIMARY session (getDb → read-your-writes).
//
// Safety invariants (validated here AND in lib/field-builder.ts):
//   • SYSTEM fields are immutable in key/type and cannot be deleted (reorder/relabel/
//     group/visibility/half-width ARE allowed).
//   • Custom keys are safe snake_case, unique per entity, and never collide with a real
//     column / reserved name / existing field key.
//   • Only the v1 field types are creatable (bespoke widgets are system-only).
// The `entity` audited is `field_definitions:<entity>` so registry edits are
// distinguishable from record edits in the audit_log; `field` is the field key.
// =============================================================================

type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const AUDIT_REGISTRY = 'field_definitions';

/** Resolve {actor} after confirming Full-Admin; returns an error result otherwise. */
async function requireAdmin(): Promise<{ ok: true; actor: string } | { ok: false; error: string }> {
  let actor: string;
  try {
    actor = await getCurrentUser();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not authenticated' };
  }
  if (!(await isAdmin())) {
    return { ok: false, error: 'Forbidden: Field Builder requires Full Admin.' };
  }
  return { ok: true, actor };
}

/** Audit a registry change and revalidate the builder page for the entity. */
async function postFieldWrite(
  db: Db,
  entity: EntityKey,
  fieldKey: string | null,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  actor: string
): Promise<void> {
  const row: NewAuditLogRow = {
    entity: `${AUDIT_REGISTRY}:${entity}`,
    entityId: fieldKey ?? entity,
    field: fieldKey,
    action,
    oldValue,
    newValue,
    actor,
  };
  await db.insert(auditLog).values([row]);
}

export interface CreateFieldInput {
  entity: string;
  label: string;
  type: string;
  /** explicit key (optional — generated from the label when omitted). */
  key?: string;
  help?: string | null;
  groupLabel?: string | null;
  required?: boolean;
  visibleInForm?: boolean;
  visibleInList?: boolean;
  halfWidth?: boolean;
  /** {value,label}[] for a `select`; ignored for other types. */
  options?: Array<{ value: string; label: string }> | string[];
}

/**
 * Create a custom (non-system) field for an entity. Generates a safe snake_case key
 * (unique per entity) when none is supplied, validates the type + key, appends it after
 * the entity's current fields (sort = max+1), and audits a `field_create`.
 */
export async function createFieldDefinition(
  input: CreateFieldInput
): Promise<ActionResult<{ id: string; key: string }>> {
  const def = getEntity(input.entity);
  if (!def) return { ok: false, error: `Unknown entity: ${input.entity}` };

  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;

  const label = (input.label ?? '').trim();
  if (label === '') return { ok: false, error: 'Label is required' };

  const type = String(input.type ?? '');
  if (!isFieldType(type)) {
    return { ok: false, error: `Invalid field type: ${type}` };
  }

  const { db } = getDb();

  // Existing keys for the entity + the entity's reserved/real-column key set.
  const existing = (await db
    .select()
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.entity, def.key))
    .orderBy(asc(fieldDefinitions.sort))) as FieldDefinition[];
  const taken = reservedKeysForEntity(def.key);
  for (const r of existing) taken.add(r.key);

  // Resolve the key: explicit (validated) or generated from the label.
  let key: string;
  if (input.key && input.key.trim() !== '') {
    key = input.key.trim();
    if (!isValidKeyShape(key)) {
      return { ok: false, error: `Invalid key "${key}" — use lower snake_case (a–z, 0–9, _).` };
    }
    if (taken.has(key)) {
      return { ok: false, error: `Key "${key}" is reserved or already in use for ${def.label}.` };
    }
  } else {
    key = generateFieldKey(label, taken);
  }

  const optionsJson =
    type === 'select' ? JSON.stringify(normalizeOptions(input.options)) : null;

  const maxSort = existing.reduce((m, r) => Math.max(m, r.sort), -1);
  const id = `${def.key}__${key}`;
  const row: NewFieldDefinition = {
    id,
    entity: def.key,
    key,
    label,
    help: input.help?.trim() ? input.help.trim() : null,
    groupLabel: input.groupLabel?.trim() ? input.groupLabel.trim() : null,
    sort: maxSort + 1,
    type,
    optionsJson,
    required: Boolean(input.required),
    system: false, // builder-created fields are never system
    visibleInForm: input.visibleInForm ?? true,
    visibleInList: Boolean(input.visibleInList),
    halfWidth: Boolean(input.halfWidth),
    framerFieldId: null,
    framerType: FIELD_TYPE_META[type as FieldType].framerType,
  };

  await db.insert(fieldDefinitions).values(row);
  await postFieldWrite(db, def.key, key, 'field_create', null, `${type}:${label}`, actor);

  revalidatePath('/settings/fields');
  revalidatePath(`/${def.segment}`);
  return { ok: true, id, key };
}

export interface UpdateFieldInput {
  id: string;
  /** Presentation/visibility edits — all optional (only provided keys change). */
  label?: string;
  help?: string | null;
  groupLabel?: string | null;
  required?: boolean;
  visibleInForm?: boolean;
  visibleInList?: boolean;
  halfWidth?: boolean;
  /** retype — ALLOWED for custom fields only; rejected for system fields. */
  type?: string;
  /** select options — only honored when the (resulting) type is `select`. */
  options?: Array<{ value: string; label: string }> | string[];
}

/**
 * Update a field definition. SYSTEM fields may only have label/help/group/visibility/
 * half-width changed (key/type are immutable, and they can't be deleted). CUSTOM fields
 * may additionally retype + edit options. Audits a `field_update` with a compact diff.
 */
export async function updateFieldDefinition(input: UpdateFieldInput): Promise<ActionResult> {
  if (!input.id) return { ok: false, error: 'Missing field id' };

  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;

  const { db } = getDb();
  const rows = (await db
    .select()
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.id, input.id))
    .limit(1)) as FieldDefinition[];
  if (rows.length === 0) return { ok: false, error: `Field ${input.id} not found` };
  const cur = rows[0]!;
  const entity = cur.entity as EntityKey;

  const patch: Partial<NewFieldDefinition> = {};
  const changed: string[] = [];

  if (input.label !== undefined) {
    const label = input.label.trim();
    if (label === '') return { ok: false, error: 'Label cannot be blank' };
    if (label !== cur.label) {
      patch.label = label;
      changed.push('label');
    }
  }
  if (input.help !== undefined) {
    const help = input.help && input.help.trim() ? input.help.trim() : null;
    if (help !== cur.help) {
      patch.help = help;
      changed.push('help');
    }
  }
  if (input.groupLabel !== undefined) {
    const g = input.groupLabel && input.groupLabel.trim() ? input.groupLabel.trim() : null;
    if (g !== cur.groupLabel) {
      patch.groupLabel = g;
      changed.push('group');
    }
  }
  if (input.required !== undefined && Boolean(input.required) !== cur.required) {
    patch.required = Boolean(input.required);
    changed.push('required');
  }
  if (input.visibleInForm !== undefined && Boolean(input.visibleInForm) !== cur.visibleInForm) {
    patch.visibleInForm = Boolean(input.visibleInForm);
    changed.push('visibleInForm');
  }
  if (input.visibleInList !== undefined && Boolean(input.visibleInList) !== cur.visibleInList) {
    patch.visibleInList = Boolean(input.visibleInList);
    changed.push('visibleInList');
  }
  if (input.halfWidth !== undefined && Boolean(input.halfWidth) !== cur.halfWidth) {
    patch.halfWidth = Boolean(input.halfWidth);
    changed.push('halfWidth');
  }

  // RETYPE — system fields are immutable in type; custom fields may retype to a v1 type.
  let effectiveType = cur.type;
  if (input.type !== undefined && input.type !== cur.type) {
    if (cur.system) {
      return { ok: false, error: 'System fields cannot be retyped.' };
    }
    if (!isFieldType(input.type)) {
      return { ok: false, error: `Invalid field type: ${input.type}` };
    }
    patch.type = input.type;
    patch.framerType = FIELD_TYPE_META[input.type as FieldType].framerType;
    effectiveType = input.type;
    changed.push('type');
  }

  // OPTIONS — only meaningful for select. Editing options on a system field is allowed
  // only if it's already a select with static options (none are today); otherwise it's a
  // no-op. For custom selects this is the canonical options editor path.
  if (input.options !== undefined && effectiveType === 'select') {
    const optionsJson = JSON.stringify(normalizeOptions(input.options));
    // Compare against the current value normalized to '[]' when NULL/blank, so re-saving
    // the same options is a no-op.
    if (optionsJson !== (cur.optionsJson ?? '[]')) {
      patch.optionsJson = optionsJson;
      changed.push('options');
    }
  }
  // If a field is retyped AWAY from select, drop stale options.
  if (effectiveType !== 'select' && cur.optionsJson) {
    patch.optionsJson = null;
    if (!changed.includes('options')) changed.push('options');
  }

  if (changed.length === 0) return { ok: true }; // no-op

  patch.updatedAt = new Date().toISOString();
  await db.update(fieldDefinitions).set(patch).where(eq(fieldDefinitions.id, input.id));
  await postFieldWrite(
    db,
    entity,
    cur.key,
    'field_update',
    null,
    changed.join(','),
    actor
  );

  revalidatePath('/settings/fields');
  const ent = getEntity(entity);
  if (ent) revalidatePath(`/${ent.segment}`);
  return { ok: true };
}

/**
 * Delete a CUSTOM field definition. SYSTEM fields can NEVER be deleted. The stored
 * custom_fields VALUES on existing rows are intentionally left in place (harmless orphan
 * JSON keys); removing the registry row is enough to stop rendering/collecting the field.
 * Audits a `field_delete`.
 */
export async function deleteFieldDefinition(id: string): Promise<ActionResult> {
  if (!id) return { ok: false, error: 'Missing field id' };

  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;

  const { db } = getDb();
  const rows = (await db
    .select()
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.id, id))
    .limit(1)) as FieldDefinition[];
  if (rows.length === 0) return { ok: false, error: `Field ${id} not found` };
  const cur = rows[0]!;
  if (cur.system) {
    return { ok: false, error: 'System fields cannot be deleted.' };
  }
  const entity = cur.entity as EntityKey;

  await db.delete(fieldDefinitions).where(eq(fieldDefinitions.id, id));
  await postFieldWrite(db, entity, cur.key, 'field_delete', `${cur.type}:${cur.label}`, null, actor);

  revalidatePath('/settings/fields');
  const ent = getEntity(entity);
  if (ent) revalidatePath(`/${ent.segment}`);
  return { ok: true };
}

export interface ReorderItem {
  id: string;
  sort: number;
  /** assign/move to a section (NULL clears the group). */
  groupLabel?: string | null;
}

/**
 * Reorder (and re-group) an entity's fields in one shot: set `sort` + `group_label` for
 * each item. Reordering/regrouping is allowed for ALL fields (including system ones — the
 * spec permits reorder/group on synced fields). Items must all belong to `entity`. Audits
 * a single `field_reorder` summarizing the new order.
 */
export async function reorderFieldDefinitions(
  entity: string,
  items: ReorderItem[]
): Promise<ActionResult> {
  const def = getEntity(entity);
  if (!def) return { ok: false, error: `Unknown entity: ${entity}` };
  if (!Array.isArray(items) || items.length === 0) return { ok: true };

  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;

  const { db } = getDb();
  // Validate every id belongs to this entity (no cross-entity writes).
  const rows = (await db
    .select()
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.entity, def.key))) as FieldDefinition[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const it of items) {
    if (!byId.has(it.id)) {
      return { ok: false, error: `Field ${it.id} does not belong to ${def.label}` };
    }
  }

  const at = new Date().toISOString();
  for (const it of items) {
    const cur = byId.get(it.id)!;
    const group =
      it.groupLabel === undefined
        ? cur.groupLabel
        : it.groupLabel && it.groupLabel.trim()
          ? it.groupLabel.trim()
          : null;
    // Skip if nothing actually changed for this row.
    if (cur.sort === it.sort && (cur.groupLabel ?? null) === (group ?? null)) continue;
    await db
      .update(fieldDefinitions)
      .set({ sort: it.sort, groupLabel: group ?? null, updatedAt: at })
      .where(and(eq(fieldDefinitions.id, it.id), eq(fieldDefinitions.entity, def.key)));
  }

  const summary = [...items]
    .sort((a, b) => a.sort - b.sort)
    .map((it) => byId.get(it.id)?.key ?? it.id)
    .join(',');
  await postFieldWrite(db, def.key, null, 'field_reorder', null, summary, actor);

  revalidatePath('/settings/fields');
  revalidatePath(`/${def.segment}`);
  return { ok: true };
}

// =============================================================================
// FRAMER FIELD TYPES (Phase C) — applyFramerTypes.
//
// The Settings → Framer Field Types tab stages two kinds of change per entity:
//   • RETYPE an existing field (change its field_definitions.framer_type), and/or
//   • ADD a new custom field (key/label/admin-type/framer-type).
// "Apply N changes to Framer" commits the whole batch here. For each affected
// collection we:
//   1. For ADDED fields: INSERT the field_definitions row FIRST (custom=1,
//      visible_in_form=1, the given admin type + framer_type) so the entity's D1 edit
//      page immediately renders the input (value ↔ custom_fields[key]).
//   2. Call framer-push POST /schema (service binding or token) with the affected
//      collection's fields to re-type/create the Framer fields + re-push the collection.
//   3. On a successful per-field result (retyped/created/unchanged), update
//      field_definitions.framer_type to the applied value + stamp framer_field_id (==
//      the key, the framer-push convention).
// Full-Admin gated (this is a data-feed/schema surface). Returns per-field results.
// =============================================================================

export interface ApplyTypeChange {
  /** the field_definitions key (snake_case). For an added field this is the new key. */
  key: string;
  /** the target Framer CMS type (must be a settable framer-push type). */
  framerType: string;
  /** present ONLY for an ADDED field — its admin field-builder type + label. */
  add?: { adminType: string; label: string };
}

export interface ApplyTypeFieldResult {
  key: string;
  /** how the registry row resolved (added inserts a row; existing just updates type). */
  status: 'applied' | 'created' | 'unchanged' | 'error';
  /** the Framer /schema action for this field, when reached. */
  framerAction?: SchemaFieldResult['action'];
  framerType?: string;
  error?: string;
}

export interface ApplyTypeEntityResult {
  entity: string;
  /** the Framer collection name reported by /schema (when reached). */
  collectionName?: string;
  deploymentId?: string | null;
  fields: ApplyTypeFieldResult[];
  error?: string;
}

/**
 * Apply a batch of Framer-type changes (re-types + added fields), grouped per entity.
 * `batch` is keyed by EntityKey → the changes for that entity. Order within the action:
 * insert added rows first (so the D1 edit page renders them), then call /schema, then
 * advance field_definitions.framer_type for the fields the worker accepted.
 */
export async function applyFramerTypes(
  batch: Record<string, ApplyTypeChange[]>
): Promise<{ ok: true; results: ApplyTypeEntityResult[] } | { ok: false; error: string }> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;

  const { db } = getDb();
  const env = getCloudflareContext().env as unknown as {
    FRAMER_PUSH?: { fetch: (req: Request) => Promise<Response> };
    FRAMER_PUSH_URL?: string;
    WEBHOOK_TOKEN?: string;
  };

  const results: ApplyTypeEntityResult[] = [];

  for (const [entityRaw, changes] of Object.entries(batch)) {
    const def = getEntity(entityRaw);
    if (!def) {
      results.push({ entity: entityRaw, fields: [], error: `Unknown entity: ${entityRaw}` });
      continue;
    }
    if (!Array.isArray(changes) || changes.length === 0) continue;
    const entity = def.key;
    const entityResult: ApplyTypeEntityResult = { entity, fields: [] };

    // Per-field bookkeeping: validate types, insert added rows, build the /schema request.
    const existing = (await db
      .select()
      .from(fieldDefinitions)
      .where(eq(fieldDefinitions.entity, entity))
      .orderBy(asc(fieldDefinitions.sort))) as FieldDefinition[];
    const byKey = new Map(existing.map((r) => [r.key, r]));
    const taken = reservedKeysForEntity(entity);
    for (const r of existing) taken.add(r.key);
    let maxSort = existing.reduce((m, r) => Math.max(m, r.sort), -1);

    const schemaReqs: SchemaFieldRequest[] = [];
    // Track which keys we attempted to apply (to advance framer_type after /schema).
    const attempted = new Map<string, ApplyTypeFieldResult>();

    for (const ch of changes) {
      const key = (ch.key ?? '').trim();
      const framerType = (ch.framerType ?? '').trim();
      const fr: ApplyTypeFieldResult = { key, status: 'error', framerType };

      if (!key) {
        fr.error = 'missing key';
        entityResult.fields.push(fr);
        continue;
      }
      if (!isSettableFramerType(framerType)) {
        fr.error = `“${framerType}” is not a Framer type that can be applied`;
        entityResult.fields.push(fr);
        continue;
      }

      if (ch.add) {
        // ADD a new custom field — insert the registry row FIRST.
        const adminType = String(ch.add.adminType ?? '');
        const label = String(ch.add.label ?? '').trim();
        if (!isFieldType(adminType)) {
          fr.error = `invalid admin type: ${adminType}`;
          entityResult.fields.push(fr);
          continue;
        }
        if (label === '') {
          fr.error = 'label is required';
          entityResult.fields.push(fr);
          continue;
        }
        if (!isValidKeyShape(key)) {
          fr.error = `invalid key “${key}” — use lower snake_case`;
          entityResult.fields.push(fr);
          continue;
        }
        if (taken.has(key)) {
          fr.error = `key “${key}” is reserved or already in use`;
          entityResult.fields.push(fr);
          continue;
        }
        maxSort += 1;
        const id = `${entity}__${key}`;
        const row: NewFieldDefinition = {
          id,
          entity,
          key,
          label,
          help: null,
          groupLabel: null,
          sort: maxSort,
          type: adminType,
          optionsJson: adminType === 'select' ? '[]' : null,
          required: false,
          system: false,
          visibleInForm: true, // so the entity edit page renders it immediately
          visibleInList: false,
          halfWidth: false,
          framerFieldId: null,
          framerType, // provisional; confirmed/advanced after /schema succeeds
          custom: true, // value lives in custom_fields[key]
        };
        await db.insert(fieldDefinitions).values(row);
        await postFieldWrite(db, entity, key, 'field_create', null, `${adminType}:${label}`, actor);
        taken.add(key);
        fr.status = 'created';
        attempted.set(key, fr);
        schemaReqs.push({ key, framer_type: framerType, label });
        entityResult.fields.push(fr);
        continue;
      }

      // RETYPE an existing field.
      const cur = byKey.get(key);
      if (!cur) {
        fr.error = `field “${key}” not found for ${def.label}`;
        entityResult.fields.push(fr);
        continue;
      }
      fr.status = 'applied';
      attempted.set(key, fr);
      schemaReqs.push({ key, framer_type: framerType, label: cur.label ?? key });
      entityResult.fields.push(fr);
    }

    // Nothing valid to send → record the entity result and move on.
    if (schemaReqs.length === 0) {
      results.push(entityResult);
      continue;
    }

    // Call framer-push /schema for this collection (re-type/create + re-push).
    let schema;
    try {
      schema = await postSchema(env, entity, schemaReqs);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'framer-push /schema failed';
      entityResult.error = error;
      // Mark every attempted field errored; do NOT advance framer_type.
      for (const fr of attempted.values()) {
        fr.status = 'error';
        fr.error = error;
      }
      results.push(entityResult);
      continue;
    }

    entityResult.collectionName = schema.collectionName;
    entityResult.deploymentId = schema.deploymentId ?? null;
    if (schema.error) entityResult.error = schema.error;

    // Advance field_definitions.framer_type (+ framer_field_id) for accepted fields.
    const schemaByKey = new Map((schema.fields ?? []).map((f) => [f.key, f]));
    const at = new Date().toISOString();
    for (const [key, fr] of attempted) {
      const sf = schemaByKey.get(key);
      fr.framerAction = sf?.action;
      if (!sf || sf.action === 'error') {
        fr.status = 'error';
        fr.error = sf?.detail ?? schema.error ?? 'field not applied by Framer';
        continue;
      }
      // retyped | created | unchanged → persist the configured type + the live field id.
      await db
        .update(fieldDefinitions)
        .set({ framerType: fr.framerType ?? null, framerFieldId: key, updatedAt: at })
        .where(and(eq(fieldDefinitions.entity, entity), eq(fieldDefinitions.key, key)));
      await postFieldWrite(
        db,
        entity,
        key,
        'framer_type_set',
        null,
        `${fr.framerType} (${sf.action})`,
        actor
      );
      if (fr.status !== 'created') fr.status = sf.action === 'unchanged' ? 'unchanged' : 'applied';
    }

    results.push(entityResult);
    revalidatePath(`/${def.segment}`);
  }

  revalidatePath('/settings/framer-types');
  revalidatePath('/settings/fields');
  return { ok: true, results };
}
