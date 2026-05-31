'use client';

// =============================================================================
// QmiPriceCard — base (floor-plan from-price) vs current (this home) pricing, in the
// market-value-style card from bundui. Shows the override indicator when the current
// price is admin-pinned (override_price set). Presentational only — the price EDIT
// lives in the synced/override form (SyncedOverrideField name="price").
// =============================================================================

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

function usd(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function QmiPriceCard({
  basePrice,
  currentPrice,
  hasOverride,
}: {
  basePrice: number | null;
  currentPrice: number | null;
  hasOverride: boolean;
}) {
  const delta =
    basePrice != null && currentPrice != null ? currentPrice - basePrice : null;
  const up = delta != null && delta > 0;
  const down = delta != null && delta < 0;

  return (
    <Card className="py-5">
      <CardContent className="space-y-4 px-5">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Current price (this home)</p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-3xl font-bold">{usd(currentPrice)}</p>
            {hasOverride ? (
              <Badge
                variant="secondary"
                className="h-5 text-amber-700 uppercase dark:text-amber-400"
              >
                override
              </Badge>
            ) : null}
          </div>
        </div>

        <Separator />

        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Base price (plan from-price)</p>
          <p className="text-xl font-semibold">{usd(basePrice)}</p>
        </div>

        {delta != null && delta !== 0 ? (
          <p
            className={
              up
                ? 'inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400'
                : down
                  ? 'inline-flex items-center gap-1 text-sm text-destructive'
                  : 'text-sm text-muted-foreground'
            }
          >
            {up ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}
            {usd(Math.abs(delta))} {up ? 'above' : 'below'} base
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">At base price.</p>
        )}
      </CardContent>
    </Card>
  );
}
