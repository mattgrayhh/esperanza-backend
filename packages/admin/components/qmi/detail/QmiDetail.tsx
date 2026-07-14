'use client';

// =============================================================================
// QmiDetail — the BESPOKE Quick Move-In detail screen (client shell).
//
// A real-estate property-detail page wired to the EXISTING admin write path. EVERY
// mutation routes through the documented server actions — no new write paths.
// =============================================================================

import { useMemo, useState } from 'react';
import { saveEntity } from '@/lib/actions';
import type { QmiDetailView } from '@/lib/qmi-detail';
import { parseGalleryUrls } from '@/lib/gallery-urls';
import { SyncedOverrideField } from '@/components/fields/SyncedOverrideField';
import { GenericField } from '@/components/fields/GenericField';
import { ImageUploader } from '@/components/fields/ImageUploader';
import { ImageGalleryEditor } from '@/components/fields/ImageGalleryEditor';
import { PublishedToggle } from '@/components/fields/PublishedToggle';
import { LOCATION_STATUS } from '@/lib/status';
import { CopyableId } from './CopyableId';
import { QmiAssignFloorPlan } from './QmiAssignFloorPlan';
import { QmiElevationSelect } from './QmiElevationSelect';
import { QmiTourField } from './QmiTourField';
import { QmiSiteHeader } from './QmiSiteHeader';
import { QmiPriceOverrideStat } from './QmiPriceOverrideStat';
import { QmiMarketingSection } from './QmiMarketingSection';
import { ExpandableDescription } from './ExpandableDescription';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  EditToast,
  MarkSystemsSection,
  PlacementRail,
  RecordEditBreadcrumb,
  RecordEditLayout,
  StickyActionBar,
  UnsavedLeaveToast,
  sectionId,
} from '@/components/record-edit/RecordEditShell';
import { useEditSaveFeedback } from '@/components/record-edit/useEditSaveFeedback';
import {
  BedDouble,
  Bath,
  Ruler,
} from 'lucide-react';

function fmtNum(v: number | null): string {
  return v == null ? '—' : v.toLocaleString();
}

export function QmiDetail({ view }: { view: QmiDetailView }) {
  const formId = `qmi-edit-${view.id}`;
  const [galleryUrls, setGalleryUrls] = useState(() => parseGalleryUrls(view.photoGalleryJson));
  // Virtual tour is a per-home field; when blank it can inherit the assigned plan's tour
  // (one click), mirroring how the Floor Plan Image falls back to the plan default.
  const {
    pending,
    startTransition,
    reportResult,
    barStatusText,
    barTone,
    toast,
    dismissToast,
    leavePrompt,
    saveBeforeLeave,
    discardLeave,
    stayOnPage,
  } = useEditSaveFeedback(formId);

  const title = view.address.trim() || view.housenumber || view.id;

  function onSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await saveEntity('qmi', view.id, formData);
      reportResult(res.ok ? 'Saved' : `Error: ${res.error}`);
    });
  }

  const stats = useMemo(
    () => [
      { icon: BedDouble, value: fmtNum(view.bedroomCount), label: 'beds' },
      { icon: Bath, value: fmtNum(view.bathroomCount), label: 'baths' },
      { icon: Ruler, value: fmtNum(view.totalSquareFootage), label: 'Total SqFt' },
      { icon: Ruler, value: fmtNum(view.livingSquareFootage), label: 'Living SqFt' },
    ],
    [view.bedroomCount, view.bathroomCount, view.totalSquareFootage, view.livingSquareFootage]
  );

  const mediaRail = (
    <div className="min-w-0 space-y-5">
      <h3 className="text-sm font-medium text-foreground">Media</h3>
      {/* Always render: the floor_plan_image override is a valid per-home column even for
          specs with no effective plan (isUnassigned) — those operators still need somewhere
          to set the home's image. */}
      <ImageUploader
        entity="qmi"
        id={view.id}
        field="floor_plan_image"
        label="Floor Plan Image"
        initialUrl={view.admin.floorPlanImage}
        fallbackPreviewUrl={view.admin.floorPlanImageDefault}
        help={
          view.admin.floorPlanImage
            ? 'Home-specific override — replaces the plan layout on the live site for this home. Clear and save to revert to the plan default.'
            : view.admin.floorPlanImageDefault
              ? `Using the ${view.floorPlanName} plan layout. Upload only if this production home differs from the standard sketch.`
              : 'Upload only when this home’s layout differs from the standard plan sketch.'
        }
        compact
      />
      <QmiElevationSelect
        options={view.admin.elevationOptions}
        selection={view.admin.elevationSelection}
      />
      <QmiTourField
        planTour={view.admin.virtualTourUrlDefault}
        ownValue={view.admin.virtualTourUrl}
      />
      <ImageGalleryEditor
        entity="qmi"
        id={view.id}
        field="photo_gallery_json"
        label="Photo Gallery"
        initialValue={view.photoGalleryJson}
        galleryUrls={galleryUrls}
        onGalleryUrlsChange={setGalleryUrls}
        suggestions={view.floorPlanGallery.map((g) => g.url)}
        suggestionsLabel={`Photos from ${view.floorPlanName || 'the floor plan'}`}
        help="Per-home photos in display order. Slots 2 and 3 also appear in the header (right column). Entry 1 is usually the elevation render."
        compact
      />
    </div>
  );

  const titleWithStatus = (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {view.availableNow ? (
        <Badge variant="outline" className="text-emerald-700 dark:text-emerald-400">
          Available now
        </Badge>
      ) : null}
      {view.isUnassigned ? (
        <Badge variant="destructive">Unassigned draft</Badge>
      ) : null}
    </div>
  );

  const mainContent = (
    <div className="space-y-4">
      <div id={sectionId('Overview')} className="sr-only">
        Overview
      </div>

      {view.isUnassigned ? (
        <div id={sectionId('Assign floor plan')}>
          <QmiAssignFloorPlan id={view.id} options={view.options.floorPlans} onResult={reportResult} />
        </div>
      ) : null}

      <Card className="py-5">
        <CardContent className="space-y-6 px-5">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 *:space-y-1 *:rounded-md *:border *:p-3 *:text-center">
            {stats.map((stat) => (
              <div key={stat.label}>
                <p className="text-2xl font-semibold">{stat.value}</p>
                <p className="inline-flex items-center gap-1 text-muted-foreground">
                  <stat.icon className="size-4" />
                  {stat.label}
                </p>
              </div>
            ))}
          </div>

          <QmiPriceOverrideStat
            price={view.price}
            syncedDisplay={view.syncedOverride.price.syncedDisplay}
            overrideValue={view.syncedOverride.price.overrideValue}
          />

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Info label="Elevation" value={view.elevation || '—'} />
            <GenericField
              field="move_in_date"
              label="Move-In Date"
              widget="date"
              value={view.admin.moveInDate}
            />
            <Info label="Slug" value={view.slug || '—'} mono />
            <Info label="Floor plan" value={view.isUnassigned ? 'Unassigned' : view.floorPlanName || '—'} />
            <Info label="Community" value={view.communityName || '—'} />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div id={sectionId('From MarkSystems')}>
          <MarkSystemsSection title="MarkSystems">
            <div className="grid gap-4 sm:grid-cols-2">
              {!view.isUnassigned ? (
                <div className="sm:col-span-2">
                  <SyncedOverrideField {...view.relations.floorPlan} label="Floor Plan Assignment" />
                </div>
              ) : null}
              <SyncedOverrideField {...view.syncedOverride.address} />
              <SyncedOverrideField {...view.syncedOverride.bedroomCount} />
              <SyncedOverrideField {...view.syncedOverride.bathroomCount} />
              <SyncedOverrideField {...view.syncedOverride.livingSquareFootage} />
              <SyncedOverrideField {...view.syncedOverride.totalSquareFootage} />
              <SyncedOverrideField {...view.syncedOverride.elevation} />
              <SyncedOverrideField {...view.syncedOverride.lotNumber} />
              {/* elevation_type + material_type are set together via the Elevation
                  dropdown in the Media rail (QmiElevationSelect) — a single control that
                  picks a gallery elevation and splits it into the two override columns.
                  Rendering the raw SyncedOverrideField text inputs here too would submit
                  the same field names twice. */}
              <SyncedOverrideField {...view.syncedOverride.isModelHome} />
              {!view.isUnassigned ? (
                <>
                  <SyncedOverrideField {...view.relations.community} />
                  <SyncedOverrideField {...view.relations.city} />
                </>
              ) : null}
            </div>
          </MarkSystemsSection>
        </div>

        <QmiMarketingSection
          initial={{
            incentive: view.admin.incentive,
            availabilityText: view.admin.availabilityText,
            availableNow: view.admin.availableNow,
            selfTourAvailable: view.admin.selfTourAvailable,
            nterNow: view.admin.nterNow,
          }}
          card={{
            address: view.address,
            cityName: view.cityName,
            price: view.price,
            bedroomCount: view.bedroomCount,
            bathroomCount: view.bathroomCount,
            livingSquareFootage: view.livingSquareFootage,
            totalSquareFootage: view.totalSquareFootage,
            communityName: view.communityName,
            floorPlanName: view.floorPlanName,
            lotNumber:
              view.syncedOverride.lotNumber.overrideValue.trim() ||
              view.syncedOverride.lotNumber.syncedDisplay,
            imageUrl: view.admin.imageUrl || view.admin.heroFallbackUrl,
          }}
        />

        <Card id={sectionId('Map Coordinates')}>
          <CardHeader className="border-b">
            <CardTitle className="text-base font-medium">Map Coordinates</CardTitle>
            <p className="text-xs text-muted-foreground">
              Drives the “Get Directions” button and the map pin on the spec page. Per-home
              (each spec sits on its own lot) — leave blank for no directions link.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <GenericField
              field="latitude"
              label="Latitude"
              widget="number"
              step="any"
              value={view.admin.latitude == null ? '' : String(view.admin.latitude)}
            />
            <GenericField
              field="longitude"
              label="Longitude"
              widget="number"
              step="any"
              value={view.admin.longitude == null ? '' : String(view.admin.longitude)}
            />
            {view.admin.latitude == null &&
            view.admin.longitude == null &&
            (view.admin.geoLatitude != null || view.admin.geoLongitude != null) ? (
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Raw geo on file: {view.admin.geoLatitude ?? '—'}, {view.admin.geoLongitude ?? '—'} —
                copy into the fields above to use it for directions.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card id={sectionId('Description')}>
          <CardHeader className="border-b">
            <CardTitle className="text-base font-medium">Description</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <GenericField
              field="description"
              label="Floorplan Description"
              widget="richtext"
              value={view.ownDescription}
              entity="qmi"
              id={view.id}
              help="Leave blank to use the floor-plan copy shown below. Set it only to override the plan description for this home — e.g. to format the features as bullet points."
            />
            {view.ownDescription.trim() === '' && view.floorPlanDescription.trim() ? (
              <div className="space-y-1.5 rounded-lg border border-dashed bg-muted/40 p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Floor-plan copy (used on the site while the override above is blank)
                </p>
                <ExpandableDescription text={view.floorPlanDescription} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Promotions membership list hidden for now — targeting still lives on each
          promotion's scope picker; revisit if operators need a home-side jump list. */}
    </div>
  );

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-screen-2xl px-2 md:px-4">
        <RecordEditBreadcrumb
          collectionLabel="Quick Move-Ins"
          collectionHref="/qmi"
          recordName={title}
        />
        <div className="mt-3">
          <StickyActionBar
            formId={formId}
            pending={pending}
            statusText={barStatusText}
            statusTone={barTone}
            title={titleWithStatus}
            children={
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="shrink-0"
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      'Discard unsaved changes and reload? Note: images you already replaced are saved immediately and will not revert.',
                    )
                  ) {
                    window.location.reload();
                  }
                }}
              >
                Discard changes
              </Button>
            }
            footer={
              <div className="flex flex-wrap items-center gap-2">
                <CopyableId label="Housemaster" value={view.housenumber} />
                <CopyableId label="ECI" value={view.eciKey} />
                <CopyableId label="Job" value={view.markJobNumber} />
              </div>
            }
          />
        </div>
      </div>
      <EditToast message={toast?.message ?? null} tone={toast?.tone ?? 'success'} onDismiss={dismissToast} />
      <UnsavedLeaveToast
        open={leavePrompt != null}
        pending={pending}
        onSave={saveBeforeLeave}
        onDiscard={discardLeave}
        onStay={stayOnPage}
      />

      <form id={formId} action={onSubmit} className="mt-5">
        <QmiSiteHeader
          id={view.id}
          title={title}
          imageUrl={view.admin.imageUrl}
          heroFallbackUrl={view.admin.heroFallbackUrl}
          galleryUrls={galleryUrls}
          onGalleryUrlsChange={setGalleryUrls}
        />

        <div className="mx-auto w-full max-w-screen-2xl px-2 md:px-4">
          <RecordEditLayout
            main={mainContent}
            rail={
              <PlacementRail
                placement={view.liveSite}
                publishControl={
                  <PublishedToggle
                    entityKey="qmi"
                    id={view.id}
                    gate="status"
                    initialStatus={view.status}
                    statusOptions={LOCATION_STATUS}
                    onResult={reportResult}
                  />
                }
                media={mediaRail}
              />
            }
          />
        </div>
      </form>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn('font-medium', mono && 'font-mono text-xs')}>{value}</p>
    </div>
  );
}
