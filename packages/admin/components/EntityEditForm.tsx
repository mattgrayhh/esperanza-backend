'use client';

// =============================================================================
// EntityEditForm — the CONFIG-DRIVEN edit engine (client). One component renders the
// editor for ANY of the 9 entities from a resolved field list.
//
// Layout: a publish-gate control in the header (if any), then the form. Inside the
// <form action={saveEntity}>:
//   - override fields  → SyncedOverrideField (routes through buildOverrideWrite/Audit)
//   - synced fields    → read-only GenericField('synced')
//   - admin fields     → GenericField (text/textarea/number/boolean/richtext/select)
//                        or ImageUploader (image widget)
// The publish-bucket gate field is NOT a form input — it's the header toggle (its own
// action). The custom side-widgets (hoaLinks / jsonBlocks / promoScopeTag) render
// BELOW the form with their own save buttons, since they call dedicated actions.
//
// All view data is precomputed server-side (RSC) and passed in as plain JSON so this
// stays a thin presentational shell.
// =============================================================================

import { useState, useTransition } from 'react';
import { saveEntity } from '../lib/actions';
import { GenericField } from './fields/GenericField';
import { ImageUploader } from './fields/ImageUploader';
import { SyncedOverrideField } from './fields/SyncedOverrideField';
import { PublishedToggle } from './fields/PublishedToggle';
import { HoaLinksEditor } from './fields/HoaLinksEditor';
import { JsonBlocksEditor } from './fields/JsonBlocksEditor';
import { PromoScopeTagPicker } from './fields/PromoScopeTagPicker';
import type { SelectOption } from '../lib/select-options';

// --- the per-field view model the RSC builds (one of these unions per field) ---

export type FieldView =
  | {
      kind: 'generic';
      field: string;
      label: string;
      widget: 'text' | 'textarea' | 'number' | 'boolean' | 'richtext' | 'select' | 'synced';
      value: string;
      step?: 'any' | '1';
      options?: SelectOption[];
      staticOptions?: string[];
      readOnly?: boolean;
      help?: string;
    }
  | {
      kind: 'image';
      field: string;
      label: string;
      value: string;
      help?: string;
    }
  | {
      kind: 'syncedOverride';
      field: string;
      label: string;
      variant: 'text' | 'number' | 'select';
      syncedDisplay: string;
      overrideValue: string;
      step?: 'any' | '1';
      options?: SelectOption[];
      help?: string;
    };

export interface PublishGateView {
  gate: 'published' | 'active' | 'status';
  published?: boolean;
  status?: string;
  statusOptions?: string[];
}

export interface HoaLinksView {
  kind: 'hoaLinks';
  initial: Array<{ title: string; link: string }>;
}
export interface JsonBlocksView {
  kind: 'jsonBlocks';
  copy: Record<string, string>;
  venue: Record<string, string>;
}
export interface PromoScopeView {
  kind: 'promoScope';
  global: boolean;
  selected: { cities: string[]; communities: string[]; qmis: string[] };
  options: { cities: SelectOption[]; communities: SelectOption[]; qmis: SelectOption[] };
}
export type SideWidget = HoaLinksView | JsonBlocksView | PromoScopeView;

export function EntityEditForm({
  entityKey,
  segment,
  label,
  id,
  fields,
  publishGate,
  sideWidgets,
}: {
  entityKey: string;
  segment: string;
  label: string;
  id: string;
  fields: FieldView[];
  publishGate: PublishGateView | null;
  sideWidgets: SideWidget[];
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await saveEntity(entityKey, id, formData);
      setMsg(res.ok ? 'Saved' : `Error: ${res.error}`);
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <a href={`/${segment}`} className="text-sm text-gray-500 hover:underline">
          ← {label}
        </a>
        <h1 className="text-lg font-bold">{label.replace(/s$/, '')} {id}</h1>
        {publishGate ? (
          <PublishedToggle
            entityKey={entityKey}
            id={id}
            gate={publishGate.gate}
            initialPublished={publishGate.published}
            initialStatus={publishGate.status}
            statusOptions={publishGate.statusOptions}
            onResult={setMsg}
          />
        ) : null}
        {msg ? <span className="text-sm text-gray-700">{msg}</span> : null}
      </div>

      <form action={onSubmit} className="grid max-w-2xl gap-3">
        {fields.map((f) => {
          if (f.kind === 'image') {
            return (
              <ImageUploader
                key={f.field}
                entity={segment}
                id={id}
                field={f.field}
                label={f.label}
                initialUrl={f.value}
                help={f.help}
              />
            );
          }
          if (f.kind === 'syncedOverride') {
            return (
              <SyncedOverrideField
                key={f.field}
                field={f.field}
                label={f.label}
                variant={f.variant}
                syncedDisplay={f.syncedDisplay}
                overrideValue={f.overrideValue}
                step={f.step}
                options={f.options}
                help={f.help}
              />
            );
          }
          return (
            <GenericField
              key={f.field}
              field={f.field}
              label={f.label}
              widget={f.widget}
              value={f.value}
              step={f.step}
              options={f.options}
              staticOptions={f.staticOptions}
              readOnly={f.readOnly}
              help={f.help}
            />
          );
        })}
        <button
          type="submit"
          disabled={pending}
          className="mt-1 justify-self-start rounded-md bg-[#2f5d4a] px-4 py-2 text-sm text-white disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>

      {sideWidgets.map((w, i) => (
        <SideWidgetBlock key={i} entityKey={entityKey} id={id} widget={w} onResult={setMsg} />
      ))}
    </div>
  );
}

function SideWidgetBlock({
  id,
  widget,
  onResult,
}: {
  entityKey: string;
  id: string;
  widget: SideWidget;
  onResult: (msg: string) => void;
}) {
  if (widget.kind === 'hoaLinks') {
    return (
      <section className="mt-8">
        <h2 className="mb-2 text-base font-semibold">HOA Links</h2>
        <HoaLinksEditor id={id} initial={widget.initial} onResult={onResult} />
      </section>
    );
  }
  if (widget.kind === 'jsonBlocks') {
    return (
      <section className="mt-8">
        <h2 className="mb-2 text-base font-semibold">Content Blocks</h2>
        <JsonBlocksEditor id={id} initialCopy={widget.copy} initialVenue={widget.venue} onResult={onResult} />
      </section>
    );
  }
  // promoScope
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-base font-semibold">Targeting Scope</h2>
      <PromoScopeTagPicker
        promoId={id}
        initialGlobal={widget.global}
        initialSelected={widget.selected}
        options={widget.options}
        onResult={onResult}
      />
    </section>
  );
}
