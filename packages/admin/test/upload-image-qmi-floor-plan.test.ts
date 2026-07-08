import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { schema } from '@esperanza/db';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const INIT_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

interface Harness {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  images: Map<string, ArrayBuffer>;
}
let H: Harness;

function freshHarness(): Harness {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(INIT_SQL);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, images: new Map() };
}

vi.mock('../lib/db', () => ({
  getDb: () => ({ db: H.db, session: {} }),
  getReadDb: () => H.db,
  idColumn: (table: unknown) => (table as { id: unknown }).id,
}));

vi.mock('../lib/auth', () => ({
  getCurrentUser: async () => 'test@example.com',
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: {
      IMAGES: {
        put: async (key: string, body: ArrayBuffer) => {
          H.images.set(key, body);
        },
      },
      IMAGES_PUBLIC_BASE_URL: 'https://media.test.local',
      FRAMER_QUEUE: { send: async () => {} },
    },
  }),
}));

import { uploadImage } from '../lib/actions';

beforeEach(() => {
  H = freshHarness();
  H.sqlite
    .prepare(
      `INSERT INTO qmi (id, published, synced_address, updated_at, created_at)
       VALUES (?, 1, ?, datetime('now'), datetime('now'))`
    )
    .run('recapUOUOtwQWVHS1', '123 Test St');
});
afterEach(() => {
  H.sqlite.close();
});

describe('uploadImage — qmi.floor_plan_image override', () => {
  it('accepts floor_plan_image as an editable QMI column and persists the stable url', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = new File([png], 'custom-layout.png', { type: 'image/png' });

    const res = await uploadImage('qmi', 'recapUOUOtwQWVHS1', 'floor_plan_image', file);
    expect(res).toEqual({
      ok: true,
      url: 'https://media.test.local/qmi/recapUOUOtwQWVHS1/custom-layout.png',
    });

    const row = H.sqlite
      .prepare('SELECT floor_plan_image FROM qmi WHERE id = ?')
      .get('recapUOUOtwQWVHS1') as { floor_plan_image: string };
    expect(row.floor_plan_image).toBe(
      'https://media.test.local/qmi/recapUOUOtwQWVHS1/custom-layout.png'
    );
    expect(H.images.has('qmi/recapUOUOtwQWVHS1/custom-layout.png')).toBe(true);
  });
});
