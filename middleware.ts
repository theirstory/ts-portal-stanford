import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Skip if on gatekeeper page, API routes, or static files
  if (
    pathname.startsWith('/gatekeeper') ||
    pathname.startsWith('/api/auth') ||
    // Portal Publisher's "sync now" ping; the portal-sync service verifies its HMAC signature.
    pathname === '/api/portal-sync' ||
    pathname.includes('.') || // matches images, fonts, etc.
    pathname.startsWith('/_next')
  ) {
    return NextResponse.next();
  }

  // 2. Check for site password requirement in env
  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) {
    return NextResponse.next();
  }

  // 3. Check for auth cookie
  const authCookie = request.cookies.get('ts_site_access');
  if (authCookie?.value === sitePassword) {
    return NextResponse.next();
  }

  // 4. API routes get a 401 rather than an HTML redirect
  if (pathname.startsWith('/api')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 5. Redirect to gatekeeper if not authenticated
  const url = request.nextUrl.clone();
  url.pathname = '/gatekeeper';
  // Store the original path to redirect back after login
  url.searchParams.set('callbackUrl', pathname);

  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
