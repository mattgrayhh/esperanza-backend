'use client';

// =============================================================================
// SyncNowButton — dashboard "Sync now" (client feedback 2026-06-10).
//
// Fires the triggerIngestSync server action (ingest POST /run: the same
// Snowflake→D1 reconciliation the 4-hour cron runs, on demand). Admin edits
// already reach the website quickly via API cache purge — this button is for
// pulling MARK SYSTEMS changes through without waiting for the next cron tick.
// The run is fire-to-completion server-side (typically tens of seconds: Snowflake
// login + diff + queue drain), so we show a spinner, then a settled state.
// =============================================================================

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCwIcon, CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { triggerIngestSync } from '../lib/actions';
import { Button } from '@/components/ui/button';

export function SyncNowButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<'ok' | string | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      const res = await triggerIngestSync();
      setResult(res.ok ? 'ok' : res.error);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {result === 'ok' && !pending && (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleCheckIcon className="size-3.5 text-primary" />
          Synced from Mark Systems
        </span>
      )}
      {result != null && result !== 'ok' && !pending && (
        <span
          className="inline-flex items-center gap-1.5 text-xs text-destructive"
          title={result}
        >
          <TriangleAlertIcon className="size-3.5" />
          Sync failed
        </span>
      )}
      <Button size="sm" variant="outline" onClick={run} disabled={pending}>
        <RefreshCwIcon className={pending ? 'animate-spin' : undefined} />
        {pending ? 'Syncing…' : 'Sync now'}
      </Button>
    </div>
  );
}
