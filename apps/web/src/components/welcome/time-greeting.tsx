"use client";

import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  const t = setInterval(cb, 60_000);
  return () => clearInterval(t);
};
// Minute resolution keeps the snapshot stable between renders.
const getSnapshot = () => Math.floor(Date.now() / 60_000);
const getServerSnapshot = () => null;

function partOfDay(hour: number) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Local time of day and date. Rendered after hydration (the server can't know the user's clock). */
export function useLocalMoment() {
  const minute = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (minute === null) return null;
  const now = new Date(minute * 60_000);
  return {
    greeting: partOfDay(now.getHours()),
    date: now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
  };
}

export function TimeGreeting({ className }: { className?: string }) {
  const moment = useLocalMoment();
  return (
    <p className={className} aria-live="off">
      {moment ? (
        <>
          <span className="text-white/90">{moment.greeting}</span>
          <span className="mx-2 text-white/30">·</span>
          <span>{moment.date}</span>
        </>
      ) : (
        " "
      )}
    </p>
  );
}
