'use client';

// =============================================================================
// SyncedOverrideField — the QMI synced_/override_ widget.
//
// Renders the Snowflake-synced value as muted helper text and an override input.
//   - A non-blank input PINS an admin override (survives ingest).
//   - A BLANK input REVERTS to synced (the engine sends '' → coerced to NULL →
//     buildOverrideWrite sets override_<field> = NULL).
//
// The input's `name` is the QmiOverridableField logical name (e.g. `price`,
// `floor_plan_id`); saveEntity routes it through buildOverrideWrite/buildOverrideAudit.
//
// Variants:
//   text          — free text
//   number        — numeric (step controls .5 vs integer)
//   select        — pick a related record by id (floor_plan/community/city). The
//                   muted helper shows the synced human NAME (displayLabel), not the id.
// =============================================================================

import { useState } from 'react';
import type { SelectOption } from '../../lib/select-options';

export interface SyncedOverrideFieldProps {
  field: string;
  label: string;
  /** synced value, formatted for display (raw column value as string). */
  syncedDisplay: string;
  /** current override value (empty string = no override / follows synced). */
  overrideValue: string;
  /** 'text' | 'number' | 'select' */
  variant: 'text' | 'number' | 'select';
  step?: 'any' | '1';
  /** select options when variant === 'select'. */
  options?: SelectOption[];
  help?: string;
}

export function SyncedOverrideField({
  field,
  label,
  syncedDisplay,
  overrideValue,
  variant,
  step,
  options,
  help,
}: SyncedOverrideFieldProps) {
  const [value, setValue] = useState(overrideValue);
  const overriding = value.trim() !== '';

  const muted =
    syncedDisplay.trim() === ''
      ? 'Snowflake: (empty) — leave blank to follow Snowflake'
      : `Snowflake: ${syncedDisplay} — leave blank to follow Snowflake`;

  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium text-gray-700">
        {label} <span className="font-mono text-xs text-gray-400">{field}</span>
        {overriding ? (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            override
          </span>
        ) : null}
      </span>

      {variant === 'select' ? (
        <select
          name={field}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded border border-[#d8d3ca] bg-white px-2 py-1.5"
        >
          <option value="">(follow Snowflake)</option>
          {(options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={field}
          type={variant === 'number' ? 'number' : 'text'}
          step={variant === 'number' ? (step ?? 'any') : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="blank = follow Snowflake"
          className="rounded border border-[#d8d3ca] px-2 py-1.5"
        />
      )}

      <span className="text-xs text-gray-400">{muted}</span>
      {help ? <span className="text-xs text-gray-400">{help}</span> : null}
    </label>
  );
}
