// =============================================================================
// packages/admin — DASHBOARD landing (/).
//
// SERVER COMPONENT. Reads real counts + recent audit activity directly from D1
// via getReadDb() (first-primary session — read-your-writes). NO client-side
// data fetching: every number on this page is computed here on the server and
// passed into presentational primitives.
//
// Reframed from "scoreboard" to "worklist". The page leads with a Needs-attention
// band (what the operator should DO next), then a compact at-a-glance status, then
// humanized recent activity + collection nav. It only READS — it does NOT touch
// auth, server actions, the engine, or synced/override + promo-scope semantics.
//
// Readiness (the heart of the Needs-attention band) follows the team's real
// publish gate for a Quick Move-In:
//   G1  matched to a house number          → qmi.housenumber present
//   G2  linked to a COMPLETE floor plan     → fp published + image/type/sqft/
//                                             price/beds/baths/garage all filled
//   G3  PDFs rendered                       → pdf_renders.status = 'live'
// A draft passing all three is "ready to publish"; otherwise it sits in one of
// three buckets (unmatched → plan gaps → awaiting PDF), which is a clean funnel.
// =============================================================================

import Link from 'next/link';
import { sql } from 'drizzle-orm';
import {
  HomeIcon,
  BuildingIcon,
  MapPinIcon,
  LayoutTemplateIcon,
  TagIcon,
  LayersIcon,
  ImageIcon,
  FileTextIcon,
  QuoteIcon,
  PlusIcon,
  ArrowRightIcon,
  RocketIcon,
  ListChecksIcon,
  RefreshCwIcon,
  CircleCheckIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { getReadDb } from '@/lib/db';
import { ENTITY_LIST, type EntityKey } from '@/lib/entities';
import {
  type AuditRow,
  activityPhrase,
  actorName,
  entityLabel,
  entitySegment,
  groupActivity,
  timeAgo,
} from '@/lib/activity-format';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { cn } from '@/lib/utils';

// Admin pages are always dynamic + auth-gated; never statically cache.
export const dynamic = 'force-dynamic';

// Per-entity icon keyed by EntityKey — mirrors app-shared.tsx so the dashboard
// and the sidebar agree. ENTITY_LIST stays the source of truth for label/segment.
const ENTITY_ICON: Record<EntityKey, LucideIcon> = {
  qmi: HomeIcon,
  communities: BuildingIcon,
  cities: MapPinIcon,
  floor_plans: LayoutTemplateIcon,
  promotions: TagIcon,
  collections: LayersIcon,
  images: ImageIcon,
  blogs: FileTextIcon,
  testimonials: QuoteIcon,
};

interface QmiBreakdown {
  total: number;
  published: number;
  ready: number; // unpublished, all three gates pass
  unmatched: number; // unpublished, no house number
  planGaps: number; // matched, floor plan incomplete
  pdfPending: number; // matched + plan complete, PDFs not rendered
}

interface FramerSync {
  status: string | null;
  at: string;
  errorMessage: string | null;
}

interface DashboardData {
  qmi: QmiBreakdown;
  communitiesTotal: number;
  communitiesPublished: number;
  promotionsTotal: number;
  promotionsActive: number;
  framer: FramerSync | null;
  framerLastOk: string | null;
  recent: AuditRow[];
}

async function loadDashboard(): Promise<DashboardData> {
  const db = getReadDb();

  // ── QMI readiness funnel ────────────────────────────────────────────────
  // One pass over qmi, LEFT JOIN the effective floor plan, and probe pdf_renders
  // with a correlated EXISTS (avoids row fan-out). Each gate resolves to 1/0 so
  // the outer SUMs are exhaustive: every draft lands in exactly one bucket.
  const [qmiRow] = await db.all<{
    total: number;
    published: number;
    ready: number;
    unmatched: number;
    plan_gaps: number;
    pdf_pending: number;
  }>(
    sql.raw(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN q.published = 1 THEN 1 ELSE 0 END), 0) AS published,
         COALESCE(SUM(CASE WHEN q.published = 0 AND g1 = 1 AND g2 = 1 AND g3 = 1 THEN 1 ELSE 0 END), 0) AS ready,
         COALESCE(SUM(CASE WHEN q.published = 0 AND g1 = 0 THEN 1 ELSE 0 END), 0) AS unmatched,
         COALESCE(SUM(CASE WHEN q.published = 0 AND g1 = 1 AND g2 = 0 THEN 1 ELSE 0 END), 0) AS plan_gaps,
         COALESCE(SUM(CASE WHEN q.published = 0 AND g1 = 1 AND g2 = 1 AND g3 = 0 THEN 1 ELSE 0 END), 0) AS pdf_pending
       FROM (
         SELECT
           q.published,
           CASE WHEN q.housenumber IS NOT NULL AND q.housenumber <> '' THEN 1 ELSE 0 END AS g1,
           CASE WHEN fp.id IS NOT NULL
                     AND fp.published = 1
                     AND fp.fp_image IS NOT NULL AND fp.fp_image NOT IN ('', '[]')
                     AND fp.collection IS NOT NULL AND fp.collection <> ''
                     AND COALESCE(fp.override_total_square_footage, fp.synced_total_square_footage) IS NOT NULL
                     AND COALESCE(fp.override_starting_price, fp.synced_starting_price) IS NOT NULL
                     AND COALESCE(fp.override_bedroom_max, fp.synced_bedroom_max) IS NOT NULL
                     AND COALESCE(fp.override_bathroom_max, fp.synced_bathroom_max) IS NOT NULL
                     AND fp.car_garage_count IS NOT NULL
                THEN 1 ELSE 0 END AS g2,
           CASE WHEN EXISTS (
                  SELECT 1 FROM pdf_renders pr
                  WHERE pr.type = 'qmi' AND pr.entity_id = q.id AND pr.status = 'live'
                ) THEN 1 ELSE 0 END AS g3
         FROM qmi q
         LEFT JOIN floor_plans fp
           ON fp.id = COALESCE(q.override_floor_plan_id, q.synced_floor_plan_id)
       ) q`
    )
  );

  const [communities] = await db.all<{ total: number; published: number }>(
    sql.raw(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END), 0) AS published
       FROM communities`
    )
  );
  const [promotions] = await db.all<{ total: number; active: number }>(
    sql.raw(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END), 0) AS active
       FROM promotions`
    )
  );

  // ── Framer sync health ──────────────────────────────────────────────────
  // framer-push writes one sync_log row per batch (source='framer'). There is no
  // per-record push state in D1, so we surface system-level health: the latest
  // batch outcome + the last known-good push time.
  const [framer] = await db.all<{ status: string | null; at: string; error_message: string | null }>(
    sql.raw(
      `SELECT status, at, error_message
       FROM sync_log
       WHERE source = 'framer'
       ORDER BY at DESC, id DESC
       LIMIT 1`
    )
  );
  const [framerOk] = await db.all<{ last_ok: string | null }>(
    sql.raw(
      `SELECT MAX(at) AS last_ok FROM sync_log WHERE source = 'framer' AND status = 'success'`
    )
  );

  // Pull a wider window than we render so adjacent same-actor edits group well.
  const recent = await db.all<AuditRow>(
    sql.raw(
      `SELECT entity, field, action, actor, at
       FROM audit_log
       ORDER BY at DESC, id DESC
       LIMIT 40`
    )
  );

  return {
    qmi: {
      total: Number(qmiRow?.total ?? 0),
      published: Number(qmiRow?.published ?? 0),
      ready: Number(qmiRow?.ready ?? 0),
      unmatched: Number(qmiRow?.unmatched ?? 0),
      planGaps: Number(qmiRow?.plan_gaps ?? 0),
      pdfPending: Number(qmiRow?.pdf_pending ?? 0),
    },
    communitiesTotal: Number(communities?.total ?? 0),
    communitiesPublished: Number(communities?.published ?? 0),
    promotionsTotal: Number(promotions?.total ?? 0),
    promotionsActive: Number(promotions?.active ?? 0),
    framer: framer ? { status: framer.status, at: framer.at, errorMessage: framer.error_message } : null,
    framerLastOk: framerOk?.last_ok ?? null,
    recent: recent ?? [],
  };
}

// =============================================================================
// Page
// =============================================================================
export default async function DashboardPage() {
  const d = await loadDashboard();
  const groups = groupActivity(d.recent).slice(0, 7);
  const drafts = d.qmi.unmatched + d.qmi.planGaps + d.qmi.pdfPending;

  const syncErrored = d.framer != null && d.framer.status !== 'success';
  const syncOk = d.framer != null && d.framer.status === 'success';

  // The band is a true worklist: it lists only things the operator should act on.
  const hasWork = d.qmi.ready > 0 || drafts > 0 || syncErrored;

  return (
    <div className="flex flex-col gap-8">
      {/* ── Title band ─────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage Quick Move-Ins, communities, and promotions.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button render={<Link href="/qmi/new" />} size="sm">
            <PlusIcon />
            New QMI
          </Button>
          <Button render={<Link href="/promotions/new" />} size="sm" variant="outline">
            <PlusIcon />
            New promotion
          </Button>
        </div>
      </header>

      {/* ── Needs attention (the lead) ─────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Needs attention
          </h2>
          {syncOk && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheckIcon className="size-3.5 text-primary" />
              Website synced {timeAgo(d.framer!.at)}
            </span>
          )}
        </div>

        {hasWork ? (
          <div className="flex flex-col gap-px overflow-hidden rounded-xl border bg-border sm:flex-row">
            {d.qmi.ready > 0 && (
              <AttentionItem
                href="/qmi"
                tone="positive"
                icon={RocketIcon}
                count={d.qmi.ready}
                grow={2}
                label={d.qmi.ready === 1 ? 'home ready to publish' : 'homes ready to publish'}
                sub="House number, floor plan, and PDFs all cleared."
              />
            )}

            {drafts > 0 && (
              <AttentionItem
                href="/qmi"
                tone="neutral"
                icon={ListChecksIcon}
                grow={1}
                count={drafts}
                label={drafts === 1 ? 'draft in progress' : 'drafts in progress'}
                sub={[
                  d.qmi.unmatched > 0 ? `${d.qmi.unmatched} need a house number` : null,
                  d.qmi.planGaps > 0 ? `${d.qmi.planGaps} waiting on floor-plan data` : null,
                  d.qmi.pdfPending > 0 ? `${d.qmi.pdfPending} awaiting PDF render` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}

            {syncErrored && (
              <AttentionItem
                href="/activity"
                tone="alert"
                icon={TriangleAlertIcon}
                grow={1}
                label={`Website update ${d.framer!.status === 'partial' ? 'partly failed' : 'failed'}`}
                timestamp={timeAgo(d.framer!.at)}
                sub={
                  d.framer!.errorMessage
                    ? d.framer!.errorMessage.slice(0, 120)
                    : d.framerLastOk
                      ? `Last clean sync ${timeAgo(d.framerLastOk)}. Open the sync log.`
                      : 'Open the sync log to investigate.'
                }
              />
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border bg-secondary/40 px-4 py-3 text-sm">
            <CircleCheckIcon className="size-4 shrink-0 text-primary" />
            <span className="text-foreground">
              All clear. Every draft is published or in good shape, and the last website sync succeeded.
            </span>
          </div>
        )}
      </section>

      {/* ── At a glance ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          At a glance
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <QmiStatusCard className="lg:col-span-2" qmi={d.qmi} draftsTotal={drafts} />
          <div className="flex flex-col gap-4">
            <CompactStat
              icon={BuildingIcon}
              label="Communities"
              primary={d.communitiesPublished}
              total={d.communitiesTotal}
              href="/communities"
            />
            <CompactStat
              icon={TagIcon}
              label="Active promotions"
              primary={d.promotionsActive}
              total={d.promotionsTotal}
              href="/promotions"
            />
          </div>
        </div>
      </section>

      {/* ── Activity + nav ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b">
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Latest changes across every collection.</CardDescription>
            <CardAction>
              <Button render={<Link href="/activity" />} variant="ghost" size="sm">
                View all
                <ArrowRightIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-2 py-2">
            {groups.length === 0 ? (
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ListChecksIcon />
                  </EmptyMedia>
                  <EmptyTitle>No activity yet</EmptyTitle>
                  <EmptyDescription>Saving any record records an entry here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col">
                {groups.map((g, i) => {
                  const seg = entitySegment(g.entity);
                  const Icon = ENTITY_ICON[g.entity as EntityKey] ?? ListChecksIcon;
                  const label = entityLabel(g.entity);
                  return (
                    <li
                      key={`${g.entity}-${g.action}-${g.at}-${i}`}
                      className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted"
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <Icon className="size-4" />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-foreground">
                          {activityPhrase(g)}{' '}
                          <span className="text-muted-foreground">on</span>{' '}
                          {seg ? (
                            <Link href={`/${seg}`} className="font-medium text-primary hover:underline">
                              {label}
                            </Link>
                          ) : (
                            <span className="font-medium">{label}</span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">{actorName(g.actor)}</span>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {timeAgo(g.at)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Jump-to all 9 entities. */}
        <Card>
          <CardHeader className="border-b">
            <CardTitle>All collections</CardTitle>
            <CardDescription>Jump to any of the 9 managed entities.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 px-2">
            {ENTITY_LIST.map((e) => {
              const Icon = ENTITY_ICON[e.key];
              return (
                <div
                  key={e.key}
                  className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <Link href={`/${e.segment}`} className="flex-1 text-sm font-medium hover:underline">
                    {e.label}
                  </Link>
                  <Link
                    href={`/${e.segment}/new`}
                    aria-label={`New ${e.label}`}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <PlusIcon className="size-4" />
                  </Link>
                  <Link
                    href={`/${e.segment}`}
                    aria-label={`Open ${e.label}`}
                    className="rounded p-1 text-muted-foreground hover:text-primary"
                  >
                    <ArrowRightIcon className="size-4" />
                  </Link>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Needs-attention item ────────────────────────────────────────────────────
// One actionable cell. `count` items lead with the number; the sync item leads
// with a timestamp instead. Tone tints only the icon + accent, never a full fill,
// so the band stays calm even when it is dense.
function AttentionItem({
  href,
  tone,
  icon: Icon,
  count,
  label,
  sub,
  timestamp,
  grow = 1,
}: {
  href: string;
  tone: 'positive' | 'neutral' | 'alert';
  icon: LucideIcon;
  count?: number;
  label: string;
  sub?: string;
  timestamp?: string;
  /** flex-grow weight so tiles can share the row unevenly (e.g. 2 : 1). */
  grow?: number;
}) {
  const accent =
    tone === 'positive'
      ? 'text-primary'
      : tone === 'alert'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <Link
      href={href}
      style={{ flexGrow: grow, flexBasis: 0 }}
      className="group flex min-w-0 flex-col gap-2 bg-card p-4 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'flex size-8 items-center justify-center rounded-lg bg-muted',
            accent
          )}
        >
          <Icon className="size-4" />
        </span>
        <ArrowRightIcon className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="flex items-baseline gap-2">
        {count != null ? (
          <span className={cn('font-heading text-3xl font-semibold leading-none tabular-nums', accent)}>
            {count}
          </span>
        ) : (
          timestamp && (
            <span className={cn('font-heading text-2xl font-semibold leading-none', accent)}>
              {timestamp}
            </span>
          )
        )}
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      {sub && <p className="text-xs leading-relaxed text-muted-foreground">{sub}</p>}
    </Link>
  );
}

// ── QMI status card: one segmented bar, not three scattered numbers ──────────
function QmiStatusCard({
  qmi,
  draftsTotal,
  className,
}: {
  qmi: QmiBreakdown;
  draftsTotal: number;
  className?: string;
}) {
  const total = Math.max(qmi.total, 1);
  const w = (n: number) => `${(n / total) * 100}%`;
  const segments = [
    { n: qmi.published, label: 'Published', className: 'bg-primary' },
    { n: qmi.ready, label: 'Ready', className: 'bg-primary/45' },
    { n: draftsTotal, label: 'In progress', className: 'bg-muted-foreground/30' },
  ];
  return (
    <Card className={className}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <HomeIcon className="size-4 text-primary" />
          Quick Move-Ins
        </CardTitle>
        <CardDescription>
          {qmi.published} of {qmi.total} live.
        </CardDescription>
        <CardAction>
          <Button render={<Link href="/qmi" />} variant="outline" size="sm">
            Manage QMIs
            <ArrowRightIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          {segments.map(
            (s) =>
              s.n > 0 && (
                <div
                  key={s.label}
                  className={cn('h-full first:rounded-l-full last:rounded-r-full', s.className)}
                  style={{ width: w(s.n) }}
                />
              )
          )}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {segments.map((s) => (
            <div key={s.label} className="flex items-center gap-2">
              <span className={cn('size-2.5 rounded-full', s.className)} />
              <span className="text-sm font-medium tabular-nums text-foreground">{s.n}</span>
              <span className="text-sm text-muted-foreground">{s.label.toLowerCase()}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Compact secondary stat (Communities / Promotions) ───────────────────────
function CompactStat({
  icon: Icon,
  label,
  primary,
  total,
  href,
}: {
  icon: LucideIcon;
  label: string;
  primary: number;
  total: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50"
    >
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="size-4 text-primary" />
          {label}
        </span>
        <span className="text-xs text-muted-foreground">
          <span className="font-heading text-xl font-semibold tabular-nums text-foreground">
            {primary}
          </span>{' '}
          live / {total} total
        </span>
      </div>
      <ArrowRightIcon className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
    </Link>
  );
}
