// =============================================================================
// esperanza-cf framer-push — shared queue/contract types.
//
// The cron-lookback producer AND the admin worker both enqueue the SAME message
// shape onto esperanza-framer-queue. The consumer reads the FULL per-entity field
// set from D1 by `id` (it does NOT trust enqueued field values) — so the message
// only needs to say WHICH collection + WHICH record + WHAT action.
// =============================================================================

/** The 9 managed-collection keys (== CRON_TABLES keys == webhook route keys). */
export type CollectionKey =
  | 'floor_plans'
  | 'qmi'
  | 'communities'
  | 'collections'
  | 'images'
  | 'blogs'
  | 'promotions'
  | 'cities'
  | 'testimonials';

export const COLLECTION_KEYS: CollectionKey[] = [
  'floor_plans',
  'qmi',
  'communities',
  'collections',
  'images',
  'blogs',
  'promotions',
  'cities',
  'testimonials',
];

/**
 * Queue message. `action:"upsert"` → consumer reads the row from D1, maps, and
 * addItems (which itself upserts by id; if the row is unpublished/draft the mapper
 * still emits it with draft:true — soft-delete, item kept but hidden).
 * `action:"delete"` → consumer removeItems([id]) (hard delete; used by the admin
 * on a true record deletion). If the row is simply missing on an upsert read, the
 * consumer treats it as a delete (it was removed before the message drained).
 */
export interface FramerSyncMessage {
  collection: CollectionKey;
  action: 'upsert' | 'delete';
  /** D1 / Airtable record id (recXXXX) — the Framer upsert key. */
  id: string;
}

/** Minimal D1 surface (matches packages/ingest consumer's D1Like). */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(colName?: string): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

/** Cloudflare Queues producer binding (the subset we use). */
export interface QueueProducer {
  send(body: unknown): Promise<void>;
  sendBatch(messages: { body: unknown }[]): Promise<void>;
}

// -- Queues consumer glue (typed loosely so the module stays testable) --
export interface QueueMessageLike<Body> {
  body: Body;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
export interface MessageBatchLike<Body> {
  messages: QueueMessageLike<Body>[];
}
