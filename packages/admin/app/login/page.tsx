// =============================================================================
// packages/admin — /login page (Auth.js v5 Credentials sign-in).
//
// The middleware leaves /login open (see auth.config.ts isOpenPath). The form posts to
// a server action that calls signIn('credentials', …). On success Auth.js throws a
// redirect (to callbackUrl or /); on bad credentials it throws an AuthError, which we
// translate into ?error=1 so the form can show a message. We re-throw the redirect
// (NEXT_REDIRECT) so navigation still happens.
// =============================================================================

import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { signIn } from '../../lib/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const callbackUrl = typeof sp.callbackUrl === 'string' ? sp.callbackUrl : '/';
  const hasError = sp.error != null;

  async function authenticate(formData: FormData) {
    'use server';
    const cb = String(formData.get('callbackUrl') || '/');
    try {
      await signIn('credentials', {
        email: formData.get('email'),
        password: formData.get('password'),
        redirectTo: cb,
      });
    } catch (error) {
      // signIn throws a redirect on success — let it bubble.
      if (error instanceof AuthError) {
        redirect(`/login?error=1&callbackUrl=${encodeURIComponent(cb)}`);
      }
      throw error;
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-surface)',
        padding: 24,
      }}
    >
      <form
        action={authenticate}
        style={{
          width: '100%',
          maxWidth: 360,
          background: '#fff',
          border: '1px solid #e5e1da',
          borderRadius: 12,
          padding: 28,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Esperanza Admin</h1>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>Sign in to continue.</p>

        {hasError && (
          <div
            role="alert"
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#b91c1c',
              fontSize: 13,
              borderRadius: 8,
              padding: '8px 10px',
              marginBottom: 16,
            }}
          >
            Invalid email or password.
          </div>
        )}

        <input type="hidden" name="callbackUrl" value={callbackUrl} />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Email
        </label>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '9px 11px',
            border: '1px solid #d1d5db',
            borderRadius: 8,
            fontSize: 14,
            marginBottom: 14,
          }}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Password
        </label>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '9px 11px',
            border: '1px solid #d1d5db',
            borderRadius: 8,
            fontSize: 14,
            marginBottom: 20,
          }}
        />

        <button
          type="submit"
          style={{
            width: '100%',
            padding: '10px 12px',
            background: 'var(--color-brand)',
            color: 'var(--color-brand-foreground)',
            border: 'none',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
