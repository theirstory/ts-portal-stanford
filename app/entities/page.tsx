'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SearchIcon from '@mui/icons-material/Search';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { colors } from '@/lib/theme';
import { getNerColor, getNerDisplayName } from '@/config/organizationConfig';
import type { EntityAggregate, EntityAggregateResult } from '@/lib/weaviate/entities';
import { EntityDetailPanel, type EntityDetailTarget } from '@/components/EntityDetailPanel';

/** Columns shown when drilling into one category, before "show all". */
const DEFAULT_COLUMN_LIMIT = 30;

const ROW_LABEL_WIDTH = 240;
const CELL_WIDTH = 58;
const CELL_HEIGHT = 40;

type Row = { storyUuid: string; title: string };
type Column = { key: string; label: string; nerLabel: string };
type Matrix = Map<string, number>;

const cellKey = (rowId: string, columnKey: string) => `${rowId}::${columnKey}`;

const formatTimecode = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

const hexToRgb = (hex: string): [number, number, number] => {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((char) => char + char)
          .join('')
      : clean;
  const int = Number.parseInt(full, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};

/**
 * Sequential fill for a count, scaled against the busiest cell in view.
 *
 * The scale is rebuilt per view rather than fixed globally: inside one category
 * the interesting contrast is between that category's own values, and a global
 * maximum would flatten every column except the largest.
 */
const heatStyle = (value: number, max: number, hue: string): React.CSSProperties => {
  if (value === 0) {
    return { backgroundColor: 'transparent', color: colors.text.disabled };
  }

  // Square root keeps mid-range values legible; counts are heavily skewed by a
  // handful of very frequent names.
  const intensity = max > 0 ? Math.sqrt(value / max) : 0;
  // Capped below full strength on purpose: the number is always black, so the
  // fill must never get dark enough to fight it. Depth still reads across the
  // range, and the count stays legible in every cell.
  const alpha = 0.08 + intensity * 0.62;
  const [r, g, b] = hexToRgb(hue);

  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
    color: colors.text.primary,
  };
};

function EntitiesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<EntityAggregateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [showCounts, setShowCounts] = useState(true);
  const [filter, setFilter] = useState('');

  /**
   * Which view is on screen lives in the URL, not in state, so a reader can
   * link a colleague to one category — or to one entity in one recording —
   * and the browser's own back button walks the views they came through.
   * Transient controls (filter text, show-all, counts) stay local.
   */
  const category = searchParams.get('category');
  const focusUuid = searchParams.get('focus');
  const focusDirection = searchParams.get('focusDir') === 'asc' ? 'asc' : 'desc';
  const sortColumn = searchParams.get('sortCol');
  const sortDirection = searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';
  const selectedEntityKey = searchParams.get('entity');
  const selectedRecording = searchParams.get('recording');

  const setParams = useCallback(
    (changes: Record<string, string | null>, { replace = false }: { replace?: boolean } = {}) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(changes).forEach(([key, value]) => {
        if (value === null) params.delete(key);
        else params.set(key, value);
      });
      const query = params.toString();
      const href = query ? `/entities?${query}` : '/entities';
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [router, searchParams],
  );

  const sort = sortColumn ? { columnKey: sortColumn, direction: sortDirection as 'desc' | 'asc' } : null;
  const columnSort = focusUuid ? { storyUuid: focusUuid, direction: focusDirection as 'desc' | 'asc' } : null;

  useEffect(() => {
    let cancelled = false;

    fetch('/api/entities')
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<EntityAggregateResult>;
      })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setError('The entity index could not be loaded. Reload the page to try again.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Rows are the recordings, ordered by how much they contribute overall so the
  // densest interviews read first.
  const baseRows = useMemo<Row[]>(() => {
    if (!data) return [];
    const totals = new Map<string, { title: string; mentions: number }>();

    data.entities.forEach((entity) => {
      entity.stories.forEach((story) => {
        const existing = totals.get(story.storyUuid);
        if (existing) {
          existing.mentions += story.mentions;
        } else {
          totals.set(story.storyUuid, {
            title: story.interviewTitle || 'Untitled recording',
            mentions: story.mentions,
          });
        }
      });
    });

    return Array.from(totals.entries())
      .sort((a, b) => b[1].mentions - a[1].mentions)
      .map(([storyUuid, { title }]) => ({ storyUuid, title }));
  }, [data]);

  const { columns, matrix, max, entityByColumn } = useMemo(() => {
    const emptyResult = {
      columns: [] as Column[],
      matrix: new Map() as Matrix,
      max: 0,
      entityByColumn: new Map<string, EntityAggregate>(),
    };
    if (!data) return emptyResult;

    const counts: Matrix = new Map();
    const byColumn = new Map<string, EntityAggregate>();
    let columnDefs: Column[];

    if (category === null) {
      // Overview: one column per entity category.
      columnDefs = data.labels.map(({ label }) => ({
        key: label,
        label: getNerDisplayName(label),
        nerLabel: label,
      }));

      data.entities.forEach((entity) => {
        entity.stories.forEach((story) => {
          const key = cellKey(story.storyUuid, entity.label);
          counts.set(key, (counts.get(key) ?? 0) + story.mentions);
        });
      });
    } else {
      // Drill-down: one column per entity inside the chosen category.
      const needle = filter.trim().toLowerCase();
      const inCategory = data.entities
        .filter((entity) => entity.label === category)
        .filter((entity) => !needle || entity.text.toLowerCase().includes(needle));

      // Ranking before the cut matters: the default order is collection-wide
      // frequency, so when a reader is asking about one recording, the entities
      // that recording actually talks about would be dropped by the column
      // limit if they happen to be rare across the collection.
      const mentionsIn = (entity: EntityAggregate, storyUuid: string) =>
        entity.stories.find((story) => story.storyUuid === storyUuid)?.mentions ?? 0;

      const ranked = columnSort
        ? [...inCategory].sort((a, b) => {
            const direction = columnSort.direction === 'desc' ? -1 : 1;
            const left = mentionsIn(a, columnSort.storyUuid);
            const right = mentionsIn(b, columnSort.storyUuid);
            if (left === right) return a.text.localeCompare(b.text);
            return (left - right) * direction;
          })
        : inCategory;

      const visible = showAllColumns ? ranked : ranked.slice(0, DEFAULT_COLUMN_LIMIT);

      columnDefs = visible.map((entity) => {
        byColumn.set(entity.key, entity);
        return { key: entity.key, label: entity.text, nerLabel: entity.label };
      });

      visible.forEach((entity) => {
        entity.stories.forEach((story) => {
          counts.set(cellKey(story.storyUuid, entity.key), story.mentions);
        });
      });
    }

    let highest = 0;
    counts.forEach((value) => {
      if (value > highest) highest = value;
    });

    // The overview's columns are fixed categories, so they are ordered here
    // rather than before a cut.
    if (columnSort && category === null) {
      const direction = columnSort.direction === 'desc' ? -1 : 1;
      columnDefs = [...columnDefs].sort((a, b) => {
        const left = counts.get(cellKey(columnSort.storyUuid, a.key)) ?? 0;
        const right = counts.get(cellKey(columnSort.storyUuid, b.key)) ?? 0;
        if (left === right) return a.label.localeCompare(b.label);
        return (left - right) * direction;
      });
    }

    return { columns: columnDefs, matrix: counts, max: highest, entityByColumn: byColumn };
  }, [data, category, filter, showAllColumns, columnSort]);

  // Rows reorder by a chosen column so a reader can rank recordings by how much
  // they talk about one thing; without a sort the matrix only answers
  // "where is this mentioned", never "who mentions it most".
  const rows = useMemo<Row[]>(() => {
    let ordered = baseRows;

    if (sort) {
      const direction = sort.direction === 'desc' ? -1 : 1;
      ordered = [...baseRows].sort((a, b) => {
        const left = matrix.get(cellKey(a.storyUuid, sort.columnKey)) ?? 0;
        const right = matrix.get(cellKey(b.storyUuid, sort.columnKey)) ?? 0;
        if (left === right) return a.title.localeCompare(b.title);
        return (left - right) * direction;
      });
    }

    // The recording the columns are ordered by goes first. Otherwise the reader
    // has to find it again in the list to read the ordering it produced.
    if (columnSort) {
      const focused = ordered.find((row) => row.storyUuid === columnSort.storyUuid);
      if (focused) {
        ordered = [focused, ...ordered.filter((row) => row.storyUuid !== columnSort.storyUuid)];
      }
    }

    return ordered;
  }, [baseRows, matrix, sort, columnSort]);

  const toggleColumnSort = (storyUuid: string) => {
    if (focusUuid !== storyUuid) return setParams({ focus: storyUuid, focusDir: 'desc' }, { replace: true });
    if (focusDirection === 'desc') return setParams({ focus: storyUuid, focusDir: 'asc' }, { replace: true });
    return setParams({ focus: null, focusDir: null }, { replace: true });
  };

  const toggleSort = (columnKey: string) => {
    if (sortColumn !== columnKey) return setParams({ sortCol: columnKey, sortDir: 'desc' }, { replace: true });
    if (sortDirection === 'desc') return setParams({ sortCol: columnKey, sortDir: 'asc' }, { replace: true });
    return setParams({ sortCol: null, sortDir: null }, { replace: true });
  };

  const selected = useMemo(() => {
    if (!data || !selectedEntityKey) return null;
    const entity = data.entities.find(
      (candidate) => candidate.key === selectedEntityKey && (!category || candidate.label === category),
    );
    // A recording is optional. Selecting a square asks about one recording, so
    // its group opens and the rest stay closed; selecting the column asks about
    // the entity across the collection, so every group opens.
    return entity ? { entity, storyUuid: selectedRecording ?? undefined } : null;
  }, [data, selectedEntityKey, selectedRecording, category]);

  const focusedRowTitle =
    category !== null && columnSort
      ? (baseRows.find((row) => row.storyUuid === columnSort.storyUuid)?.title ?? null)
      : null;

  const categoryTotal = useMemo(
    () => (data && category ? data.entities.filter((entity) => entity.label === category).length : 0),
    [data, category],
  );

  const openCell = (row: Row, column: Column) => {
    if (category === null) {
      // "How does this category show up in this recording?" — drill in with the
      // recording's own entities ranked and its row first, rather than dropping
      // the reader into a collection-wide view they have to re-find it in.
      setShowAllColumns(false);
      setFilter('');
      setParams({
        category: column.nerLabel,
        focus: row.storyUuid,
        focusDir: 'desc',
        sortCol: null,
        sortDir: null,
        entity: null,
        recording: null,
      });
      return;
    }

    const entity = entityByColumn.get(column.key);
    if (!entity) return;
    if (!matrix.get(cellKey(row.storyUuid, column.key))) return;
    setParams({ entity: entity.key, recording: row.storyUuid }, { replace: true });
  };

  const hue = category ? getNerColor(category) : colors.primary.main;

  return (
    <Box sx={{ display: 'flex', alignItems: 'stretch', minHeight: 0 }}>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          overflowX: 'hidden',
          px: { xs: 2, sm: 3 },
          py: { xs: 3, sm: 4 },
          maxWidth: 1400,
          mx: 'auto',
        }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 0.5 }}>
          {category !== null && (
            <IconButton
              size="small"
              aria-label="Back to all categories"
              onClick={() => {
                setFilter('');
                setShowAllColumns(false);
                setParams({
                  category: null,
                  focus: null,
                  focusDir: null,
                  sortCol: null,
                  sortDir: null,
                  entity: null,
                  recording: null,
                });
              }}
              sx={{ mt: 0.25 }}>
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          )}
          <Box>
            {/*
              The back control names where it goes, not where you are — with
              only the category beside an arrow it reads as "back to more
              organizations" rather than "this page is Organization".
            */}
            {category !== null && (
              <Typography
                component="button"
                type="button"
                onClick={() => {
                  setFilter('');
                  setShowAllColumns(false);
                  setParams({
                    category: null,
                    focus: null,
                    focusDir: null,
                    sortCol: null,
                    sortDir: null,
                    entity: null,
                    recording: null,
                  });
                }}
                sx={{
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                  color: colors.text.secondary,
                  background: 'none',
                  border: 'none',
                  p: 0,
                  mb: 0.25,
                  cursor: 'pointer',
                  font: 'inherit',
                  '&:hover': { color: colors.primary.main, textDecoration: 'underline' },
                }}>
                Named Entities
              </Typography>
            )}
            <Typography component="h1" sx={{ fontSize: { xs: 22, sm: 28 }, fontWeight: 700, lineHeight: 1.15 }}>
              {category === null ? 'Named Entities' : getNerDisplayName(category)}
            </Typography>
            <Typography sx={{ color: colors.text.secondary, fontSize: 14.5, mt: 0.5, maxWidth: '68ch' }}>
              {category === null
                ? 'Each column is a kind of thing the interviews mention; each row is a recording. Darker means more mentions. Pick a column to see the individual names inside it.'
                : focusedRowTitle
                  ? `Ordered by what ${focusedRowTitle} mentions most, with that recording first. Select a square to see every time an entity is spoken.`
                  : `Each column is one ${getNerDisplayName(category).toLowerCase().replace(/s$/, '')} mentioned in the collection. Select a square to see every time it is spoken in that recording.`}
            </Typography>
          </Box>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mt: 3 }}>
            {error}
          </Alert>
        )}

        {!data && !error && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 6, color: colors.text.secondary }}>
            <CircularProgress size={18} />
            <Typography sx={{ fontSize: 14 }}>Building the index across all recordings…</Typography>
          </Box>
        )}

        {data && (
          <>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: { xs: 1.5, sm: 2.5 },
                mt: 2.5,
                mb: 1.5,
              }}>
              {category !== null && (
                <TextField
                  size="small"
                  id="entity-column-filter"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={`Filter ${getNerDisplayName(category).toLowerCase()}…`}
                  sx={{ minWidth: 220 }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon sx={{ fontSize: 18, color: colors.text.secondary }} />
                      </InputAdornment>
                    ),
                  }}
                />
              )}

              <FormControlLabel
                control={
                  <Switch
                    id="entity-show-counts"
                    size="small"
                    checked={showCounts}
                    onChange={(event) => setShowCounts(event.target.checked)}
                  />
                }
                label={<Typography sx={{ fontSize: 13.5 }}>Show counts</Typography>}
              />

              <Typography sx={{ fontSize: 13, color: colors.text.secondary, fontVariantNumeric: 'tabular-nums' }}>
                {category === null
                  ? `${data.entities.length.toLocaleString()} distinct entities · ${data.totalMentions.toLocaleString()} mentions · ${rows.length} recordings`
                  : `${columns.length} of ${categoryTotal.toLocaleString()} shown`}
              </Typography>

              {category !== null && !showAllColumns && categoryTotal > columns.length && (
                <Typography
                  component="button"
                  onClick={() => setShowAllColumns(true)}
                  sx={{
                    fontSize: 13,
                    color: colors.primary.main,
                    background: 'none',
                    border: 'none',
                    p: 0,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    font: 'inherit',
                  }}>
                  Show all
                </Typography>
              )}
            </Box>

            {columns.length === 0 ? (
              <Typography sx={{ py: 5, color: colors.text.secondary, fontSize: 14 }}>
                Nothing matches that filter.
              </Typography>
            ) : (
              <Box
                sx={{
                  overflowX: 'auto',
                  border: `1px solid ${colors.common.border}`,
                  borderRadius: 1,
                  backgroundColor: colors.background.paper,
                }}>
                <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: 'max-content' }}>
                  <Box component="thead">
                    <Box component="tr">
                      <Box
                        component="th"
                        sx={{
                          position: 'sticky',
                          left: 0,
                          zIndex: 3,
                          backgroundColor: colors.background.paper,
                          borderBottom: `1px solid ${colors.common.border}`,
                          borderRight: `1px solid ${colors.common.border}`,
                          width: ROW_LABEL_WIDTH,
                          minWidth: ROW_LABEL_WIDTH,
                        }}
                      />
                      {columns.map((column) => (
                        <Box
                          component="th"
                          key={column.key}
                          scope="col"
                          sx={{
                            p: 0,
                            borderBottom: `1px solid ${colors.common.border}`,
                            verticalAlign: 'bottom',
                            width: CELL_WIDTH,
                            minWidth: CELL_WIDTH,
                          }}>
                          <Tooltip
                            title={
                              category === null
                                ? `See every ${column.label.toLowerCase()}`
                                : `Every mention of ${column.label} in the collection`
                            }>
                            <Box
                              component="button"
                              type="button"
                              onClick={() => {
                                if (category === null) {
                                  setShowAllColumns(false);
                                  setFilter('');
                                  setParams({
                                    category: column.nerLabel,
                                    focus: null,
                                    focusDir: null,
                                    sortCol: null,
                                    sortDir: null,
                                    entity: null,
                                    recording: null,
                                  });
                                  return;
                                }
                                // Inside a category the column is one entity, so
                                // the header asks about it across every
                                // recording — no focus recording, so the panel
                                // opens with all of them expanded.
                                setParams({ entity: column.key, recording: null }, { replace: true });
                              }}
                              sx={{
                                height: 150,
                                width: '100%',
                                display: 'flex',
                                alignItems: 'flex-end',
                                justifyContent: 'center',
                                pb: 1,
                                background: 'none',
                                border: 'none',
                                font: 'inherit',
                                color: 'inherit',
                                cursor: 'pointer',
                                '&:hover': { backgroundColor: colors.background.subtle },
                              }}>
                              <Typography
                                sx={{
                                  writingMode: 'vertical-rl',
                                  transform: 'rotate(180deg)',
                                  fontSize: 12.5,
                                  fontWeight: category === null ? 600 : 500,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  maxHeight: 138,
                                  borderLeft: `3px solid ${getNerColor(column.nerLabel)}`,
                                  pl: 0.75,
                                }}>
                                {column.label}
                              </Typography>
                            </Box>
                          </Tooltip>
                        </Box>
                      ))}
                    </Box>

                    <Box component="tr">
                      <Box
                        component="th"
                        sx={{
                          position: 'sticky',
                          left: 0,
                          zIndex: 3,
                          backgroundColor: colors.background.paper,
                          borderBottom: `1px solid ${colors.common.border}`,
                          borderRight: `1px solid ${colors.common.border}`,
                          textAlign: 'right',
                          pr: 1.5,
                          py: 0.25,
                        }}>
                        <Typography sx={{ fontSize: 11, color: colors.text.secondary }}>
                          {sort ? 'sorted' : 'sort'}
                        </Typography>
                      </Box>
                      {columns.map((column) => {
                        const active = sort?.columnKey === column.key;
                        const Icon = !active
                          ? SwapVertIcon
                          : sort?.direction === 'desc'
                            ? ArrowDownwardIcon
                            : ArrowUpwardIcon;

                        return (
                          <Box
                            component="th"
                            key={`sort-${column.key}`}
                            sx={{ p: 0, borderBottom: `1px solid ${colors.common.border}` }}>
                            <Tooltip
                              title={
                                active && sort?.direction === 'desc'
                                  ? `Sort recordings by fewest ${column.label}`
                                  : active
                                    ? 'Clear sorting'
                                    : `Sort recordings by most ${column.label}`
                              }>
                              <Box
                                component="button"
                                type="button"
                                onClick={() => toggleSort(column.key)}
                                aria-label={`Sort recordings by ${column.label}`}
                                sx={{
                                  width: '100%',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  py: 0.4,
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: active ? colors.primary.main : colors.text.secondary,
                                  '&:hover': { backgroundColor: colors.background.subtle },
                                }}>
                                <Icon sx={{ fontSize: 15 }} />
                              </Box>
                            </Tooltip>
                          </Box>
                        );
                      })}
                    </Box>
                  </Box>

                  <Box component="tbody">
                    {rows.map((row) => {
                      const rowSortActive = columnSort?.storyUuid === row.storyUuid;
                      const isFocusedRow = rowSortActive && category !== null;
                      const RowSortIcon = !rowSortActive
                        ? SwapVertIcon
                        : columnSort?.direction === 'desc'
                          ? ArrowDownwardIcon
                          : ArrowUpwardIcon;

                      return (
                        <Box component="tr" key={row.storyUuid}>
                          <Box
                            component="th"
                            scope="row"
                            sx={{
                              position: 'sticky',
                              left: 0,
                              zIndex: 2,
                              backgroundColor: isFocusedRow ? colors.background.subtle : colors.background.paper,
                              boxShadow: isFocusedRow ? `inset 3px 0 0 ${colors.primary.main}` : 'none',
                              transition: 'background-color 120ms ease',
                              // Matches the column headers, so both axes read as the same control.
                              '&:hover': { backgroundColor: colors.background.subtle },
                              borderRight: `1px solid ${colors.common.border}`,
                              borderBottom: `1px solid ${colors.common.border}`,
                              textAlign: 'left',
                              px: 1.5,
                              py: 0.5,
                              width: ROW_LABEL_WIDTH,
                              minWidth: ROW_LABEL_WIDTH,
                              fontWeight: 500,
                            }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                              <Link
                                // Carry the category through, so the recording
                                // opens with these entities already highlighted
                                // rather than making the reader re-find them.
                                href={
                                  category
                                    ? `/story/${row.storyUuid}?nerLabel=${encodeURIComponent(category)}`
                                    : `/story/${row.storyUuid}`
                                }
                                title={row.title}
                                // Takes the slack and truncates, so every sort
                                // control lands on the same vertical line
                                // regardless of how long the title is.
                                style={{
                                  color: colors.text.primary,
                                  textDecoration: 'none',
                                  fontSize: 13.5,
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}>
                                {row.title}
                              </Link>
                              <Tooltip
                                title={
                                  rowSortActive && columnSort?.direction === 'desc'
                                    ? `Order columns by what ${row.title} mentions least`
                                    : rowSortActive
                                      ? 'Clear column ordering'
                                      : `Order columns by what ${row.title} mentions most`
                                }>
                                <Box
                                  component="button"
                                  type="button"
                                  onClick={() => toggleColumnSort(row.storyUuid)}
                                  aria-label={`Order columns by ${row.title}`}
                                  sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    flexShrink: 0,
                                    p: 0.25,
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    borderRadius: 0.5,
                                    color: rowSortActive ? colors.primary.main : colors.text.secondary,
                                    '&:hover': { backgroundColor: colors.background.subtle },
                                  }}>
                                  <RowSortIcon sx={{ fontSize: 15, transform: 'rotate(90deg)' }} />
                                </Box>
                              </Tooltip>
                            </Box>
                          </Box>

                          {columns.map((column) => {
                            const value = matrix.get(cellKey(row.storyUuid, column.key)) ?? 0;
                            const interactive = value > 0;
                            const style = heatStyle(value, max, hue);

                            return (
                              <Box
                                component="td"
                                key={column.key}
                                sx={{
                                  p: 0,
                                  borderBottom: `1px solid ${colors.common.border}`,
                                  width: CELL_WIDTH,
                                  minWidth: CELL_WIDTH,
                                  height: CELL_HEIGHT,
                                }}>
                                <Tooltip
                                  title={
                                    interactive
                                      ? `${row.title} · ${column.label} · ${value} ${value === 1 ? 'mention' : 'mentions'}`
                                      : ''
                                  }
                                  disableHoverListener={!interactive}>
                                  <Box
                                    component={interactive ? 'button' : 'div'}
                                    type={interactive ? 'button' : undefined}
                                    onClick={interactive ? () => openCell(row, column) : undefined}
                                    aria-label={
                                      interactive
                                        ? `${value} mentions of ${column.label} in ${row.title}`
                                        : `No mentions of ${column.label} in ${row.title}`
                                    }
                                    style={style}
                                    sx={{
                                      width: '100%',
                                      height: CELL_HEIGHT,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      border: 'none',
                                      font: 'inherit',
                                      fontSize: 12.5,
                                      fontVariantNumeric: 'tabular-nums',
                                      cursor: interactive ? 'pointer' : 'default',
                                      '&:hover': interactive
                                        ? { outline: `2px solid ${colors.primary.main}`, outlineOffset: '-2px' }
                                        : {},
                                    }}>
                                    {showCounts && value > 0 ? value : ''}
                                  </Box>
                                </Tooltip>
                              </Box>
                            );
                          })}
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              </Box>
            )}
          </>
        )}
      </Box>

      {selected && (
        <Box
          sx={{
            flexShrink: 0,
            // Wide enough that a transcript passage reads as prose rather
            // than a column of two-word lines.
            width: { xs: '100%', md: 480, lg: 560 },
            borderLeft: '1px solid',
            borderColor: 'divider',
            height: '100%',
            minHeight: 0,
          }}>
          <EntityDetailPanel
            target={{
              text: selected.entity.text,
              label: selected.entity.label,
              variants: selected.entity.variants.map((variant) => variant.text),
              focusStoryUuid: selected.storyUuid,
            }}
            onClose={() => setParams({ entity: null, recording: null }, { replace: true })}
          />
        </Box>
      )}
    </Box>
  );
}

export default function EntitiesPage() {
  return (
    <Suspense
      fallback={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 4, color: colors.text.secondary }}>
          <CircularProgress size={18} />
          <Typography sx={{ fontSize: 14 }}>Loading…</Typography>
        </Box>
      }>
      <EntitiesPageContent />
    </Suspense>
  );
}
