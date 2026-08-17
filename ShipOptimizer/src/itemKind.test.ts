import { describe, expect, it } from "vitest";
import { compareModules, kindOf } from "./itemKind";
import type { Item } from "./types";

// The case that produced no suggestion at all: two Tractor Beams both reading "7 Tractor Beams", where the
// candidate drew 0 power instead of 1,147, carried Q15, an aspect slot and extra substats — every one of which
// was ignored because only the headline was compared.
const mod = (o: Partial<Item>): Item => ({
  name: "Tractor Beam", rarity: "Standard", level: 63, stats: [], substats: [], aspects: [],
  mainStat: { name: "Tractor Beams", amount: "7" }, ...o,
} as unknown as Item);

describe("compareModules", () => {
  it("prefers the bigger headline first", () => {
    // A MAGNITUDE headline, so the step being tested is the ordering and not the saturation below.
    const small = mod({ mainStat: { name: "Energy", amount: "20,000" } });
    const big = mod({ mainStat: { name: "Energy", amount: "25,000" } });
    expect(compareModules(big, small)).toBeGreaterThan(0);
  });

  // A COUNT is not a magnitude, and past its ceiling it must not decide anything: the player's report was a
  // tractor beam swap "worse on every level but the tractor beam count", where beyond five beams the extra ones
  // only gather loot marginally faster.
  it("does not let a saturated count outrank everything else", () => {
    const manyBeams = mod({ mainStat: { name: "Tractor Beams", amount: "10" }, powerUsage: 1_147 });
    const better = mod({
      mainStat: { name: "Tractor Beams", amount: "6" }, powerUsage: 0, aspectSlots: 1,
      substats: [{ stat: "Hull HP", amount: 2_000, multiplier: 1 }],
    } as Partial<Item>);
    // Ten beats six on the raw number, and the raw number is what the card still shows…
    expect(compareModules(manyBeams, better)).toBeLessThan(0);   // …but the decision goes the other way
  });

  it("still counts a count BELOW its ceiling", () => {
    const four = mod({ mainStat: { name: "Tractor Beams", amount: "4" } });
    const five = mod({ mainStat: { name: "Tractor Beams", amount: "5" } });
    expect(compareModules(five, four)).toBeGreaterThan(0);
  });

  // The reported case: on a SALVAGE hull the objective is silent about Precision and Hull HP, so this
  // chain carries the whole decision — and 26 units of draw outranked three stat lines and two aspects.
  it("does not spend a decision on a draw difference nobody feels", () => {
    const en = { usedWithout: 7_951, capacity: 14_456 };   // 26 units is 0.18% of the budget
    const richer = mod({
      powerUsage: 732, aspectSlots: 2,
      aspects: [{ name: "Repair Nanites", description: "", stats: [] },
                { name: "Operational Reserves", description: "", stats: [] }],
      substats: [
        { stat: "Power", amount: 694, multiplier: 1 },
        { stat: "Hull HP", amount: 1_335, multiplier: 1 },
        { stat: "Precision", amount: 1_220, multiplier: 1 },
      ],
    } as Partial<Item>);
    const barelyLeaner = mod({ powerUsage: 706, aspectSlots: 0 } as Partial<Item>);
    expect(compareModules(barelyLeaner, richer, en)).toBeLessThanOrEqual(0);
  });

  it("still prefers a draw saving that is material", () => {
    const en = { usedWithout: 1_000, capacity: 10_000 };   // 900 units is 9% of the budget
    expect(compareModules(mod({ powerUsage: 0 }), mod({ powerUsage: 900 }), en)).toBeGreaterThan(0);
  });

  it("breaks a headline tie on energy draw", () => {
    expect(compareModules(mod({ powerUsage: 0 }), mod({ powerUsage: 1147 }))).toBeGreaterThan(0);
  });

  // Slots are permanent capacity; draw only matters when it moves the ship across a reactor bracket. So with no
  // bracket at stake the module with a slot wins even though it draws more.
  it("prefers a slot over lower draw when no bracket changes", () => {
    const en = { usedWithout: 1000, capacity: 10000 };   // 10-20% load either way: same bracket
    expect(compareModules(mod({ aspectSlots: 1, powerUsage: 900 }), mod({ aspectSlots: 0, powerUsage: 0 }), en)).toBeGreaterThan(0);
  });

  // But a draw that crosses a threshold outweighs a slot: the bracket multiplies every power pool.
  it("prefers lower draw when it keeps a better bracket", () => {
    const en = { usedWithout: 4600, capacity: 10000 };   // +300 -> 49% (+20%); +900 -> 55% (+10%)
    expect(compareModules(mod({ aspectSlots: 0, powerUsage: 300 }), mod({ aspectSlots: 1, powerUsage: 900 }), en)).toBeGreaterThan(0);
  });

  // A stat the ship's role actually uses beats spare energy: capacity the build has no use for is worth less
  // than a mining bonus on a mining hull.
  it("prefers role-useful stats over lower draw", () => {
    const en = { usedWithout: 1000, capacity: 10000 };   // same bracket either way
    const roleful = mod({ powerUsage: 900, substats: [{ stat: "Mining Power", amount: 120, multiplier: 1 }] } as Partial<Item>);
    const thrifty = mod({ powerUsage: 0 });
    expect(compareModules(roleful, thrifty, en, "Mining")).toBeGreaterThan(0);
    // With no role given there is nothing to prefer, so the thriftier one wins on draw.
    expect(compareModules(roleful, thrifty, en)).toBeLessThan(0);
  });

  it("then on aspect slots, then extra stat lines", () => {
    expect(compareModules(mod({ powerUsage: 0, aspectSlots: 1 }), mod({ powerUsage: 0, aspectSlots: 0 }))).toBeGreaterThan(0);
    expect(compareModules(
      mod({ powerUsage: 0, substats: [{ stat: "Armor HP", amount: 1336, multiplier: 1 }] } as Partial<Item>),
      mod({ powerUsage: 0 }))).toBeGreaterThan(0);
  });

  it("calls two identical modules equal", () => {
    expect(compareModules(mod({}), mod({}))).toBe(0);
  });

  // Quality boosts `bonusStat`, so it already shows in the stat lines; scoring it again would count the same
  // advantage twice.
  it("ignores the quality level itself", () => {
    expect(compareModules(mod({ bonus: 15 }), mod({ bonus: 0 }))).toBe(0);
  });
});

describe("aspect slots are capacity, not contents", () => {
  it("a FULL 2/2 does not outrank a full 1/1 — the aspects already count through their stats", () => {
    const full2 = mod({ aspectSlots: 2, aspects: [{ name: "A", description: "", stats: [] }, { name: "B", description: "", stats: [] }] } as Partial<Item>);
    const full1 = mod({ aspectSlots: 1, aspects: [{ name: "A", description: "", stats: [] }] } as Partial<Item>);
    expect(compareModules(full2, full1)).toBe(0);
  });

  it("an EMPTY slot still wins: it is somewhere to put one later", () => {
    const spare = mod({ aspectSlots: 2, aspects: [{ name: "A", description: "", stats: [] }] } as Partial<Item>);
    const full1 = mod({ aspectSlots: 1, aspects: [{ name: "A", description: "", stats: [] }] } as Partial<Item>);
    expect(compareModules(spare, full1)).toBeGreaterThan(0);
  });
});

describe("kindOf", () => {
  const row = (o: Partial<Item>): Item => ({ name: "x", stats: [], substats: [], aspects: [], ...o } as unknown as Item);

  it("classifies by the game's CATEGORY, whatever the item rolled", () => {
    // A common piece of gear rolls no substats, so `stats` is empty — and that used to read as "not equipment",
    // which kept every Standard module and booster out of the sell list entirely.
    expect(kindOf(row({ category: "Module", type: "Tractor Beam", stats: [] }))).toBe("Module");
    expect(kindOf(row({ category: "Booster", type: "Booster", stats: [] }))).toBe("Booster");
    expect(kindOf(row({ category: "Turret", type: "Railgun", stats: [] }))).toBe("Turret");
  });

  it("keeps stock out of the equipment lists", () => {
    for (const c of ["Ore", "Ammo", "Junk", "TradeGoods", "RefinedProduct", "Crystal", "Salvage", "Currency"])
      expect(kindOf(row({ category: c, stats: [{ stat: "x", amount: 1, multiplier: 1 }] }))).toBeNull();
    expect(kindOf(row({ category: "Drone" }))).toBeNull();
    expect(kindOf(row({ category: "DefensiveTurret" }))).toBeNull();   // excluded before the Turret match
  });

  it("falls back to the shape when a bridge sends no category at all", () => {
    expect(kindOf(row({ type: "Plasma Turret", stats: [{ stat: "x", amount: 1, multiplier: 1 }] }))).toBe("Turret");
    expect(kindOf(row({ type: "Whatever", stats: [] }))).toBeNull();
  });
});
