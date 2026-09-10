import type React from 'react';
import { colors } from './colors';

export const muxPlayerThemeProps = {
  accentColor: colors.primary.light,
  style: {
    // Keep the picture clear while paused/hovered: the controls have their own
    // backgrounds, so no scrim is needed over the video.
    '--controls-backdrop-color': 'transparent',
    '--media-control-background': colors.primary.light,
    '--media-control-hover-background': colors.primary.dark,
    '--media-control-color': colors.primary.contrastText,
    '--media-range-bar-color': colors.primary.light,
    '--media-range-track-color': `${colors.common.white}55`,
    width: '100%',
  } as React.CSSProperties,
};
