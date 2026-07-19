// =============================================================================
// Single-flight sync lock (migration 0029). The cron and the manual POST /run
// can invoke runIngest concurrently; the D1 sync_lock row makes the second
// caller skip. A row older than the ~15 min TTL is a crashed run — stolen.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, d1 } from './helpers.js';
import { acquireSyncLock, releaseSyncLock } from '../src/index.js';

describe('sync lock', () => {
  it('second acquire while held is refused; release frees it', async () => {
    const db = freshDb();
    expect(await acquireSyncLock(d1(db))).toBe(true);
    expect(await acquireSyncLock(d1(db))).toBe(false);
    await releaseSyncLock(d1(db));
    expect(await acquireSyncLock(d1(db))).toBe(true);
    db.close();
  });

  it('a lock older than the TTL (crashed run) is stolen', async () => {
    const db = freshDb();
    const now = Date.now();
    expect(await acquireSyncLock(d1(db), now)).toBe(true);
    expect(await acquireSyncLock(d1(db), now + 14 * 60_000)).toBe(false); // still live
    expect(await acquireSyncLock(d1(db), now + 16 * 60_000)).toBe(true); // expired → stolen
    db.close();
  });
});
