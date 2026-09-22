import { NextResponse } from 'next/server';
import { getEntityAggregates } from '@/lib/weaviate/entities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Collection-wide named entity index.
 *
 * The aggregate requires a full scan of the chunk set, so it is computed once
 * and held briefly: the browse page filters and pages client-side against a
 * single response rather than re-scanning per keystroke.
 */
const CACHE_TTL_MS = 5 * 60_000;

type Cached = { value: Awaited<ReturnType<typeof getEntityAggregates>>; expiresAt: number };
let cached: Cached | null = null;

export async function GET() {
  try {
    if (!cached || cached.expiresAt <= Date.now()) {
      cached = { value: await getEntityAggregates(), expiresAt: Date.now() + CACHE_TTL_MS };
    }

    return NextResponse.json(cached.value, {
      headers: { 'cache-control': 'private, max-age=60' },
    });
  } catch (error) {
    console.error('Entities API error:', error);
    return NextResponse.json({ error: 'Failed to build the entity index' }, { status: 500 });
  }
}
