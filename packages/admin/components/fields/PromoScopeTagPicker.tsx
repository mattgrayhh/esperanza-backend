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
// The QMI column is GROUPED BY COMMUNITY (SelectOption.group = the home's community
// name), and a live "Where will this show" summary combines the SAVED surface
// toggles (show_site_banner / show_card_badge / show_card_cta / show_incentive_page /
// show_banner_button — edited above in the "Where it shows" group) with the CURRENT
// scope selection, so editors see surfaces + reach before publishing.
//
// Re-skinned with shadcn (Card/Checkbox/Input/Button/Badge/Label). The emitted
// PromoScope payload + savePromotionTargets call are UNCHANGED.
// =============================================================================

import { useState, useTransition } from 'react';
import { savePromotionTargets, type PromoScope } from '../../lib/actions';
import type { SelectOption } from '../../lib/select-options';
import type { PromoSurfaces } from '../EntityEditForm';
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

interface Options {
  cities: SelectOption[];
  communities: SelectOption[];
  floorPlans: SelectOption[];
  qmis: SelectOption[];
}

export function PromoScopeTagPicker({
  promoId,
  initialGlobal,
  initialSelected,
  options,
  surfaces,
  published,
  onResult,
  showStandaloneSave = false,
}: {
  promoId: string;
  initialGlobal: boolean;
  initialSelected: Selected;
  options: Options;
  /** SAVED surface toggles (the "Where it shows" booleans, as of the last save). */
  surfaces?: PromoSurfaces;
  published?: boolean;
  onResult?: (msg: string) => void;
  showStandaloneSave?: boolean;
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

  function onSave() {
    startTransition(async () => {
      const res = await savePromotionTargets(promoId, scope);
      onResult?.(res.ok ? 'Targeting saved' : `Error: ${res.error}`);
    });
  }

  return (
    <div className="grid gap-4">
      {/* Mirror the live scope into the parent <form> so the page's primary Save
          persists targets too — saveEntity reads __promo_targets. The standalone
          "Save targeting" button stays as a secondary path. */}
      <input type="hidden" name="__promo_targets" value={JSON.stringify(scope)} />
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
          <Picker title="QMIs" opts={options.qmis} sel={sel.qmis} onToggle={(o) => toggle('qmis', o)} grouped />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">This promotion applies to every page.</p>
      )}

      {surfaces ? (
        <SurfaceSummary
          surfaces={surfaces}
          published={published ?? true}
          mode={mode}
          sel={sel}
          options={options}
        />
      ) : null}

      {showStandaloneSave ? (
        <Button type="button" onClick={onSave} disabled={pending} className="justify-self-start">
          {pending ? 'Saving…' : 'Save targeting'}
        </Button>
      ) : null}
    </div>
  );
}

// =============================================================================
// "Where will this show" — a plain-language preview combining the SAVED surface
// toggles with the LIVE scope selection. Surfaces come from the last save (they
// live in the form fields above and only land on Save); the reach updates as the
// operator picks targets.
// =============================================================================
function SurfaceSummary({
  surfaces,
  published,
  mode,
  sel,
  options,
}: {
  surfaces: PromoSurfaces;
  published: boolean;
  mode: 'global' | 'scoped';
  sel: Selected;
  options: Options;
}) {
  const reach = describeReach(mode, sel, options);
  const lines: string[] = [];
  if (surfaces.siteBanner) {
    lines.push(
      `Site banner — site-wide header ticker (uses the Headline)${surfaces.bannerButton ? ', with CTA button' : ''}`
    );
  }
  if (surfaces.incentivePage) lines.push('Incentives page — featured card on /incentives');
  if (surfaces.cardBadge) lines.push(`Card badge + incentive line — on ${reach}`);
  if (surfaces.cardCta) lines.push(`Card CTA button — on ${reach}`);
  const none = lines.length === 0;

  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-sm">
      <div className="mb-1.5 font-semibold">Where will this show</div>
      {!published ? (
        <p className="mb-1.5 font-medium text-amber-700 dark:text-amber-400">
          Unpublished — hidden everywhere until the status is set to Published.
        </p>
      ) : null}
      {none ? (
        <p className="font-medium text-amber-700 dark:text-amber-400">
          No surfaces are enabled — this promotion will not appear anywhere. Turn on a
          surface in “Where it shows” above.
        </p>
      ) : (
        <ul className="grid list-disc gap-1 pl-5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        Surface toggles reflect the last save; the reach follows your current selection.
        On each page, the single most specific promotion wins (home &gt; community &gt;
        floor plan &gt; city &gt; global, then Sort Order).
      </p>
    </div>
  );
}

/** Human reach line, e.g. "12 homes in Villas on Freddy; everything in Wright Ranch". */
function describeReach(mode: 'global' | 'scoped', sel: Selected, options: Options): string {
  if (mode === 'global') return 'every community, home and floor-plan card site-wide';
  const parts: string[] = [];

  // Direct QMI picks, counted per community (options.qmis carry group = community name).
  if (sel.qmis.length > 0) {
    const byCommunity = new Map<string, number>();
    for (const id of sel.qmis) {
      const opt = options.qmis.find((o) => o.id === id);
      const g = opt?.group || 'No community';
      byCommunity.set(g, (byCommunity.get(g) ?? 0) + 1);
    }
    for (const [community, n] of [...byCommunity.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      parts.push(`${n} home${n === 1 ? '' : 's'} in ${community}`);
    }
  }

  // Whole communities: every card/page in them (home counts read the QMI groups).
  for (const id of sel.communities) {
    const name = options.communities.find((o) => o.id === id)?.label ?? id;
    const homes = options.qmis.filter((o) => o.group === name).length;
    parts.push(`everything in ${name}${homes > 0 ? ` (${homes} home${homes === 1 ? '' : 's'})` : ''}`);
  }

  // Floor-plan targets cascade onto every home built on the plan.
  for (const id of sel.floorPlans) {
    const name = options.floorPlans.find((o) => o.id === id)?.label ?? id;
    parts.push(`the ${name} plan (and homes built on it)`);
  }

  for (const id of sel.cities) {
    const name = options.cities.find((o) => o.id === id)?.label ?? id;
    parts.push(`all of ${name} (city-wide)`);
  }

  return parts.length > 0 ? parts.join('; ') : 'nothing yet — pick at least one target';
}

function Picker({
  title,
  opts,
  sel,
  onToggle,
  grouped = false,
}: {
  title: string;
  opts: SelectOption[];
  sel: string[];
  onToggle: (id: string) => void;
  /** Render options under group headers (SelectOption.group), e.g. QMIs by community. */
  grouped?: boolean;
}) {
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? opts.filter(
        (o) =>
          o.label.toLowerCase().includes(q.toLowerCase()) ||
          (o.group ?? '').toLowerCase().includes(q.toLowerCase())
      )
    : opts;

  // Group → options, headers sorted alphabetically.
  const groups = grouped
    ? [...filtered.reduce((m, o) => {
        const g = o.group ?? '';
        const arr = m.get(g);
        if (arr) arr.push(o);
        else m.set(g, [o]);
        return m;
      }, new Map<string, SelectOption[]>())].sort((a, b) => a[0].localeCompare(b[0]))
    : null;

  const row = (o: SelectOption) => (
    <Label key={o.id} className={cn('gap-2 font-normal')}>
      <Checkbox checked={sel.includes(o.id)} onCheckedChange={() => onToggle(o.id)} />
      <span className="truncate" title={o.label}>
        {o.label}
      </span>
    </Label>
  );

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
        {groups
          ? groups.map(([g, groupOpts]) => (
              <div key={g || '(none)'} className="grid gap-1.5">
                <div className="sticky top-0 flex items-center gap-1.5 bg-card pt-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {g || 'No community'}
                  <Badge variant="secondary" className="h-3.5 px-1 text-[9px] font-normal">
                    {groupOpts.filter((o) => sel.includes(o.id)).length}/{groupOpts.length}
                  </Badge>
                </div>
                {groupOpts.map(row)}
              </div>
            ))
          : filtered.map(row)}
        {filtered.length === 0 ? <span className="text-muted-foreground">no matches</span> : null}
      </div>
    </Card>
  );
}
