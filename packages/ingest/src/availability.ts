// =============================================================================
// esperanza-cf — human-readable QMI availability text ("Available JUN/JUL 2026").
//
// The public site's availability badge renders qmi.availability_text — it
// de-prefixes "Available " and shows the remainder as the move-in display value,
// falling back to the raw ISO date ONLY when availability_text is absent (that ISO
// fallback must never be what visitors see). This module derives the text from the
// effective move-in date so ingest-created/updated homes always carry it.
//
// Convention (confirmed against live D1 values on 2026-06-11):
//   * Two-month window: move-in month + the following month, uppercase 3-letter
//     English month abbreviations, single 4-digit year suffix taken from the
//     SECOND month — "Available JUN/JUL 2026". For non-boundary windows the
//     second month's year equals the move-in year (matches every observed row);
//     across the year boundary it rolls forward — "Available DEC/JAN 2027".
//   * Move-in date today-or-earlier → "Available Now".
//   * No / unparseable date → null (leave the field absent; never write junk).
// =============================================================================

const MONTHS_ABBR = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

/** Today as a UTC YYYY-MM-DD string (the same calendar space as D1 dates). */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Derive the canonical availability text from an effective move-in date
 * (YYYY-MM-DD, as stored in synced_move_in_date / override_move_in_date).
 *
 * Returns null when the date is missing or unparseable — callers must then
 * leave availability_text untouched/absent.
 *
 * `todayIso` is injectable for tests; defaults to the current UTC date.
 */
/**
 * Construction stages that mean the home is move-in ready NOW. Sourced from the
 * MarkSystems milestone chain (DM_HOUSE.CONSTRUCTION_STAGE): 'Buyer Sign Off' is the
 * final in-inventory stage (settled homes are filtered out upstream). Confirmed
 * against the legacy O'Neill listing on 2026-06-16: 49/50 "Available Now" homes were
 * at 'Buyer Sign Off'; every windowed home sat at an earlier stage. Case-insensitive.
 */
const READY_STAGES = new Set(['buyer sign off']);

export function isReadyConstructionStage(stage: string | null | undefined): boolean {
  return READY_STAGES.has(String(stage ?? '').trim().toLowerCase());
}

// ── Auto-publish horizon ─────────────────────────────────────────────────────
// How far out a still-under-construction home may be and still be worth showing
// as available inventory.
//
// Derived from the legacy O'Neill listing rather than assumed. Scrape of
// www.esperanzahomes.com/new-homes/available/ on 2026-07-28 (121 homes):
//   Available Now 44 · JUL/AUG 20 · AUG/SEP 23 · SEP/OCT 15 · OCT/NOV 13 ·
//   NOV/DEC 4 · MAY/JUN + JUN/JUL 2 · nothing in 2027 at all.
// The envelope stops dead at NOV/DEC 2026 — ~120 days out from that date. So 120
// days reproduces the business rule the sales side has been running for years.
//
// Without this gate the auto-publish leg (diff.ts) published on presence-in-Snowflake
// + has-an-image alone, which put graded pads and "Preliminary Plan Review" rows on
// the site with move-in dates as far out as 2027-02-26 (2026-07-28 incident: published
// QMIs went 112 → 262).
export const PUBLISH_HORIZON_DAYS = 120;

/** todayIso + days, as a YYYY-MM-DD string. UTC calendar space, same as D1 dates. */
export function addDays(todayIso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(todayIso.trim());
  if (!m) return todayIso;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * True when an effective move-in date is inside the publish horizon. A missing or
 * unparseable date is NOT within the horizon — we refuse to publish a home whose
 * timing we cannot establish, since the availability badge would have nothing to say.
 */
export function isWithinPublishHorizon(
  isoDate: string | null | undefined,
  todayIso: string = todayIsoDate(),
  horizonDays: number = PUBLISH_HORIZON_DAYS
): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((isoDate ?? '').trim());
  const day = m?.[1];
  if (!day) return false;
  return day <= addDays(todayIso, horizonDays);
}

/**
 * The auto-publish readiness gate: a home may be published unattended only when it
 * is finished, or is due inside the horizon.
 *
 * `effectiveMoveInDate` must be override_move_in_date ?? synced/Snowflake move-in date —
 * the same COALESCE the public views apply, so the gate judges what a visitor would see.
 */
export function isPublishReady(
  constructionStage: string | null | undefined,
  effectiveMoveInDate: string | null | undefined,
  todayIso: string = todayIsoDate(),
  horizonDays: number = PUBLISH_HORIZON_DAYS
): boolean {
  if (isReadyConstructionStage(constructionStage)) return true;
  return isWithinPublishHorizon(effectiveMoveInDate, todayIso, horizonDays);
}

export function deriveAvailabilityText(
  isoDate: string | null | undefined,
  todayIso: string = todayIsoDate(),
  constructionStage: string | null | undefined = null
): string | null {
  // A completed home is "Available Now" regardless of its (now-irrelevant) estimated
  // move-in date — this is the primary signal; the date window is only for homes still
  // under construction. Also fixes stale future-window text on homes that have finished.
  if (isReadyConstructionStage(constructionStage)) return 'Available Now';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((isoDate ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Past or imminent (today counts): the home is move-in ready.
  const dateKey = `${m[1]}-${m[2]}-${m[3]}`;
  if (dateKey <= todayIso) return 'Available Now';

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `Available ${MONTHS_ABBR[month - 1]}/${MONTHS_ABBR[nextMonth - 1]} ${nextYear}`;
}

/**
 * True when a stored availability_text matches the machine-generated convention
 * ("Available JUN/JUL 2026" / "Available Now") — i.e. it is safe for ingest to
 * refresh. Anything else (admin-authored copy like "Move in this fall!") is
 * treated as an admin override and is NEVER clobbered. availability_text is a
 * plain column (no synced_/override_ pair), so this pattern check IS the
 * no-clobber rule. Stale auto values (window text whose date has since moved)
 * still match and are correctly refreshed.
 */
export function isAutoAvailabilityText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (t === '') return true; // empty → nothing to clobber
  return /^Available ((JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) \d{4}|Now)$/.test(
    t
  );
}
