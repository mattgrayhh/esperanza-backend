'use client';

// =============================================================================
// CommunityRemainingFields — grouped remaining admin/synced fields rendered as
// <details> accordions per group. Each field renders by kind:
//   generic       → GenericField
//   image         → ImageUploader
//   imageGallery  → ImageGalleryEditor
// All live inside the parent shell's <form>.
// =============================================================================

import { GenericField } from '../../fields/GenericField';
import { ImageUploader } from '../../fields/ImageUploader';
import { ImageGalleryEditor } from '../../fields/ImageGalleryEditor';
import type { FieldView } from '../../EntityEditForm';

export function CommunityRemainingFields({
  groups,
  id,
}: {
  groups: { group: string; fields: FieldView[] }[];
  id: string;
}) {
  if (groups.length === 0) return null;

  return (
    <div className="space-y-3">
      {groups.map(({ group, fields }) => (
        <details
          key={group}
          className="group rounded-lg border bg-card text-card-foreground shadow-sm"
          open={group === 'Details'}
        >
          <summary className="flex cursor-pointer select-none items-center justify-between px-5 py-3 font-semibold text-sm list-none [&::-webkit-details-marker]:hidden">
            {group}
            <span className="text-muted-foreground text-xs group-open:hidden">▼</span>
            <span className="text-muted-foreground text-xs hidden group-open:inline">▲</span>
          </summary>
          <div className="border-t px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((f) => {
                if (f.kind === 'image') {
                  return (
                    <div key={f.field} className="sm:col-span-1">
                      <ImageUploader
                        entity="communities"
                        id={id}
                        field={f.field}
                        label={f.label}
                        initialUrl={f.value}
                        help={f.help}
                      />
                    </div>
                  );
                }
                if (f.kind === 'imageGallery') {
                  return (
                    <div key={f.field} className="col-span-1 sm:col-span-2">
                      <ImageGalleryEditor
                        entity="communities"
                        id={id}
                        field={f.field}
                        label={f.label}
                        initialValue={f.value}
                        help={f.help}
                      />
                    </div>
                  );
                }
                // generic (and syncedOverride shouldn't appear here, but guard anyway)
                if (f.kind === 'generic') {
                  return (
                    <div
                      key={f.field}
                      className={'halfWidth' in f && f.halfWidth ? 'sm:col-span-1' : 'col-span-1 sm:col-span-2'}
                    >
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
                        entity="communities"
                        id={id}
                      />
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
