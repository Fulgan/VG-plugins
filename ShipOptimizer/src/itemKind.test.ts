import { describe, expect, it } from "vitest";
import { compareModules } from "./itemKind";
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
    expect(compareModules(mod({ mainStat: { name: "Tractor Beams", amount: "8" } }), mod({}))).toBeGreaterThan(0);
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
