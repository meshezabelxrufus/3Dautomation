"use client";

import { useSyncExternalStore } from "react";

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "minute") {
      return rtf?.format(Math.round(seconds / size), unit) ?? new Date(iso).toLocaleString();
    }
  }
  return "just now";
}

// One shared 30s clock for every RelativeTime on the page.
const TICK_MS = 30_000;
let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    current = Date.now();
    listeners.forEach((l) => l());
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
function getSnapshot() {
  if (Date.now() - current >= TICK_MS) current = Date.now();
  return current;
}
// No clock on the server: render a placeholder and fill in after hydration (no mismatch).
const getServerSnapshot = () => null;

/** "5 minutes ago", kept fresh every 30s. Server and client never disagree. */
export function RelativeTime({ iso, prefix, className }: { iso: string; prefix?: string; className?: string }) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <time dateTime={iso} className={className} title={now ? new Date(iso).toLocaleString() : undefined}>
      {prefix ? `${prefix} ` : null}
      {now ? formatRelative(iso, now) : "\u00a0"}
    </time>
  );
}
