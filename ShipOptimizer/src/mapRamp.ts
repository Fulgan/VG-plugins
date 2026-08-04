// Every colour ramp the galaxy map paints a system with, in one place.
//
// A ramp declares HUE and a curve. The saturation and lightness spans are SHARED by all of them, which is
// what makes an intensity comparable across layers: the same `t` reads as the same brightness whether the map
// is showing materials or recency, so one legend covers every layer. A ramp written at its call site owns
// none of that, and each one that appeared invented its own hue AND its own span.
//
// Not here, deliberately: the faction/territory colour. That comes from the payload (`conquestColor`) and is
// the colour the game itself paints territory with — data, not palette.

export type RampKey = "item" | "materials" | "level" | "recency" | "stations";

/** "No reading here" — one colour for every layer's zero, and a token so a design can move it. */
export const MAP_EMPTY = "var(--map-empty)";

/** Station count at which the ramp tops out; past this, one more dock says nothing about the system. */
export const STATIONS_FULL = 4;

/** Shared across every ramp, so intensity means one thing map-wide. */
const SAT: readonly [number, number] = [30, 85];
const LIGHT: readonly [number, number] = [18, 58];

interface Ramp {
  /** One hue holds still; a pair rotates from the first to the second as `t` rises. */
  hue: number | readonly [number, number];
  /** Reshapes `t` before it hits the span. Absent = linear. */
  curve?: (t: number) => number;
}

export const RAMPS: Readonly<Record<RampKey, Ramp>> = {
  // sqrt: one huge stash would otherwise flatten every smaller one to the floor
  item: { hue: [28, 0], curve: Math.sqrt },
  materials: { hue: 45 },
  // green where you can go, red where you cannot yet
  level: { hue: [140, 0] },
  recency: { hue: 200 },
  stations: { hue: 265 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Colour for a reading at `t` (0 = the ramp's dimmest step, 1 = its brightest). `t` is clamped, so a caller
 * may divide by its own scale without guarding the top. A caller with NO reading returns `MAP_EMPTY` itself —
 * the dimmest step of a ramp is still a reading, and the two must not paint the same.
 */
export function mapRamp(key: RampKey, t: number): string {
  if (!Number.isFinite(t)) return MAP_EMPTY;
  const r = RAMPS[key];
  const u = Math.min(1, Math.max(0, r.curve ? r.curve(Math.min(1, Math.max(0, t))) : t));
  const hue = typeof r.hue === "number" ? r.hue : lerp(r.hue[0], r.hue[1], u);
  return `hsl(${Math.round(hue)} ${Math.round(lerp(SAT[0], SAT[1], u))}% ${Math.round(lerp(LIGHT[0], LIGHT[1], u))}%)`;
}
