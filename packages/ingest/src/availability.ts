// =============================================================================
// esperanza-cf — human-readable QMI availability text ("Available JUN/JUL 2026").
//
// The Framer site's availability badge renders qmi.availability_text (see
// packages/framer-push/src/collections.ts availabilityBadgeValue — it de-prefixes
// "Available " and pushes the remainder as the managed move_in_date display
// value, falling back to the raw ISO date ONLY when availability_text is absent;
// that ISO fallback must never be what visitors see). This module derives the
// text from the effective move-in date so ingest-created/updated homes always
// carry it.
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
export function deriveAvailabilityText(
  isoDate: string | null | undefined,
  todayIso: string = todayIsoDate()
): string | null {
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
