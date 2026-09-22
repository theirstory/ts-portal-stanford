'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

import { colors } from '@/lib/theme';
import config from '@/config.json';

/**
 * Marks text that a language model wrote.
 *
 * A stewarding institution's authority rests on readers being able to tell
 * which words are the archive's and which a model drafted. Interview
 * descriptions and chapter titles and summaries are currently generated, and
 * they read exactly like curatorial writing — so they are labelled until a
 * curator has reviewed them.
 *
 * `human` renders nothing: an unmarked passage is the institution's own voice,
 * which is the default a reader should be able to assume.
 */
export type Authorship = 'human' | 'ai-assisted' | 'ai';

const LABELS: Record<Exclude<Authorship, 'human'>, { short: string; explanation: string }> = {
  ai: {
    short: 'AI-generated',
    explanation: 'Written by a language model from the transcript. Not yet reviewed by an archivist.',
  },
  'ai-assisted': {
    short: 'AI-assisted',
    explanation: 'Drafted by a language model from the transcript and reviewed by an archivist.',
  },
};

const provenanceEnabled = () =>
  (config as { features?: { provenance?: { showBadges?: boolean } } }).features?.provenance?.showBadges !== false;

export const AuthorshipBadge = ({
  authorship,
  size = 'medium',
}: {
  authorship: Authorship | undefined;
  size?: 'small' | 'medium';
}) => {
  if (!authorship || authorship === 'human' || !provenanceEnabled()) return null;

  const { short, explanation } = LABELS[authorship];
  const compact = size === 'small';

  return (
    <Tooltip title={explanation} enterTouchDelay={0}>
      <Box
        component="span"
        aria-label={`${short}. ${explanation}`}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.4,
          verticalAlign: 'middle',
          flexShrink: 0,
          px: compact ? 0.5 : 0.75,
          py: compact ? 0.1 : 0.25,
          borderRadius: 0.75,
          border: `1px solid ${colors.common.border}`,
          backgroundColor: colors.background.subtle,
          color: colors.text.secondary,
          fontSize: compact ? 10 : 11,
          lineHeight: 1.4,
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap',
          cursor: 'help',
        }}>
        <AutoAwesomeIcon sx={{ fontSize: compact ? 10 : 12 }} />
        {short}
      </Box>
    </Tooltip>
  );
};

export default AuthorshipBadge;
