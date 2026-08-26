import { describe, expect, it } from "vitest";
import { background, goalReadingOf, optimizeTurretSet, projectLayer, setRank,
         type ShipPools, type SlotChoice } from "./fleetDps";
import type { Item } from "./types";

/**
 * A BATTERY SPENDS HULL, ARMOR AND SHIELD, and the ranked goal has to be able to see it.
 *
 * The layers are not pools: they are the game's own `/ship/vitals` maxima, so they reach a search only through
 * `TurretGoal.layers`. A search given no projection reads those keys as unset, an unset key orders nothing, and
 * the plan the allowance was set to refuse becomes feasible by construction.
 */

const gun = (name: string, cp: number, over: Partial<Item> = {}): Item => ({
  name, size: "Large", type: "Railgun", category: "Turret", damageType: "Kinetic",
  aspects: [], substats: [], stats: [], powerUsage: 0,
  mainStat: { name: "Combat Power", amount: String(cp) },
  ...over,
} as unknown as Item);

const line = (stat: string, amount: number, multiplier = 1) => ({ stat, amount, multiplier, percent: false });

const pools = (): ShipPools => ({
  poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 3, precisionDivisor: 3430,
  critDamage: 0, megaCrit: 0, energy: { used: 0, capacity: 200, mod: 0 },
} as unknown as ShipPools);

describe("a gun moves a layer", () => {
  it("scales a turret's flat Armor HP by the plating's multiplier, exactly as a module's", () => {
    // The reported maximum is `(base + Σ amount) * Π multiplier`, and the plating is the whole product: at
    // ×171.43 one hardpoint's 2,628 points are worth 450,516 of the figure the player reads.
    const plating = gun("Armor Plating", 0, { stats: [line("Armor HP", 0, 171.43)] });
    const plain = gun("plain", 2_000);
    const tanky = gun("tanky", 2_000, { stats: [line("Armor HP", 2_628)] });

    const now = projectLayer(7_089_900, "Armor HP", [plating, tanky], [plating, tanky]);
    const without = projectLayer(7_089_900, "Armor HP", [plating, tanky], [plating, plain]);

    expect(now).toBe(7_089_900);                       // nothing moved ⇒ the game's own figure, untouched
    expect(without).toBeLessThan(7_089_900);
    expect(Math.round(7_089_900 - (without as number))) .toBe(Math.round(2_628 * 171.43));
  });

  it("moves nothing when the swap carries no layer line", () => {
    const plating = gun("Armor Plating", 0, { stats: [line("Armor HP", 0, 171.43)] });
    expect(projectLayer(7_089_900, "Armor HP", [plating, gun("a", 2_000)], [plating, gun("b", 3_000)]))
      .toBe(7_089_900);
  });
});

describe("the turret search under an allowance on a layer", () => {
  // Two candidates for one hardpoint: `bruiser` has the higher Combat Power and sheds the armor line, `guard`
  // keeps it. The fake projection stands in for `projectLayer` so this test fails for ONE reason — whether the
  // search consults the layers at all — rather than also having to be right about the stat model.
  const guard = gun("guard", 2_000);
  const bruiser = gun("bruiser", 2_600);
  const slots: SlotChoice[] = [{ key: "t:0", candidates: [guard, bruiser], current: guard }];
  const ARMOR_NOW = 7_089_900;
  const armorOf = (guns: (Item | null)[]) =>
    guns.some((g) => g?.name === "bruiser") ? ARMOR_NOW * 0.936 : ARMOR_NOW;   // a 6.4% spend
  const order = ["combat", "armor"] as const;
  // The REFERENCE is read off the fitted battery through the same owner the search uses. A hand-written figure
  // would put both candidates on one side of it and the order would never reach the second key.
  const fitted = goalReadingOf(pools(), setRank([guard], background(pools(), [guard])),
                               { hull: null, armor: ARMOR_NOW, shield: null });

  it("refuses the battery that spends more of the layer than the allowance", () => {
    const chosen = optimizeTurretSet(slots, pools(), 4, [], "balanced", undefined, {
      order, fitted, pools: pools(), allow: 0.02,
      layers: (guns) => ({ hull: null, armor: armorOf(guns), shield: null }),
    });
    expect(chosen.get("t:0")).toBe(guard);
  });

  it("takes it once the allowance is wide enough to pay for it", () => {
    const chosen = optimizeTurretSet(slots, pools(), 4, [], "balanced", undefined, {
      order, fitted, pools: pools(), allow: 0.10,
      layers: (guns) => ({ hull: null, armor: armorOf(guns), shield: null }),
    });
    expect(chosen.get("t:0")).toBe(bruiser);
  });

  it("cannot refuse it with no projection supplied, which is why one is", () => {
    // The shape of the defect: the same 6.4% spend against the same 2% allowance, feasible because `armor` is
    // absent from every reading and an absent key can neither promote nor demote a candidate.
    const chosen = optimizeTurretSet(slots, pools(), 4, [], "balanced", undefined, {
      order, fitted, pools: pools(), allow: 0.02,
    });
    expect(chosen.get("t:0")).toBe(bruiser);
  });
});
