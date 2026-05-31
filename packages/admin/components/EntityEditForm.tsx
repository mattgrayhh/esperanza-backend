'use client';

// =============================================================================
// EntityEditForm — the CONFIG-DRIVEN edit engine (client). One component renders the
// editor for ANY of the 9 entities from a resolved field list.
//
// Layout: a header (back link + title + publish-gate toggle + save status), then a
// two-column body INSIDE one <form action={saveEntity}>:
//   - MAIN column (left): override / synced / admin fields
//       · override fields  → SyncedOverrideField (routes through buildOverrideWrite/Audit)
//       · synced fields    → read-only GenericField('synced')
//       · admin fields     → GenericField (text/textarea/number/boolean/richtext/select)
//   - RIGHT RAIL: the image widgets (ImageUploader). These STILL live inside the same
//       <form>, so they submit into the same saveEntity FormData (field names unchanged).
// The publish-bucket gate field is NOT a form input — it's the header toggle (its own
// action). The custom side-widgets (hoaLinks / jsonBlocks / promoScopeTag) render
// BELOW the form with their own save buttons, since they call dedicated actions.
//
// All view data is precomputed server-side (RSC) and passed in as plain JSON so this
// stays a thin presentational shell.
//
// Re-skinned with shadcn (Card/Button/Badge/Separator). Every field NAME and the
// <form action={saveEntity}> submission are UNCHANGED.
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
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ArrowLeftIcon } from 'lucide-react';

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

  // Split fields: image widgets go to the right rail; everything else to the main column.
  const imageFields = fields.filter((f) => f.kind === 'image');
  const mainFields = fields.filter((f) => f.kind !== 'image');

  const singular = label.replace(/s$/, '');
  const isError = msg != null && msg.startsWith('Error:');

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <a
          href={`/${segment}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" /> {label}
        </a>
        <h1 className="font-heading text-lg font-bold">
          {singular} <span className="font-mono text-sm font-normal text-muted-foreground">{id}</span>
        </h1>
        <div className="ml-auto flex items-center gap-3">
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
          {msg ? (
            <Badge variant={isError ? 'destructive' : 'secondary'} className="h-5">
              {msg}
            </Badge>
          ) : null}
        </div>
      </div>

      <form action={onSubmit}>
        <div className={cn('grid gap-5', imageFields.length ? 'lg:grid-cols-[1fr_20rem]' : 'grid-cols-1')}>
          {/* MAIN column */}
          <Card>
            <CardHeader className="border-b">
              <CardTitle>Fields</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {mainFields.map((f) => {
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
              <Separator />
              <Button type="submit" disabled={pending} className="justify-self-start">
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </CardContent>
          </Card>

          {/* RIGHT RAIL: image widgets (still inside the form → same FormData). */}
          {imageFields.length ? (
            <Card className="self-start">
              <CardHeader className="border-b">
                <CardTitle>Media</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                {imageFields.map((f) =>
                  f.kind === 'image' ? (
                    <ImageUploader
                      key={f.field}
                      entity={segment}
                      id={id}
                      field={f.field}
                      label={f.label}
                      initialUrl={f.value}
                      help={f.help}
                    />
                  ) : null
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
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
      <Card className="mt-6">
        <CardHeader className="border-b">
          <CardTitle>HOA Links</CardTitle>
        </CardHeader>
        <CardContent>
          <HoaLinksEditor id={id} initial={widget.initial} onResult={onResult} />
        </CardContent>
      </Card>
    );
  }
  if (widget.kind === 'jsonBlocks') {
    return (
      <Card className="mt-6">
        <CardHeader className="border-b">
          <CardTitle>Content Blocks</CardTitle>
        </CardHeader>
        <CardContent>
          <JsonBlocksEditor id={id} initialCopy={widget.copy} initialVenue={widget.venue} onResult={onResult} />
        </CardContent>
      </Card>
    );
  }
  // promoScope
  return (
    <Card className="mt-6">
      <CardHeader className="border-b">
        <CardTitle>Targeting Scope</CardTitle>
      </CardHeader>
      <CardContent>
        <PromoScopeTagPicker
          promoId={id}
          initialGlobal={widget.global}
          initialSelected={widget.selected}
          options={widget.options}
          onResult={onResult}
        />
      </CardContent>
    </Card>
  );
}
