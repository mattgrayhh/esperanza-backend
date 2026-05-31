import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppShell } from '../components/app-shell';
import { getCurrentUserOrNull, signOut } from '../lib/auth';
import { Geist, Overpass } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});
// Esperanza headings — Overpass (brand display face); body stays on Geist sans.
const overpass = Overpass({subsets:['latin'],weight:['400','500','600','700'],variable:'--font-heading'});

export const metadata: Metadata = {
  title: 'Esperanza Admin',
  description: 'Esperanza Homes CMS admin — D1 + R2 + Framer push.',
  robots: { index: false, follow: false },
};

// Admin is fully dynamic + auth-gated; never statically cache a page.
export const dynamic = 'force-dynamic';

// Server action: sign out and return to /login. Wraps the existing Auth.js
// signOut UNCHANGED — the re-skinned NavUser just posts a form to this.
async function doSignOut() {
  'use server';
  await signOut({ redirectTo: '/login' });
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const currentUser = await getCurrentUserOrNull();
  // When there is no identity (e.g. the /login page, which the middleware leaves
  // open) render a bare full-width shell — no app shell for a signed-out user.
  if (!currentUser) {
    return (
      <html lang="en" className={cn("font-sans", geist.variable, overpass.variable)}>
        <body style={{ margin: 0 }}>{children}</body>
      </html>
    );
  }
  return (
    <html lang="en" className={cn("font-sans", geist.variable, overpass.variable)}>
      <body style={{ margin: 0 }}>
        <AppShell email={currentUser} signOutAction={doSignOut}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
