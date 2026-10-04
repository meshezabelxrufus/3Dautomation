import { describe, expect, it } from "vitest";
import { dayNumber, QUOTES, quoteOfTheDay } from "@/lib/quotes";

describe("quote of the day", () => {
  it("is the same all day (UTC) and changes the next day", () => {
    const morning = quoteOfTheDay(new Date("2026-10-04T00:05:00Z"));
    const night = quoteOfTheDay(new Date("2026-10-04T23:55:00Z"));
    const tomorrow = quoteOfTheDay(new Date("2026-10-05T00:05:00Z"));
    expect(night).toEqual(morning);
    expect(tomorrow).not.toEqual(morning);
  });

  it("shows every quote once before repeating", () => {
    const start = dayNumber(new Date("2026-01-01T12:00:00Z"));
    const seen = new Set<string>();
    for (let d = 0; d < QUOTES.length; d++) {
      seen.add(quoteOfTheDay(new Date((start + d) * 86_400_000 + 43_200_000)).text);
    }
    expect(seen.size).toBe(QUOTES.length);
  });

  it("every quote has text and an author", () => {
    for (const q of QUOTES) {
      expect(q.text.trim().length).toBeGreaterThan(5);
      expect(q.author.trim().length).toBeGreaterThan(2);
    }
  });
});
