'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import { colors } from '@/lib/theme';
import { getNerColor } from '@/config/organizationConfig';
import type { Transcription } from '@/types/transcription';
import type { EntityOccurrence } from '@/lib/weaviate/entities';

/** Word timings and occurrence bounds rarely align exactly. */
const MATCH_EPSILON = 0.35;

type TranscriptResponse = {
  transcription: Transcription;
  interviewTitle: string;
};

const formatTimecode = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

/**
 * The recording's transcript with every mention of one entity marked.
 *
 * Reading a mention in place answers what a list of excerpts cannot: who was
 * speaking, what was asked, and what came next. The occurrence list stays the
 * index — this is the page it points into.
 */
export const EntityTranscriptView = ({
  storyUuid,
  entityLabel,
  occurrences,
  activeStart,
  onSelectOccurrence,
}: {
  storyUuid: string;
  entityLabel: string;
  /** Mentions of the selected entity in this recording, earliest first. */
  occurrences: EntityOccurrence[];
  activeStart: number;
  onSelectOccurrence: (start: number) => void;
}) => {
  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);

    fetch(`/api/transcript?storyId=${encodeURIComponent(storyUuid)}`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<TranscriptResponse>;
      })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [storyUuid]);

  const activeIndex = useMemo(() => {
    if (occurrences.length === 0) return -1;
    let best = 0;
    let bestDistance = Infinity;
    occurrences.forEach((occurrence, index) => {
      const distance = Math.abs(occurrence.start - activeStart);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }, [occurrences, activeStart]);

  // Keep the current mention in view as the reader steps through.
  useEffect(() => {
    if (!data) return;
    const container = containerRef.current;
    if (!container) return;

    const target = container.querySelector('[data-active-mention="true"]');
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [data, activeStart]);

  const highlightColor = getNerColor(entityLabel);

  const step = (delta: number) => {
    if (occurrences.length === 0) return;
    const next = Math.min(Math.max(activeIndex + delta, 0), occurrences.length - 1);
    onSelectOccurrence(occurrences[next].start);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 0.75,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}>
        <Typography sx={{ fontSize: 12.5, color: colors.text.secondary }}>
          {occurrences.length === 0
            ? 'No mentions in this recording'
            : `Mention ${activeIndex + 1} of ${occurrences.length}`}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <IconButton size="small" aria-label="Previous mention" disabled={activeIndex <= 0} onClick={() => step(-1)}>
          <KeyboardArrowUpIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          aria-label="Next mention"
          disabled={activeIndex < 0 || activeIndex >= occurrences.length - 1}
          onClick={() => step(1)}>
          <KeyboardArrowDownIcon fontSize="small" />
        </IconButton>
      </Box>

      {!data && !error && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 3, color: colors.text.secondary }}>
          <CircularProgress size={16} />
          <Typography sx={{ fontSize: 13.5 }}>Loading transcript…</Typography>
        </Box>
      )}

      {error && (
        <Typography sx={{ p: 3, fontSize: 13.5, color: colors.text.secondary }}>
          This transcript could not be loaded.
        </Typography>
      )}

      {data && (
        <Box ref={containerRef} sx={{ flex: 1, overflow: 'auto', minHeight: 0, px: 2, py: 1.5 }}>
          {(data.transcription?.sections ?? []).map((section, sectionIndex) => (
            <Box key={sectionIndex} sx={{ mb: 2.5 }}>
              {section.title && (
                <Typography
                  sx={{
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: colors.text.secondary,
                    mb: 0.75,
                  }}>
                  {section.title}
                </Typography>
              )}

              {(section.paragraphs ?? []).map((paragraph, paragraphIndex) => {
                const words = paragraph.words ?? [];
                const paragraphHasMention = occurrences.some(
                  (occurrence) =>
                    occurrence.start >= paragraph.start - MATCH_EPSILON &&
                    occurrence.start <= paragraph.end + MATCH_EPSILON,
                );

                return (
                  <Box key={paragraphIndex} sx={{ mb: 1.25 }}>
                    <Typography sx={{ fontSize: 11.5, color: colors.text.secondary, mb: 0.25 }}>
                      {paragraph.speaker} · {formatTimecode(paragraph.start)}
                    </Typography>
                    <Typography sx={{ fontSize: 13.5, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
                      {words.map((word, wordIndex) => {
                        const inMention = occurrences.find(
                          (occurrence) =>
                            word.start >= occurrence.start - MATCH_EPSILON &&
                            word.start <= (occurrence.end ?? occurrence.start) + MATCH_EPSILON,
                        );
                        const isActive =
                          inMention !== undefined &&
                          activeIndex >= 0 &&
                          Math.abs(inMention.start - occurrences[activeIndex].start) < MATCH_EPSILON;

                        if (!inMention) {
                          return <React.Fragment key={wordIndex}>{word.text} </React.Fragment>;
                        }

                        return (
                          <Box
                            key={wordIndex}
                            component="mark"
                            data-active-mention={isActive ? 'true' : undefined}
                            onClick={() => onSelectOccurrence(inMention.start)}
                            sx={{
                              backgroundColor: highlightColor,
                              borderRadius: 0.5,
                              px: 0.3,
                              cursor: 'pointer',
                              fontWeight: 600,
                              color: colors.text.primary,
                              outline: isActive ? `2px solid ${colors.primary.main}` : 'none',
                              outlineOffset: 1,
                            }}>
                            {word.text}{' '}
                          </Box>
                        );
                      })}
                    </Typography>
                    {paragraphHasMention && (
                      <Typography
                        component="button"
                        type="button"
                        onClick={() => {
                          const first = occurrences.find(
                            (occurrence) =>
                              occurrence.start >= paragraph.start - MATCH_EPSILON &&
                              occurrence.start <= paragraph.end + MATCH_EPSILON,
                          );
                          if (first) onSelectOccurrence(first.start);
                        }}
                        sx={{
                          fontSize: 11.5,
                          color: colors.primary.main,
                          background: 'none',
                          border: 'none',
                          p: 0,
                          mt: 0.25,
                          cursor: 'pointer',
                          font: 'inherit',
                        }}>
                        Play from here
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default EntityTranscriptView;
