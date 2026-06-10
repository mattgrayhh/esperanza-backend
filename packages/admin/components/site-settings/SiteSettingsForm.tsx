'use client';

// =============================================================================
// SiteSettingsForm — Settings → Site Settings client form (migration 0013).
//
// One field today: Mortgage Rate (%). Saving calls the saveSiteSettings action,
// which validates, writes D1 + audit_log, and purges the public settings API
// cache — the Framer mortgage calculators fetch that endpoint on page load, so
// the new rate is live across every community / home / financing calculator
// within moments of saving.
// =============================================================================

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PercentIcon, CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { saveSiteSettings } from '../../lib/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function SiteSettingsForm({
  mortgageRate,
  updatedBy,
  updatedAt,
}: {
  mortgageRate: string;
  updatedBy: string | null;
  updatedAt: string | null;
}) {
  const router = useRouter();
  const [rate, setRate] = useState(mortgageRate);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<'ok' | string | null>(null);

  function save() {
    setResult(null);
    startTransition(async () => {
      const res = await saveSiteSettings({ mortgage_rate: rate });
      setResult(res.ok ? 'ok' : res.error);
      if (res.ok) router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PercentIcon className="size-4 text-primary" />
          Mortgage Rate
        </CardTitle>
        <CardDescription>
          The interest rate every payment calculator on the website uses — community
          pages, home pages, and the financing page. Update it here and the whole site
          follows within moments.
          {updatedAt ? (
            <>
              {' '}
              Last updated {new Date(updatedAt).toLocaleDateString()}
              {updatedBy ? ` by ${updatedBy}` : ''}.
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.01"
            min="0"
            max="25"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            className="max-w-36"
            aria-label="Mortgage Rate (%)"
          />
          <span className="text-sm text-muted-foreground">% APR</span>
          <Button size="sm" onClick={save} disabled={pending || rate.trim() === ''}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {result === 'ok' && !pending && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleCheckIcon className="size-3.5 text-primary" />
            Saved — calculators site-wide now use {rate}%.
          </span>
        )}
        {result != null && result !== 'ok' && !pending && (
          <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
            <TriangleAlertIcon className="size-3.5" />
            {result}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
