'use client';

// =============================================================================
// CommunityBasicInfo — renders the basicInfo FieldView array.
// syncedOverride kind → SyncedOverrideField; generic kind → GenericField.
// =============================================================================

import { GenericField } from '../../fields/GenericField';
import { SyncedOverrideField } from '../../fields/SyncedOverrideField';
import type { FieldView } from '../../EntityEditForm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function CommunityBasicInfo({ fields }: { fields: FieldView[] }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Basic Info</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => {
          if (f.kind === 'syncedOverride') {
            return (
              <div key={f.field}>
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
          // generic (including 'synced' widget for read-only fields)
          if (f.kind === 'generic') {
            return (
              <div key={f.field}>
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
                />
              </div>
            );
          }
          return null;
        })}
      </CardContent>
    </Card>
  );
}
