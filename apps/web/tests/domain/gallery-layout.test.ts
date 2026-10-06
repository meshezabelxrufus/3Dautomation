import { describe, expect, it } from "vitest";
import { galleryLayout } from "@/components/studio/concept-gallery";

describe("concept gallery layout (2–5 concepts)", () => {
  it("pairs for 2 and 4, three columns for 3", () => {
    expect(galleryLayout(2).grid).toBe("sm:grid-cols-2");
    expect(galleryLayout(4).grid).toBe("sm:grid-cols-2");
    expect(galleryLayout(3).grid).toContain("xl:grid-cols-3");
  });

  it("five is a row of three over a row of two wider cards (no empty slot)", () => {
    const l = galleryLayout(5);
    expect(l.grid).toContain("xl:grid-cols-6");
    const spans = [0, 1, 2, 3, 4].map((i) => Number(l.item(i).match(/col-span-(\d)/)?.[1]));
    expect(spans).toEqual([2, 2, 2, 3, 3]);
    expect(spans.slice(0, 3).reduce((a, b) => a + b)).toBe(6);
    expect(spans.slice(3).reduce((a, b) => a + b)).toBe(6);
  });
});
