'use client';

// =============================================================================
// PromoScopeTagPicker — promotions targeting widget (bucket `target`).
//
// A scope picker: radio "Everything (global)" OR multi-select across
// Cities / Communities / Floor Plans / QMIs. target_type ∈ {global, city,
// community, floor_plan, qmi}. A floor-plan target cascades onto every QMI built
// on that plan (resolution: qmi > community > floor_plan > city > global).
//
// On save → savePromotionTargets REPLACES all promotion_targets rows for this promo:
//   global → one row {target_type:'global', target_id:NULL}
//   each selected id → row {target_type, target_id:<recId>}
// (DB CHECK enforces global=NULL / non-global=NOT NULL.) The action audits the replace
// and enqueues the framer push.
//
// Re-skinned with shadcn (Card/Checkbox/Input/Button/Badge/Label). The emitted
// PromoScope payload + savePromotionTargets call are UNCHANGED.
// =============================================================================

import { useState, useTransition } from 'react';
import { savePromotionTargets, type PromoScope } from '../../lib/actions';
import type { SelectOption } from '../../lib/select-options';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

interface Selected {
  cities: string[];
  communities: string[];
  floorPlans: string[];
  qmis: string[];
}

export function PromoScopeTagPicker({
  promoId,
  initialGlobal,
  initialSelected,
  options,
  onResult,
}: {
  promoId: string;
  initialGlobal: boolean;
  initialSelected: Selected;
  options: {
    cities: SelectOption[];
    communities: SelectOption[];
    floorPlans: SelectOption[];
    qmis: SelectOption[];
  };
  onResult?: (msg: string) => void;
}) {
  const [mode, setMode] = useState<'global' | 'scoped'>(initialGlobal ? 'global' : 'scoped');
  const [sel, setSel] = useState<Selected>(initialSelected);
  const [pending, startTransition] = useTransition();

  function toggle(kind: keyof Selected, optId: string) {
    setSel((prev) => {
      const has = prev[kind].includes(optId);
      return { ...prev, [kind]: has ? prev[kind].filter((x) => x !== optId) : [...prev[kind], optId] };
    });
  }

  const totalScoped =
    sel.cities.length + sel.communities.length + sel.floorPlans.length + sel.qmis.length;

  function onSave() {
    startTransition(async () => {
      const scope: PromoScope =
        mode === 'global'
          ? { type: 'global' }
          : {
              type: 'scoped',
              cities: sel.cities,
              communities: sel.communities,
              floorPlans: sel.floorPlans,
              qmis: sel.qmis,
            };
      const res = await savePromotionTargets(promoId, scope);
      onResult?.(res.ok ? 'Targeting saved' : `Error: ${res.error}`);
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex gap-6 text-sm">
        <Label className="font-normal">
          <input
            type="radio"
            className="accent-primary"
            checked={mode === 'global'}
            onChange={() => setMode('global')}
          />
          Everything (global)
        </Label>
        <Label className="font-normal">
          <input
            type="radio"
            className="accent-primary"
            checked={mode === 'scoped'}
            onChange={() => setMode('scoped')}
          />
          Scoped ({totalScoped})
        </Label>
      </div>

      {mode === 'scoped' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Picker title="Cities" opts={options.cities} sel={sel.cities} onToggle={(o) => toggle('cities', o)} />
          <Picker title="Communities" opts={options.communities} sel={sel.communities} onToggle={(o) => toggle('communities', o)} />
          <Picker title="Floor Plans" opts={options.floorPlans} sel={sel.floorPlans} onToggle={(o) => toggle('floorPlans', o)} />
          <Picker title="QMIs" opts={options.qmis} sel={sel.qmis} onToggle={(o) => toggle('qmis', o)} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">This promotion applies to every page.</p>
      )}

      <Button type="button" onClick={onSave} disabled={pending} className="justify-self-start">
        {pending ? 'Saving…' : 'Save targeting'}
      </Button>
    </div>
  );
}

function Picker({
  title,
  opts,
  sel,
  onToggle,
}: {
  title: string;
  opts: SelectOption[];
  sel: string[];
  onToggle: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
    : opts;
  return (
    <Card size="sm" className="gap-2 p-2">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        {title}
        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
          {sel.length}
        </Badge>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…" className="h-7 text-xs" />
      <div className="grid max-h-60 gap-1.5 overflow-auto text-xs">
        {filtered.map((o) => (
          <Label key={o.id} className={cn('gap-2 font-normal')}>
            <Checkbox checked={sel.includes(o.id)} onCheckedChange={() => onToggle(o.id)} />
            <span className="truncate" title={o.label}>
              {o.label}
            </span>
          </Label>
        ))}
        {filtered.length === 0 ? <span className="text-muted-foreground">no matches</span> : null}
      </div>
    </Card>
  );
}
