import { describe, it, expect } from "vitest";
import { boosterType, boosterValue, defaultSlotTypes, optimizeBoosters } from "./booster";
import type { Item } from "./types";

function booster(stat: string, amount: string): Item {
  return {
    key: null, slot: null, identifier: null, name: `${stat} booster`, rarity: "Standard", level: 1,
    size: null, type: `${stat} R-Booster`, category: "Booster", sellValue: 0,
    aspects: [], stats: [], substats: [], bonus: null, bonusStat: null,
    mainStat: { name: stat, amount },
  };
}

describe("booster optimizer", () => {
  it("classifies type by main stat and parses value (flat + percent)", () => {
    expect(boosterType(booster("Combat Power", "1,257"))).toBe("Combat Power");
    expect(boosterValue(booster("Combat Power", "1,257"))).toBe(1257);
    expect(boosterValue(booster("Officer Bonus", "6.25%"))).toBe(6.25);
  });

  it("fills each slot with the highest-value unused booster of its type", () => {
    const pool = [
      booster("Combat Power", "1000"), booster("Combat Power", "1500"),
      booster("Mining Power", "800"),
    ];
    const { picks } = optimizeBoosters(pool, ["Combat Power", "Combat Power", "Mining Power"]);
    expect(picks.map((p) => p.value)).toEqual([1500, 1000, 800]); // top-2 combat, then mining
    expect(picks[0].chosen).not.toBe(picks[1].chosen); // no reuse
  });

  it("empty slots default to the ship-role booster type", () => {
    const pool = [booster("Combat Power", "1000"), booster("Mining Power", "800")];
    const types = defaultSlotTypes([null, null], 2, "Mining", pool);
    expect(types).toEqual(["Mining Power", "Mining Power"]);
  });

  it("keeps the equipped booster's type on occupied slots", () => {
    const pool = [booster("Combat Power", "1000")];
    const types = defaultSlotTypes([booster("Combat Power", "900"), null], 2, "Mining", pool);
    expect(types[0]).toBe("Combat Power"); // kept from equipped
  });
});
