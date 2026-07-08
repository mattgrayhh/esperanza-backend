'use client';

// =============================================================================
// QmiDetail — the BESPOKE Quick Move-In detail screen (client shell).
//
// A real-estate property-detail page (adapted from bundui real-estate/detail) wired to
// the EXISTING admin write path. EVERY mutation routes through the documented server
// actions — no new write paths:
//   · saveEntity('qmi', id, formData)  — one <form> carrying:
//        - the floor-plan ASSIGNMENT select  (name="floor_plan_id" → QMI override field
//          → buildOverrideWrite; this is the 80-90% auto-fill moment for a draft)
//        - the Snowflake synced/override fields via <SyncedOverrideField/>
//          (price/address/beds/baths/sqft/elevation — blank reverts to synced)
//        - home-specific marketing fields via <GenericField/> (admin columns, direct)
//        - the main image via <ImageUploader/> (text url submits with the same form;
//          the file upload uses its own uploadImage round-trip)
//   · togglePublished('qmi', id, value) — the publish gate, via <PublishedToggle/>.
// FormData field names are IDENTICAL to the generic engine, so the audit_log +
// FRAMER_QUEUE enqueue + first-primary session behaviour is unchanged.
//
// Layout: breadcrumb + address title + copyable SKU strip (Housemaster / ECI / Job) +
// status badges + action buttons; photo gallery; stats row; base-vs-current price card;
// the prominent "Assign floor plan" lead for drafts (floor_plan_id NULL); the synced/
// override editors; home-specific marketing; promotions membership; description.
// =============================================================================

import { useMemo } from 'react';
import Link from 'next/link';
import { saveEntity } from '@/lib/actions';
import type { QmiDetailView } from '@/lib/qmi-detail';
import { SyncedOverrideField } from '@/components/fields/SyncedOverrideField';
import { GenericField } from '@/components/fields/GenericField';
import { ImageUploader } from '@/components/fields/ImageUploader';
import { ImageGalleryEditor } from '@/components/fields/ImageGalleryEditor';
import { PublishedToggle } from '@/components/fields/PublishedToggle';
import { LOCATION_STATUS, statusTone } from '@/lib/status';
import { QmiPhotoGallery } from './QmiPhotoGallery';
import { CopyableId } from './CopyableId';
import { QmiPriceCard } from './QmiPriceCard';
import { QmiAssignFloorPlan } from './QmiAssignFloorPlan';
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
    ...(!view.isUnassigned ? [{ id: sectionId('Floor plan assignment'), label: 'Assignment' }] : []),
    { id: sectionId('From MarkSystems'), label: 'MarkSystems' },
    { id: sectionId('Marketing'), label: 'Marketing' },
    { id: sectionId('Description'), label: 'Description' },
    { id: sectionId('Promotions'), label: 'Promotions' },
  ];

  const mediaRail = (
    <div className="min-w-0 space-y-5">
      <h3 className="text-sm font-medium text-foreground">Media</h3>
      <ImageUploader
        entity="qmi"
        id={view.id}
        field="image_url"
        label="Main Image"
        initialUrl={view.gallery[0]?.url ?? ''}
        help="Home-level hero. Falls back to the floor-plan rendering when empty."
        compact
      />
      <ImageUploader
        entity="qmi"
        id={view.id}
        field="floor_plan_image"
        label="Floor Plan Image"
        initialUrl={view.admin.floorPlanImage}
        compact
      />
      <ImageGalleryEditor
        entity="qmi"
        id={view.id}
        field="photo_gallery_json"
        label="Photo Gallery"
        initialValue={view.photoGalleryJson}
        help="Per-home photos shown on the listing detail page — e.g. upgraded-option photos. Upload in display order."
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

      <QmiPhotoGallery images={view.gallery} alt={title} />

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
        {!view.isUnassigned ? (
          <Card id={sectionId('Floor plan assignment')}>
            <CardHeader className="border-b">
              <CardTitle className="text-base font-medium">Floor plan assignment</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <SyncedOverrideField {...view.relations.floorPlan} />
              <SyncedOverrideField {...view.relations.community} />
              <SyncedOverrideField {...view.relations.city} />
            </CardContent>
          </Card>
        ) : null}

        <div id={sectionId('From MarkSystems')}>
          <MarkSystemsSection>
          <div className="grid gap-4 sm:grid-cols-2">
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
    <div className="mx-auto w-full max-w-7xl">
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
        />
      </div>
      <EditToast message={toast?.message ?? null} tone={toast?.tone ?? 'success'} onDismiss={dismissToast} />
      <UnsavedLeaveToast
        open={leavePrompt != null}
        pending={pending}
        onSave={saveBeforeLeave}
        onDiscard={discardLeave}
        onStay={stayOnPage}
      />

      <div className="mt-5">
        <form id={formId} action={onSubmit}>
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
        </form>
      </div>
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
