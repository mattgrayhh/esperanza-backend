'use client';

// =============================================================================
// CommunityFloorPlansPicker — pick which floor plans are offered in this community.
//
// The relationship is denormalized on the floor-plan side (floor_plans.communities
// CSV + community_count), so on Save → saveCommunityFloorPlans rewrites that CSV on
// each AFFECTED floor-plan row (adds this community to newly-checked plans, strips it
// from unchecked ones) and enqueues a Framer push per change. Mirrors PromoScopeTagPicker.
// =============================================================================

import { useState, useTransition } from 'react';
import { saveCommunityFloorPlans } from '../../lib/actions';
import type { SelectOption } from '../../lib/select-options';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

export function CommunityFloorPlansPicker({
  communityId,
  initialSelected,
  options,
  onResult,
}: {
  communityId: string;
  initialSelected: string[];
  options: SelectOption[];
  onResult?: (msg: string) => void;
}) {
  const [sel, setSel] = useState<string[]>(initialSelected);
  const [q, setQ] = useState('');
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const filtered = q.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
    : options;

  function onSave() {
    startTransition(async () => {
      const res = await saveCommunityFloorPlans(communityId, sel);
      onResult?.(
        res.ok
          ? res.changed === 0
            ? 'No changes'
            : `Floor plans saved (${res.changed} plan${res.changed === 1 ? '' : 's'} updated)`
          : `Error: ${res.error}`
      );
    });
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        Floor plans in this community
        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
          {sel.length}
        </Badge>
      </div>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="filter floor plans…"
        className="h-8 max-w-xs text-xs"
      />
      <Card size="sm" className="gap-1.5 p-2">
        <div className="grid max-h-72 grid-cols-1 gap-1.5 overflow-auto text-xs sm:grid-cols-2">
          {filtered.map((o) => (
            <Label key={o.id} className={cn('gap-2 font-normal')}>
              <Checkbox checked={sel.includes(o.id)} onCheckedChange={() => toggle(o.id)} />
              <span className="truncate" title={o.label}>
                {o.label}
              </span>
            </Label>
          ))}
          {filtered.length === 0 ? <span className="text-muted-foreground">no matches</span> : null}
        </div>
      </Card>
      <Button type="button" onClick={onSave} disabled={pending} className="justify-self-start">
        {pending ? 'Saving…' : 'Save floor plans'}
      </Button>
    </div>
  );
}
