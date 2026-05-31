// Minimal sidebar nav listing the 9 managed entities. Server component (no client JS).
import Link from 'next/link';
import { ENTITY_LIST } from '../lib/entities';
import { signOut } from '../lib/auth';

// Server action: sign out and return to /login.
async function doSignOut() {
  'use server';
  await signOut({ redirectTo: '/login' });
}

export function Nav({ currentUser }: { currentUser: string | null }) {
  return (
    <nav
      style={{
        width: 220,
        flex: '0 0 220px',
        borderRight: '1px solid #e5e1da',
        padding: '20px 12px',
        minHeight: '100vh',
        background: '#ffffff',
      }}
    >
      <Link href="/" style={{ fontWeight: 700, fontSize: 16, display: 'block', marginBottom: 16 }}>
        Esperanza Admin
      </Link>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
        {ENTITY_LIST.map((e) => (
          <li key={e.key}>
            <Link
              href={`/${e.segment}`}
              style={{
                display: 'block',
                padding: '8px 10px',
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              {e.label}
            </Link>
          </li>
        ))}
      </ul>
      <div
        style={{
          marginTop: 24,
          paddingTop: 16,
          borderTop: '1px solid #e5e1da',
          fontSize: 12,
          color: '#6b7280',
          wordBreak: 'break-all',
        }}
      >
        {currentUser ? `Signed in: ${currentUser}` : 'Not authenticated'}
        {currentUser && (
          <form action={doSignOut} style={{ marginTop: 10 }}>
            <button
              type="submit"
              style={{
                width: '100%',
                padding: '6px 8px',
                background: '#fff',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                color: '#374151',
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          </form>
        )}
      </div>
    </nav>
  );
}
