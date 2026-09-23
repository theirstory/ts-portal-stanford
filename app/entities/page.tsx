'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SearchIcon from '@mui/icons-material/Search';
import Link from 'next/link';

import { colors } from '@/lib/theme';
import { getNerColor, getNerDisplayName } from '@/config/organizationConfig';
import type { EntityAggregate, EntityAggregateResult } from '@/lib/weaviate/entities';

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
  const alpha = 0.1 + intensity * 0.85;
  const [r, g, b] = hexToRgb(hue);

  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
    // Once the fill is strong enough, dark text on it stops being legible.
    color: intensity > 0.6 ? '#fff' : colors.text.primary,
  };
};

export default function EntitiesPage() {
  const [data, setData] = useState<EntityAggregateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** null = category overview; otherwise the drilled-into NER label. */
  const [category, setCategory] = useState<string | null>(null);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [showCounts, setShowCounts] = useState(true);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<{ entity: EntityAggregate; storyUuid: string } | null>(null);

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
  const rows = useMemo<Row[]>(() => {
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

      const visible = showAllColumns ? inCategory : inCategory.slice(0, DEFAULT_COLUMN_LIMIT);

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

    return { columns: columnDefs, matrix: counts, max: highest, entityByColumn: byColumn };
  }, [data, category, filter, showAllColumns]);

  const categoryTotal = useMemo(
    () => (data && category ? data.entities.filter((entity) => entity.label === category).length : 0),
    [data, category],
  );

  const openCell = (row: Row, column: Column) => {
    if (category === null) {
      setCategory(column.nerLabel);
      setShowAllColumns(false);
      setFilter('');
      return;
    }

    const entity = entityByColumn.get(column.key);
    if (!entity) return;
    if (!matrix.get(cellKey(row.storyUuid, column.key))) return;
    setSelected({ entity, storyUuid: row.storyUuid });
  };

  const selectedStory = selected?.entity.stories.find((story) => story.storyUuid === selected.storyUuid);
  const hue = category ? getNerColor(category) : colors.primary.main;

  return (
    <Box sx={{ px: { xs: 2, sm: 3 }, py: { xs: 3, sm: 4 }, maxWidth: 1400, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 0.5 }}>
        {category !== null && (
          <IconButton
            size="small"
            aria-label="Back to all categories"
            onClick={() => {
              setCategory(null);
              setFilter('');
              setShowAllColumns(false);
            }}
            sx={{ mt: 0.25 }}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Box>
          <Typography component="h1" sx={{ fontSize: { xs: 22, sm: 28 }, fontWeight: 700, lineHeight: 1.15 }}>
            {category === null ? 'Who and what the collection talks about' : getNerDisplayName(category)}
          </Typography>
          <Typography sx={{ color: colors.text.secondary, fontSize: 14.5, mt: 0.5, maxWidth: '68ch' }}>
            {category === null
              ? 'Each column is a kind of thing the interviews mention; each row is a recording. Darker means more mentions. Pick a column to see the individual names inside it.'
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
                        <Tooltip title={category === null ? `See every ${column.label.toLowerCase()}` : column.label}>
                          <Box
                            component={category === null ? 'button' : 'div'}
                            type={category === null ? 'button' : undefined}
                            onClick={
                              category === null
                                ? () => {
                                    setCategory(column.nerLabel);
                                    setShowAllColumns(false);
                                    setFilter('');
                                  }
                                : undefined
                            }
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
                              cursor: category === null ? 'pointer' : 'default',
                              '&:hover': category === null ? { backgroundColor: colors.background.subtle } : {},
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
                </Box>

                <Box component="tbody">
                  {rows.map((row) => (
                    <Box component="tr" key={row.storyUuid}>
                      <Box
                        component="th"
                        scope="row"
                        sx={{
                          position: 'sticky',
                          left: 0,
                          zIndex: 2,
                          backgroundColor: colors.background.paper,
                          borderRight: `1px solid ${colors.common.border}`,
                          borderBottom: `1px solid ${colors.common.border}`,
                          textAlign: 'left',
                          px: 1.5,
                          py: 0.5,
                          width: ROW_LABEL_WIDTH,
                          minWidth: ROW_LABEL_WIDTH,
                          fontWeight: 500,
                        }}>
                        <Link
                          href={`/story/${row.storyUuid}`}
                          style={{ color: colors.text.primary, textDecoration: 'none', fontSize: 13.5 }}>
                          {row.title}
                        </Link>
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
                  ))}
                </Box>
              </Box>
            </Box>
          )}

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
            <Typography sx={{ fontSize: 12, color: colors.text.secondary }}>Fewer</Typography>
            {[0.08, 0.3, 0.52, 0.72, 0.95].map((alpha) => (
              <Box
                key={alpha}
                sx={{ width: 26, height: 12, borderRadius: 0.5, backgroundColor: hue, opacity: alpha }}
              />
            ))}
            <Typography sx={{ fontSize: 12, color: colors.text.secondary }}>
              More{max > 0 ? ` (up to ${max.toLocaleString()})` : ''}
            </Typography>
          </Box>
        </>
      )}

      <Drawer
        anchor="right"
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        PaperProps={{ sx: { width: { xs: '100%', sm: 440 }, p: 2.5 } }}>
        {selected && selectedStory && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
              <Box>
                <Typography sx={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{selected.entity.text}</Typography>
                <Typography sx={{ fontSize: 13, color: colors.text.secondary, mt: 0.25 }}>
                  {getNerDisplayName(selected.entity.label)} · in {selectedStory.interviewTitle}
                </Typography>
              </Box>
              <IconButton size="small" aria-label="Close" onClick={() => setSelected(null)}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>

            <Typography sx={{ fontSize: 13, color: colors.text.secondary, mb: 1.5 }}>
              {selectedStory.mentions} {selectedStory.mentions === 1 ? 'mention' : 'mentions'} here ·{' '}
              {selected.entity.mentions} across {selected.entity.stories.length}{' '}
              {selected.entity.stories.length === 1 ? 'recording' : 'recordings'}
            </Typography>

            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0.5 }}>
              {selectedStory.occurrences.map((occurrence, index) => (
                <Box component="li" key={`${occurrence.start}-${index}`}>
                  <Link
                    href={`/story/${selected.storyUuid}?start=${Math.floor(occurrence.start)}&nerLabel=${encodeURIComponent(selected.entity.label)}`}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 10,
                      padding: '7px 9px',
                      borderRadius: 4,
                      border: `1px solid ${colors.common.border}`,
                      color: colors.text.primary,
                      textDecoration: 'none',
                    }}>
                    <Typography
                      sx={{
                        fontSize: 12.5,
                        fontVariantNumeric: 'tabular-nums',
                        color: colors.primary.main,
                        fontWeight: 600,
                      }}>
                      {formatTimecode(occurrence.start)}
                    </Typography>
                    <Typography sx={{ fontSize: 13.5 }}>“{occurrence.text}”</Typography>
                  </Link>
                </Box>
              ))}
            </Box>

            {selectedStory.occurrences.length === 0 && (
              <Typography sx={{ fontSize: 13.5, color: colors.text.secondary }}>
                No timings were recorded for these mentions.
              </Typography>
            )}

            {selected.entity.stories.length > 1 && (
              <Box sx={{ mt: 2.5 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, color: colors.text.secondary, mb: 0.75 }}>
                  Also mentioned in
                </Typography>
                <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0.25 }}>
                  {selected.entity.stories
                    .filter((story) => story.storyUuid !== selected.storyUuid)
                    .map((story) => (
                      <Box component="li" key={story.storyUuid}>
                        <Typography
                          component="button"
                          onClick={() => setSelected({ entity: selected.entity, storyUuid: story.storyUuid })}
                          sx={{
                            fontSize: 13.5,
                            background: 'none',
                            border: 'none',
                            p: '3px 0',
                            cursor: 'pointer',
                            color: colors.text.primary,
                            font: 'inherit',
                            textAlign: 'left',
                            '&:hover': { textDecoration: 'underline' },
                          }}>
                          {story.interviewTitle}{' '}
                          <Box component="span" sx={{ color: colors.text.secondary }}>
                            ({story.mentions})
                          </Box>
                        </Typography>
                      </Box>
                    ))}
                </Box>
              </Box>
            )}

            {selected.entity.variants.length > 1 && (
              <Typography sx={{ mt: 2, fontSize: 12, color: colors.text.secondary }}>
                Also transcribed as{' '}
                {selected.entity.variants
                  .filter((variant) => variant.text !== selected.entity.text)
                  .map((variant) => `“${variant.text}” (${variant.mentions})`)
                  .join(', ')}
              </Typography>
            )}
          </>
        )}
      </Drawer>
    </Box>
  );
}
