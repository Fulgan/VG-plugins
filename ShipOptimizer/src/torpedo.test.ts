import { describe, expect, it } from "vitest";
import { bayOf, launchesPerSecond, torpedoDps, torpedoPower, type TorpedoBay } from "./torpedo";
import type { Item } from "./types";

// The two prefabs the game ships, from `/catalog/prefabs` and `the internal notes`.
const MEDIUM: TorpedoBay = { fireDelay: 1, reloadTime: 3, latches: 1 };
const SMALL: TorpedoBay = { fireDelay: 8, reloadTime: 4, latches: 1 };

describe("how often a bay launches", () => {
  it("matches the measured cycle for both prefabs, at one latch and at several", () => {
    // The rules doc's own table: Medium ~7s on one latch and ~5s on two or more, Small ~12s either way. Door
    // animation omitted there and here alike, so these are the same upper bound on both sides.
    expect(1 / launchesPerSecond(MEDIUM)).toBeCloseTo(7, 6);
    expect(1 / launchesPerSecond({ ...MEDIUM, latches: 2 })).toBeCloseTo(5, 6);
    expect(1 / launchesPerSecond({ ...MEDIUM, latches: 8 })).toBeCloseTo(5, 6);
    expect(1 / launchesPerSecond(SMALL)).toBeCloseTo(12, 6);
    expect(1 / launchesPerSecond({ ...SMALL, latches: 4 })).toBeCloseTo(12, 6);
  });

  it("stops speeding up once the launch sequence is the binding constraint", () => {
    // Latches only ever relieve the RELOAD half. Past the point where the sequence itself is slower, another
    // latch buys nothing, which is why `min(1/fireRate, latches/reloadSpeed)` overstated a many-latch hull.
    const one = launchesPerSecond({ ...MEDIUM, latches: 2 });
    for (const latches of [3, 6, 12]) expect(launchesPerSecond({ ...MEDIUM, latches })).toBeCloseTo(one, 9);
  });

  it("treats a hull that reports no latches as having one", () => {
    expect(launchesPerSecond({ ...MEDIUM, latches: 0 })).toBeCloseTo(launchesPerSecond(MEDIUM), 9);
  });
});

describe("what one torpedo carries", () => {
  it("adds ONE turret-share of the combat pool to the whole torpedo pool", () => {
    // 3 Large (rating 3) plus 3 Medium (rating 2) is the game's own 15.
    expect(torpedoPower(1_000, 30_000, 15)).toBeCloseTo(1_000 + 2_000, 9);
  });

  it("drops every torpedo's combat term when another gun is fitted", () => {
    // The coupling that stops a bay being scoreable as an independent slot: 15 to 18 costs it a sixth.
    const before = torpedoPower(1_000, 30_000, 15);
    const after = torpedoPower(1_000, 30_000, 18);
    expect(after).toBeLessThan(before);
    expect(after - 1_000).toBeCloseTo((before - 1_000) * (15 / 18), 9);
  });

  it("hands back the UNDIVIDED pool at zero equivalent turrets, like the game does", () => {
    // Not a convenience: this is the mid-recalculation reading `statsDirty` exists to warn about, and hiding it
    // here would turn an inflated figure into a plausible one.
    expect(torpedoPower(1_000, 30_000, 0)).toBeCloseTo(31_000, 9);
  });
});

describe("torpedo dps", () => {
  it("is power/5 per launch times the launch rate, with no fire-rate divisor", () => {
    // `CalculateDamage` divides by the turret's attacks per second only when a turret fired. A torpedo has no
    // source turret, so power/5 is ONE torpedo rather than a per-second figure.
    const dps = torpedoDps(MEDIUM, 10_000, 1, 0, 0);
    expect(dps).toBeCloseTo((10_000 / 5) / 7, 6);
  });

  it("scales with the ship's pooled crit, Heat and damage bonuses", () => {
    const base = torpedoDps(MEDIUM, 10_000, 1, 0, 0);
    expect(torpedoDps(MEDIUM, 10_000, 2, 0, 0)).toBeCloseTo(base * 2, 6);
    expect(torpedoDps(MEDIUM, 10_000, 1, 0.5, 0)).toBeCloseTo(base * 1.5, 6);
    expect(torpedoDps(MEDIUM, 10_000, 1, 0.2, 0.3)).toBeCloseTo(base * 1.5, 6);
  });

  it("orders the two prefabs the way their cadence does, at equal power", () => {
    // The whole point of the fix: before it, two bays at the same power scored identically.
    expect(torpedoDps(MEDIUM, 10_000, 1, 0, 0)).toBeGreaterThan(torpedoDps(SMALL, 10_000, 1, 0, 0));
  });

  it("is zero with no bay, and zero on a bay with no power to spend", () => {
    expect(torpedoDps(null, 10_000, 1, 0, 0)).toBe(0);
    expect(torpedoDps(undefined, 10_000, 1, 0, 0)).toBe(0);
    expect(torpedoDps(MEDIUM, 0, 1, 0, 0)).toBe(0);
  });
});

describe("reading a bay off an item", () => {
  const item = (extra: Partial<Item>): Item => ({ name: "bay", category: "Module", ...extra } as unknown as Item);

  it("takes the hull's latch count rather than the item's, since latches are the hull's", () => {
    expect(bayOf(item({ torpedoFireDelay: 1, torpedoReloadTime: 3 }), 4))
      .toEqual({ fireDelay: 1, reloadTime: 3, latches: 4 });
  });

  it("refuses to invent a cadence, so a bay it cannot read is not priced at all", () => {
    // Half the numbers is no cadence: guessing the other half would price a bay off a value nothing sent.
    expect(bayOf(item({ torpedoFireDelay: 1 }), 2)).toBeNull();
    expect(bayOf(item({ torpedoReloadTime: 3 }), 2)).toBeNull();
    expect(bayOf(item({}), 2)).toBeNull();
    expect(bayOf(null, 2)).toBeNull();
  });

  it("falls back to one latch when the bridge cannot say", () => {
    for (const latches of [null, undefined, 0]) {
      expect(bayOf(item({ torpedoFireDelay: 1, torpedoReloadTime: 3 }), latches)?.latches).toBe(1);
    }
  });
});
