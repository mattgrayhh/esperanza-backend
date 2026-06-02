'use client';

// =============================================================================
// FramerFieldTypes — Settings → Framer Field Types client UI (Phase C). Full-Admin
// only (gated by the RSC page + the applyFramerTypes action). Three behaviors:
//   • One section per entity (the 9 collections). Each field shows its label, admin
//     type, the APPLIED Framer type, and a Framer-type <Select> (recommended subset
//     pre-grouped; an inline warning on a risky conversion like number → image).
//   • "Add field" per entity stages a NEW custom field (key snake_case, label, admin
//     type, Framer type). It renders inline (un-applied) with a "new" badge.
//   • Edits stage CLIENT-SIDE; a "pending" badge marks staged fields and a "drift"
//     badge marks a field whose applied Framer type differs from its recommendation.
//     The sticky "Apply N changes to Framer" button commits the whole batch.
// =============================================================================

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { FramerTypeField, FramerTypeSection } from '../../lib/build-framer-types';
import {
  applyFramerTypes,
  type ApplyTypeChange,
  type ApplyTypeEntityResult,
} from '../../lib/actions';
import { FIELD_TYPES, FIELD_TYPE_META, toSnakeCase, type FieldType } from '../../lib/field-builder';
import {
  classifyConversion,
  compatibleFramerTypes,
  conversionWarning,
  defaultFramerType,
  framerTypeLabel,
} from '../../lib/framer-types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PlusIcon, AlertTriangleIcon, SparklesIcon } from 'lucide-react';

interface FramerTypeOpt {
  value: string;
  label: string;
}

// A staged/added field as the client tracks it. `added` rows are new custom fields not
// yet in field_definitions; everything else mirrors a server FramerTypeField.
interface StagedField extends FramerTypeField {
  /** the Framer type currently chosen in the UI (may differ from `framerType`). */
  chosen: string;
  /** true when this is a brand-new custom field staged for add. */
  added?: boolean;
}

type EntityState = Record<string, StagedField[]>; // entity → fields

function initialState(sections: FramerTypeSection[]): EntityState {
  const out: EntityState = {};
  for (const s of sections) {
    out[s.entity] = s.fields.map((f) => ({ ...f, chosen: f.framerType ?? f.recommended }));
  }
  return out;
}

export function FramerFieldTypes({
  sections,
  framerTypes,
}: {
  sections: FramerTypeSection[];
  framerTypes: FramerTypeOpt[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<EntityState>(() => initialState(sections));
  const [addFor, setAddFor] = useState<FramerTypeSection | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const isError = msg != null && msg.startsWith('Error');

  const labelByEntity = useMemo(
    () => Object.fromEntries(sections.map((s) => [s.entity, s.label])),
    [sections]
  );

  // The batch of changes: a retype whose chosen ≠ applied, OR an added field.
  const batch = useMemo<Record<string, ApplyTypeChange[]>>(() => {
    const b: Record<string, ApplyTypeChange[]> = {};
    for (const [entity, fields] of Object.entries(state)) {
      const changes: ApplyTypeChange[] = [];
      for (const f of fields) {
        if (f.added) {
          changes.push({
            key: f.key,
            framerType: f.chosen,
            add: { adminType: f.adminType, label: f.label },
          });
        } else if (f.chosen !== (f.framerType ?? '')) {
          changes.push({ key: f.key, framerType: f.chosen });
        }
      }
      if (changes.length > 0) b[entity] = changes;
    }
    return b;
  }, [state]);

  const changeCount = useMemo(
    () => Object.values(batch).reduce((n, arr) => n + arr.length, 0),
    [batch]
  );

  function setChosen(entity: string, key: string, value: string) {
    setState((prev) => ({
      ...prev,
      [entity]: prev[entity]!.map((f) => (f.key === key ? { ...f, chosen: value } : f)),
    }));
  }

  function stageAdd(entity: string, field: StagedField) {
    setState((prev) => ({ ...prev, [entity]: [...prev[entity]!, field] }));
    setAddFor(null);
  }

  function removeAdded(entity: string, key: string) {
    setState((prev) => ({
      ...prev,
      [entity]: prev[entity]!.filter((f) => !(f.added && f.key === key)),
    }));
  }

  function apply() {
    if (changeCount === 0) return;
    startTransition(async () => {
      const res = await applyFramerTypes(batch);
      if (!res.ok) {
        setMsg(`Error: ${res.error}`);
        return;
      }
      setMsg(summarizeResults(res.results));
      router.refresh();
    });
  }

  return (
    <div className="flex w-full flex-col gap-5 pb-24">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Settings</p>
          <h1 className="font-heading text-2xl font-bold text-foreground">Framer Field Types</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Control how each field is published to the Framer CMS. Re-type a field or add a new
            one; applying re-types/creates the Framer field and re-pushes the collection so values
            repopulate in the new type.
          </p>
        </div>
        {msg ? (
          <Badge variant={isError ? 'destructive' : 'secondary'} className="ml-auto h-6">
            {msg}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-5">
        {sections.map((s) => (
          <Card key={s.entity} className="self-start">
            <CardHeader className="flex flex-row items-center justify-between gap-2 border-b">
              <CardTitle>{s.label}</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setAddFor(s)} disabled={pending}>
                <PlusIcon className="size-4" /> Add field
              </Button>
            </CardHeader>
            <CardContent className="grid gap-1.5">
              {(state[s.entity] ?? []).map((f) => (
                <FieldRow
                  key={f.key}
                  field={f}
                  framerTypes={framerTypes}
                  onChange={(v) => setChosen(s.entity, f.key, v)}
                  onRemove={f.added ? () => removeAdded(s.entity, f.key) : undefined}
                  disabled={pending}
                />
              ))}
              {(state[s.entity] ?? []).length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No fields.</p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Sticky apply bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-6xl items-center justify-end gap-3 px-6 py-3">
          <span className="text-sm text-muted-foreground">
            {changeCount === 0
              ? 'No staged changes'
              : `${changeCount} staged change${changeCount === 1 ? '' : 's'}`}
          </span>
          <Button onClick={apply} disabled={pending || changeCount === 0}>
            {pending ? 'Applying…' : `Apply ${changeCount} change${changeCount === 1 ? '' : 's'} to Framer`}
          </Button>
        </div>
      </div>

      {addFor ? (
        <AddFieldDialog
          section={addFor}
          framerTypes={framerTypes}
          existingKeys={(state[addFor.entity] ?? []).map((f) => f.key)}
          onAdd={(field) => stageAdd(addFor.entity, field)}
          onClose={() => setAddFor(null)}
        />
      ) : null}
    </div>
  );
}

function summarizeResults(results: ApplyTypeEntityResult[]): string {
  let applied = 0;
  let created = 0;
  let errors = 0;
  for (const r of results) {
    if (r.error) errors += 1;
    for (const f of r.fields) {
      if (f.status === 'error') errors += 1;
      else if (f.status === 'created') created += 1;
      else if (f.status === 'applied' || f.status === 'unchanged') applied += 1;
    }
  }
  const parts: string[] = [];
  if (created) parts.push(`${created} created`);
  if (applied) parts.push(`${applied} applied`);
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  const base = parts.length ? parts.join(', ') : 'No changes';
  return errors ? `Error: ${base}` : base;
}

function adminTypeLabel(t: string): string {
  return (FIELD_TYPE_META as Record<string, { label: string }>)[t]?.label ?? t;
}

function FieldRow({
  field,
  framerTypes,
  onChange,
  onRemove,
  disabled,
}: {
  field: StagedField;
  framerTypes: FramerTypeOpt[];
  onChange: (v: string) => void;
  onRemove?: () => void;
  disabled: boolean;
}) {
  const compatible = new Set(compatibleFramerTypes(field.adminType));
  const recommended = compatibleFramerTypes(field.adminType); // ordered; recommended[0] first
  const others = framerTypes.filter((t) => !compatible.has(t.value));
  const conv = classifyConversion(field.adminType, field.chosen);
  const warning = conversionWarning(field.adminType, field.chosen);

  const staged = !field.added && field.chosen !== (field.framerType ?? '');
  const drift =
    !field.added && field.framerType != null && field.framerType !== defaultFramerType(field.adminType);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-foreground">{field.label}</span>
          {field.added ? (
            <Badge variant="default" className="h-5 gap-1 px-1.5">
              <SparklesIcon className="size-3" /> New
            </Badge>
          ) : null}
          {field.system ? (
            <Badge variant="outline" className="h-5 px-1.5 text-muted-foreground">
              Synced
            </Badge>
          ) : null}
          {field.custom && !field.added ? (
            <Badge variant="outline" className="h-5 px-1.5 text-muted-foreground">
              Custom
            </Badge>
          ) : null}
          {staged ? (
            <Badge variant="secondary" className="h-5 px-1.5">
              Pending
            </Badge>
          ) : null}
          {drift ? (
            <Badge variant="outline" className="h-5 px-1.5 text-amber-600">
              Drift
            </Badge>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {field.key} · {adminTypeLabel(field.adminType)}
          {!field.added ? ` · applied: ${field.framerType ?? '—'}` : ''}
        </p>
        {warning ? (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-600">
            <AlertTriangleIcon className="size-3 shrink-0" /> {warning}
          </p>
        ) : null}
      </div>

      <div className="w-56">
        <Select value={field.chosen} onValueChange={(v) => v && onChange(v)} disabled={disabled}>
          <SelectTrigger
            className={cn('w-full', conv === 'risky' && 'border-amber-500 text-amber-700')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Recommended</SelectLabel>
              {recommended.map((v) => (
                <SelectItem key={v} value={v}>
                  {framerTypeLabel(v)}
                </SelectItem>
              ))}
            </SelectGroup>
            {others.length ? (
              <SelectGroup>
                <SelectLabel>Other</SelectLabel>
                {others.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>
      </div>

      {onRemove ? (
        <Button variant="ghost" size="sm" className="h-8" onClick={onRemove} disabled={disabled}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

// =============================================================================
// Add-a-field dialog: key (auto snake_case), label, admin type, Framer type.
// =============================================================================
function AddFieldDialog({
  section,
  framerTypes,
  existingKeys,
  onAdd,
  onClose,
}: {
  section: FramerTypeSection;
  framerTypes: FramerTypeOpt[];
  existingKeys: string[];
  onAdd: (field: StagedField) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [key, setKey] = useState('');
  const [adminType, setAdminType] = useState<FieldType>('text');
  const [framer, setFramer] = useState<string>(defaultFramerType('text'));

  const effectiveKey = keyEdited ? key : toSnakeCase(label);
  const taken = new Set(existingKeys);
  const keyError =
    effectiveKey !== '' && !/^[a-z][a-z0-9_]*$/.test(effectiveKey)
      ? 'Use lower snake_case (a–z, 0–9, _).'
      : taken.has(effectiveKey)
        ? 'A field with this key already exists.'
        : null;
  const canAdd = label.trim() !== '' && effectiveKey !== '' && !keyError;

  function pickAdminType(t: FieldType) {
    setAdminType(t);
    setFramer(defaultFramerType(t)); // re-default the Framer type to the recommendation
  }

  function submit() {
    if (!canAdd) return;
    onAdd({
      id: `${section.entity}__${effectiveKey}`,
      key: effectiveKey,
      label: label.trim(),
      adminType,
      framerType: null,
      framerFieldId: null,
      recommended: defaultFramerType(adminType),
      custom: true,
      system: false,
      chosen: framer,
      added: true,
    });
  }

  const warning = conversionWarning(adminType, framer);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add field to {section.label}</DialogTitle>
          <DialogDescription>
            Creates a custom field. It renders on the {section.label} edit page immediately and is
            created in Framer when you apply.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Label</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Plan Viewer Link" />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Key</label>
            <Input
              value={effectiveKey}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value);
              }}
              placeholder="plan_viewer_link"
            />
            {keyError ? <p className="text-xs text-destructive">{keyError}</p> : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Field type</label>
              <Select value={adminType} onValueChange={(v) => v && pickAdminType(v as FieldType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {adminTypeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Framer type</label>
              <Select value={framer} onValueChange={(v) => v && setFramer(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {framerTypes.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {warning ? (
            <p className="flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangleIcon className="size-3 shrink-0" /> {warning}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canAdd}>
            Stage field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
