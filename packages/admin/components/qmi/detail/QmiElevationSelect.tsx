'use client';

// =============================================================================
// QmiElevationSelect — VISUAL picker for which ELEVATION this spec home is.
//
// Shows the linked floor plan's elevation renderings as a thumbnail grid (image +
// label). Selecting one sets the hero image (the gallery entry whose `type` matches)
// on the live site and in the admin preview.
//
// Storage: no new column. The selected gallery `type` ("<Style> <Material>") is split
// on the LAST space → override_elevation_type (style) + override_material_type
// (material), submitted under the existing override field names, so the normal QMI
// Save persists them via buildOverrideWrite (actions.ts). "Match plan default" submits
// '' for both → clears the overrides (home follows its Snowflake-synced elevation).
// =============================================================================

import { useState } from 'react';
import { CheckIcon } from 'lucide-react';
import { FieldLabel } from '@/components/fields/FieldLabel';
import { cn } from '@/lib/utils';

export function QmiElevationSelect({
  options,
  selection,
}: {
  /** The linked plan's elevation renderings (deduped by type). */
  options: { url: string; type: string }[];
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
        help="Pick the elevation this home was built as — the hero image on the live site changes to the matching plan rendering. “Match plan default” clears it and follows the synced elevation."
      />
      {/* Submitted overrides — split from the picked gallery type. */}
      <input type="hidden" name="elevation_type" value={style} />
      <input type="hidden" name="material_type" value={material} />

      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This home’s floor plan has no elevation renderings to choose from.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {options.map((o) => {
            const selected = value.toLowerCase() === o.type.toLowerCase();
            return (
              <button
                key={o.type}
                type="button"
                aria-pressed={selected}
                onClick={() => setValue(selected ? '' : o.type)}
                className={cn(
                  'group/elev relative overflow-hidden rounded-lg border text-left transition-colors',
                  selected ? 'border-primary ring-2 ring-primary/40' : 'border-input hover:border-ring'
                )}
              >
                <div className="relative aspect-[4/3] w-full bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={o.url}
                    alt={o.type}
                    className="absolute inset-0 size-full object-cover"
                    loading="lazy"
                  />
                  {selected ? (
                    <span className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <CheckIcon className="size-3.5" />
                    </span>
                  ) : null}
                </div>
                <span className="block truncate px-2 py-1 text-xs font-medium text-foreground">
                  {o.type}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {value !== '' ? (
        <button
          type="button"
          onClick={() => setValue('')}
          className="mt-0.5 w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Match plan default
        </button>
      ) : null}
    </div>
  );
}
