'use client';

// =============================================================================
// GenericField — renders the primitive widgets that submit via the saveEntity FormData:
//   text | textarea | number | boolean | richtext(markdown textarea) | select
//   synced (read-only display, never submitted)
//
// `name` === the physical column. The value is uncontrolled (defaultValue) for plain
// fields so the parent <form action> picks it up. Booleans submit '1'/'0'; selects
// (admin id-pickers) submit the selected id or '' (cleared).
// =============================================================================

import type { SelectOption } from '../../lib/select-options';

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
  const labelEl = (
    <span className="font-medium text-gray-700">
      {label} <span className="font-mono text-xs text-gray-400">{field}</span>
    </span>
  );
  const inputBase = 'rounded border border-[#d8d3ca] px-2 py-1.5';

  return (
    <label className="grid gap-1 text-sm">
      {labelEl}
      {widget === 'synced' ? (
        <span className="rounded border border-dashed border-[#d8d3ca] bg-[#faf9f6] px-2 py-1.5 text-gray-500">
          {value === '' ? '—' : value}
        </span>
      ) : widget === 'boolean' ? (
        <select name={field} defaultValue={value === 'true' || value === '1' ? '1' : '0'} className={`${inputBase} bg-white`}>
          <option value="1">true</option>
          <option value="0">false</option>
        </select>
      ) : widget === 'select' ? (
        <select name={field} defaultValue={value} className={`${inputBase} bg-white`}>
          <option value="">(none)</option>
          {staticOptions
            ? staticOptions
                .filter((o) => o !== '')
                .map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))
            : (options ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
        </select>
      ) : widget === 'textarea' || widget === 'richtext' ? (
        <textarea
          name={field}
          defaultValue={value}
          rows={widget === 'richtext' ? 6 : 3}
          placeholder={widget === 'richtext' ? 'markdown' : undefined}
          className={inputBase}
        />
      ) : widget === 'number' ? (
        <input name={field} type="number" step={step ?? 'any'} defaultValue={value} readOnly={readOnly} className={inputBase} />
      ) : (
        <input name={field} type="text" defaultValue={value} readOnly={readOnly} className={inputBase} />
      )}
      {help ? <span className="text-xs text-gray-400">{help}</span> : null}
    </label>
  );
}
