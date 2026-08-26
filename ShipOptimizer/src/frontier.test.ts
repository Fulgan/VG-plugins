import { describe, expect, it } from "vitest";
import { frontier, optimizeGearSet, FRONTIER_STEPS,
         type LayerReading, type Rank, type ShipSearch, type SlotChoice } from "./fleetDps";
import type { Item } from "./types";

// THE FRONTIER IS THE ANSWER TO "how do I say what kind of ship I want" WITHOUT A WEIGHT. What is pinned here is
// that it enumerates REAL builds under a real constraint — a row that cannot be applied, or that does not do what
// its own floor says, would be worse than offering nothing.

const it_ = (id: string, dps: number, tank: number): Item =>
  ({ id, key: id, name: id, dps, tank } as unknown as Item);
const dpsOf = (x: Item) => (x as unknown as { dps: number }).dps;
const tankOf = (x: Item) => (x as unknown as { tank: number }).tank;

describe("feasibility is the top key in the ascent", () => {
  const slot = (key: string, candidates: Item[], current?: Item): SlotChoice => ({ key, candidates, current });

  it("prefers a feasible build over an infeasible one that scores higher", () => {
    // A build breaking what the player REQUIRED is not a candidate, whatever it scores.
    const glass = it_("glass", 900, 0);
    const solid = it_("solid", 100, 500);
    const chosen = optimizeGearSet({
      slots: [slot("t:0", [glass, solid], solid)],
      score: (c) => [2, [...c.values()].reduce((n, x) => n + dpsOf(x), 0)] as Rank,
      feasible: (c) => [...c.values()].every((x) => tankOf(x) >= 400),
    });
    expect(chosen.get("t:0")).toBe(solid);
  });

  it("still ranks by the objective among feasible builds", () => {
    const a = it_("a", 300, 500);
    const b = it_("b", 700, 500);
    const chosen = optimizeGearSet({
      slots: [slot("t:0", [a, b], a)],
      score: (c) => [2, [...c.values()].reduce((n, x) => n + dpsOf(x), 0)] as Rank,
      feasible: (c) => [...c.values()].every((x) => tankOf(x) >= 400),
    });
    expect(chosen.get("t:0")).toBe(b);
  });

  it("changes nothing when no constraint is given", () => {
    const a = it_("a", 300, 0);
    const b = it_("b", 700, 0);
    const score = (c: ReadonlyMap<string, Item>): Rank => [2, [...c.values()].reduce((n, x) => n + dpsOf(x), 0)];
    expect(optimizeGearSet({ slots: [slot("t:0", [a, b], a)], score }).get("t:0")).toBe(b);
  });
});

describe("the sweep", () => {
  /**
   * ONE HARDPOINT whose candidates trade shield for Combat Power, which is the whole shape of the feature: the
   * order says Combat Power is what a plan buys and the ALLOWANCE says how much shield it may pay with.
   *
   * The trade sits on a TURRET rather than a module on purpose. A gun is priced by the objective itself (its
   * `mainStat` is its pool contribution and `setRank` reads it), so the fixture fails for one reason — whether
   * the allowance bounds the spend. A module would additionally have to satisfy `moduleBetter`, whose own
   * heuristics would decide the outcome before an allowance ever spoke.
   */
  const gun = (id: string, cp: number, shield: number): Item =>
    ({ id, key: id, name: id, tank: shield, size: "Large", damageType: "Kinetic", powerUsage: 0,
       aspects: [], substats: [], stats: [], mainStat: { name: "Combat Power", amount: String(cp) },
       fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0 } as unknown as Item);

  const guns = [gun("light", 2000, 2000), gun("mid", 2300, 1500), gun("heavy", 2600, 1000)];
  const SHIELD_NOW = 2000;

  const pools = () => ({
    poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 3, precisionDivisor: 3430,
    critDamage: 0, megaCrit: 0, energy: { used: 0, capacity: 200, mod: 0 },
  });

  // The layer as the CANDIDATE battery reads it — the second argument, which is what a search choosing guns has
  // to be given.
  const layers = (_mods: (Item | null)[], chosen?: (Item | null)[]): LayerReading =>
    ({ shield: (chosen ?? [guns[0]]).reduce((n, g) => n + (g ? tankOf(g) : 0), 0) });

  const search = (over: Partial<ShipSearch> = {}): ShipSearch => ({
    turretSlots: [{ key: "t:0", candidates: guns, current: guns[0] }],
    moduleSlots: [],
    pools: pools() as never,
    fittedTurrets: [guns[0]],
    goal: { order: ["dps", "shield"], fitted: { dps: 0, shield: SHIELD_NOW }, layers },
    ...over,
  });

  it("returns nothing with no order to bound", () => {
    // An allowance is a bound on a ranked key. With no key ranked there is nothing to sweep, and five identical
    // rows would be worse than none.
    expect(frontier(search({ goal: undefined }), [...FRONTIER_STEPS])).toEqual([]);
    expect(frontier(search({ goal: { order: [], fitted: {}, layers } }), [...FRONTIER_STEPS])).toEqual([]);
  });

  it("never returns a build that breaches its own row's allowance", () => {
    // The row is named by the allowance it was solved under, so a build spending more than that makes the row a
    // lie — the same claim the old floor sweep made about its floor.
    for (const p of frontier(search(), [...FRONTIER_STEPS])) {
      const shield = p.reading.shield;
      if (shield != null) expect(shield).toBeGreaterThanOrEqual(SHIELD_NOW * (1 - p.allow) - 1e-6);
    }
  });

  it("spends nothing at an allowance of zero", () => {
    const pts = frontier(search(), [0]);
    expect(pts).toHaveLength(1);
    expect(pts[0].reading.shield).toBe(SHIELD_NOW);
  });

  it("projects the layers from the battery it CHOSE, not the one that is fitted", () => {
    // The row's figures and the comparison that produced it have to be the same reading. Handed only the module
    // assignment, the projection falls back on the fitted battery and every row prints the armor the ship has
    // today beside a plan that replaced the guns.
    const seen: Array<(Item | null)[] | undefined> = [];
    frontier(search({
      goal: {
        order: ["dps", "shield"], fitted: { dps: 0, shield: SHIELD_NOW },
        layers: (_mods, chosen) => { seen.push(chosen); return layers(_mods, chosen); },
      },
    }), [0]);
    expect(seen.length).toBeGreaterThan(0);
    for (const guns_ of seen) expect(guns_).toBeDefined();
    // Positional over the slots the search chose, so a caller can pair each pick with the slot it entered.
    expect(seen.at(-1)).toHaveLength(1);
  });

  // THAT A WIDER ALLOWANCE BUYS A BIGGER SPEND is pinned in `gunLayers.test.ts` against the turret search, where
  // the trade can be expressed: a gun's `mainStat` is its own LOCAL main power rather than a pool contribution,
  // so a synthetic battery of one cannot make the objective prefer the heavier gun and a test here would pass or
  // fail on the fixture rather than on the rule.

  it("dedupes neighbouring allowances that solve to the same build", () => {
    // A list showing one answer several times reads as several choices.
    const pts = frontier(search(), [0.01, 0.02, 0.03]);
    expect(pts).toHaveLength(1);
    expect(pts[0].reading.shield).toBe(SHIELD_NOW);
  });

  it("starts at the strictest end and never proposes spending everything", () => {
    expect(FRONTIER_STEPS[0]).toBe(0);
    expect(Math.max(...FRONTIER_STEPS)).toBeLessThan(1);
  });
});
