import { NextResponse, type NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER } from '@/lib/return-path';

/**
 * Passes the requested path to the page, so that someone sent to sign in can
 * be brought back to it afterwards (src/server/auth/session.ts). Nothing else:
 * whether the request is signed in is decided by the page, not here.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // App pages only: not the API, the public website and its sample workflow, the subcontractor portal, sign-in pages or static files.
  matcher: ['/((?!api/|_next/|landing/|portal/|sample|pdfjs/|login|signup|forgot-password|reset-password|invite|favicon\\.ico|icon\\.png|apple-icon\\.png).+)'],
};
