import Link from 'next/link';
import { ENTITY_LIST } from '../lib/entities';

export default function HomePage() {
  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Esperanza Admin</h1>
      <p style={{ color: '#4b5563', marginBottom: 24, maxWidth: 640 }}>
        Edit the 9 managed entities. Every save writes D1 (read-your-writes), records an
        audit_log entry, and enqueues a Framer push. QMI synced fields route through the
        override helper; the publish toggle is the only path that publishes.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}
      >
        {ENTITY_LIST.map((e) => (
          <Link
            key={e.key}
            href={`/${e.segment}`}
            style={{
              display: 'block',
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e5e1da',
              background: '#fff',
            }}
          >
            <div style={{ fontWeight: 600 }}>{e.label}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>/{e.segment}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
