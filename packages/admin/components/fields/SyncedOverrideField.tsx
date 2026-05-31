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
//
// Re-skinned with shadcn primitives (Input/Select/Label/Badge). The control stays
// CONTROLLED (useState) so the override chip toggles live and a cleared value still
// submits '' (revert). base-ui Select with `name` submits via a hidden input; the empty
// option '' === "(follow Snowflake)".
// =============================================================================

import { useState } from 'react';
import type { SelectOption } from '../../lib/select-options';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
    <div className="grid gap-1.5 text-sm">
      <Label className="font-medium text-foreground">
        {label} <span className="font-mono text-xs font-normal text-muted-foreground">{field}</span>
        {overriding ? (
          <Badge
            variant="secondary"
            className="ml-1 h-4 px-1.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400"
          >
            override
          </Badge>
        ) : null}
      </Label>

      {variant === 'select' ? (
        <Select name={field} value={value} onValueChange={(v) => setValue((v as string) ?? '')}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="(follow Snowflake)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">(follow Snowflake)</SelectItem>
            {(options ?? []).map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          name={field}
          type={variant === 'number' ? 'number' : 'text'}
          step={variant === 'number' ? (step ?? 'any') : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="blank = follow Snowflake"
        />
      )}

      <span className="text-xs text-muted-foreground">{muted}</span>
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
