'use client';

// =============================================================================
// QmiDetail — the BESPOKE Quick Move-In detail screen (client shell).
//
// A real-estate property-detail page wired to the EXISTING admin write path. EVERY
// mutation routes through the documented server actions — no new write paths.
// =============================================================================

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { saveEntity } from '@/lib/actions';
import type { QmiDetailView } from '@/lib/qmi-detail';
import { parseGalleryUrls } from '@/lib/gallery-urls';
import { SyncedOverrideField } from '@/components/fields/SyncedOverrideField';
import { GenericField } from '@/components/fields/GenericField';
import { ImageUploader } from '@/components/fields/ImageUploader';
import { ImageGalleryEditor } from '@/components/fields/ImageGalleryEditor';
import { PublishedToggle } from '@/components/fields/PublishedToggle';
import { LOCATION_STATUS, statusTone } from '@/lib/status';
import { CopyableId } from './CopyableId';
import { QmiPriceCard } from './QmiPriceCard';
import { QmiAssignFloorPlan } from './QmiAssignFloorPlan';
import { QmiSiteHeader } from './QmiSiteHeader';
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
  SectionJumpNav,
  StickyActionBar,
  UnsavedLeaveToast,
  sectionId,
} from '@/components/record-edit/RecordEditShell';
import { useEditSaveFeedback } from '@/components/record-edit/useEditSaveFeedback';
import {
  BedDouble,
  Bath,
  Ruler,
  MapPin,
  TagIcon,
  Building2,
} from 'lucide-react';

function fmtNum(v: number | null): string {
  return v == null ? '—' : v.toLocaleString();
}

export function QmiDetail({ view }: { view: QmiDetailView }) {
  const formId = `qmi-edit-${view.id}`;
  const [galleryUrls, setGalleryUrls] = useState(() => parseGalleryUrls(view.photoGalleryJson));
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
      { icon: Ruler, value: fmtNum(view.totalSquareFootage), label: 'sqft' },
    ],
    [view.bedroomCount, view.bathroomCount, view.totalSquareFootage]
  );

  const jumpSections = [
    { id: sectionId('Overview'), label: 'Overview' },
    ...(view.isUnassigned ? [{ id: sectionId('Assign floor plan'), label: 'Assign plan' }] : []),
    { id: sectionId('From MarkSystems'), label: 'MarkSystems' },
    { id: sectionId('Marketing'), label: 'Marketing' },
    { id: sectionId('Description'), label: 'Description' },
    { id: sectionId('Promotions'), label: 'Promotions' },
  ];

  const mediaRail = (
    <div className="min-w-0 space-y-5">
      <h3 className="text-sm font-medium text-foreground">Media</h3>
      {!view.isUnassigned ? (
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
      ) : null}
      <ImageGalleryEditor
        entity="qmi"
        id={view.id}
        field="photo_gallery_json"
        label="Photo Gallery"
        initialValue={view.photoGalleryJson}
        galleryUrls={galleryUrls}
        onGalleryUrlsChange={setGalleryUrls}
        help="Per-home photos in display order. Slots 2 and 3 also appear in the header (right column). Entry 1 is usually the elevation render."
        compact
      />
    </div>
  );

  const mainContent = (
    <div className="space-y-4">
      <div className="space-y-3" id={sectionId('Overview')}>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <Badge
            variant={
              statusTone(view.status) === 'live'
                ? 'default'
                : statusTone(view.status) === 'pending'
                  ? 'outline'
                  : 'secondary'
            }
            className={
              statusTone(view.status) === 'pending'
                ? 'text-amber-700 dark:text-amber-400'
                : undefined
            }
          >
            {view.status}
          </Badge>
          {view.availableNow ? (
            <Badge variant="outline" className="text-emerald-700 dark:text-emerald-400">
              Available now
            </Badge>
          ) : null}
          {view.isUnassigned ? (
            <Badge variant="destructive">Unassigned draft</Badge>
          ) : null}
        </div>
        <SectionJumpNav sections={jumpSections} />
        <div className="flex flex-wrap items-center gap-2">
          <CopyableId label="Housemaster" value={view.housenumber} />
          <CopyableId label="ECI" value={view.eciKey} />
          <CopyableId label="Job" value={view.markJobNumber} />
        </div>
      </div>

      {view.isUnassigned ? (
        <div id={sectionId('Assign floor plan')}>
          <QmiAssignFloorPlan id={view.id} options={view.options.floorPlans} onResult={reportResult} />
        </div>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="py-5">
          <CardContent className="space-y-6 px-5">
            <div className="space-y-4">
              <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                <div className="space-y-1.5">
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MapPin className="size-3.5" />
                    {[view.communityName, view.cityName].filter(Boolean).join(' · ') || '—'}
                  </p>
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Building2 className="size-3.5" />
                    {view.isUnassigned ? (
                      <span className="text-amber-700 dark:text-amber-400">No floor plan assigned</span>
                    ) : (
                      <>
                        <span className="font-medium text-foreground">{view.floorPlanName || '—'}</span>
                        <span className="text-xs">(from floor plan)</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-3 text-sm *:space-y-1 *:rounded-md *:border *:p-3 *:text-center">
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
              </div>
            </div>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Info label="Elevation" value={view.elevation || '—'} />
              <Info label="Living SqFt" value={fmtNum(view.livingSquareFootage)} />
              <Info label="Move-in date" value={view.moveInDate || 'TBD'} />
              <Info label="Slug" value={view.slug || '—'} mono />
              <Info label="Floor plan" value={view.isUnassigned ? 'Unassigned' : view.floorPlanName || '—'} />
              <Info label="Community" value={view.communityName || '—'} />
            </div>
          </CardContent>
        </Card>

        <QmiPriceCard
          basePrice={view.fpStartingPrice}
          currentPrice={view.price}
          hasOverride={view.hasPriceOverride}
        />
      </section>

      <div className="space-y-4">
        <div id={sectionId('From MarkSystems')}>
          <MarkSystemsSection title="MarkSystems">
            <div className="grid gap-4 sm:grid-cols-2">
              {!view.isUnassigned ? (
                <div className="sm:col-span-2">
                  <SyncedOverrideField {...view.relations.floorPlan} label="Floor Plan Assignment" />
                </div>
              ) : null}
              <SyncedOverrideField {...view.syncedOverride.price} />
              <SyncedOverrideField {...view.syncedOverride.address} />
              <SyncedOverrideField {...view.syncedOverride.bedroomCount} />
              <SyncedOverrideField {...view.syncedOverride.bathroomCount} />
              <SyncedOverrideField {...view.syncedOverride.livingSquareFootage} />
              <SyncedOverrideField {...view.syncedOverride.totalSquareFootage} />
              <SyncedOverrideField {...view.syncedOverride.elevation} />
              <SyncedOverrideField {...view.syncedOverride.lotNumber} />
              <SyncedOverrideField {...view.syncedOverride.elevationType} />
              <SyncedOverrideField {...view.syncedOverride.materialType} />
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

        <Card id={sectionId('Marketing')}>
          <CardHeader className="border-b">
            <CardTitle className="text-base font-medium">Marketing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <GenericField field="incentive" label="Incentive" widget="textarea" value={view.admin.incentive} />
            <GenericField field="promo_text" label="Promo Text" widget="text" value={view.admin.promoText} />
            <GenericField
              field="availability_text"
              label="Availability Text"
              widget="text"
              value={view.admin.availabilityText}
            />
            <GenericField
              field="virtual_tour_url"
              label="Virtual Tour URL"
              widget="text"
              value={view.admin.virtualTourUrl}
            />
            <GenericField field="move_in_date" label="Move-In Date" widget="date" value={view.admin.moveInDate} />
            <div className="grid gap-4 sm:grid-cols-2">
              <GenericField
                field="available_now"
                label="Available Now"
                widget="boolean"
                value={view.admin.availableNow ? '1' : '0'}
              />
              <GenericField
                field="self_tour_available"
                label="Self Tour Available"
                widget="boolean"
                value={view.admin.selfTourAvailable ? '1' : '0'}
              />
            </div>
          </CardContent>
        </Card>

        <Card id={sectionId('Description')}>
          <CardHeader className="border-b">
            <CardTitle className="text-base font-medium">Description</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <GenericField
              field="description"
              label="Description"
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

      <Card className="py-5" id={sectionId('Promotions')}>
        <CardContent className="space-y-3 px-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <TagIcon className="size-4" /> Promotions
          </h2>
          {view.promotions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No promotions currently target this home.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {view.promotions.map((p) => (
                <Button key={p.id} variant="outline" size="sm" render={<Link href={`/promotions/${p.id}`} />}>
                  {p.title}
                  {p.global ? <span className="ml-1 text-xs text-muted-foreground">(global)</span> : null}
                </Button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Targeting is managed on each promotion (scope picker). This list is read-only.
          </p>
        </CardContent>
      </Card>
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
            title={title}
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
