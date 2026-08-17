// Every colour ramp the galaxy map paints a system with, in one place.
//
// A ramp declares HUE and a curve. The saturation and BRIGHTNESS spans are SHARED by all of them, which is
// what makes an intensity comparable across layers: the same `t` reads as the same brightness whether the map
// is showing materials or recency, so one legend covers every layer. A ramp written at its call site owns
// none of that, and each one that appeared invented its own hue AND its own span.
//
// Not here, deliberately: the faction/territory colour. That comes from the payload (`conquestColor`) and is
// the colour the game itself paints territory with — data, not palette.

export type RampKey = "item" | "materials" | "level" | "recency" | "stations" | "umbral";

/** "No reading here" — one colour for every layer's zero, and a token so a design can move it. */
export const MAP_EMPTY = "var(--map-empty)";

/** Station count at which the ramp tops out; past this, one more dock says nothing about the system. */
export const STATIONS_FULL = 4;

/** Shared across every ramp, so intensity means one thing map-wide. */
// The map is READ, not looked at: a galaxy of 377 fully saturated nodes competes with the shapes, the labels and
// the routes drawn over it. So the tones are toned DOWN — but only as far as a hue stays nameable, because the
// fill is the layer's whole answer and a wash pale enough to be restful is also pale enough that two readings
// (or two factions) look alike. Order carries the meaning (dimmer = less), hue carries which layer.
//
// The BRIGHTNESS span is stated as relative luminance, ⊥ as HSL lightness, because those are not the same
// thing: `hsl(45 40% 37%)` (yellow) and `hsl(265 40% 37%)` (violet) share a lightness and differ in luminance by
// a factor of three. A lightness span therefore makes one hue glare while another sinks into the backdrop — which
// is what "the blues are unreadable, the red barely so" was: not a bad hue, a span measured in the wrong unit.
// Every ramp step is solved back to the lightness that hits its target luminance, so `t` reads the same on every
// layer and the level digit's contrast is bounded for all of them at once.
//
// The ceiling is set by that digit. `ink` picks whichever of two inks contrasts better, and a two-ink choice is
// WEAKEST in the middle (~4.3:1 near luminance 0.22, whatever the pair) — so the top of the span stays well under
// it: every ramp fill takes the light ink with margin, and the dark ink is left for the bright faction colours the
// map does not choose. The floor sits above `--map-empty`'s own luminance, so the dimmest READING stays visibly
// different from "nothing here".
const SAT: readonly [number, number] = [16, 46];
const LUM: readonly [number, number] = [0.035, 0.16];

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
  // The Umbral daily. Its own hue, and deliberately not the level ramp's green→red: this is not a measurement but
  // three named states (unclaimed / waiting / spent), so the ramp carries them apart by BRIGHTNESS at one hue —
  // amber, which the app already uses for the Umbral faction's own colour.
  umbral: { hue: 38 },
};


/** The graph's backdrop and the two digit colours, as numbers — a contrast test needs values, not tokens. */
type RGB = readonly [number, number, number];
const VOID: RGB = [0x0b, 0x0e, 0x14];
const LVL: RGB = [0xf5, 0xf8, 0xfd];

export const INK_DARK = "var(--map-void)";
export const INK_LIGHT = "var(--map-lvl)";

const hue2rgb = (p: number, q: number, t: number) => {
  const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
};

function hslRgb(hue: number, sat: number, light: number): RGB {
  const [h, s, l] = [((((hue % 360) + 360) % 360) / 360) % 1, sat / 100, light / 100];
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

/**
 * The rgb behind a CSS colour this module or the payload produced: `#rgb`, `#rrggbb`, `rgb()` or the `hsl()` the
 * ramps emit. A `var()` or a name yields null — the caller cannot resolve a token without the document, and
 * guessing a value for one is how a contrast test comes out confident and wrong.
 */
export function parseColor(c: string): RGB | null {
  const s = c.trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const wide = h.length >= 6;
    if (h.length !== 3 && h.length !== 6) return null;
    const at = (i: number) => (wide ? h.slice(i * 2, i * 2 + 2) : h[i] + h[i]);
    const v = [0, 1, 2].map((i) => parseInt(at(i), 16));
    return v.some(Number.isNaN) ? null : [v[0], v[1], v[2]];
  }
  const nums = s.startsWith("rgb(") || s.startsWith("hsl(")
    ? (s.slice(4).match(/-?[\d.]+/g) ?? []).map(Number)
    : null;
  if (!nums || nums.length < 3) return null;
  if (s.startsWith("rgb(")) return [nums[0], nums[1], nums[2]];
  return hslRgb(nums[0], nums[1], nums[2]);
}

const channel = (v: number) => {
  const u = Math.min(255, Math.max(0, v)) / 255;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance — how BRIGHT a colour actually is, which HSL lightness only approximates per hue. */
export const luminance = (c: RGB) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);

/** WCAG contrast between two colours, ≥1. Used to CHOOSE, so only the ordering of two ratios matters. */
export function contrast(a: RGB, b: RGB): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Which digit colour to put ON `fill` — whichever of the two contrasts with it more.
 *
 * The alternative, one fixed digit colour, forces the fills to stay inside whatever range that colour survives:
 * dark digits need pale fills, light digits need dark ones, and a map that must paint one ramp per layer plus
 * every faction's own colour cannot hold to either. Measuring per fill lets the palette be chosen for the map
 * and still guarantees the number is readable on any of it.
 *
 * A fill this cannot resolve (a `var()` token, e.g. `MAP_EMPTY`) gets the LIGHT ink: every unresolvable colour
 * the map uses is one of its dark surface tokens.
 */
export function ink(fill: string): string {
  const rgb = parseColor(fill);
  if (!rgb) return INK_LIGHT;
  return contrast(rgb, VOID) >= contrast(rgb, LVL) ? INK_DARK : INK_LIGHT;
}

/**
 * `color` laid over the graph's backdrop at `frac` strength — a hint of it, resolved to `rgb()` so `ink` can
 * measure the result. For a node that carries a colour without being filled by it: an unvisited system's outline
 * says which layer reading it has, and a bare backdrop inside that outline leaves its level digit floating on
 * the graph itself, which is the one place a number cannot be read.
 */
export const faint = (color: string, frac: number): string => {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const mix = rgb.map((v, i) => Math.round(VOID[i] + (v - VOID[i]) * frac));
  return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
};

/** rgb → hsl, for a colour whose HUE is worth keeping and whose brightness is not. */
function rgbHsl(c: RGB): { h: number; s: number; l: number } {
  const [r, g, b] = c.map((v) => Math.min(255, Math.max(0, v)) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

/**
 * The game's colour for a faction, made fit to paint a whole node with.
 *
 * HUE is kept exactly, because that is what a player recognises a faction by, and identity is the entire point of
 * the ownership layer. Everything else is normalised, because the game's own values are picked for a different
 * surface and two of them are unusable as a fill: `#ff0400` and `#0004ff` are fully saturated primaries, the blue
 * dark enough that a digit on it cannot be read and the red loud enough to own the screen.
 *
 * So: saturation is CAPPED (never raised — a faction the game painted grey stays grey, which is also identity),
 * and brightness is set to one target for every faction. Uniform brightness is what makes the set comparable —
 * no faction reads as more important than another because its hue happens to be a bright one — and it puts every
 * fill in the band where `ink` has margin on both counts.
 */
const FACTION_SAT_CAP = 62;
const FACTION_LUM = 0.3;
export const factionFill = (color: string, lum = FACTION_LUM): string => {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const { h, s } = rgbHsl(rgb);
  const hue = Math.round(h), sat = Math.round(Math.min(s, FACTION_SAT_CAP));
  return `hsl(${hue} ${sat}% ${lightnessFor(hue, sat, lum).toFixed(2)}%)`;
};

/**
 * Fills for the WHOLE faction table at once, because "can I tell these two apart" is a property of the set and
 * not of any one colour.
 *
 * Uniform brightness is what makes the layer readable, and it is also what collapses two factions the game
 * distinguished by brightness alone: `#ffa830` and `#d4870a` are four degrees of hue apart, and normalising them
 * both to one brightness makes them the same fill. So factions are grouped by ADJACENT HUE, and a group of more
 * than one is spread across a brightness band instead — hue is preserved exactly (it is the stronger cue and the
 * one a player names a faction by), and the pair that shares a hue gets told apart the way the game told it apart.
 *
 * Greys land in one group by construction (no hue to separate them), which is correct: brightness is the only
 * thing that can distinguish two grey factions.
 */
const HUE_MIN = 14;
const LUM_BAND: readonly [number, number] = [0.2, 0.42];
export function factionPalette(list: readonly { id: string; color: string }[]): Map<string, string> {
  const rows = list
    .map((f) => ({ id: f.id, color: f.color, rgb: parseColor(f.color) }))
    .filter((r): r is { id: string; color: string; rgb: RGB } => r.rgb != null)
    .map((r) => ({ ...r, ...rgbHsl(r.rgb) }))
    .sort((a, b) => a.h - b.h || a.l - b.l);

  // Groups of hue-adjacent factions, walking the sorted list.
  const groups: (typeof rows)[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && r.h - last[last.length - 1].h < HUE_MIN) last.push(r);
    else groups.push([r]);
  }
  // The 0/360 seam is crowded, not empty: the game ships hue 352 and hue 1 as two different factions. So the last
  // group joins the first when they are adjacent ACROSS it, ordered dimmest-hue-last so the merged group still
  // walks the hue circle in one direction.
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length - 1];
    if (360 - last[last.length - 1].h + first[0].h < HUE_MIN) {
      groups[0] = [...last, ...first];
      groups.pop();
    }
  }

  const out = new Map<string, string>();
  for (const group of groups)
    group.forEach((r, i) => {
      // Dimmest first, so the order a group is spread in is stable across payloads rather than incidental.
      const lum = group.length === 1
        ? FACTION_LUM
        : LUM_BAND[0] + ((LUM_BAND[1] - LUM_BAND[0]) * i) / (group.length - 1);
      out.set(r.id, factionFill(r.color, lum));
    });
  return out;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The HSL lightness at which `hue`/`sat` reaches `target` luminance. Bisection: luminance rises monotonically
 * with lightness at fixed hue and saturation, and there is no closed form through the sRGB transfer curve.
 * A target above what the hue can reach saturates at 100 rather than failing — the ramp's top is far below that.
 */
function lightnessFor(hue: number, sat: number, target: number): number {
  let lo = 0, hi = 100;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(hslRgb(hue, sat, mid)) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Colour for a reading at `t` (0 = the ramp's dimmest step, 1 = its brightest). `t` is clamped, so a caller
 * may divide by its own scale without guarding the top. A caller with NO reading returns `MAP_EMPTY` itself —
 * the dimmest step of a ramp is still a reading, and the two must not paint the same.
 */
export function mapRamp(key: RampKey, t: number): string {
  if (!Number.isFinite(t)) return MAP_EMPTY;
  const r = RAMPS[key];
  const u = Math.min(1, Math.max(0, r.curve ? r.curve(Math.min(1, Math.max(0, t))) : t));
  const hue = Math.round(typeof r.hue === "number" ? r.hue : lerp(r.hue[0], r.hue[1], u));
  const sat = Math.round(lerp(SAT[0], SAT[1], u));
  const light = lightnessFor(hue, sat, lerp(LUM[0], LUM[1], u));
  return `hsl(${hue} ${sat}% ${light.toFixed(2)}%)`;
}
