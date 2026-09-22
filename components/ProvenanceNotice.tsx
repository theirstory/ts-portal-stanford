'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

import { colors } from '@/lib/theme';
import config from '@/config.json';

/**
 * Page-level disclosure for a view whose text is largely model-written.
 *
 * Used instead of a badge per row where nearly every item is generated —
 * hundreds of identical badges would read as decoration and stop being
 * information. One clear statement at the top of the page does the work.
 */
const provenanceEnabled = () =>
  (config as { features?: { provenance?: { showBadges?: boolean } } }).features?.provenance?.showBadges !== false;

export const ProvenanceNotice = ({ children }: { children: React.ReactNode }) => {
  if (!provenanceEnabled()) return null;

  return (
    <Box
      role="note"
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        px: 1.5,
        py: 1,
        mb: 2,
        borderLeft: `3px solid ${colors.common.border}`,
        backgroundColor: colors.background.subtle,
        borderRadius: '0 4px 4px 0',
      }}>
      <AutoAwesomeIcon sx={{ fontSize: 15, color: colors.text.secondary, mt: '2px', flexShrink: 0 }} />
      <Typography sx={{ fontSize: 13, lineHeight: 1.5, color: colors.text.secondary, maxWidth: '72ch' }}>
        {children}
      </Typography>
    </Box>
  );
};

export default ProvenanceNotice;
