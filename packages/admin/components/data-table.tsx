"use client"

// =============================================================================
// packages/admin — reusable client DataTable for the generic entity LIST view.
//
// PRESENTATION ONLY. This component receives plain, already-fetched server data
// (columns + rows from lib/build-list-view.ts via getReadDb()) and renders it with
// @tanstack/react-table + base-nova primitives. It adds NO client-side data
// fetching — every prop is computed server-side in app/[entity]/page.tsx.
//
// Columns are DERIVED from the per-entity list config (ListColumn[]) so the config
// (lib/field-config.ts) stays the single source of truth for which fields render.
// The engine just maps each ListColumn -> a TanStack ColumnDef:
//   - first column           → link to the editor (/segment/id)
//   - kind 'publish'          → status Badge (published/active/status)
//   - everything else         → plain text cell
// Plus a synthetic "State" column (the publish gate) and a row-action column.
// =============================================================================

import * as React from "react"
import Link from "next/link"
import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// ── serializable shapes (mirror lib/build-list-view.ts ListView, kept local so
//    this client component imports no server-only modules) ────────────────────
export type ListCellKind = "text" | "number" | "boolean" | "publish" | "currency"

export interface DataTableColumn {
  field: string
  label: string
  kind?: ListCellKind
}

export interface DataTableRow {
  id: string
  /** field -> formatted display string (already fmt()'d server-side). */
  values: Record<string, string>
  /** publish-gate value: true=live, false=draft, null=no gate for this entity. */
  live: boolean | null
}

export interface DataTableProps {
  segment: string
  columns: DataTableColumn[]
  rows: DataTableRow[]
  /** the entity's publish gate column, or null when it has none. */
  gateColumn: string | null
  truncated: boolean
  label: string
}

// =============================================================================
// Status badge — maps a publish/gate state to the brand status tokens defined in
// app/globals.css (--color-status-{published,draft,sold}). Terracotta is reserved
// for "sold"; brand green for live/published; warm-gray muted for draft.
// =============================================================================
type StatusTone = "published" | "draft" | "sold"

const STATUS_CLASSES: Record<StatusTone, string> = {
  published: "bg-status-published text-status-published-foreground",
  draft: "bg-status-draft text-status-draft-foreground",
  sold: "bg-status-sold text-status-sold-foreground",
}

/** Classify a raw publish-cell string into a tone + display label. */
function classifyPublish(raw: string): { tone: StatusTone; text: string } {
  const v = raw.trim()
  const lower = v.toLowerCase()
  if (lower === "sold") return { tone: "sold", text: v }
  // empty/0/no/false/draft => draft (matches the legacy PublishPill predicate).
  const isDraft =
    v === "" || lower === "0" || lower === "no" || lower === "false" || lower === "draft"
  if (isDraft) return { tone: "draft", text: v === "" ? "draft" : v }
  return { tone: "published", text: v }
}

function StatusBadge({ tone, text }: { tone: StatusTone; text: string }) {
  return (
    <Badge className={cn("capitalize", STATUS_CLASSES[tone])}>{text}</Badge>
  )
}

/** The synthetic "State" column derives its tone from the boolean gate. */
function GateBadge({ live }: { live: boolean | null }) {
  if (live == null) return <span className="text-muted-foreground">—</span>
  return live ? (
    <StatusBadge tone="published" text="live" />
  ) : (
    <StatusBadge tone="draft" text="draft" />
  )
}

// =============================================================================
// Column factory — derive TanStack ColumnDef[] from the entity list config.
// =============================================================================
const ACTION_COL_ID = "__actions"
const STATE_COL_ID = "__state"

function buildColumns(
  segment: string,
  cols: DataTableColumn[],
  gateColumn: string | null,
): ColumnDef<DataTableRow>[] {
  const defs: ColumnDef<DataTableRow>[] = cols.map((c, index) => ({
    id: c.field,
    accessorFn: (row) => row.values[c.field] ?? "",
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 px-2 text-muted-foreground hover:text-foreground"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        {c.label}
        <ArrowUpDown className="size-3 opacity-60" />
      </Button>
    ),
    cell: ({ row }) => {
      const value = row.original.values[c.field] ?? ""
      // First column → link to the editor.
      if (index === 0) {
        return (
          <Link
            href={`/${segment}/${row.original.id}`}
            className="font-medium text-primary hover:underline"
          >
            {value || row.original.id}
          </Link>
        )
      }
      // Publish-kind column → status badge.
      if (c.kind === "publish") {
        const { tone, text } = classifyPublish(value)
        return <StatusBadge tone={tone} text={text} />
      }
      return <span className="text-foreground/80">{value || "—"}</span>
    },
    // Numeric + currency columns sort by value (numericSort strips $ and commas).
    sortingFn: c.kind === "number" || c.kind === "currency" ? numericSort : "alphanumeric",
    enableHiding: index !== 0, // keep the title column always visible
  }))

  // Synthetic State column for entities that have a publish gate.
  if (gateColumn != null) {
    defs.push({
      id: STATE_COL_ID,
      accessorFn: (row) => (row.live == null ? "" : row.live ? "live" : "draft"),
      header: "State",
      cell: ({ row }) => <GateBadge live={row.original.live} />,
      enableSorting: true,
    })
  }

  // Row-action column → edit link.
  defs.push({
    id: ACTION_COL_ID,
    header: "",
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => (
      <div className="text-right">
        <Button
          variant="ghost"
          size="xs"
          render={
            <Link href={`/${segment}/${row.original.id}`}>edit →</Link>
          }
        />
      </div>
    ),
  })

  return defs
}

/** numeric-aware sort over the formatted display string (falls back to text). */
function numericSort(
  a: { getValue: (id: string) => unknown },
  b: { getValue: (id: string) => unknown },
  id: string,
): number {
  const na = parseFloat(String(a.getValue(id)).replace(/[^0-9.-]/g, ""))
  const nb = parseFloat(String(b.getValue(id)).replace(/[^0-9.-]/g, ""))
  const aNan = Number.isNaN(na)
  const bNan = Number.isNaN(nb)
  if (aNan && bNan) return 0
  if (aNan) return -1
  if (bNan) return 1
  return na - nb
}

// =============================================================================
// DataTable
// =============================================================================
export function DataTable({
  segment,
  columns,
  rows,
  gateColumn,
  truncated,
  label,
}: DataTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = React.useState("")
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})

  const columnDefs = React.useMemo(
    () => buildColumns(segment, columns, gateColumn),
    [segment, columns, gateColumn],
  )

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  })

  const colSpan = columnDefs.length
  const totalRows = rows.length
  const filteredRows = table.getFilteredRowModel().rows.length

  // Map ColumnDef id -> label for the visibility menu.
  const labelFor = (id: string): string => {
    if (id === STATE_COL_ID) return "State"
    return columns.find((c) => c.field === id)?.label ?? id
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── header: title + New ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground">{label}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {filteredRows === totalRows
              ? `${totalRows} record${totalRows === 1 ? "" : "s"}`
              : `${filteredRows} of ${totalRows} records`}
            {truncated ? ` · showing first ${totalRows}` : ""}
          </p>
        </div>
        <Button render={<Link href={`/${segment}/new`} />}>
          <Plus className="size-4" />
          New
        </Button>
      </div>

      {/* ── toolbar: search + column visibility ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder={`Filter ${label.toLowerCase()}…`}
            className="pl-8"
            aria-label={`Filter ${label}`}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <SlidersHorizontal className="size-3.5" />
            Columns
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide() && column.id !== ACTION_COL_ID)
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {labelFor(column.id)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── table ── */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="bg-muted/40 hover:bg-muted/40"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="text-xs font-medium tracking-wide text-muted-foreground"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="hover:bg-accent/40">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={colSpan}
                  className="h-24 text-center text-muted-foreground"
                >
                  {totalRows === 0 ? "No records." : "No matching records."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── pagination ── */}
      {table.getPageCount() > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft className="size-3.5" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
