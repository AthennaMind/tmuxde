import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 renamed the `middleware` file convention and named export to
// `proxy`. Behaviour here is unchanged: this only sets security headers. The
// auth guard stays client-side because the credential lives in localStorage /
// IndexedDB, which a server-side proxy can't read.
export function proxy(request: NextRequest) {
  const response = NextResponse.next();

  // Derive relay HTTP origin for CSP (allows <img>, <video>, <audio>, <iframe> to load files).
  // When NEXT_PUBLIC_RELAY_URL is unset (single-port CLI mode), the relay is same-origin
  // and 'self' already covers it.
  const relayWsUrl = process.env.NEXT_PUBLIC_RELAY_URL;
  const relayOrigin = relayWsUrl
    ? ` ${new URL(relayWsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:")).origin}`
    : "";
  const socketOrigin = new URL(request.url).origin.replace(/^http/, "ws");
  const relaySocketOrigin = relayWsUrl ? ` ${new URL(relayWsUrl).origin}` : "";

  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "microphone=(), camera=(), geolocation=()",
  );
  response.headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${socketOrigin}${relaySocketOrigin}${relayOrigin}; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' data: blob:${relayOrigin}; media-src 'self'${relayOrigin}; frame-src 'self'${relayOrigin};`,
  );

  return response;
}

export const config = {
  matcher: [
    // The PWA's static assets are excluded alongside the rest: they carry no
    // app content, and `offline.html` in particular is served by the service
    // worker from cache, where none of these headers apply anyway.
    "/((?!_next/static|_next/image|favicon.ico|icon-|apple-icon.png|manifest.json|offline.html|sw.js).*)",
  ],
};
