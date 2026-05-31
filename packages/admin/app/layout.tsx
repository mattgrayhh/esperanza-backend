import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Nav } from './nav';
import { getCurrentUserOrNull } from '../lib/auth';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'Esperanza Admin',
  description: 'Esperanza Homes CMS admin — D1 + R2 + Framer push.',
  robots: { index: false, follow: false },
};

// Admin is fully dynamic + auth-gated; never statically cache a page.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const currentUser = await getCurrentUserOrNull();
  // When there is no identity (e.g. the /login page, which the middleware leaves
  // open) render a bare full-width shell — no entity sidebar for a signed-out user.
  if (!currentUser) {
    return (
      <html lang="en" className={cn("font-sans", geist.variable)}>
        <body style={{ margin: 0 }}>{children}</body>
      </html>
    );
  }
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <Nav currentUser={currentUser} />
          <main style={{ flex: 1, padding: '24px 32px', maxWidth: 1100 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
