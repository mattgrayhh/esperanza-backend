'use client';

// =============================================================================
// CommunityMediaBar — compact horizontal row of ImageUploaders for the four
// single-image slots (featured/secondary/logo/descriptionImage) plus the full
// ImageGalleryEditor for the photo gallery. Lives INSIDE the shell's <form>.
// =============================================================================

import { ImageUploader } from '../../fields/ImageUploader';
import { ImageGalleryEditor } from '../../fields/ImageGalleryEditor';
import { GenericField } from '../../fields/GenericField';
import type { CommunityDetailView } from '../../../lib/community-detail';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Media = CommunityDetailView['media'];

const SINGLE_FIELDS: Array<{ key: keyof Omit<Media, 'gallery' | 'featuredAlt'>; label: string }> = [
  { key: 'featured', label: 'Featured Image' },
  { key: 'secondary', label: 'Secondary Image' },
  { key: 'logo', label: 'Logo' },
  { key: 'descriptionImage', label: 'Description Image' },
];

export function CommunityMediaBar({ id, media }: { id: string; media: Media }) {
  const featuredAlt = media.featuredAlt;
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Media</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        {/* Compact horizontal row for the single-image slots */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {SINGLE_FIELDS.map(({ key, label }) => {
            const f = media[key];
            // The media FieldViews are always image kind; guard for TS narrowing
            const imgValue = f.kind === 'image' ? f.value : '';
            return (
              <div key={key} className="[&_img]:max-h-24 [&_img]:object-cover">
                <ImageUploader
                  entity="communities"
                  id={id}
                  field={f.field}
                  label={label}
                  initialUrl={imgValue}
                  help={'help' in f ? (f.help as string | undefined) : undefined}
                />
              </div>
            );
          })}
        </div>

        {/* Featured image alt text — compact, rendered directly below the image grid */}
        {featuredAlt.kind === 'generic' && (
          <div className="max-w-sm">
            <GenericField
              field={featuredAlt.field}
              label={featuredAlt.label}
              widget={featuredAlt.widget}
              value={featuredAlt.value}
              help={featuredAlt.help}
              readOnly={featuredAlt.widget === 'synced'}
            />
          </div>
        )}

        {/* Full-width gallery editor */}
        <ImageGalleryEditor
          entity="communities"
          id={id}
          field="photo_gallery_json"
          label="Photo Gallery"
          initialValue={media.gallery.kind !== 'syncedOverride' ? media.gallery.value : ''}
          help={'help' in media.gallery ? (media.gallery.help as string | undefined) : undefined}
        />
      </CardContent>
    </Card>
  );
}
