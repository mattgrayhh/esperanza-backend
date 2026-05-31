'use client';

// =============================================================================
// PromoScopeTagPicker — promotions targeting widget (bucket `target`).
//
// A scope picker: radio "Everything (global)" OR multi-select across
// Cities / Communities / QMIs. target_type ∈ {global, city, community, qmi} (NO
// floor_plan/collection — intentional per operator).
//
// On save → savePromotionTargets REPLACES all promotion_targets rows for this promo:
//   global → one row {target_type:'global', target_id:NULL}
//   each selected id → row {target_type, target_id:<recId>}
// (DB CHECK enforces global=NULL / non-global=NOT NULL.) The action audits the replace
// and enqueues the framer push.
// =============================================================================

import { useState, useTransition } from 'react';
import { savePromotionTargets, type PromoScope } from '../../lib/actions';
import type { SelectOption } from '../../lib/select-options';

interface Selected {
  cities: string[];
  communities: string[];
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
  options: { cities: SelectOption[]; communities: SelectOption[]; qmis: SelectOption[] };
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

  const totalScoped = sel.cities.length + sel.communities.length + sel.qmis.length;

  function onSave() {
    startTransition(async () => {
      const scope: PromoScope =
        mode === 'global'
          ? { type: 'global' }
          : { type: 'scoped', cities: sel.cities, communities: sel.communities, qmis: sel.qmis };
      const res = await savePromotionTargets(promoId, scope);
      onResult?.(res.ok ? 'Targeting saved' : `Error: ${res.error}`);
    });
  }

  return (
    <div className="grid gap-3">
      <div className="flex gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'global'} onChange={() => setMode('global')} />
          Everything (global)
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'scoped'} onChange={() => setMode('scoped')} />
          Scoped ({totalScoped})
        </label>
      </div>

      {mode === 'scoped' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Picker title="Cities" opts={options.cities} sel={sel.cities} onToggle={(o) => toggle('cities', o)} />
          <Picker title="Communities" opts={options.communities} sel={sel.communities} onToggle={(o) => toggle('communities', o)} />
          <Picker title="QMIs" opts={options.qmis} sel={sel.qmis} onToggle={(o) => toggle('qmis', o)} />
        </div>
      ) : (
        <p className="text-sm text-gray-500">This promotion applies to every page.</p>
      )}

      <button
        type="button"
        onClick={onSave}
        disabled={pending}
        className="justify-self-start rounded-md bg-[#2f5d4a] px-4 py-2 text-sm text-white disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save targeting'}
      </button>
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
    <div className="rounded-lg border border-[#e5e1da] bg-white p-2">
      <div className="mb-1 text-sm font-semibold">
        {title} <span className="text-xs font-normal text-gray-400">({sel.length})</span>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="filter…"
        className="mb-2 w-full rounded border border-[#d8d3ca] px-2 py-1 text-xs"
      />
      <div className="grid max-h-60 gap-1 overflow-auto text-xs">
        {filtered.map((o) => (
          <label key={o.id} className="flex items-center gap-2">
            <input type="checkbox" checked={sel.includes(o.id)} onChange={() => onToggle(o.id)} />
            <span className="truncate" title={o.label}>
              {o.label}
            </span>
          </label>
        ))}
        {filtered.length === 0 ? <span className="text-gray-400">no matches</span> : null}
      </div>
    </div>
  );
}
