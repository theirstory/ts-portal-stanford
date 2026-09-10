import { NextRequest, NextResponse } from 'next/server';

/**
 * Poster frame picker.
 *
 * Recordings typically open on a black screen and then a title card before
 * cutting to the speaker, so a small fixed offset (Mux defaults to frame 0)
 * yields an all-black or title-card thumbnail instead of the interviewee.
 *
 * Offsets are therefore derived from the recording's duration, which reliably
 * clears the intro, with a size check as a safety net: a solid-colour JPEG
 * compresses to almost nothing (~600 bytes at probe size) while a real frame is
 * an order of magnitude larger, so encoded size detects a black frame without
 * needing to decode the image. (Size cannot tell a title card from a real frame -
 * both compress similarly - which is why the offset, not the probe, does the
 * real work here.)
 *
 * Redirects to the chosen Mux URL rather than proxying the bytes, so images are
 * still served (and cached) by Mux. Usable directly as an <img src>, including
 * inside list renders where a hook could not be called.
 */

const FALLBACK_TIMES = [60, 120, 240, 30];
const DURATION_FRACTIONS = [0.02, 0.04, 0.08, 0.01];
const DEFAULT_TIME = 60;
const PROBE_WIDTH = 160;
/** A solid-colour frame is ~600 bytes at probe width; require clearly more. */
const MIN_PROBE_BYTES = 2000;
const PROBE_TIMEOUT_MS = 8000;

/**
 * Cache the in-flight promise, not just the result: a single page renders many
 * thumbnails for the same recordings, and without this each one would kick off
 * its own probe before the first finished.
 */
const posterTimeCache = new Map<string, Promise<number>>();

const isValidPlaybackId = (value: string): boolean => /^[A-Za-z0-9]+$/.test(value);

async function probeFrameSize(playbackId: string, time: number): Promise<number> {
  try {
    const response = await fetch(
      `https://image.mux.com/${playbackId}/thumbnail.jpg?time=${time}&width=${PROBE_WIDTH}`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' },
    );

    if (!response.ok) return 0;

    return (await response.arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

function candidateTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return FALLBACK_TIMES;

  // Keep the absolute floors: even a short recording needs to clear the title card.
  return DURATION_FRACTIONS.map((fraction, index) =>
    Math.max(FALLBACK_TIMES[index], Math.floor(duration * fraction)),
  );
}

/**
 * Probe candidates in order and stop at the first frame that has picture in it,
 * so the common case (the duration-derived offset is fine) costs one fetch
 * rather than one per candidate.
 */
async function probeForPosterTime(playbackId: string, duration: number): Promise<number> {
  const candidates = candidateTimes(duration);
  let best = { time: candidates[0] ?? DEFAULT_TIME, size: -1 };

  for (const time of candidates) {
    const size = await probeFrameSize(playbackId, time);
    if (size >= MIN_PROBE_BYTES) return time;
    if (size > best.size) best = { time, size };
  }

  // Every candidate looked blank (or every probe failed); use the least-blank one.
  return best.time;
}

function pickPosterTime(playbackId: string, duration: number): Promise<number> {
  const cacheKey = `${playbackId}:${Math.floor(duration)}`;
  const cached = posterTimeCache.get(cacheKey);
  if (cached) return cached;

  const pending = probeForPosterTime(playbackId, duration).catch(() => DEFAULT_TIME);
  posterTimeCache.set(cacheKey, pending);
  return pending;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const playbackId = searchParams.get('playbackId')?.trim() ?? '';

  if (!playbackId || !isValidPlaybackId(playbackId)) {
    return NextResponse.json({ error: 'A valid playbackId is required' }, { status: 400 });
  }

  const kind = searchParams.get('kind') === 'gif' ? 'gif' : 'image';
  const width = searchParams.get('width') ?? '320';
  const height = searchParams.get('height');
  const fitMode = searchParams.get('fit_mode') ?? 'crop';

  // An explicit time means the caller wants a specific moment (e.g. a citation),
  // so skip probing and honour it.
  const requestedTime = searchParams.get('time');
  const duration = Number(searchParams.get('duration') ?? '');
  const time =
    requestedTime != null && requestedTime !== '' && Number.isFinite(Number(requestedTime))
      ? Math.max(0, Math.floor(Number(requestedTime)))
      : await pickPosterTime(playbackId, duration);

  const params = new URLSearchParams({ width, fit_mode: fitMode });
  if (height) params.set('height', height);

  if (kind === 'gif') {
    params.set('start', String(time));
    params.set('end', String(time + 2));
    params.set('fps', '10');
  } else {
    params.set('time', String(time));
  }

  const target =
    kind === 'gif'
      ? `https://image.mux.com/${playbackId}/animated.gif?${params}`
      : `https://image.mux.com/${playbackId}/thumbnail.jpg?${params}`;

  return NextResponse.redirect(target, {
    status: 302,
    headers: {
      // The chosen frame is stable for a given recording, so let clients keep it.
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
