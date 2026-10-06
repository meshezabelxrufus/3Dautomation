import { NextResponse, type NextRequest } from "next/server";
import { gateConfig, SESSION_COOKIE, verifySessionToken } from "@/lib/server/session";

/**
 * Studio access gate: every page, API route and Server Action needs a valid session cookie when
 * STUDIO_ACCESS_PASSWORD is set. Exempt: /login, /api/health (monitoring) and /api/internal/*
 * (n8n callbacks, protected by their own bearer token).
 */
export function proxy(request: NextRequest) {
  const gate = gateConfig();
  if (!gate) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/health" || pathname.startsWith("/api/internal/")) return NextResponse.next();

  if (!gate.secret || gate.secret.length < 32) {
    return NextResponse.json(
      { error: { code: "misconfigured", message: "Access gate misconfigured: STUDIO_SESSION_SECRET (32+ chars) is required." } },
      { status: 503 },
    );
  }
  if (verifySessionToken(gate.secret, request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/") || request.headers.has("next-action")) {
    return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in required." } }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
