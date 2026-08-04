import { describe, it, expect } from "vitest";
import { gearModuleOpps, gearBoosterOpps } from "./opportunities";
import { mainVal, effectiveMainVal } from "./format";
import type { Item } from "./types";

// The MODULE and BOOSTER rails. These spend the player's credits, and the module one is where a
// 21.2K reactor offered over an equipped 20.8K whose aspect grants +10%, i.e. a downgrade sold as an upgrade.
// Neither had a single test until now.

const mod = (over: Partial<Item> = {}): Item => ({
  key: 1, slot: 1, name: "Reactor", rarity: "Standard", level: 60, size: "Medium",
  slotType: "Reactor", category: "Module", sellValue: 0,
  mainStat: { name: "Energy", amount: "20,000" },
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null,
  ...over,
} as unknown as Item);

const booster = (name: string, stat: string, amount: string): Item => ({
  key: 1, slot: 1, name, rarity: "Standard", level: 60, size: null,
  slotType: "Booster", category: "Booster", sellValue: 0,
  mainStat: { name: stat, amount },
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

const reactorSlot = (equipped: Item | null) => [{ slot: "Reactor", size: "Medium", equipped }];

describe("gearModuleOpps", () => {
  it("offers a genuinely better module for the slot it fits", () => {
    const eq = mod({ name: "small", mainStat: { name: "Energy", amount: "20,000" } });
    const big = mod({ name: "big", mainStat: { name: "Energy", amount: "25,000" } });
    const opps = gearModuleOpps([big], reactorSlot(eq), undefined, null);
    expect(opps).toHaveLength(1);
    expect(opps[0].item.name).toBe("big");
    expect(opps[0].replaces).toBe(eq);
    expect(opps[0].slotLabel).toBe("Reactor");
    expect(opps[0].delta).toBeCloseTo(5_000);
  });

  // The equipped item's aspect grants +10% of its own headline, so its EFFECTIVE value is 22,880 and the
  // bigger-on-paper 21,200 candidate is a downgrade. Ranking on the printed number alone offered it anyway.
  it("does not offer a bigger headline that loses once the equipped item's aspect counts", () => {
    const eq = mod({
      name: "with-aspect",
      mainStat: { name: "Energy", amount: "20,800" },
      aspects: [{ name: "Microgenerators", description: "+10% reactor energy",
                  stats: [{ stat: "EnergyCapacity", amount: 0, multiplier: 1.1 }] }],
    } as Partial<Item>);
    const bare = mod({ name: "bare", mainStat: { name: "Energy", amount: "21,200" } });
    // Prove the fixture IS the trap before asserting the behaviour: raw headline favours the candidate, effective
    // value favours the equipped item. Without this the test would also pass on two identical modules, which is
    // exactly how an earlier draft of it passed for the wrong reason.
    expect(mainVal(bare)).toBeGreaterThan(mainVal(eq) as number);
    expect(effectiveMainVal(bare)).toBeLessThan(effectiveMainVal(eq) as number);
    expect(gearModuleOpps([bare], reactorSlot(eq), undefined, null)).toHaveLength(0);
  });

  it("never offers anything for an EMPTY slot — those are filled from the Gear tab", () => {
    const any = mod({ name: "any", mainStat: { name: "Energy", amount: "99,000" } });
    expect(gearModuleOpps([any], reactorSlot(null), undefined, null)).toHaveLength(0);
  });

  it("respects the slot's type and size", () => {
    const eq = mod();
    const wrongSlot = mod({ name: "engine", slotType: "Engine", mainStat: { name: "Energy", amount: "99,000" } });
    const wrongSize = mod({ name: "large", size: "Large", mainStat: { name: "Energy", amount: "99,000" } });
    expect(gearModuleOpps([wrongSlot, wrongSize], reactorSlot(eq), undefined, null)).toHaveLength(0);
  });

  // A tie-break win (aspect slots, role stats, draw) is a real recommendation whose HEADLINE delta is 0 — the
  // entry belongs on the rail, it just sorts below anything with a headline gain.
  it("keeps a tie-break win, whose headline delta is 0", () => {
    const eq = mod({ name: "plain", aspectSlots: 0 } as Partial<Item>);
    const roomier = mod({ name: "roomier", aspectSlots: 2 } as Partial<Item>);
    const opps = gearModuleOpps([roomier], reactorSlot(eq), undefined, null);
    expect(opps).toHaveLength(1);
    expect(opps[0].delta).toBeCloseTo(0);
  });

  it("keeps the best instance per item NAME and sorts by delta", () => {
    const eq = mod({ name: "eq", mainStat: { name: "Energy", amount: "10,000" } });
    const dupLow = mod({ name: "dup", mainStat: { name: "Energy", amount: "12,000" } });
    const dupHigh = mod({ name: "dup", mainStat: { name: "Energy", amount: "18,000" } });
    const other = mod({ name: "other", mainStat: { name: "Energy", amount: "14,000" } });
    const opps = gearModuleOpps([dupLow, dupHigh, other], reactorSlot(eq), undefined, null);
    expect(opps.map((o) => o.item.name)).toEqual(["dup", "other"]);   // 8,000 then 4,000
    expect(opps[0].delta).toBeCloseTo(8_000);
  });

  // The reactor bracket outranks everything else in `compareModules`, so a lower-draw module can win on that
  // alone — the energy argument is what makes the rail agree with the gear tab.
  it("prefers the module that keeps the ship in a better reactor bracket", () => {
    const eq = mod({ name: "thirsty", powerUsage: 60, powerUsageBase: 60 } as Partial<Item>);
    const lean = mod({ name: "lean", powerUsage: 10, powerUsageBase: 10 } as Partial<Item>);
    // 60 already drawn of 200: keeping the 60-draw module sits at 30%, the 10-draw one lower still. Same headline,
    // so any offer here comes from the bracket/draw steps rather than the main stat.
    const opps = gearModuleOpps([lean], reactorSlot(eq), { used: 60, capacity: 200 }, null);
    expect(opps.map((o) => o.item.name)).toEqual(["lean"]);
  });
});

describe("gearBoosterOpps", () => {
  const eq = booster("equipped", "Combat Power", "1,000");

  it("offers a stronger booster of the SLOT'S configured type", () => {
    const better = booster("better", "Combat Power", "1,500");
    const opps = gearBoosterOpps([better], ["Combat Power"], [eq]);
    expect(opps).toHaveLength(1);
    expect(opps[0].item.name).toBe("better");
    expect(opps[0].delta).toBeCloseTo(500);
  });

  it("ignores a stronger booster of a DIFFERENT type", () => {
    const otherType = booster("mining", "Mining Power", "9,000");
    expect(gearBoosterOpps([otherType], ["Combat Power"], [eq])).toHaveLength(0);
  });

  it("is upgrades only — equal or worse is not an opportunity", () => {
    const same = booster("same", "Combat Power", "1,000");
    const worse = booster("worse", "Combat Power", "900");
    expect(gearBoosterOpps([same, worse], ["Combat Power"], [eq])).toHaveLength(0);
  });

  it("skips an untyped slot and an empty one", () => {
    const better = booster("better", "Combat Power", "1,500");
    expect(gearBoosterOpps([better], [null], [eq])).toHaveLength(0);
    expect(gearBoosterOpps([better], ["Combat Power"], [null])).toHaveLength(0);
  });

  it("keeps the best instance per name and sorts by delta", () => {
    const dupLow = booster("dup", "Combat Power", "1,200");
    const dupHigh = booster("dup", "Combat Power", "1,900");
    const other = booster("other", "Combat Power", "1,400");
    const opps = gearBoosterOpps([dupLow, dupHigh, other], ["Combat Power"], [eq]);
    expect(opps.map((o) => o.item.name)).toEqual(["dup", "other"]);
    expect(opps[0].delta).toBeCloseTo(900);
  });

  it("scores each slot against ITS OWN occupant", () => {
    const weakSlot = booster("weak", "Combat Power", "100");
    const cand = booster("cand", "Combat Power", "1,100");
    // Beats the weak slot's occupant by 1,000 and the strong one's by 100 — the bigger gain is the one reported.
    const opps = gearBoosterOpps([cand], ["Combat Power", "Combat Power"], [weakSlot, eq]);
    expect(opps).toHaveLength(1);
    expect(opps[0].delta).toBeCloseTo(1_000);
  });
});
