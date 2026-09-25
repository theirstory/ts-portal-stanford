/**
 * Server-side ETag helpers for API routes whose output only changes when portal data changes.
 *
 * ETags carry the portal data version (lib/data-version.ts), which portal-sync bumps after every
 * run that changed Weaviate, so a sync invalidates browser copies on their next revalidation.
 */
import { createHash } from 'node:crypto';

/** A strong ETag: `"<prefix>-v<dataVersion>-<hash of parts>"`. */
export function makeEtag(
  prefix: string,
  dataVersion: string,
  ...parts: (string | number | null | undefined)[]
): string {
  const hash = createHash('sha1')
    .update(parts.map((part) => String(part ?? '')).join('\u0000'))
    .digest('base64url')
    .slice(0, 16);
  return `"${prefix}-v${dataVersion}-${hash}"`;
}

/** True when the request's If-None-Match lists `etag` (weak comparison, as RFC 9110 requires for it). */
export function ifNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  const wanted = bare(etag);
  return header.split(',').some((tag) => {
    const candidate = tag.trim();
    return candidate === '*' || bare(candidate) === wanted;
  });
}

/** A 304 carrying the validators and caching headers a 200 would have. */
export function notModified(etag: string, cacheControl: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl, ...extra } });
}
