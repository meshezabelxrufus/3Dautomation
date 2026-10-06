import { Box, LogOut, Plus } from "lucide-react";
import Link from "next/link";
import { logoutAction } from "@/app/login/actions";
import { ButtonLink } from "@/components/ui/button";
import { cookies } from "next/headers";
import {
  gateConfig,
  SESSION_COOKIE,
  verifySessionToken,
} from "@/lib/server/session";

/** Floating translucent bar: content scrolls underneath (solid when transparency is reduced). */
export async function AppHeader() {
  const gate = gateConfig();
  // With the access gate on, navigation is only shown to a signed-in session (not on the login page).
  const signedIn = gate
    ? verifySessionToken(
        gate.secret,
        (await cookies()).get(SESSION_COOKIE)?.value,
      )
    : true;
  return (
    <header className="material sticky top-0 z-40 border-b border-hairline">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="pressable inline-flex items-center gap-2 rounded-full pr-2 text-ink"
          aria-label="3D Studio home"
        >
          <span className="grid size-7 place-items-center rounded-lg bg-ink text-canvas">
            <Box className="size-4" strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="text-callout font-semibold tracking-[-0.01em]">
            3D Studio
          </span>
        </Link>
        {signedIn ? (
          <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/projects"
              className="pressable rounded-full px-3 py-1.5 text-callout text-ink-2 hover:text-ink"
            >
              Projects
            </Link>
            <ButtonLink
              href="/projects/new"
              size="sm"
              icon={<Plus className="size-3.5" />}
              aria-label="New project"
            >
              <span className="hidden min-[400px]:inline">New project</span>
            </ButtonLink>
            {gate ? (
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="pressable grid size-8 place-items-center rounded-full text-ink-3 hover:bg-sunken/60 hover:text-ink"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="size-4" aria-hidden="true" />
                </button>
              </form>
            ) : null}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
