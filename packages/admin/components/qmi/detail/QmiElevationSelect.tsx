'use client';

// =============================================================================
// QmiElevationSelect — picks which ELEVATION this spec home is, from the linked
// floor plan's typed elevation gallery. The choice drives the hero image (the
// gallery entry whose `type` matches) both in the admin preview and on the site.
//
// Storage: no new column. The selected gallery `type` ("<Style> <Material>") is
// split on the LAST space → override_elevation_type (style) + override_material_type
// (material). Both submit under the existing override field names, so the normal
// QMI Save persists them through the standard buildOverrideWrite path (actions.ts).
// The blank "(match plan default)" option submits '' for both → clears the overrides
// (the home follows its Snowflake-synced elevation again).
// =============================================================================

import { useState } from 'react';
import { FieldLabel } from '@/components/fields/FieldLabel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function QmiElevationSelect({
  options,
  selection,
}: {
  /** The linked plan's gallery `type` labels (deduped, non-empty). */
  options: string[];
  /** Composed effective elevation when it matches an option, else '' (plan default). */
  selection: string;
}) {
  const [value, setValue] = useState(selection);

  // Split the gallery type on the LAST space: "Traditional Brick" → style/material,
  // single-word "Farmhouse" → style only. '' (plan default) → both blank (clears override).
  const idx = value.lastIndexOf(' ');
  const style = idx === -1 ? value : value.slice(0, idx);
  const material = idx === -1 ? '' : value.slice(idx + 1);

  return (
    <div className="grid gap-1.5 text-sm">
      <FieldLabel
        label="Elevation"
        help="Which elevation this home is — sets the hero image to the matching plan rendering. Choose “(match plan default)” to clear it and follow the synced elevation."
      />
      {/* The submitted overrides — split from the picked gallery type. */}
      <input type="hidden" name="elevation_type" value={style} />
      <input type="hidden" name="material_type" value={material} />
      <Select value={value} onValueChange={(v) => setValue((v as string) ?? '')}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="(match plan default)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">(match plan default)</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
