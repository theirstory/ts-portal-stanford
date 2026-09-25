import { getDataVersion } from '@/lib/data-version';
import { ifNoneMatch, makeEtag, notModified } from '@/lib/http-cache';
import { fetchStoryTranscriptByUuid } from '@/lib/weaviate/search';
import type { Transcription, Word } from '@/types/transcription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * WebVTT captions built from the stored transcript.
 *
 * The Mux assets carry no caption track (`CLOSED-CAPTIONS=NONE` on every
 * rendition), so the player has nothing to show on its own. The transcript
 * already holds word-level timings, which is everything a caption file needs —
 * so captions are generated from it rather than re-transcribed or uploaded.
 *
 * Cues break on the gaps a listener already hears: a change of speaker, a long
 * pause, or a line growing too long to read at speed.
 */
const MAX_CUE_CHARS = 84;
const MAX_CUE_SECONDS = 6;
/** A gap this long reads as a new utterance rather than a continuation. */
const CUE_BREAK_GAP_SECONDS = 1.2;

/**
 * Browsers revalidate every time; the ETag changes when portal-sync changes the
 * data (the data version), so a republished transcript shows up on the next
 * load. The hourly bucket caps staleness from changes made outside portal-sync
 * at what the old `max-age=3600` allowed.
 */
const CACHE_CONTROL = 'private, no-cache';
const ETAG_BUCKET_MS = 60 * 60_000;

const timestamp = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`;
};

/** VTT treats these as cue markup, so they are escaped in cue text. */
const escapeCueText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Cue = { start: number; end: number; speaker: string; text: string };

const buildCues = (transcription: Transcription): Cue[] => {
  const cues: Cue[] = [];

  for (const section of transcription.sections ?? []) {
    for (const paragraph of section.paragraphs ?? []) {
      const words = (paragraph.words ?? []).filter(
        (word): word is Word => Boolean(word) && typeof word.start === 'number' && Boolean(word.text?.trim()),
      );
      if (words.length === 0) continue;

      let current: Word[] = [];

      const flush = () => {
        if (current.length === 0) return;
        const text = current
          .map((word) => word.text.trim())
          .join(' ')
          .replace(/\s+([,.!?;:])/g, '$1')
          .trim();
        if (text) {
          cues.push({
            start: current[0].start,
            end: current[current.length - 1].end ?? current[current.length - 1].start,
            speaker: paragraph.speaker ?? '',
            text,
          });
        }
        current = [];
      };

      for (const word of words) {
        const previous = current[current.length - 1];
        const pendingChars = current.reduce((sum, entry) => sum + entry.text.length + 1, 0);
        const wouldOverrun =
          pendingChars + word.text.length > MAX_CUE_CHARS ||
          (current.length > 0 && word.end - current[0].start > MAX_CUE_SECONDS);
        const afterPause = previous ? word.start - (previous.end ?? previous.start) > CUE_BREAK_GAP_SECONDS : false;

        if (current.length > 0 && (wouldOverrun || afterPause)) flush();
        current.push(word);
      }

      flush();
    }
  }

  return cues;
};

const toVtt = (cues: Cue[]): string => {
  const lines = ['WEBVTT', ''];
  let previousSpeaker = '';

  cues.forEach((cue, index) => {
    // Nudge a zero-length cue so players do not drop it.
    const end = cue.end > cue.start ? cue.end : cue.start + 0.5;
    const speakerChanged = cue.speaker && cue.speaker !== previousSpeaker;
    previousSpeaker = cue.speaker || previousSpeaker;

    lines.push(String(index + 1));
    lines.push(`${timestamp(cue.start)} --> ${timestamp(end)}`);
    lines.push(escapeCueText(speakerChanged ? `${cue.speaker}: ${cue.text}` : cue.text));
    lines.push('');
  });

  return lines.join('\n');
};

export async function GET(request: Request) {
  const storyId = new URL(request.url).searchParams.get('storyId');

  if (!storyId) {
    return new Response('storyId is required', { status: 400 });
  }

  // storyId (the Testimony uuid) is the only input that affects the output.
  const etag = makeEtag('captions', getDataVersion(), storyId, Math.floor(Date.now() / ETAG_BUCKET_MS));
  if (ifNoneMatch(request, etag)) return notModified(etag, CACHE_CONTROL);

  try {
    const story = await fetchStoryTranscriptByUuid(storyId);
    const raw = story?.properties?.transcription;

    if (!raw) {
      return new Response('No transcript for that recording', { status: 404 });
    }

    const cues = buildCues(JSON.parse(raw) as Transcription);
    if (cues.length === 0) {
      return new Response('No timed words in that transcript', { status: 404 });
    }

    return new Response(toVtt(cues), {
      headers: {
        'content-type': 'text/vtt; charset=utf-8',
        'cache-control': CACHE_CONTROL,
        etag,
      },
    });
  } catch (error) {
    console.error('Captions API error:', error);
    return new Response('Failed to build captions', { status: 500 });
  }
}
