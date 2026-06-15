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
import { ImageGalleryEditor } from './fields/ImageGalleryEditor';
import { ElevationGalleryEditor } from './fields/ElevationGalleryEditor';
import { JsonBlocksEditor } from './fields/JsonBlocksEditor';
import { PromoScopeTagPicker } from './fields/PromoScopeTagPicker';
import { CommunityFloorPlansPicker } from './fields/CommunityFloorPlansPicker';
import type { SelectOption } from '../lib/select-options';
import type { SelectOptionItem } from '../lib/field-config';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
      widget:
        | 'text'
        | 'textarea'
        | 'number'
        | 'currency'
        | 'boolean'
        | 'richtext'
        | 'wysiwyg'
        | 'date'
        | 'select'
        | 'synced';
      value: string;
      step?: 'any' | '1';
      options?: SelectOption[];
      staticOptions?: string[];
      /** builder {value,label} options (custom select fields) → SelectField. */
      optionItems?: SelectOptionItem[];
      readOnly?: boolean;
      help?: string;
      halfWidth?: boolean;
      group?: string;
    }
  | {
      kind: 'image';
      field: string;
      label: string;
      value: string;
      help?: string;
      group?: string;
    }
  | {
      kind: 'imageGallery';
      field: string;
      label: string;
      value: string; // serialized JSON array of URLs
      help?: string;
      group?: string;
    }
  | {
      kind: 'elevationGallery';
      field: string;
      label: string;
      value: string; // serialized JSON array of { url, type }
      help?: string;
      group?: string;
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
      halfWidth?: boolean;
      group?: string;
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
  selected: { cities: string[]; communities: string[]; floorPlans: string[]; qmis: string[] };
  options: {
    cities: SelectOption[];
    communities: SelectOption[];
    floorPlans: SelectOption[];
    qmis: SelectOption[];
  };
}
export interface CommunityFloorPlansView {
  kind: 'communityFloorPlans';
  communityName: string;
  selected: string[];
  options: SelectOption[];
}
export type SideWidget = HoaLinksView | JsonBlocksView | PromoScopeView | CommunityFloorPlansView;

export function EntityEditForm({
  entityKey,
  segment,
  label,
  id,
  displayName,
  subtitle = '',
  fields,
  publishGate,
  sideWidgets,
  preview = false,
}: {
  entityKey: string;
  segment: string;
  label: string;
  id: string;
  displayName: string;
  /** Small line under the H1. Empty → omitted (we no longer show the raw `· recXXXX` id;
   *  communities show the city, testimonials show nothing — feedback [4][35][36]). */
  subtitle?: string;
  fields: FieldView[];
  publishGate: PublishGateView | null;
  sideWidgets: SideWidget[];
  /** LIVE PREVIEW (Field Builder): render the form read-only with no save/submit. */
  preview?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    if (preview) return; // preview never writes
    startTransition(async () => {
      const res = await saveEntity(entityKey, id, formData);
      setMsg(res.ok ? 'Saved' : `Error: ${res.error}`);
    });
  }

  // Split fields: single-image widgets go to the right rail; everything else (including
  // imageGallery) to the main column.
  const imageFields = fields.filter((f) => f.kind === 'image');
  const mainFields = fields.filter((f) => f.kind !== 'image');

  // [21][5][6] Group the main fields into section cards by their `group`
  // (field_definitions.group_label). Ungrouped fields fall under "Details".
  // First-seen order is preserved so the Field Builder's sort drives section order.
  // An explicit group_label (set in the Field Builder) always wins. Otherwise fall back
  // to a sensible default so the form reads as form-layout2 sections instead of one slab:
  // synced/override → "Pricing & specifications"; long copy → "Content"; the rest → "Details".
  // mainFields excludes the image variant (TS narrows it from the `kind !== 'image'`
  // predicate); keep that narrowing so the section render can read generic-field props.
  type MainField = (typeof mainFields)[number];
  const groupOf = (f: MainField): string => {
    if (f.group) return f.group;
    if (f.kind === 'syncedOverride') return 'Pricing & specifications';
    if (f.kind === 'generic' && f.widget === 'synced') return 'Pricing & specifications';
    if (f.kind === 'generic' && (f.widget === 'richtext' || f.widget === 'textarea')) return 'Content';
    return 'Details';
  };
  const sections: { label: string; fields: MainField[] }[] = [];
  const sectionIndex = new Map<string, number>();
  for (const f of mainFields) {
    const g = groupOf(f);
    let idx = sectionIndex.get(g);
    if (idx === undefined) {
      idx = sections.length;
      sectionIndex.set(g, idx);
      sections.push({ label: g, fields: [] });
    }
    sections[idx]!.fields.push(f);
  }

  const isError = msg != null && msg.startsWith('Error:');

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          {/* Back link doubles as the "this is a {singular}" breadcrumb context. */}
          <a
            href={`/${segment}`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" /> {label}
          </a>
          {/* [13][14][15][43] The H1 IS the record's display name (not "Entitie recXXXX"). */}
          <h1 className="font-heading mt-1 truncate text-2xl font-bold text-foreground">
            {displayName}
          </h1>
          {subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {publishGate && !preview ? (
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
          {preview ? (
            <Badge variant="outline" className="h-5">
              Preview
            </Badge>
          ) : null}
          {msg ? (
            <Badge variant={isError ? 'destructive' : 'secondary'} className="h-5">
              {msg}
            </Badge>
          ) : null}
        </div>
      </div>

      <form action={onSubmit}>
        {/* In preview mode, force single-column layout — the preview panel is ~350px and
            viewport-based breakpoints (lg/sm) would otherwise trigger on the full browser
            width, causing the 2-column grids to overflow the narrow card. */}
        <div className={cn('grid gap-5', !preview && imageFields.length ? 'lg:grid-cols-[1fr_20rem]' : 'grid-cols-1')}>
          {/* MAIN column — one Card per field group (feedback [21][5][6]); ungrouped
              fields collapse into a single "Details" section. */}
          <div className="min-w-0 space-y-5">
            {sections.map((section) => (
              <Card key={section.label}>
                <CardHeader className="border-b">
                  <CardTitle>{section.label}</CardTitle>
                </CardHeader>
                {/* [32] Two-up grid: half-width fields take one column; the rest span both.
                    In preview mode use single-column to avoid overflow in the narrow panel. */}
                <CardContent className={cn('grid grid-cols-1 gap-4', !preview && 'sm:grid-cols-2')}>
                  {section.fields.map((f) => {
                    const span = preview
                      ? 'col-span-1'
                      : 'halfWidth' in f && f.halfWidth ? 'sm:col-span-1' : 'col-span-1 sm:col-span-2';
                    if (f.kind === 'syncedOverride') {
                      return (
                        <div key={f.field} className={span}>
                          <SyncedOverrideField
                            field={f.field}
                            label={f.label}
                            variant={f.variant}
                            syncedDisplay={f.syncedDisplay}
                            overrideValue={f.overrideValue}
                            step={f.step}
                            options={f.options}
                            help={f.help}
                          />
                        </div>
                      );
                    }
                    if (f.kind === 'imageGallery') {
                      return (
                        <div key={f.field} className="col-span-1 sm:col-span-2">
                          <ImageGalleryEditor
                            entity={segment}
                            id={id}
                            field={f.field}
                            label={f.label}
                            initialValue={f.value}
                            help={f.help}
                          />
                        </div>
                      );
                    }
                    if (f.kind === 'elevationGallery') {
                      return (
                        <div key={f.field} className="col-span-1 sm:col-span-2">
                          <ElevationGalleryEditor
                            entity={segment}
                            id={id}
                            field={f.field}
                            label={f.label}
                            initialValue={f.value}
                            help={f.help}
                          />
                        </div>
                      );
                    }
                    return (
                      <div key={f.field} className={span}>
                        <GenericField
                          field={f.field}
                          label={f.label}
                          widget={f.widget}
                          value={f.value}
                          step={f.step}
                          options={f.options}
                          staticOptions={f.staticOptions}
                          optionItems={f.optionItems}
                          readOnly={f.readOnly}
                          help={f.help}
                          entity={segment}
                          id={id}
                        />
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            ))}
            {preview ? null : (
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={pending}>
                  {pending ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </div>

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

      {preview
        ? null
        : sideWidgets.map((w, i) => (
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
  if (widget.kind === 'communityFloorPlans') {
    return (
      <Card className="mt-6">
        <CardHeader className="border-b">
          <CardTitle>Floor Plans Offered</CardTitle>
        </CardHeader>
        <CardContent>
          <CommunityFloorPlansPicker
            communityId={id}
            initialSelected={widget.selected}
            options={widget.options}
            onResult={onResult}
          />
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
