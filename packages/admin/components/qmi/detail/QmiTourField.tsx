'use client';

// =============================================================================
// QmiTourField — Virtual Tour URL as a synced-style locked/unlock control.
//
// A QMI's tour is assigned to its FLOOR PLAN. So by default this shows the plan's
// tour URL, grayed + locked (like the Snowflake-synced fields). Checking "Unlock to
// override" lets the operator paste a per-home tour.
//
// Submission: the plain `virtual_tour_url` column (no synced_/override_ pair).
//   - locked            → submits '' → qmi.virtual_tour_url stays empty and
//                          v_public_qmi COALESCEs it to the floor plan's tour (inherit).
//   - unlocked + value  → pins that per-home tour (COALESCE picks it over the plan).
// The visible locked input carries no name; a hidden input owns the submitted value.
// =============================================================================

import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { FieldLabel } from '@/components/fields/FieldLabel';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';

export function QmiTourField({
  planTour,
  ownValue,
}: {
  /** The linked floor plan's virtual_tour_url (the inherited default). */
  planTour: string;
  /** The QMI's own virtual_tour_url (empty = inherit the plan). */
  ownValue: string;
}) {
  const [value, setValue] = useState(ownValue);
  // Locked by default; an existing per-home tour arrives unlocked (it's pinned).
  const [unlocked, setUnlocked] = useState(ownValue.trim() !== '');
  const checkboxId = useId();

  const overriding = unlocked && value.trim() !== '';
  const planShown = planTour.trim() === '' ? '(none set on the floor plan)' : planTour;

  return (
    <div className="grid gap-1.5 text-sm">
      <FieldLabel
        label="Virtual Tour URL"
        help="Assigned to the home's floor plan. Unlock to set a per-home tour instead."
      >
        {overriding ? (
          <Badge className="h-4 border-warning/30 bg-warning/10 px-1.5 text-[10px] font-semibold tracking-wide text-warning uppercase">
            override
          </Badge>
        ) : (
          <Badge
            variant="secondary"
            className="h-4 px-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
          >
            from floor plan
          </Badge>
        )}
      </FieldLabel>

      {/* Submitted value: the per-home tour only when unlocked; else '' → inherit the plan. */}
      <input type="hidden" name="virtual_tour_url" value={unlocked ? value : ''} />

      {unlocked ? (
        <Input
          type="url"
          inputMode="url"
          placeholder="https://…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <Input type="url" value={planShown} disabled aria-label="Virtual Tour URL (from floor plan)" />
      )}

      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          checked={unlocked}
          onCheckedChange={(c) => setUnlocked(c === true)}
        />
        <Label htmlFor={checkboxId} className="text-xs font-normal text-muted-foreground">
          Unlock to override
        </Label>
      </div>
    </div>
  );
}
