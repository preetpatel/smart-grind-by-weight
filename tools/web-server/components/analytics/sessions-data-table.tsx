'use client';

// The session browser. The interesting rows in a store of 250 grinds are the
// outliers — the TIMEOUTs, the MAX_PULSES, the ones that missed tolerance — so
// this sorts, filters by outcome, and searches, rather than showing the newest
// 25 and hoping. Selecting rows hands them straight to Compare.
import {
    type ColumnDef,
    type ColumnFiltersState,
    flexRender,
    getCoreRowModel,
    getFacetedRowModel,
    getFacetedUniqueValues,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    type RowSelectionState,
    type SortingState,
    useReactTable,
    type VisibilityState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown, GitCompare, ListFilter, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ResultBadge } from '@/components/analytics/result-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { sessionErrorLabel, sessionStartLabel, sessionTargetLabel } from '@/lib/analytics/labels';
import type { Annotation } from '@/lib/analytics/types';
import { type StoredRecord, TOLERANCE_G } from '@/lib/analytics/types';
import { MODE_MAP, PROFILE_MAP } from '@/lib/parser';
import { cn } from '@/lib/utils';

const NUMERIC = 'text-right font-mono tabular-nums';

function SortHeader({
    label,
    sorted,
    onToggle,
    numeric = false,
}: {
    label: string;
    sorted: false | 'asc' | 'desc';
    onToggle: () => void;
    numeric?: boolean;
}) {
    const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown;
    return (
        <button
            type="button"
            onClick={onToggle}
            className={cn(
                'group inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground',
                numeric && 'flex-row-reverse',
            )}
        >
            {label}
            <Icon
                className={cn(
                    'size-3 transition-opacity',
                    sorted ? 'opacity-100' : 'opacity-0 group-hover:opacity-60',
                )}
            />
        </button>
    );
}

// One dropdown per categorical column, counts included — the point of a facet
// is knowing there are three TIMEOUTs before you filter to them.
function FacetFilter({
    label,
    values,
    selected,
    onChange,
}: {
    label: string;
    values: Map<string, number>;
    selected: string[];
    onChange: (next: string[]) => void;
}) {
    const options = [...values.keys()].sort();
    if (options.length < 2) return null;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button variant="outline" size="sm">
                        <ListFilter />
                        {label}
                        {selected.length > 0 && (
                            <span className="ml-1 font-mono text-primary text-xs">
                                {selected.length}
                            </span>
                        )}
                    </Button>
                }
            />
            <DropdownMenuContent align="start" className="w-56">
                {options.map((option) => (
                    <DropdownMenuCheckboxItem
                        key={option}
                        checked={selected.includes(option)}
                        onCheckedChange={(checked) =>
                            onChange(
                                checked
                                    ? [...selected, option]
                                    : selected.filter((v) => v !== option),
                            )
                        }
                        closeOnClick={false}
                    >
                        <span className="flex-1">{option}</span>
                        <span className="font-mono text-muted-foreground text-xs">
                            {values.get(option)}
                        </span>
                    </DropdownMenuCheckboxItem>
                ))}
                {selected.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start"
                            onClick={() => onChange([])}
                        >
                            Clear
                        </Button>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function SessionsDataTable({
    records,
    annotations,
}: {
    records: StoredRecord[];
    annotations: Map<string, Annotation>;
}) {
    const router = useRouter();
    const [sorting, setSorting] = useState<SortingState>([{ id: 'started', desc: true }]);
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
        events: false,
        samples: false,
        setting: false,
    });
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const [search, setSearch] = useState('');

    const columns = useMemo<ColumnDef<StoredRecord>[]>(
        () => [
            {
                id: 'select',
                enableSorting: false,
                enableHiding: false,
                header: ({ table }) => (
                    <Checkbox
                        aria-label="Select all visible sessions"
                        checked={table.getIsAllPageRowsSelected()}
                        indeterminate={table.getIsSomePageRowsSelected()}
                        onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
                    />
                ),
                cell: ({ row }) => (
                    <Checkbox
                        aria-label={`Select session ${row.original.session.session_id}`}
                        checked={row.getIsSelected()}
                        onCheckedChange={(value) => row.toggleSelected(value === true)}
                    />
                ),
            },
            {
                id: 'id',
                accessorFn: (r) => r.session.session_id,
                header: 'ID',
                cell: ({ row }) => (
                    <span className="font-mono text-muted-foreground tabular-nums">
                        #{row.original.session.session_id}
                    </span>
                ),
            },
            {
                id: 'started',
                accessorFn: (r) => r.session.session_timestamp,
                header: 'Started',
                cell: ({ row }) => (
                    <span className="whitespace-nowrap">
                        {sessionStartLabel(row.original.session)}
                    </span>
                ),
            },
            {
                id: 'mode',
                accessorFn: (r) => MODE_MAP[r.session.grind_mode] ?? 'UNKNOWN',
                header: 'Mode',
                filterFn: (row, id, value: string[]) =>
                    !value.length || value.includes(row.getValue(id)),
                cell: ({ getValue }) => (
                    <span className="text-muted-foreground">{getValue<string>()}</span>
                ),
            },
            {
                id: 'profile',
                accessorFn: (r) => PROFILE_MAP[r.session.profile_id] ?? `P${r.session.profile_id}`,
                header: 'Profile',
                filterFn: (row, id, value: string[]) =>
                    !value.length || value.includes(row.getValue(id)),
                cell: ({ getValue }) => (
                    <span className="text-muted-foreground">{getValue<string>()}</span>
                ),
            },
            {
                id: 'target',
                accessorFn: (r) => r.session.target_weight,
                header: 'Target',
                cell: ({ row }) => (
                    <span className="text-muted-foreground">
                        {sessionTargetLabel(row.original.session)}
                    </span>
                ),
                meta: { numeric: true },
            },
            {
                id: 'final',
                accessorFn: (r) => r.session.final_weight,
                header: 'Final',
                cell: ({ getValue }) => `${getValue<number>().toFixed(2)} g`,
                meta: { numeric: true },
            },
            {
                id: 'error',
                accessorFn: (r) => r.session.final_weight - r.session.target_weight,
                header: 'Error',
                cell: ({ row }) => {
                    const s = row.original.session;
                    const isWeight = (MODE_MAP[s.grind_mode] ?? 'WEIGHT') === 'WEIGHT';
                    const within = Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G;
                    return (
                        <span
                            className={
                                isWeight
                                    ? within
                                        ? 'text-success'
                                        : 'text-destructive'
                                    : 'text-muted-foreground'
                            }
                        >
                            {sessionErrorLabel(s)}
                        </span>
                    );
                },
                meta: { numeric: true },
            },
            {
                id: 'pulses',
                accessorFn: (r) => r.session.pulse_count,
                header: 'Pulses',
                meta: { numeric: true },
            },
            {
                id: 'result',
                accessorFn: (r) => r.session.result_status,
                header: 'Result',
                filterFn: (row, id, value: string[]) =>
                    !value.length || value.includes(row.getValue(id)),
                cell: ({ getValue }) => <ResultBadge status={getValue<string>()} />,
            },
            {
                id: 'bean',
                accessorFn: (r) => annotations.get(r.sha256)?.bean ?? '—',
                header: 'Bean',
                filterFn: (row, id, value: string[]) =>
                    !value.length || value.includes(row.getValue(id)),
                cell: ({ getValue }) => {
                    const bean = getValue<string>();
                    return bean === '—' ? (
                        <span className="text-muted-foreground/50">—</span>
                    ) : (
                        <span className="truncate">{bean}</span>
                    );
                },
            },
            {
                id: 'setting',
                accessorFn: (r) => annotations.get(r.sha256)?.grind_setting ?? '',
                header: 'Setting',
                cell: ({ getValue }) => (
                    <span className="text-muted-foreground">{getValue<string>() || '—'}</span>
                ),
                meta: { numeric: true },
            },
            {
                id: 'events',
                accessorFn: (r) => r.events.length,
                header: 'Events',
                meta: { numeric: true },
            },
            {
                id: 'samples',
                accessorFn: (r) => r.measurements.length,
                header: 'Samples',
                meta: { numeric: true },
            },
        ],
        [annotations],
    );

    const table = useReactTable({
        data: records,
        columns,
        state: { sorting, columnFilters, columnVisibility, rowSelection, globalFilter: search },
        getRowId: (row) => row.sha256,
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        onColumnVisibilityChange: setColumnVisibility,
        onRowSelectionChange: setRowSelection,
        onGlobalFilterChange: setSearch,
        globalFilterFn: (row, _id, value: string) => {
            const s = row.original.session;
            const annotation = annotations.get(row.original.sha256);
            const haystack =
                `#${s.session_id} ${sessionStartLabel(s)} ${MODE_MAP[s.grind_mode]} ${PROFILE_MAP[s.profile_id]} ${s.result_status} ${annotation?.bean ?? ''} ${annotation?.grind_setting ?? ''} ${annotation?.note ?? ''} ${annotation?.tags.join(' ') ?? ''}`.toLowerCase();
            return haystack.includes(value.toLowerCase());
        },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getFacetedRowModel: getFacetedRowModel(),
        getFacetedUniqueValues: getFacetedUniqueValues(),
        getPaginationRowModel: getPaginationRowModel(),
        initialState: { pagination: { pageSize: 25 } },
    });

    const facet = (id: string) => table.getColumn(id)?.getFacetedUniqueValues() ?? new Map();
    const filterValue = (id: string) =>
        (table.getColumn(id)?.getFilterValue() as string[] | undefined) ?? [];
    const setFilter = (id: string, next: string[]) =>
        table.getColumn(id)?.setFilterValue(next.length ? next : undefined);

    const selectedIds = table
        .getSelectedRowModel()
        .rows.map((row) => row.original.session.session_id);
    const rows = table.getRowModel().rows;
    const filteredCount = table.getFilteredRowModel().rows.length;

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-3.5 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search sessions"
                        aria-label="Search sessions"
                        className="h-8 w-56 pl-8"
                    />
                </div>
                <FacetFilter
                    label="Result"
                    values={facet('result')}
                    selected={filterValue('result')}
                    onChange={(next) => setFilter('result', next)}
                />
                <FacetFilter
                    label="Mode"
                    values={facet('mode')}
                    selected={filterValue('mode')}
                    onChange={(next) => setFilter('mode', next)}
                />
                <FacetFilter
                    label="Profile"
                    values={facet('profile')}
                    selected={filterValue('profile')}
                    onChange={(next) => setFilter('profile', next)}
                />
                <FacetFilter
                    label="Bean"
                    values={facet('bean')}
                    selected={filterValue('bean')}
                    onChange={(next) => setFilter('bean', next)}
                />

                <div className="flex-1" />

                {selectedIds.length >= 2 && (
                    <Button
                        size="sm"
                        nativeButton={false}
                        render={
                            <Link href={`/analytics/compare?sessions=${selectedIds.join(',')}`} />
                        }
                    >
                        <GitCompare />
                        Compare {selectedIds.length}
                    </Button>
                )}

                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button variant="ghost" size="sm">
                                Columns
                            </Button>
                        }
                    />
                    <DropdownMenuContent align="end">
                        {table
                            .getAllColumns()
                            .filter((column) => column.getCanHide() && column.id !== 'select')
                            .map((column) => (
                                <DropdownMenuCheckboxItem
                                    key={column.id}
                                    checked={column.getIsVisible()}
                                    onCheckedChange={(value) => column.toggleVisibility(!!value)}
                                    closeOnClick={false}
                                    className="capitalize"
                                >
                                    {column.id}
                                </DropdownMenuCheckboxItem>
                            ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Wide screens read this as a table; phones get one card per grind,
                because eleven columns in 390px is not a table any more. */}
            <div className="hidden overflow-x-auto sm:block">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    const numeric = (
                                        header.column.columnDef.meta as
                                            | { numeric?: boolean }
                                            | undefined
                                    )?.numeric;
                                    return (
                                        <TableHead
                                            key={header.id}
                                            className={cn(
                                                'h-8 text-xs',
                                                numeric && 'text-right',
                                                header.id === 'select' && 'w-8',
                                            )}
                                        >
                                            {header.isPlaceholder ? null : header.column.getCanSort() ? (
                                                <SortHeader
                                                    label={String(header.column.columnDef.header)}
                                                    sorted={header.column.getIsSorted()}
                                                    numeric={numeric}
                                                    onToggle={() =>
                                                        header.column.toggleSorting(
                                                            header.column.getIsSorted() === 'asc',
                                                        )
                                                    }
                                                />
                                            ) : (
                                                flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext(),
                                                )
                                            )}
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell
                                    colSpan={columns.length}
                                    className="h-24 text-center text-muted-foreground text-sm"
                                >
                                    No sessions match those filters.
                                </TableCell>
                            </TableRow>
                        )}
                        {rows.map((row) => (
                            <TableRow
                                key={row.id}
                                data-state={row.getIsSelected() && 'selected'}
                                className="cursor-pointer"
                                onClick={() =>
                                    router.push(`/analytics/session/${row.original.sha256}`)
                                }
                            >
                                {row.getVisibleCells().map((cell) => {
                                    const numeric = (
                                        cell.column.columnDef.meta as
                                            | { numeric?: boolean }
                                            | undefined
                                    )?.numeric;
                                    return (
                                        <TableCell
                                            key={cell.id}
                                            className={cn('py-1.5 text-sm', numeric && NUMERIC)}
                                            onClick={
                                                cell.column.id === 'select'
                                                    ? (e) => e.stopPropagation()
                                                    : undefined
                                            }
                                        >
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext(),
                                            )}
                                        </TableCell>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            <div className="divide-y border-y sm:hidden">
                {rows.map((row) => {
                    const s = row.original.session;
                    const within = Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G;
                    return (
                        <Link
                            key={row.id}
                            href={`/analytics/session/${row.original.sha256}`}
                            className="flex items-center justify-between gap-3 py-3"
                        >
                            <span className="min-w-0">
                                <span className="block font-mono text-sm tabular-nums">
                                    {s.final_weight.toFixed(2)} g
                                    <span
                                        className={cn(
                                            'ml-2 text-xs',
                                            within ? 'text-success' : 'text-destructive',
                                        )}
                                    >
                                        {sessionErrorLabel(s)}
                                    </span>
                                </span>
                                <span className="mt-0.5 block truncate text-muted-foreground text-xs">
                                    #{s.session_id} · {sessionStartLabel(s)}
                                </span>
                            </span>
                            <ResultBadge status={s.result_status} />
                        </Link>
                    );
                })}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
                <span>
                    {filteredCount === records.length
                        ? `${records.length} sessions`
                        : `${filteredCount} of ${records.length} sessions`}
                    {selectedIds.length > 0 && ` · ${selectedIds.length} selected`}
                </span>
                <div className="flex-1" />
                <span>
                    Page {table.getState().pagination.pageIndex + 1} of{' '}
                    {Math.max(1, table.getPageCount())}
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={!table.getCanPreviousPage()}
                    onClick={() => table.previousPage()}
                >
                    Previous
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={!table.getCanNextPage()}
                    onClick={() => table.nextPage()}
                >
                    Next
                </Button>
            </div>
        </div>
    );
}
