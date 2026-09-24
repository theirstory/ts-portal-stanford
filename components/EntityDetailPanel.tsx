'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MuxPlayer from '@mux/mux-player-react';
import type MuxPlayerElement from '@mux/mux-player';
import Link from 'next/link';

import { colors } from '@/lib/theme';
import { muxPlayerThemeProps } from '@/lib/theme/muxPlayerTheme';
import { getMuxPlaybackId } from '@/app/utils/converters';
import { getNerColor, getNerDisplayName } from '@/config/organizationConfig';
import { getEntityOccurrences } from '@/lib/weaviate/search';
import type { EntityCollectionOccurrences } from '@/lib/weaviate/entities';
import { EntityTranscriptView } from '@/components/EntityTranscriptView';

/** Characters of surrounding passage shown before "Show more". */
const EXCERPT_RADIUS = 90;

const formatTimecode = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

/**
 * Renders the passage with the entity marked, trimmed around the mention unless
 * expanded. The name is found case-insensitively because transcripts spell it
 * inconsistently — the whole reason these are grouped in the first place.
 */
const Excerpt = ({ context, term, expanded }: { context: string; term: string; expanded: boolean }) => {
  const { text, truncatedStart, truncatedEnd } = useMemo(() => {
    if (expanded || !context) return { text: context, truncatedStart: false, truncatedEnd: false };

    const at = context.toLowerCase().indexOf(term.toLowerCase());
    if (at === -1) {
      return {
        text: context.slice(0, EXCERPT_RADIUS * 2),
        truncatedStart: false,
        truncatedEnd: context.length > EXCERPT_RADIUS * 2,
      };
    }

    const from = Math.max(0, at - EXCERPT_RADIUS);
    const to = Math.min(context.length, at + term.length + EXCERPT_RADIUS);
    return { text: context.slice(from, to), truncatedStart: from > 0, truncatedEnd: to < context.length };
  }, [context, term, expanded]);

  const parts = useMemo(() => {
    if (!term) return [text];
    const pattern = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return text.split(pattern);
  }, [text, term]);

  return (
    <Typography sx={{ fontSize: 13.5, lineHeight: 1.55, color: colors.text.primary, overflowWrap: 'anywhere' }}>
      {truncatedStart && '…'}
      {parts.map((part, index) =>
        part.toLowerCase() === term.toLowerCase() ? (
          <Box
            key={index}
            component="mark"
            sx={{ backgroundColor: '#FFF1A8', px: 0.4, borderRadius: 0.5, fontWeight: 600 }}>
            {part}
          </Box>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
      {truncatedEnd && '…'}
    </Typography>
  );
};

export type EntityDetailTarget = {
  text: string;
  label: string;
  variants: string[];
  /** Recording whose square was clicked; its group opens first. */
  focusStoryUuid?: string;
};

export const EntityDetailPanel = ({ target, onClose }: { target: EntityDetailTarget; onClose: () => void }) => {
  const [data, setData] = useState<EntityCollectionOccurrences | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Recording opened for playback inside the panel, with the moment to seek to. */
  const [playing, setPlaying] = useState<{ storyUuid: string; start: number } | null>(null);
  const playerRef = useRef<MuxPlayerElement>(null);

  const variantKey = target.variants.join('|');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    setFilter('');
    setExpanded(new Set());
    setPlaying(null);

    getEntityOccurrences(target.text, target.label, variantKey ? variantKey.split('|') : [])
      .then((result) => {
        if (cancelled) return;
        setData(result);
        // Everything open except the recordings other than the one clicked, so
        // the square the reader came from is what they land on.
        setCollapsed(
          new Set(
            target.focusStoryUuid
              ? result.recordings.filter((r) => r.storyUuid !== target.focusStoryUuid).map((r) => r.storyUuid)
              : [],
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [target.text, target.label, target.focusStoryUuid, variantKey]);

  // Selecting another moment in the same recording seeks the open player
  // rather than remounting it, so playback is not interrupted.
  useEffect(() => {
    if (playing && playerRef.current) {
      playerRef.current.currentTime = playing.start;
    }
  }, [playing]);

  const recordings = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return data.recordings;

    return data.recordings
      .map((recording) => ({
        ...recording,
        occurrences: recording.occurrences.filter(
          (occurrence) =>
            occurrence.context.toLowerCase().includes(needle) ||
            occurrence.speaker.toLowerCase().includes(needle) ||
            occurrence.sectionTitle.toLowerCase().includes(needle),
        ),
      }))
      .filter(
        (recording) => recording.occurrences.length > 0 || recording.interviewTitle.toLowerCase().includes(needle),
      );
  }, [data, filter]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const playingRecording = playing
    ? (data?.recordings.find((recording) => recording.storyUuid === playing.storyUuid) ?? null)
    : null;

  const labelColor = getNerColor(target.label);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', bgcolor: colors.background.paper }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.25,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}>
        <Chip
          label={getNerDisplayName(target.label)}
          size="small"
          sx={{ backgroundColor: labelColor, fontSize: 11, height: 20 }}
        />
        <Typography sx={{ fontWeight: 700, fontSize: 16 }} noWrap>
          {target.text}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <IconButton size="small" onClick={onClose} aria-label="Close panel">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {!data && !error && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 3, color: colors.text.secondary }}>
          <CircularProgress size={16} />
          <Typography sx={{ fontSize: 13.5 }}>Finding every mention…</Typography>
        </Box>
      )}

      {error && (
        <Typography sx={{ p: 3, fontSize: 13.5, color: colors.text.secondary }}>
          These mentions could not be loaded. Close the panel and try again.
        </Typography>
      )}

      {data && playing && playingRecording && (
        <Box sx={{ flexShrink: 0, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.75 }}>
            <IconButton size="small" onClick={() => setPlaying(null)} aria-label="Back to all mentions">
              <ArrowBackIcon fontSize="small" />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600 }} noWrap>
                {playingRecording.interviewTitle}
              </Typography>
              <Typography sx={{ fontSize: 11, color: colors.text.secondary }}>Back to all mentions</Typography>
            </Box>
            <Box sx={{ flexGrow: 1 }} />
            <Link
              href={`/story/${playingRecording.storyUuid}?start=${Math.floor(playing.start)}&nerLabel=${encodeURIComponent(target.label)}`}
              style={{ fontSize: 12, color: colors.primary.main, fontWeight: 600, whiteSpace: 'nowrap' }}>
              Open recording
            </Link>
          </Box>
          <MuxPlayer
            ref={playerRef}
            src={playingRecording.videoUrl}
            audio={playingRecording.isAudioFile}
            startTime={playing.start}
            forwardSeekOffset={10}
            backwardSeekOffset={10}
            accentColor={muxPlayerThemeProps.accentColor}
            // Mux shows the default track unless captions are hidden explicitly.
            defaultHiddenCaptions={false}
            style={{
              ...muxPlayerThemeProps.style,
              width: '100%',
              aspectRatio: playingRecording.isAudioFile ? 'auto' : '16/9',
            }}>
            {/*
              The Mux assets carry no caption track, so this supplies one built
              from the transcript we already hold. Slotted into the player so it
              appears under the usual CC control.
            */}
            <track
              kind="captions"
              label="English"
              srcLang="en"
              default
              src={`/api/captions?storyId=${encodeURIComponent(playingRecording.storyUuid)}`}
            />
          </MuxPlayer>
        </Box>
      )}

      {data && playing && playingRecording && (
        <EntityTranscriptView
          storyUuid={playingRecording.storyUuid}
          entityLabel={target.label}
          occurrences={playingRecording.occurrences}
          activeStart={playing.start}
          onSelectOccurrence={(start) => setPlaying({ storyUuid: playingRecording.storyUuid, start })}
        />
      )}

      {data && !playing && (
        <>
          <Box sx={{ px: 2, pt: 1.5, pb: 1, flexShrink: 0 }}>
            <Typography sx={{ fontSize: 13, color: colors.text.secondary, mb: 1 }}>
              {data.totalOccurrences} {data.totalOccurrences === 1 ? 'mention' : 'mentions'} across{' '}
              {data.recordingCount} {data.recordingCount === 1 ? 'recording' : 'recordings'}
            </Typography>
            <TextField
              size="small"
              fullWidth
              id="entity-panel-filter"
              placeholder="Filter mentions…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ bgcolor: colors.background.default, borderRadius: '8px' }}
            />
          </Box>

          <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {recordings.length === 0 && (
              <Typography sx={{ p: 3, fontSize: 13.5, color: colors.text.secondary, textAlign: 'center' }}>
                No mentions match that filter.
              </Typography>
            )}

            {recordings.map((recording) => {
              const playbackId = getMuxPlaybackId(recording.videoUrl);
              const thumbnailUrl =
                playbackId && !recording.isAudioFile
                  ? `/api/thumbnail?playbackId=${playbackId}&width=320&height=180&fit_mode=crop`
                  : null;
              const isCollapsed = collapsed.has(recording.storyUuid);

              return (
                <Box key={recording.storyUuid} sx={{ borderBottom: '2px solid', borderColor: 'divider' }}>
                  <Box
                    component="button"
                    type="button"
                    onClick={() => setCollapsed((current) => toggle(current, recording.storyUuid))}
                    aria-expanded={!isCollapsed}
                    sx={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.5,
                      px: 2,
                      py: 1.25,
                      bgcolor: colors.grey[50],
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      font: 'inherit',
                    }}>
                    <KeyboardArrowDownIcon
                      sx={{
                        fontSize: 18,
                        color: colors.text.secondary,
                        transform: isCollapsed ? 'rotate(-90deg)' : 'none',
                        transition: 'transform 120ms ease',
                        flexShrink: 0,
                      }}
                    />
                    {thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbnailUrl}
                        alt=""
                        width={64}
                        height={36}
                        style={{ borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                      />
                    )}
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 600, color: colors.primary.main }} noWrap>
                        {recording.interviewTitle}
                      </Typography>
                      <Typography sx={{ fontSize: 12, color: colors.text.secondary }}>
                        {recording.occurrences.length} {recording.occurrences.length === 1 ? 'mention' : 'mentions'}
                      </Typography>
                    </Box>
                  </Box>

                  {!isCollapsed && (
                    <Box sx={{ p: 1.25, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 1 }}>
                      {recording.occurrences.map((occurrence) => {
                        const key = `${recording.storyUuid}:${occurrence.start}`;
                        const isExpanded = expanded.has(key);

                        return (
                          <Box
                            key={key}
                            sx={{
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1.5,
                              p: 1.25,
                              bgcolor: colors.background.paper,
                            }}>
                            <Box
                              sx={{
                                display: 'flex',
                                alignItems: 'baseline',
                                justifyContent: 'space-between',
                                gap: 1,
                                minWidth: 0,
                              }}>
                              {occurrence.sectionTitle && (
                                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }} noWrap>
                                  {occurrence.sectionTitle}
                                </Typography>
                              )}
                              <Box
                                component="button"
                                type="button"
                                onClick={() => setPlaying({ storyUuid: recording.storyUuid, start: occurrence.start })}
                                aria-label={`Play ${recording.interviewTitle} from ${formatTimecode(occurrence.start)}`}
                                sx={{
                                  fontSize: 12,
                                  color: colors.primary.main,
                                  fontWeight: 600,
                                  whiteSpace: 'nowrap',
                                  ml: 'auto',
                                  background: 'none',
                                  border: 'none',
                                  p: 0,
                                  cursor: 'pointer',
                                  font: 'inherit',
                                  textDecoration: 'underline',
                                  textUnderlineOffset: 2,
                                }}>
                                {formatTimecode(occurrence.start)}
                              </Box>
                            </Box>

                            {occurrence.speaker && (
                              <Typography sx={{ fontSize: 11.5, color: colors.text.secondary, mb: 0.5 }}>
                                {occurrence.speaker}
                              </Typography>
                            )}

                            <Excerpt context={occurrence.context} term={occurrence.text} expanded={isExpanded} />

                            {occurrence.context.length > EXCERPT_RADIUS * 2 && (
                              <Typography
                                component="button"
                                type="button"
                                onClick={() => setExpanded((current) => toggle(current, key))}
                                sx={{
                                  mt: 0.5,
                                  fontSize: 12.5,
                                  fontWeight: 600,
                                  color: colors.primary.main,
                                  background: 'none',
                                  border: 'none',
                                  p: 0,
                                  cursor: 'pointer',
                                  font: 'inherit',
                                }}>
                                {isExpanded ? 'Show less' : 'Show more'}
                              </Typography>
                            )}
                          </Box>
                        );
                      })}
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        </>
      )}
    </Box>
  );
};

export default EntityDetailPanel;
