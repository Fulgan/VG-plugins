import { describe, it, expect } from "vitest";
import { aspectValue, aspectDamageFraction, aspectMultiplier, damageAspects } from "./aspect";
import type { Item } from "./types";

// The descriptions here are verbatim from the running game (read off owned gear), not invented — the parse
// is only trustworthy against the real phrasing.
const FROZEN_CORE = "Deals an additional 10% Cold damage. Hits may slow the target's movement.";
const FIRESTARTER = "Deals an additional 15% Heat damage over 6 seconds.";
const PUNCH_THROUGH = "Deals an additional 10% Kinetic damage.";
const GAMMA_WARD = "Increases Energy and Radiation damage resistance by 5%.";
// Boss aspects, verbatim from the game's localisation table.
const HUGGED_BY_FLAMES = "Has a 20% chance on hit to deal an additional 50% Heat damage over 6 seconds. Stacks up to 10 times.";
const VOLATILE_PLASMA = "5% chance on hit to trigger a plasma explosion, dealing 200% damage to nearby enemies.";

const item = (descs: string[]): Item => ({
  key: 1, slot: 1, identifier: null, name: "Railgun Mk.XVI", rarity: "Exotic", level: 64,
  size: "Medium", type: "Railgun", category: "Turret", sellValue: 0,
  aspects: descs.map((d, i) => ({ name: `A${i}`, description: d })),
  stats: [], substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

describe("aspectValue", () => {
  it("reads the percentage out of the game's own wording", () => {
    expect(aspectValue(FROZEN_CORE)).toMatchObject({ kind: "extraDamage", damageFraction: 0.1, overTime: false, chance: 1 });
    expect(aspectValue(PUNCH_THROUGH)).toMatchObject({ kind: "extraDamage", damageFraction: 0.1, chance: 1 });
  });

  it("flags the over-time variant, which is the same class with a DamageOverTime sibling", () => {
    expect(aspectValue(FIRESTARTER)).toMatchObject({ kind: "extraDamage", damageFraction: 0.15, overTime: true });
  });

  it("multiplies a chance clause by the magnitude — 20% x 50% is 10%, not 50%", () => {
    // Hugged By Flames matches Frozen Core in EXPECTED value; reading the 50% alone was 5x too generous.
    const v = aspectValue(HUGGED_BY_FLAMES);
    expect(v).toMatchObject({ kind: "extraDamage", damageFraction: 0.1, overTime: true, chance: 0.2, maxStacks: 10 });
    expect(v.damageFraction).toBeCloseTo(aspectValue(FROZEN_CORE).damageFraction, 10);
  });

  it("keeps area damage out of the single-target value while still reporting it", () => {
    // 5% x 200% would be 10%, but it lands on NEARBY enemies — worth a lot in a crowd, nothing one-on-one.
    const v = aspectValue(VOLATILE_PLASMA);
    expect(v.area).toBe(true);
    expect(v.damageFraction).toBe(0);
    expect(v.chance).toBeCloseTo(0.05, 10);
  });

  it("records a stack ceiling without treating it as a damage cap", () => {
    // Over the cap the COUNTER is refused but DamageOverTime.Add still pools the damage.
    expect(aspectValue(HUGGED_BY_FLAMES).maxStacks).toBe(10);
    expect(aspectValue(FROZEN_CORE).maxStacks).toBeNull();
  });

  it("scores non-damage aspects as zero rather than inventing a value", () => {
    expect(aspectValue(GAMMA_WARD).kind).toBe("other");
    expect(aspectValue(GAMMA_WARD).damageFraction).toBe(0);
    expect(aspectValue(null).damageFraction).toBe(0);
    expect(aspectValue("").damageFraction).toBe(0);
    // A resistance percentage must not be mistaken for a damage percentage.
    expect(aspectValue("Increases Cold damage resistance by 10%.").damageFraction).toBe(0);
    expect(aspectValue("Increases critical chance by 5%.").damageFraction).toBe(0);
  });
});

describe("item scoring", () => {
  it("adds across aspects — each payload takes its own cut of the same parent hit", () => {
    expect(aspectDamageFraction(item([FROZEN_CORE, PUNCH_THROUGH]))).toBeCloseTo(0.2, 10);
    expect(aspectMultiplier(item([FROZEN_CORE, PUNCH_THROUGH]))).toBeCloseTo(1.2, 10);
  });

  it("is 1.0 for an item with no damage aspects, so ranking is untouched", () => {
    expect(aspectMultiplier(item([]))).toBe(1);
    expect(aspectMultiplier(item([GAMMA_WARD]))).toBe(1);
  });

  it("reports which aspects contributed, so a ranking can be checked", () => {
    expect(damageAspects(item([FROZEN_CORE, GAMMA_WARD, FIRESTARTER]))).toEqual([
      { name: "A0", fraction: 0.1, overTime: false },
      { name: "A2", fraction: 0.15, overTime: true },
    ]);
  });
});
