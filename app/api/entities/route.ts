import { createHash } from 'node:crypto';
import { getDataVersion } from '@/lib/data-version';
import { ifNoneMatch, makeEtag, notModified } from '@/lib/http-cache';
import { getEntityAggregates } from '@/lib/weaviate/entities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Collection-wide named entity index.
 *
 * The aggregate requires a full scan of the chunk set, so it is computed once
 * and held in memory: the browse page filters and pages client-side against a
 * single response rather than re-scanning per keystroke.
 *
 * The cache is keyed on the portal data version, which portal-sync bumps after
 * every run that changed Weaviate, so a sync shows up within seconds. The TTL
 * is only a backstop for changes made outside portal-sync (a manual
 * `weaviate:import`, say). Browsers revalidate every time (`no-cache`) and get
 * a 304 while nothing changed. The ETag also hashes the body, so a TTL rebuild
 * that produces the same index still answers 304.
 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_CONTROL = 'private, no-cache';

type Entry = { version: string; expiresAt: number; etag: string; body: string };
type EntityCache = { entry: Entry | null; pending: { version: string; promise: Promise<Entry> } | null };

// One cache per server process, even if the route module is instantiated more than once.
const store = globalThis as typeof globalThis & { __entityIndexCache?: EntityCache };
const cache: EntityCache = (store.__entityIndexCache ??= { entry: null, pending: null });

const isFresh = (entry: Entry | null, version: string): entry is Entry =>
  Boolean(entry && entry.version === version && entry.expiresAt > Date.now());

async function build(version: string): Promise<Entry> {
  const body = JSON.stringify(await getEntityAggregates());
  const digest = createHash('sha1').update(body).digest('base64url');
  return { version, expiresAt: Date.now() + CACHE_TTL_MS, etag: makeEtag('entities', version, digest), body };
}

/** The entry for `version`, rebuilt when stale; concurrent requests share one rebuild. */
function current(version: string): Promise<Entry> {
  if (isFresh(cache.entry, version)) return Promise.resolve(cache.entry);

  if (!cache.pending || cache.pending.version !== version) {
    const pending = { version, promise: build(version) };
    cache.pending = pending;
    pending.promise
      .then(
        (entry) => {
          // A build for an older version must not overwrite a newer one.
          if (cache.pending === pending) cache.entry = entry;
        },
        () => {},
      )
      .finally(() => {
        if (cache.pending === pending) cache.pending = null;
      });
  }
  return cache.pending.promise;
}

export async function GET(request: Request) {
  try {
    const version = getDataVersion();

    // Warm and current: answer a matching revalidation without touching Weaviate.
    if (isFresh(cache.entry, version) && ifNoneMatch(request, cache.entry.etag)) {
      return notModified(cache.entry.etag, CACHE_CONTROL);
    }

    const entry = await current(version);
    if (ifNoneMatch(request, entry.etag)) return notModified(entry.etag, CACHE_CONTROL);

    return new Response(entry.body, {
      headers: { 'content-type': 'application/json', 'cache-control': CACHE_CONTROL, etag: entry.etag },
    });
  } catch (error) {
    console.error('Entities API error:', error);
    return Response.json({ error: 'Failed to build the entity index' }, { status: 500 });
  }
}
