'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import Link from 'next/link';

import { colors } from '@/lib/theme';
import { getNerColor, getNerDisplayName } from '@/config/organizationConfig';
import type { EntityAggregate, EntityAggregateResult } from '@/lib/weaviate/entities';

const PAGE_SIZE = 100;

const formatTimecode = (seconds?: number) => {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

const EntityRow = ({ entity }: { entity: EntityAggregate }) => {
  const [open, setOpen] = useState(false);
  const color = getNerColor(entity.label);
  const otherVariants = entity.variants.filter((variant) => variant.text !== entity.text);

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        borderBottom: `1px solid ${colors.common.border}`,
        '&:last-of-type': { borderBottom: 'none' },
      }}>
      <Box
        component="button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: { xs: 1.5, sm: 2 },
          py: 1.25,
          background: 'none',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
          '&:hover': { backgroundColor: colors.background.subtle },
        }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }} />

        <Typography sx={{ fontWeight: 600, fontSize: 15, flexShrink: 0 }}>{entity.text}</Typography>

        <Chip
          label={getNerDisplayName(entity.label)}
          size="small"
          sx={{ backgroundColor: color, fontSize: 11, height: 20, flexShrink: 0 }}
        />

        {otherVariants.length > 0 && (
          <Typography sx={{ fontSize: 12, color: colors.text.secondary, flexShrink: 0 }}>
            {otherVariants.length === 1 ? '1 variant' : `${otherVariants.length} variants`}
          </Typography>
        )}

        <Box sx={{ flexGrow: 1 }} />

        <Typography
          sx={{ fontSize: 13, color: colors.text.secondary, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {entity.mentions} {entity.mentions === 1 ? 'mention' : 'mentions'} in {entity.stories.length}{' '}
          {entity.stories.length === 1 ? 'recording' : 'recordings'}
        </Typography>

        <KeyboardArrowDownIcon
          sx={{
            fontSize: 20,
            color: colors.text.secondary,
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        />
      </Box>

      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: { xs: 1.5, sm: 2 }, pb: 2, pt: 0.5 }}>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0.5 }}>
            {entity.stories.map((story) => {
              const timecode = formatTimecode(story.firstStartTime);
              // Matches the deep-link convention used by indexes and chat
              // citations: `start` seeks the player, `nerLabel` switches the
              // transcript's entity highlighting on for this label.
              const href =
                story.firstStartTime !== undefined
                  ? `/story/${story.storyUuid}?start=${Math.floor(story.firstStartTime)}&nerLabel=${encodeURIComponent(entity.label)}`
                  : `/story/${story.storyUuid}?nerLabel=${encodeURIComponent(entity.label)}`;

              return (
                <Box component="li" key={story.storyUuid}>
                  <Link
                    href={href}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 4,
                      color: colors.text.primary,
                      textDecoration: 'none',
                    }}>
                    <Typography sx={{ fontSize: 14, textDecoration: 'underline', textUnderlineOffset: 2 }}>
                      {story.interviewTitle || 'Untitled recording'}
                    </Typography>
                    <Typography sx={{ fontSize: 12, color: colors.text.secondary, fontVariantNumeric: 'tabular-nums' }}>
                      {story.mentions} {story.mentions === 1 ? 'mention' : 'mentions'}
                      {timecode ? ` · first at ${timecode}` : ''}
                    </Typography>
                  </Link>
                </Box>
              );
            })}
          </Box>

          {otherVariants.length > 0 && (
            <Typography sx={{ mt: 1.5, fontSize: 12, color: colors.text.secondary }}>
              Also transcribed as{' '}
              {otherVariants.map((variant, index) => (
                <React.Fragment key={variant.text}>
                  {index > 0 && ', '}
                  <Box component="span" sx={{ fontStyle: 'italic' }}>
                    “{variant.text}”
                  </Box>{' '}
                  ({variant.mentions})
                </React.Fragment>
              ))}
            </Typography>
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

export default function EntitiesPage() {
  const [data, setData] = useState<EntityAggregateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);

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

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();

    return data.entities.filter((entity) => {
      if (activeLabel && entity.label !== activeLabel) return false;
      if (!needle) return true;
      return (
        entity.text.toLowerCase().includes(needle) ||
        entity.variants.some((variant) => variant.text.toLowerCase().includes(needle)) ||
        entity.stories.some((story) => story.interviewTitle.toLowerCase().includes(needle))
      );
    });
  }, [data, query, activeLabel]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, activeLabel]);

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', px: { xs: 2, sm: 3 }, py: { xs: 3, sm: 4 } }}>
      <Typography component="h1" sx={{ fontSize: { xs: 24, sm: 30 }, fontWeight: 700, mb: 0.5 }}>
        People, places and organizations
      </Typography>
      <Typography sx={{ color: colors.text.secondary, fontSize: 15, mb: 3, maxWidth: '62ch' }}>
        Every name the collection mentions, and where it is spoken. Spellings that differ only in punctuation or
        capitalization are grouped together.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
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
          <TextField
            fullWidth
            size="small"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names, places, organizations…"
            id="entity-search"
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 20, color: colors.text.secondary }} />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  <IconButton size="small" aria-label="Clear search" onClick={() => setQuery('')}>
                    <ClearIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
          />

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2.5 }}>
            <Chip
              label="All"
              size="small"
              onClick={() => setActiveLabel(null)}
              variant={activeLabel === null ? 'filled' : 'outlined'}
              sx={{ fontSize: 12 }}
            />
            {data.labels.map(({ label, distinctEntities }) => (
              <Chip
                key={label}
                size="small"
                label={`${getNerDisplayName(label)} (${distinctEntities})`}
                onClick={() => setActiveLabel((current) => (current === label ? null : label))}
                variant={activeLabel === label ? 'filled' : 'outlined'}
                sx={{
                  fontSize: 12,
                  ...(activeLabel === label ? { backgroundColor: getNerColor(label) } : {}),
                }}
              />
            ))}
          </Box>

          <Typography sx={{ fontSize: 13, color: colors.text.secondary, mb: 1 }}>
            {filtered.length.toLocaleString()} {filtered.length === 1 ? 'entity' : 'entities'}
            {query || activeLabel ? ` of ${data.entities.length.toLocaleString()}` : ''} ·{' '}
            {data.totalMentions.toLocaleString()} mentions in total
          </Typography>

          {data.truncated && (
            <Alert severity="info" sx={{ mb: 2 }}>
              This collection is large enough that the index covers only part of it.
            </Alert>
          )}

          <Box
            component="ul"
            sx={{
              m: 0,
              p: 0,
              border: `1px solid ${colors.common.border}`,
              borderRadius: 1,
              backgroundColor: colors.background.paper,
              overflow: 'hidden',
            }}>
            {filtered.slice(0, visible).map((entity) => (
              <EntityRow key={`${entity.key}::${entity.label}`} entity={entity} />
            ))}

            {filtered.length === 0 && (
              <Box sx={{ px: 2, py: 5, textAlign: 'center' }}>
                <Typography sx={{ color: colors.text.secondary, fontSize: 14 }}>
                  No entities match that search.
                </Typography>
              </Box>
            )}
          </Box>

          {visible < filtered.length && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2.5 }}>
              <Chip
                label={`Show ${Math.min(PAGE_SIZE, filtered.length - visible)} more`}
                onClick={() => setVisible((value) => value + PAGE_SIZE)}
                sx={{ cursor: 'pointer' }}
              />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
