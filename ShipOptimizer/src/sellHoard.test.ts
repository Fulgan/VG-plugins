// What the sell list costs on a long playthrough's armory, measured rather than assumed.
//
// A player with 7,891 sellable items reported the popin taking ~90s to appear once. That turned out to be a
// stale bundle, but "turned out to be" is not a measurement — this puts a number on the data layer so the
// question is settled, and so a future change to the rule pipeline cannot quietly make opening the list slow.
//
// Volumes are the reported save's: ~7,900 sellable rows against one broad rule ("sell everything I own").
import { describe, it, expect } from "vitest";
import { evaluate, explain, type Rule, type RuleSet } from "./sellRules";
import type { Item } from "./types";

const TYPES = ["Small Autocannon", "Small Laser", "Small Salvage Laser", "Small Mining Laser", "Medium Railgun"];
const RARITIES = ["Standard", "Enhanced", "HighGrade", "Exotic"];

function item(seed: number): Item {
  const type = TYPES[seed % TYPES.length];
  return {
    key: `k${seed}`, name: `${type} Mk.${seed % 20}`, type, size: "Small",
    level: 40 + (seed % 30), rarity: RARITIES[seed % RARITIES.length],
    category: "Turret", gameplayType: "Combat", location: "armory",
    mainStat: { name: "Combat Power", amount: String(1000 + seed) },
    stats: [{ stat: "Precision", amount: (seed % 13) * 120 }],
    substats: [], aspects: [],
    sellValue: 1000 + (seed % 500), count: 1,
    // A slice is protected, as in a real armory — favourites and mission items are the ones a sale must refuse.
    favourite: seed % 700 === 0, missionItem: seed % 900 === 0,
  } as unknown as Item;
}

const ITEMS = Array.from({ length: 7900 }, (_, i) => item(i + 1));

// "Sell everything I own": no WHERE, no grouping, no TAKE — the broadest rule there is, and the one the
// report used.
const SELL_ALL: Rule = { id: "r1", where: {}, group: [], order: { f: "m", dir: "desc" }, take: null, having: null };
const SET: RuleSet = { defaultKind: "keep", rules: [SELL_ALL], cats: {}, myLevel: 70 };

describe("the sell list's pipeline over ~7,900 items", () => {
  it("evaluates every item against the rule set in a fraction of a click", () => {
    const t0 = performance.now();
    const verdicts = evaluate(ITEMS, SET);
    const ms = performance.now() - t0;

    expect(verdicts).toHaveLength(ITEMS.length);
    expect(verdicts.filter((v) => v === "sell").length).toBeGreaterThan(7000);
    expect(verdicts.filter((v) => v === "cant").length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console -- the number is the point
    console.log(`evaluate: ${ITEMS.length} items in ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000);
  });

  it("explains the rule — groups, rows and the split — without going superlinear", () => {
    const t0 = performance.now();
    const ex = explain(SELL_ALL, ITEMS, { cats: {}, myLevel: 70 });
    const ms = performance.now() - t0;

    expect(ex.inSet.size).toBeGreaterThan(7000);
    // eslint-disable-next-line no-console -- the number is the point
    console.log(`explain:  ${ITEMS.length} items in ${ms.toFixed(1)}ms → ${ex.groups.length} group(s)`);
    expect(ms).toBeLessThan(1000);
  });

  // Doubling the input must roughly double the work. A quadratic pipeline is the failure this catches: at 8k
  // items an n² term is what turns an instant popin into the 90s one that was reported.
  it("scales linearly, not quadratically", () => {
    const half = ITEMS.slice(0, ITEMS.length / 2);
    const time = (list: Item[]) => {
      const t0 = performance.now();
      evaluate(list, SET);
      return performance.now() - t0;
    };
    time(half);                       // warm the JIT so the first call is not the slow one
    const tHalf = time(half);
    const tFull = time(ITEMS);
    // eslint-disable-next-line no-console -- the number is the point
    console.log(`scaling: ${tHalf.toFixed(1)}ms at ${half.length} → ${tFull.toFixed(1)}ms at ${ITEMS.length}`);
    expect(tFull).toBeLessThan(Math.max(tHalf * 4, 50));
  });
});
