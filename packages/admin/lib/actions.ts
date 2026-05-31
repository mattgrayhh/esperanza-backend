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
import {
  promotions,
  promotionTargets,
  cities,
  communities,
  testimonials,
  auditLog,
  type NewAuditLogRow,
  type NewPromotionTarget,
} from '@esperanza/db';
import {
  buildOverrideWrite,
  buildOverrideAudit,
  type QmiOverridableField,
} from '@esperanza/db/override';
import type { PromoTargetType } from '@esperanza/db/promo';
import { getDb, idColumn, type Db } from './db';
import { getCurrentUser } from './auth';
import { getEntity, isQmiOverrideField, type EntityKey } from './entities';
import { columnMapForEntity, coerceForColumn, toDrizzlePatch } from './fields';
import { publishGateColumn } from './field-config';

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
    await db.insert(auditLog).values(rows);
  }

  const env = getCloudflareContext().env;
  await env.FRAMER_QUEUE.send({ collection, action: 'upsert', id });
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

  for (const [field, rawValue] of formData.entries()) {
    // FormData values can be File (handled by uploadImage, not here) — skip.
    if (typeof rawValue !== 'string') continue;
    // The publish gate (published/active/status) has its own action; never set it here.
    if (field === 'published' || (gate && field === gate)) continue;
    // Only accept fields we know how to map to a column.
    const col = colMap[field];

    // --- QMI synced write-set: route through override.ts ---
    if (def.key === 'qmi' && isQmiOverrideField(field)) {
      const ofield = field as QmiOverridableField;
      const value = rawValue === '' ? null : coerceForColumn(def.key, ofield, rawValue);
      const prevOverride = row[`override_${ofield}`];
      const writePatch = buildOverrideWrite(ofield, value, { actor, at });
      Object.assign(patch, writePatch);
      const auditRow = buildOverrideAudit(id, ofield, prevOverride, value, { actor, at });
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

  if (Object.keys(patch).length === 0) {
    return { ok: true }; // nothing changed
  }

  patch['updated_at'] = at;

  // `patch` is keyed by PHYSICAL column names (col.column, override.ts's override_<f>,
  // updated_at). Drizzle .set() is keyed by JS property names — re-key or every key is
  // silently dropped (→ empty SET → invalid SQL). See lib/fields.toDrizzlePatch.
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
// toggleActive — promotions' publish gate. `active` is the single gate (no separate
// published column); active=false → framer draft:true. Same audit contract as
// togglePublished but on the `active` column. Promotions are not in `publishable`
// (that flag is for the `published` column), so we accept the promotions entity here.
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
  const wasActive = Boolean((current[0]! as Record<string, unknown>)['active']);

  await db.update(promotions).set({ active: value, updatedAt: at }).where(eq(promotions.id, id));

  await postWrite(db, 'promotions', id, [
    {
      entity: 'promotions',
      entityId: id,
      field: 'active',
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
