import { describe, expect, it } from "vitest";
import mapCss from "./map.css?raw";
import { MAP_EMPTY, RAMPS, STATIONS_FULL, mapRamp, type RampKey } from "./mapRamp";

const KEYS = Object.keys(RAMPS) as RampKey[];

const hsl = (c: string) => {
  const m = /^hsl\((-?[\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(c);
  if (!m) throw new Error(`not an hsl(): ${c}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
};

describe("mapRamp", () => {
  // The whole point of one owner: a layer added with its own brightness span fails here. Without it, the same
  // reading looks stronger on one layer than another and no legend can be shared.
  it("gives every ramp the same saturation and lightness span", () => {
    const floors = KEYS.map((k) => hsl(mapRamp(k, 0)));
    const tops = KEYS.map((k) => hsl(mapRamp(k, 1)));
    for (const f of floors) {
      expect(f.s).toBe(floors[0].s);
      expect(f.l).toBe(floors[0].l);
    }
    for (const t of tops) {
      expect(t.s).toBe(tops[0].s);
      expect(t.l).toBe(tops[0].l);
    }
    expect(tops[0].l).toBeGreaterThan(floors[0].l);
  });

  it("distinguishes layers by hue alone", () => {
    const hues = KEYS.map((k) => hsl(mapRamp(k, 0)).h);
    expect(new Set(hues).size).toBe(hues.length);
  });

  it("rotates a ranged hue in the declared direction and holds a fixed one still", () => {
    expect(hsl(mapRamp("item", 0.0001)).h).toBeGreaterThan(hsl(mapRamp("item", 1)).h);   // amber -> red
    expect(hsl(mapRamp("level", 0)).h).toBeGreaterThan(hsl(mapRamp("level", 1)).h);      // green -> red
    expect(hsl(mapRamp("recency", 0)).h).toBe(hsl(mapRamp("recency", 1)).h);
  });

  it("rises monotonically with t on every ramp", () => {
    for (const k of KEYS) {
      let prev = -1;
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const l = hsl(mapRamp(k, t)).l;
        expect(l).toBeGreaterThanOrEqual(prev);
        prev = l;
      }
    }
  });

  it("clamps out-of-range t instead of running off the span", () => {
    for (const k of KEYS) {
      expect(mapRamp(k, 4)).toBe(mapRamp(k, 1));
      expect(mapRamp(k, -1)).toBe(mapRamp(k, 0));
    }
  });

  it("falls back to the empty colour on a non-finite reading", () => {
    expect(mapRamp("materials", NaN)).toBe(MAP_EMPTY);
    expect(mapRamp("materials", Infinity)).toBe(MAP_EMPTY);
  });

  // A ramp's floor is a READING (the smallest holding, the longest-ago visit); "nothing here" is not. They
  // must not paint the same, or a system you have never seen looks like one you emptied.
  it("keeps the dimmest step distinct from the empty colour", () => {
    for (const k of KEYS) expect(mapRamp(k, 0)).not.toBe(MAP_EMPTY);
  });

  it("resolves the empty colour through a token, so a design can move it", () => {
    expect(MAP_EMPTY).toBe("var(--map-empty)");
  });

  // sqrt on the item ramp: the point is that a modest stash beside a huge one is still legible, so a quarter
  // of the maximum has to sit ABOVE the halfway brightness, not below it.
  it("curves item heat so one huge stash does not flatten the rest", () => {
    const linear = hsl(mapRamp("materials", 0.25)).l;
    expect(hsl(mapRamp("item", 0.25)).l).toBeGreaterThan(linear);
    // and the curve only lifts the middle — it must not move either end
    expect(hsl(mapRamp("item", 0)).l).toBe(hsl(mapRamp("materials", 0)).l);
    expect(hsl(mapRamp("item", 1)).l).toBe(hsl(mapRamp("materials", 1)).l);
  });

  it("tops the station ramp out, so a fifth dock reads like the fourth", () => {
    expect(mapRamp("stations", 5 / STATIONS_FULL)).toBe(mapRamp("stations", 1));
  });
});

// These two guard the map's STYLESHEET, because neither defect is visible to a rendering test: jsdom never
// sees the Vite-processed CSS, so a cascade fault and an untokenised colour both pass every mount test.
describe("map.css", () => {
  it("holds no raw colour — every one is a token a design can override", () => {
    const hex = mapCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
  });

  // `.map-node circle` out-specifies `.map-you-ring` (0,1,1 beats 0,1,0), and `.map-node.here circle` beats
  // both — so a leftover node rule silently repaints the reticle that owns those circles.
  it("has no descendant selector that can restroke a node's inner shapes", () => {
    const bad = (mapCss.match(/^\s*\.map-node[^{]*\b(circle|polygon|rect|line)\b[^{]*\{[^}]*\}/gm) ?? [])
      .filter((r: string) => /\bstroke(-width)?\s*:/.test(r));
    expect(bad).toEqual([]);
  });
});
