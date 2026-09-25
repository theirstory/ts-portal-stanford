import React from 'react';

/**
 * Caption track for a recording, generated from its transcript.
 *
 * The Mux assets carry no captions of their own — every rendition reports
 * CLOSED-CAPTIONS=NONE — so without this the players have nothing to show and
 * the CC control does not appear at all. /api/captions builds WebVTT from the
 * stored transcript, which already has the word timings a caption file needs.
 *
 * Rendered as a child of MuxPlayer so it is slotted into the underlying media
 * element and picked up by the player's own caption control.
 */
export const TranscriptCaptionsTrack = ({ storyId }: { storyId?: string | null }) => {
  if (!storyId) return null;

  return (
    <track
      kind="captions"
      label="English"
      srcLang="en"
      default
      src={`/api/captions?storyId=${encodeURIComponent(storyId)}`}
    />
  );
};

export default TranscriptCaptionsTrack;
