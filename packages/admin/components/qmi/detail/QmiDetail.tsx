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

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { saveEntity } from '@/lib/actions';
import type { QmiDetailView } from '@/lib/qmi-detail';
import { SyncedOverrideField } from '@/components/fields/SyncedOverrideField';
import { GenericField } from '@/components/fields/GenericField';
import { ImageUploader } from '@/components/fields/ImageUploader';
import { PublishedToggle } from '@/components/fields/PublishedToggle';
import { QmiPhotoGallery } from './QmiPhotoGallery';
import { CopyableId } from './CopyableId';
import { QmiPriceCard } from './QmiPriceCard';
import { QmiAssignFloorPlan } from './QmiAssignFloorPlan';
import { ExpandableDescription } from './ExpandableDescription';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  BedDouble,
  Bath,
  Ruler,
  MapPin,
  ChevronLeft,
  ExternalLink,
  Share2,
  TagIcon,
  Building2,
} from 'lucide-react';

function fmtNum(v: number | null): string {
  return v == null ? '—' : v.toLocaleString();
}

export function QmiDetail({ view }: { view: QmiDetailView }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const isError = msg != null && msg.startsWith('Error:');

  const title = view.address.trim() || view.housenumber || view.id;

  // Single saveEntity submit for the whole editable form (override + admin + image).
  function onSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await saveEntity('qmi', view.id, formData);
      setMsg(res.ok ? 'Saved' : `Error: ${res.error}`);
    });
  }

  const previewHref = view.slug ? `/qmi/${view.slug}` : null;

  const stats = useMemo(
    () => [
      { icon: BedDouble, value: fmtNum(view.bedroomCount), label: 'beds' },
      { icon: Bath, value: fmtNum(view.bathroomCount), label: 'baths' },
      { icon: Ruler, value: fmtNum(view.totalSquareFootage), label: 'sqft' },
    ],
    [view.bedroomCount, view.bathroomCount, view.totalSquareFootage]
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      {/* ── Header: back + breadcrumb / actions ── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" render={<Link href="/qmi" aria-label="Back to Quick Move-Ins" />}>
            <ChevronLeft />
          </Button>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link href="/qmi">Quick Move-Ins</Link>} />
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="max-w-[16rem] truncate">{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {msg ? (
            <Badge variant={isError ? 'destructive' : 'secondary'} className="h-7">
              {msg}
            </Badge>
          ) : null}
          <PublishedToggle
            entityKey="qmi"
            id={view.id}
            gate="published"
            initialPublished={view.published}
            onResult={setMsg}
          />
          {previewHref ? (
            <Button variant="ghost" size="sm" type="button" render={<a href={previewHref} target="_blank" rel="noreferrer" />}>
              <ExternalLink />
              Preview
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => {
              const url = previewHref ?? `/qmi/${view.id}`;
              void navigator.clipboard?.writeText(url).then(() => setMsg('Link copied')).catch(() => {});
            }}
          >
            <Share2 />
            Share
          </Button>
        </div>
      </div>

      {/* ── Title + ecommerce-SKU technical id strip ── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <Badge variant={view.published ? 'default' : 'secondary'}>
            {view.published ? 'Published' : 'Draft'}
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
        <div className="flex flex-wrap items-center gap-2">
          <CopyableId label="Housemaster" value={view.housenumber} />
          <CopyableId label="ECI" value={view.eciKey} />
          <CopyableId label="Job" value={view.markJobNumber} />
        </div>
      </div>

      {/* ── Photo gallery (floor-plan renderings + home images) ── */}
      <QmiPhotoGallery images={view.gallery} alt={title} />

      {/* ── Draft lead: prominent Assign floor plan (the 80-90% auto-fill) ── */}
      {view.isUnassigned ? (
        <QmiAssignFloorPlan id={view.id} options={view.options.floorPlans} onResult={setMsg} />
      ) : null}

      {/* ── Summary: stats + location + price ── */}
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

      {/* ── Editable form: floor plan + synced/override + marketing + image ── */}
      <form action={onSubmit}>
        <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            {/* Floor-plan re-assignment (always available; for drafts the prominent
                QmiAssignFloorPlan above leads — but it also lives here so an assigned
                home can be re-assigned). Submits name="floor_plan_id" → override write. */}
            {!view.isUnassigned ? (
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Floor plan assignment</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <SyncedOverrideField {...view.relations.floorPlan} />
                  <SyncedOverrideField {...view.relations.community} />
                  <SyncedOverrideField {...view.relations.city} />
                </CardContent>
              </Card>
            ) : null}

            {/* Snowflake-fed home specifics (synced/override). Blank reverts to synced. */}
            <Card>
              <CardHeader className="border-b">
                <CardTitle>Home specifics</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <SyncedOverrideField {...view.syncedOverride.price} />
                <SyncedOverrideField {...view.syncedOverride.address} />
                <SyncedOverrideField {...view.syncedOverride.bedroomCount} />
                <SyncedOverrideField {...view.syncedOverride.bathroomCount} />
                <SyncedOverrideField {...view.syncedOverride.totalSquareFootage} />
                <SyncedOverrideField {...view.syncedOverride.elevation} />
              </CardContent>
            </Card>

            {/* Home-specific marketing (admin columns, edited directly). */}
            <Card>
              <CardHeader className="border-b">
                <CardTitle>Marketing</CardTitle>
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
                <GenericField
                  field="move_in_date"
                  label="Move-In Date"
                  widget="date"
                  value={view.admin.moveInDate}
                />
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

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save changes'}
              </Button>
              {msg ? (
                <span className={cn('text-sm', isError ? 'text-destructive' : 'text-muted-foreground')}>{msg}</span>
              ) : null}
            </div>
          </div>

          {/* RIGHT RAIL: main image (still inside the form → same saveEntity FormData). */}
          <div className="space-y-4">
            <Card className="self-start">
              <CardHeader className="border-b">
                <CardTitle>Main image</CardTitle>
              </CardHeader>
              <CardContent>
                <ImageUploader
                  entity="qmi"
                  id={view.id}
                  field="image_url"
                  label="Main Image"
                  initialUrl={view.gallery[0]?.url ?? ''}
                  help="Home-level hero. Falls back to the floor-plan rendering when empty."
                />
              </CardContent>
            </Card>
          </div>
        </section>
      </form>

      {/* ── Promotions targeting this home (read-only; targeting is owned by the promo) ── */}
      <Card className="py-5">
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

      {/* ── Description (expandable; home copy falls back to the floor-plan copy) ── */}
      <Card className="py-5">
        <CardContent className="space-y-3 px-5">
          <h2 className="text-lg font-semibold">
            Description
            {view.descriptionFromFloorPlan ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">(from floor plan)</span>
            ) : null}
          </h2>
          {view.description.trim() ? (
            <ExpandableDescription text={view.description} />
          ) : (
            <p className="text-sm text-muted-foreground">No description yet.</p>
          )}
        </CardContent>
      </Card>
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
