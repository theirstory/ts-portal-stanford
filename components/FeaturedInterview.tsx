'use client';

/**
 * Featured interview carousel for the unfiltered home view.
 *
 * Ported from the Television Academy portal's HeroCarousel, but styled from this
 * portal's theme rather than that one's hardcoded palette, and pointed at
 * /api/thumbnail so the still is a frame with picture in it (these recordings
 * open on a black screen, so the original's fixed `time=12` would be black).
 *
 * Which interviews appear is controlled by config.json -> ui.featuredInterviews.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Box, Typography } from '@mui/material';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { WeaviateGenericObject } from 'weaviate-client';
import { Testimonies } from '@/types/weaviate';
import { getMuxPlaybackId } from '@/app/utils/converters';
import { durationFormatHandler } from '@/app/utils/util';
import { colors } from '@/lib/theme';
import { config } from '@/config/organizationConfig';

const AUTOPLAY_MS = 6000;
const DESCRIPTION_LIMIT = 260;

type FeaturedStory = WeaviateGenericObject<Testimonies, any>;

const truncate = (value: string, limit: number): string => {
  if (!value) return '';
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > limit - 40 ? lastSpace : limit).trim()}…`;
};

const stillUrl = (story: FeaturedStory): string | null => {
  const playbackId = getMuxPlaybackId(story.properties.video_url);
  if (!playbackId) return null;

  const pinned = config.ui?.thumbnailTimes?.[story.uuid];
  const duration = Math.floor(story.properties.interview_duration ?? 0);
  const hint = pinned ? `&time=${Math.floor(pinned)}` : duration ? `&duration=${duration}` : '';

  return `/api/thumbnail?playbackId=${playbackId}&width=1280&height=720&fit_mode=crop${hint}`;
};

/** Order/limit the featured set from config; an empty list means every recording. */
export const selectFeaturedStories = (stories: FeaturedStory[]): FeaturedStory[] => {
  const settings = config.ui?.featuredInterviews;
  if (settings?.enabled === false) return [];

  const wanted = settings?.storyUuids ?? [];

  const selected = wanted.length
    ? wanted.map((uuid) => stories.find((story) => story.uuid === uuid)).filter((story): story is FeaturedStory => !!story)
    : stories;

  const limit = settings?.limit;
  return limit && limit > 0 ? selected.slice(0, limit) : selected;
};

const Slide = ({ story, visible }: { story: FeaturedStory; visible: boolean }) => {
  const title = story.properties.interview_title || 'Untitled';
  const description = truncate(story.properties.interview_description || '', DESCRIPTION_LIMIT);
  const duration = durationFormatHandler(story.properties.interview_duration);
  const still = stillUrl(story);
  const href = `/story/${story.uuid}`;

  return (
    <Box
      aria-hidden={!visible}
      sx={{
        position: 'absolute',
        inset: 0,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.5s ease',
        pointerEvents: visible ? 'auto' : 'none',
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '1.1fr 0.9fr' },
        gridTemplateRows: { xs: 'minmax(200px, 240px) 1fr', md: '100%' },
      }}>
      {/* Still */}
      <Box sx={{ position: 'relative', overflow: 'hidden', bgcolor: colors.common.black }}>
        {still && (
          // eslint-disable-next-line @next/next/no-img-element
          <Box
            component="img"
            src={still}
            alt=""
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        <Box
          component={Link}
          href={href}
          aria-label={`Watch ${title}`}
          sx={{
            position: 'absolute',
            left: { xs: 16, md: 24 },
            bottom: { xs: 16, md: 24 },
            width: { xs: 46, md: 56 },
            height: { xs: 46, md: 56 },
            borderRadius: '50%',
            bgcolor: colors.primary.main,
            color: colors.primary.contrastText,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 8px 24px ${colors.common.shadow}`,
            textDecoration: 'none',
            transition: 'transform .15s ease, background-color .15s ease',
            '&:hover': { transform: 'scale(1.06)', bgcolor: colors.primary.dark },
          }}>
          <PlayArrowRoundedIcon sx={{ fontSize: { xs: 28, md: 34 } }} />
        </Box>
        {duration && (
          <Box
            sx={{
              position: 'absolute',
              right: { xs: 12, md: 20 },
              bottom: { xs: 16, md: 24 },
              bgcolor: colors.common.overlay,
              color: colors.common.white,
              fontSize: 12,
              letterSpacing: '0.04em',
              px: 1,
              py: 0.5,
              borderRadius: 999,
            }}>
            {duration}
          </Box>
        )}
      </Box>

      {/* Copy */}
      <Box
        sx={{
          bgcolor: colors.grey[900],
          color: colors.common.white,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          px: { xs: 2.5, sm: 3.5, md: 5 },
          py: { xs: 3, md: 4 },
          minWidth: 0,
        }}>
        <Typography
          component="span"
          sx={{
            textTransform: 'uppercase',
            letterSpacing: '0.16em',
            fontWeight: 700,
            fontSize: 12,
            color: colors.primary.light,
            mb: 1.25,
          }}>
          Featured Interview
        </Typography>
        <Typography
          component="h2"
          sx={{
            m: 0,
            fontWeight: 700,
            lineHeight: 1.1,
            fontSize: { xs: '24px', sm: '30px', md: 'clamp(28px, 2.6vw, 40px)' },
            mb: 1.5,
            textWrap: 'balance',
          }}>
          {title}
        </Typography>
        {description && (
          <Typography
            component="p"
            sx={{
              m: 0,
              color: `${colors.common.white}c4`,
              fontSize: { xs: 14, md: 15.5 },
              lineHeight: 1.6,
              maxWidth: 520,
              mb: 3,
            }}>
            {description}
          </Typography>
        )}
        <Box
          component={Link}
          href={href}
          sx={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            px: 2.5,
            py: 1.25,
            borderRadius: 1,
            bgcolor: colors.primary.main,
            color: colors.primary.contrastText,
            fontWeight: 700,
            fontSize: 14,
            textDecoration: 'none',
            transition: 'background-color .18s ease, transform .18s ease',
            '&:hover': { bgcolor: colors.primary.dark, transform: 'translateY(-1px)' },
          }}>
          <PlayArrowRoundedIcon sx={{ fontSize: 18 }} />
          Watch the interview
        </Box>
      </Box>
    </Box>
  );
};

const navButtonSx = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  width: 40,
  height: 40,
  borderRadius: '50%',
  bgcolor: colors.common.overlay,
  border: `1.5px solid ${colors.common.white}59`,
  color: colors.common.white,
  display: { xs: 'none', sm: 'inline-flex' },
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  zIndex: 4,
  transition: 'background-color .18s ease, border-color .18s ease',
  '&:hover': { bgcolor: colors.primary.main, borderColor: colors.primary.main },
} as const;

export const FeaturedInterview = ({ stories }: { stories: FeaturedStory[] }) => {
  const slides = useMemo(() => selectFeaturedStories(stories), [stories]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (index >= slides.length) setIndex(0);
  }, [index, slides.length]);

  useEffect(() => {
    if (paused || slides.length <= 1) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % slides.length), AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [paused, slides.length]);

  const goPrev = useCallback(
    () => setIndex((current) => (current - 1 + slides.length) % slides.length),
    [slides.length],
  );
  const goNext = useCallback(() => setIndex((current) => (current + 1) % slides.length), [slides.length]);

  if (slides.length === 0) return null;

  return (
    <Box
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      sx={{
        position: 'relative',
        width: '100%',
        flexShrink: 0,
        overflow: 'hidden',
        borderRadius: 2,
        boxShadow: `0 1px 3px ${colors.common.shadow}`,
        mb: { xs: 2, md: 3 },
        height: { xs: 520, sm: 540, md: 'clamp(320px, 42vh, 420px)' },
      }}>
      {slides.map((story, slideIndex) => (
        <Slide key={story.uuid} story={story} visible={slideIndex === Math.min(index, slides.length - 1)} />
      ))}

      {slides.length > 1 && (
        <>
          <Box
            component="button"
            type="button"
            aria-label="Previous featured interview"
            onClick={goPrev}
            sx={{ ...navButtonSx, left: { xs: 8, md: 16 } }}>
            <ChevronLeftIcon />
          </Box>
          <Box
            component="button"
            type="button"
            aria-label="Next featured interview"
            onClick={goNext}
            sx={{ ...navButtonSx, left: { xs: 'auto', md: 'calc(55% - 56px)' }, right: { xs: 8, md: 'auto' } }}>
            <ChevronRightIcon />
          </Box>
          <Box
            role="tablist"
            aria-label="Featured interviews"
            sx={{
              position: 'absolute',
              right: { xs: 14, md: 22 },
              bottom: { xs: 12, md: 18 },
              display: 'inline-flex',
              gap: 1,
              zIndex: 4,
            }}>
            {slides.map((story, slideIndex) => {
              const active = slideIndex === index;
              return (
                <Box
                  key={story.uuid}
                  component="button"
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={`Show featured interview ${slideIndex + 1}`}
                  onClick={() => setIndex(slideIndex)}
                  sx={{
                    width: active ? 24 : 8,
                    height: 8,
                    p: 0,
                    border: 'none',
                    borderRadius: active ? 1 : '50%',
                    bgcolor: active ? colors.primary.light : `${colors.common.white}66`,
                    cursor: 'pointer',
                    transition: 'width .2s ease, background-color .2s ease',
                  }}
                />
              );
            })}
          </Box>
        </>
      )}
    </Box>
  );
};
