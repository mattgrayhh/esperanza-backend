// =============================================================================
// packages/admin — DASHBOARD landing (/).
//
// SERVER COMPONENT. Reads real counts + recent audit activity directly from D1
// via getReadDb() (first-primary session — read-your-writes). NO client-side
// data fetching: every number on this page is computed here on the server and
// passed as props into presentational shadcn Card primitives.
//
// Re-skin only: this replaces the old plain-link grid with purposeful shadcn
// cards. It does NOT touch auth, server actions, the config-driven engine, or
// the synced/override + promo-scope semantics — it only READS.
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
  PencilLineIcon,
  type LucideIcon,
} from 'lucide-react';
import { getReadDb } from '../lib/db';
import { ENTITY_LIST, type EntityKey } from '../lib/entities';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';

// Admin pages are always dynamic + auth-gated; never statically cache.
export const dynamic = 'force-dynamic';

// Per-entity presentation (icon) keyed by EntityKey — mirrors app-shared.tsx so
// the dashboard and the sidebar agree. ENTITY_LIST stays the source of truth for
// label/segment; this only adds an icon.
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

interface RecentEdit {
  id: number;
  entity: string;
  entityId: string;
  field: string | null;
  action: string;
  actor: string | null;
  at: string;
}

interface DashboardData {
  qmiTotal: number;
  qmiPublished: number;
  communitiesTotal: number;
  communitiesPublished: number;
  promotionsTotal: number;
  promotionsActive: number;
  recent: RecentEdit[];
}

// One read-your-writes session; a handful of small aggregate queries. We read
// BASE tables (so unpublished/draft rows count toward totals) and derive the
// "published/active" subset with a filtered COUNT — matching the publish gates
// used by the public views (qmi.published, communities.published, promotions.published).
async function loadDashboard(): Promise<DashboardData> {
  const db = getReadDb();

  const [qmi] = await db.all<{ total: number; published: number }>(
    sql.raw(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END), 0) AS published
       FROM qmi`
    )
  );
  const [communities] = await db.all<{ total: number; published: number }>(
    sql.raw(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END), 0) AS published
       FROM communities`
    )
  );
  // promotions gate renamed active→published in migration 0005.
  const [promotions] = await db.all<{ total: number; active: number }>(
    sql.raw(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END), 0) AS active
       FROM promotions`
    )
  );
  const recent = await db.all<RecentEdit>(
    sql.raw(
      `SELECT id, entity, entity_id AS entityId, field, action, actor, at
       FROM audit_log
       ORDER BY at DESC, id DESC
       LIMIT 8`
    )
  );

  return {
    qmiTotal: Number(qmi?.total ?? 0),
    qmiPublished: Number(qmi?.published ?? 0),
    communitiesTotal: Number(communities?.total ?? 0),
    communitiesPublished: Number(communities?.published ?? 0),
    promotionsTotal: Number(promotions?.total ?? 0),
    promotionsActive: Number(promotions?.active ?? 0),
    recent: recent ?? [],
  };
}

function entityDef(key: EntityKey) {
  const def = ENTITY_LIST.find((e) => e.key === key);
  if (!def) throw new Error(`Unknown entity key: ${key}`);
  return def;
}

function entityLabel(key: string): string {
  return ENTITY_LIST.find((e) => e.key === key)?.label ?? key;
}

function entitySegment(key: string): string | null {
  return ENTITY_LIST.find((e) => e.key === key)?.segment ?? null;
}

// Relative "time ago" for audit rows. `at` is an ISO string (nowIso default).
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

export default async function DashboardPage() {
  const data = await loadDashboard();
  const qmiPct = pct(data.qmiPublished, data.qmiTotal);

  return (
    <div className="flex flex-col gap-6">
      {/* ── Title band ───────────────────────────────────────────────── */}
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            Dashboard
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Every save writes D1 (read-your-writes), records an audit entry, and enqueues a Framer
            push. QMI synced fields route through the override helper; the publish toggle is the only
            path that publishes.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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

      {/* ── Primary row: QMI status hero (wide) + two stacked stat cards ─ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* QMI — the lead listing entity gets the prominent card with a ratio bar. */}
        <Card className="lg:col-span-2">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <HomeIcon className="size-4 text-primary" />
              Quick Move-Ins
            </CardTitle>
            <CardDescription>
              Published homes are live on the public site. Drafts stay hidden until toggled.
            </CardDescription>
            <CardAction>
              <Badge variant={qmiPct >= 50 ? 'default' : 'secondary'}>{qmiPct}% live</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-end gap-6">
              <div className="flex flex-col">
                <span className="font-heading text-4xl font-semibold tabular-nums leading-none text-foreground">
                  {data.qmiPublished}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">published</span>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="flex flex-col">
                <span className="font-heading text-2xl font-medium tabular-nums leading-none text-muted-foreground">
                  {data.qmiTotal}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">total records</span>
              </div>
              <div className="ml-auto flex flex-col text-right">
                <span className="font-heading text-2xl font-medium tabular-nums leading-none text-muted-foreground">
                  {Math.max(data.qmiTotal - data.qmiPublished, 0)}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">draft / hidden</span>
              </div>
            </div>
            {/* Published-ratio bar (purposeful, not a hero number). */}
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${data.qmiPublished} of ${data.qmiTotal} Quick Move-Ins published`}
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${qmiPct}%` }}
              />
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button render={<Link href="/qmi/new" />} variant="ghost" size="sm">
              <PlusIcon />
              New
            </Button>
            <Button render={<Link href="/qmi" />} variant="outline" size="sm">
              Manage QMIs
              <ArrowRightIcon />
            </Button>
          </CardFooter>
        </Card>

        {/* Stacked secondary stats: Communities + Active promotions. */}
        <div className="flex flex-col gap-4">
          <StatCard
            icon={BuildingIcon}
            label="Communities"
            primary={data.communitiesPublished}
            primaryCaption="published"
            secondary={data.communitiesTotal}
            secondaryCaption="total"
            href="/communities"
            newHref="/communities/new"
          />
          <StatCard
            icon={TagIcon}
            label="Active promotions"
            primary={data.promotionsActive}
            primaryCaption="active"
            secondary={data.promotionsTotal}
            secondaryCaption="total"
            href="/promotions"
            newHref="/promotions/new"
          />
        </div>
      </div>

      {/* ── Secondary row: recent edits (wide) + jump-to grid ──────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Recent edits — real audit_log rows. */}
        <Card className="lg:col-span-2">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <PencilLineIcon className="size-4 text-primary" />
              Recent edits
            </CardTitle>
            <CardDescription>Latest audit-log activity across all entities.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {data.recent.length === 0 ? (
              <div className="px-4">
                <Empty className="border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <PencilLineIcon />
                    </EmptyMedia>
                    <EmptyTitle>No edits yet</EmptyTitle>
                    <EmptyDescription>
                      Saving any record records an audit entry — it will show up here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity</TableHead>
                    <TableHead>Field</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recent.map((row) => {
                    const seg = entitySegment(row.entity);
                    const label = entityLabel(row.entity);
                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          {seg ? (
                            <Link
                              href={`/${seg}/${row.entityId}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {label}
                            </Link>
                          ) : (
                            <span className="font-medium">{label}</span>
                          )}
                          <span className="ml-2 text-xs text-muted-foreground">{row.action}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.field ?? <span className="text-muted-foreground/60">—</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.actor ?? <span className="text-muted-foreground/60">system</span>}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {timeAgo(row.at)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Jump-to all 9 entities — compact rows with open / + New. */}
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

// Compact secondary stat card: a primary published/active count, a muted total,
// and open / + New affordances. Used for Communities + Promotions.
function StatCard({
  icon: Icon,
  label,
  primary,
  primaryCaption,
  secondary,
  secondaryCaption,
  href,
  newHref,
}: {
  icon: LucideIcon;
  label: string;
  primary: number;
  primaryCaption: string;
  secondary: number;
  secondaryCaption: string;
  href: string;
  newHref: string;
}) {
  return (
    <Card size="sm" className="flex-1">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4 text-primary" />
          {label}
        </CardTitle>
        <CardAction>
          <Button render={<Link href={newHref} />} variant="ghost" size="icon-sm" aria-label={`New ${label}`}>
            <PlusIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex items-end justify-between">
        <div className="flex items-end gap-3">
          <div className="flex flex-col">
            <span className="font-heading text-3xl font-semibold tabular-nums leading-none text-foreground">
              {primary}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">{primaryCaption}</span>
          </div>
          <span className="pb-0.5 text-xs text-muted-foreground">
            / {secondary} {secondaryCaption}
          </span>
        </div>
        <Link
          href={href}
          aria-label={`Open ${label}`}
          className="text-muted-foreground hover:text-primary"
        >
          <ArrowRightIcon className="size-4" />
        </Link>
      </CardContent>
    </Card>
  );
}
