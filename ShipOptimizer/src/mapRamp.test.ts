import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INK_DARK, INK_LIGHT, MAP_EMPTY, RAMPS, STATIONS_FULL, contrast, factionFill, factionPalette, faint, ink,
  luminance, mapRamp, parseColor, type RampKey,
} from "./mapRamp";

const KEYS = Object.keys(RAMPS) as RampKey[];

// Read off DISK, ⊥ imported as `./map.css?raw`: this project's vitest resolves a css import to an EMPTY string,
// so every assertion made against one holds trivially. A guard that cannot fail is worse than no guard — it
// reports the surface as covered.
const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const mapCss = css("./map.css");
const tokensCss = css("./designs/tokens.css");

it("reads the stylesheets it asserts against", () => {
  expect(mapCss.length).toBeGreaterThan(1000);
  expect(tokensCss.length).toBeGreaterThan(1000);
});

const hsl = (c: string) => {
  const m = /^hsl\((-?[\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(c);
  if (!m) throw new Error(`not an hsl(): ${c}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
};

const lum = (c: string) => luminance(parseColor(c)!);

/** Hue of a colour, computed here rather than taken from the module, so a hue test measures the transform. */
const rgbHue = (color: string): number | null => {
  const [r, g, b] = parseColor(color)!.map((v) => v / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d === 0) return null;                       // grey has no hue to preserve
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};

describe("mapRamp", () => {
  // The whole point of one owner: a layer added with its own brightness span fails here. Without it, the same
  // reading looks stronger on one layer than another and no legend can be shared.
  //
  // Matched in LUMINANCE, ⊥ in HSL lightness. Those differ by a factor of three between yellow and violet at one
  // lightness, so equal lightness across ramps is equal on paper and plainly unequal on screen — the ramps whose
  // hue is dark then read as unlit and their digits stop being legible.
  it("gives every ramp the same saturation and brightness span", () => {
    const floors = KEYS.map((k) => mapRamp(k, 0));
    const tops = KEYS.map((k) => mapRamp(k, 1));
    for (const f of floors) {
      expect(hsl(f).s).toBe(hsl(floors[0]).s);
      expect(lum(f)).toBeCloseTo(lum(floors[0]), 3);
    }
    for (const t of tops) {
      expect(hsl(t).s).toBe(hsl(tops[0]).s);
      expect(lum(t)).toBeCloseTo(lum(tops[0]), 3);
    }
    expect(lum(tops[0])).toBeGreaterThan(lum(floors[0]));
  });

  // The same fact from the other side: matched brightness means the LIGHTNESS numbers must differ per hue. A ramp
  // set that agrees on lightness is the defect this replaced.
  it("moves lightness per hue to hold brightness level", () => {
    const lights = new Set(KEYS.map((k) => hsl(mapRamp(k, 1)).l));
    expect(lights.size).toBeGreaterThan(1);
  });

  // Every layer's zero is `--map-empty`; a ramp's FLOOR is the smallest real reading, and it has to look like
  // more than nothing or the two facts read alike on the node.
  it("keeps the dimmest reading brighter than the empty colour", () => {
    expect(lum(mapRamp("materials", 0))).toBeGreaterThan(luminance(parseColor("#23252c")!));
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
        const l = lum(mapRamp(k, t));
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
    expect(lum(mapRamp("item", 0.25))).toBeGreaterThan(lum(mapRamp("materials", 0.25)));
    // and the curve only lifts the middle — it must not move either end
    expect(lum(mapRamp("item", 0))).toBeCloseTo(lum(mapRamp("materials", 0)), 3);
    expect(lum(mapRamp("item", 1))).toBeCloseTo(lum(mapRamp("materials", 1)), 3);
  });

  it("tops the station ramp out, so a fifth dock reads like the fourth", () => {
    expect(mapRamp("stations", 5 / STATIONS_FULL)).toBe(mapRamp("stations", 1));
  });
});

// The digit on a node is the one number the map states without a hover, so it is readable on EVERY colour the map
// can paint under it — including the game's faction colours, which the palette does not choose. That is what makes
// the ramps free to be picked for the map: the previous span was set by what dark text survived and went pale.
describe("ink", () => {
  // Taken from the STYLESHEET, not repeated here: `ink` decides by comparing against its own copy of these two
  // values, and a copy that drifts from the token makes it choose the ink that reads worse — silently, because
  // both inks always render.
  const token = (name: string) => {
    const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{3,8})`, "i").exec(tokensCss);
    if (!m) throw new Error(`no --${name} token`);
    return parseColor(m[1])!;
  };
  const RGB = { void: token("map-void"), lvl: token("map-lvl") };
  const chosen = (fill: string) => (ink(fill) === INK_DARK ? RGB.void : RGB.lvl);

  it("agrees with the tokens it is choosing between", () => {
    // A fill just off each ink must pick the OTHER one; wrong values here flip these two.
    expect(ink(`rgb(${RGB.lvl.join(" ")})`)).toBe(INK_DARK);
    expect(ink(`rgb(${RGB.void.join(" ")})`)).toBe(INK_LIGHT);
  });

  it("keeps the level digit at 4.5:1 across every step of every ramp", () => {
    for (const k of Object.keys(RAMPS) as RampKey[])
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const fill = mapRamp(k, t);
        expect(contrast(parseColor(fill)!, chosen(fill)),
          `${k} at t=${t.toFixed(2)} (${fill})`).toBeGreaterThanOrEqual(4.5);
      }
  });

  // Faction colours arrive from the payload and can be any lightness the game ships — including the middle band
  // where a two-ink choice is at its weakest (~4.3:1 whichever is picked, for ANY pair of inks). The ramps keep
  // clear of that band by construction; these cannot, so the floor here is what the choice can actually promise.
  // It is a floor, not a target: the failure this replaced measured 1.4:1.
  it("keeps it readable on a dimmed faction colour, whatever hue", () => {
    for (let h = 0; h < 360; h += 15)
      for (const l of [22, 40, 58, 76]) {
        const fill = factionFill(`hsl(${h} 70% ${l}%)`);
        expect(contrast(parseColor(fill)!, chosen(fill)), fill).toBeGreaterThanOrEqual(4.2);
      }
  });

  // The one thing the ink choice must never do: pick the ink that contrasts LESS.
  it("always takes the better of the two inks", () => {
    for (let h = 0; h < 360; h += 30)
      for (const l of [8, 20, 35, 50, 65, 85, 98]) {
        const fill = `hsl(${h} 55% ${l}%)`;
        const rgb = parseColor(fill)!;
        const other = ink(fill) === INK_DARK ? RGB.lvl : RGB.void;
        expect(contrast(rgb, chosen(fill)), fill).toBeGreaterThanOrEqual(contrast(rgb, other));
      }
  });

  it("takes the light ink when the fill is a token it cannot resolve", () => {
    expect(ink(MAP_EMPTY)).toBe(INK_LIGHT);
    expect(ink("rebeccapurple")).toBe(INK_LIGHT);
  });

  it("reads the colour forms the map actually produces", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#0b0e14")).toEqual([11, 14, 20]);
    expect(parseColor("rgb(1 2 3)")).toEqual([1, 2, 3]);
    expect(parseColor("hsl(0 100% 50%)")!.map(Math.round)).toEqual([255, 0, 0]);
    expect(parseColor("hsl(210 0% 40%)")!.map(Math.round)).toEqual([102, 102, 102]);
    expect(parseColor("var(--map-empty)")).toBeNull();
  });
});

// The ownership layer is the only one whose colours the map does not choose. Normalising them must not cost the
// thing the layer exists for — telling one faction from another at a glance.
describe("factionFill", () => {
  // The game's actual values, which is where the problem is: two are fully saturated primaries.
  const GAME = ["#ffc61e", "#ff0400", "#0004ff", "#3fad1d", "#00aabb", "#ffa830", "#5599cc", "#d4870a",
    "#8a7060", "#689900", "#a09060", "#6a6a6a", "#aa2244", "#440088", "#af0017", "#7f00ce", "#44aaaa"];

  it("keeps each faction's hue exactly — that is what a player recognises", () => {
    for (const c of GAME) {
      const want = rgbHue(c);
      if (want == null) continue;
      expect(rgbHue(factionFill(c)), c).toBeCloseTo(want, 0);
    }
  });

  // Uniform brightness is the point: no faction reads as more important because its hue happens to be a light one,
  // and every fill lands where the digit's ink has margin.
  it("brings every faction to one brightness", () => {
    const lums = GAME.map((c) => lum(factionFill(c)));
    for (const l of lums) expect(l).toBeCloseTo(lums[0], 2);
  });

  it("caps saturation without raising it, so a grey faction stays grey", () => {
    expect(hsl(factionFill("#ff0400")).s).toBeLessThanOrEqual(62);
    expect(hsl(factionFill("#6a6a6a")).s).toBeLessThan(10);
  });


  it("returns a form `ink` can measure, so a faction fill is not exempt from the contrast test", () => {
    expect(parseColor(factionFill("#3b6fd4"))).not.toBeNull();
  });

  it("passes an unresolvable colour through untouched rather than inventing one", () => {
    expect(factionFill("var(--map-empty)")).toBe("var(--map-empty)");
  });
});

// One faction's fill is only as good as the SET it sits in: the game hands out `#ffa830` and `#d4870a`, four
// degrees of hue apart and told apart by brightness alone — which uniform brightness destroys.
describe("factionPalette", () => {
  const GAME = ["#ffc61e", "#ff0400", "#0004ff", "#3fad1d", "#00aabb", "#ffa830", "#5599cc", "#d4870a",
    "#8a7060", "#689900", "#a09060", "#6a6a6a", "#aa2244", "#440088", "#af0017", "#7f00ce", "#44aaaa"];
  const table = GAME.map((color, i) => ({ id: `f${i}`, color }));
  const palette = factionPalette(table);

  it("gives every faction a fill", () => {
    expect(palette.size).toBe(table.length);
  });

  it("keeps every pair distinguishable, including the ones the game crowds", () => {
    const rgb = table.map((f) => parseColor(palette.get(f.id)!)!);
    for (let i = 0; i < rgb.length; i++)
      for (let j = i + 1; j < rgb.length; j++) {
        const [a, b] = [rgb[i], rgb[j]];
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
          `${GAME[i]} vs ${GAME[j]}`).toBeGreaterThan(12);
      }
  });

  it("keeps the digit readable on every faction's fill", () => {
    const light = parseColor("#f5f8fd")!, dark = parseColor("#0b0e14")!;
    for (const f of table) {
      const fill = parseColor(palette.get(f.id)!)!;
      expect(Math.max(contrast(fill, light), contrast(fill, dark)), f.color).toBeGreaterThanOrEqual(4.2);
    }
  });

  it("holds hue for every faction it recolours", () => {
    for (const f of table) {
      const before = rgbHue(f.color), after = rgbHue(palette.get(f.id)!);
      if (before == null) continue;
      expect(after, f.color).toBeCloseTo(before, 0);
    }
  });

  it("survives a table with one entry, or none", () => {
    expect(factionPalette([{ id: "a", color: "#ff0400" }]).size).toBe(1);
    expect(factionPalette([]).size).toBe(0);
  });

  it("drops an entry whose colour cannot be read rather than painting it wrong", () => {
    const p = factionPalette([{ id: "a", color: "#ff0400" }, { id: "b", color: "var(--x)" }]);
    expect(p.has("a")).toBe(true);
    expect(p.has("b")).toBe(false);
  });
});

// An unvisited system carries its layer colour on the OUTLINE and is only hinted at inside, but the hint has to be
// something: a digit over the bare backdrop was the unreadable case.
describe("faint", () => {
  it("lands between the backdrop and the colour itself", () => {
    const bg = parseColor("#0b0e14")!;
    const full = parseColor("hsl(200 50% 50%)")!;
    const hint = parseColor(faint("hsl(200 50% 50%)", 0.16))!;
    expect(luminance(hint)).toBeGreaterThan(luminance(bg));
    expect(luminance(hint)).toBeLessThan(luminance(full));
  });

  it("keeps the light ink readable over it", () => {
    for (let h = 0; h < 360; h += 30) {
      const fill = faint(`hsl(${h} 60% 55%)`, 0.16);
      expect(contrast(parseColor(fill)!, parseColor("#f5f8fd")!), fill).toBeGreaterThanOrEqual(7);
    }
  });

  it("passes an unresolvable colour through untouched", () => {
    expect(faint(MAP_EMPTY, 0.2)).toBe(MAP_EMPTY);
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
