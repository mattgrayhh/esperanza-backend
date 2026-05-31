'use client';

// =============================================================================
// GenericField — renders the primitive widgets that submit via the saveEntity FormData:
//   text | textarea | number | boolean | richtext(markdown textarea) | select
//   synced (read-only display, never submitted)
//
// `name` === the physical column. The value is uncontrolled (defaultValue) for plain
// fields so the parent <form action> picks it up. Booleans submit '1'/'0'; selects
// (admin id-pickers) submit the selected id or '' (cleared).
//
// Re-skinned with shadcn (base-ui) primitives — Input/Textarea/Select/Switch/Label —
// while keeping EVERY submitted field name AND value contract identical:
//   * boolean → presentational Switch driving a controlled hidden <input name=field>
//     that ALWAYS carries '1' or '0' (never '' → so it never coerces to NULL).
//   * select  → base-ui Select with name=field renders a hidden input that submits the
//     selected id or '' for "(none)", exactly like the old native <select>.
// =============================================================================

import { useState } from 'react';
import type { SelectOption } from '../../lib/select-options';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface GenericFieldProps {
  field: string;
  label: string;
  widget: 'text' | 'textarea' | 'number' | 'boolean' | 'richtext' | 'select' | 'synced';
  value: string;
  step?: 'any' | '1';
  options?: SelectOption[];
  /** static string options (e.g. testimonials.status when rendered as a plain select). */
  staticOptions?: string[];
  readOnly?: boolean;
  help?: string;
}

function FieldLabel({ label, field }: { label: string; field: string }) {
  return (
    <Label className="font-medium text-foreground">
      {label} <span className="font-mono text-xs font-normal text-muted-foreground">{field}</span>
    </Label>
  );
}

export function GenericField({
  field,
  label,
  widget,
  value,
  step,
  options,
  staticOptions,
  readOnly,
  help,
}: GenericFieldProps) {
  return (
    <div className="grid gap-1.5 text-sm">
      <FieldLabel label={label} field={field} />

      {widget === 'synced' ? (
        <span className="rounded-lg border border-dashed border-input bg-muted/40 px-2.5 py-1.5 text-muted-foreground">
          {value === '' ? '—' : value}
        </span>
      ) : widget === 'boolean' ? (
        <BooleanField field={field} value={value} />
      ) : widget === 'select' ? (
        <SelectField field={field} value={value} options={options} staticOptions={staticOptions} />
      ) : widget === 'textarea' || widget === 'richtext' ? (
        <Textarea
          name={field}
          defaultValue={value}
          rows={widget === 'richtext' ? 6 : 3}
          placeholder={widget === 'richtext' ? 'markdown' : undefined}
        />
      ) : widget === 'number' ? (
        <Input
          name={field}
          type="number"
          step={step ?? 'any'}
          defaultValue={value}
          readOnly={readOnly}
        />
      ) : (
        <Input name={field} type="text" defaultValue={value} readOnly={readOnly} />
      )}

      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}

// boolean: a Switch for presentation, plus a controlled hidden input that ALWAYS submits
// '1' or '0' so saveEntity coerces it to a real boolean (never '' → NULL).
function BooleanField({ field, value }: { field: string; value: string }) {
  const [on, setOn] = useState(value === 'true' || value === '1');
  return (
    <div className="flex h-8 items-center gap-2">
      <input type="hidden" name={field} value={on ? '1' : '0'} />
      <Switch checked={on} onCheckedChange={setOn} aria-label={field} />
      <span className="text-sm text-muted-foreground">{on ? 'true' : 'false'}</span>
    </div>
  );
}

// select: base-ui Select with `name` (hidden input submits the value). Empty option
// value '' === the old <option value="">(none)</option>.
function SelectField({
  field,
  value,
  options,
  staticOptions,
}: {
  field: string;
  value: string;
  options?: SelectOption[];
  staticOptions?: string[];
}) {
  return (
    <Select name={field} defaultValue={value}>
      <SelectTrigger className={cn('w-full')}>
        <SelectValue placeholder="(none)" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">(none)</SelectItem>
        {staticOptions
          ? staticOptions
              .filter((o) => o !== '')
              .map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))
          : (options ?? []).map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
      </SelectContent>
    </Select>
  );
}
