import { Transcription } from '@/types/transcription';

export type TranscriptData = {
  transcription: Transcription;
  videoUrl: string;
  isAudioFile: boolean;
  interviewTitle: string;
};

export type ThematicMatch = {
  transcription: string;
  speaker: string;
  sectionTitle: string;
  startTime: number;
  endTime: number;
  score: number;
};

export type SearchMode = 'text' | 'thematic';

/**
 * A named-entity mention to mark in the transcript.
 *
 * Supplied by callers that arrive from an entity view, so the transcript can
 * show where that entity is spoken rather than only where a citation falls.
 */
export type NerHighlight = {
  startTime: number;
  endTime: number;
  text: string;
  label: string;
};
