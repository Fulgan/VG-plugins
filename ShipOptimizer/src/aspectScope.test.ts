import { describe, it, expect } from "vitest";
import { background, contributionOf, setDps, type ShipPools } from "./fleetDps";
import { statTotals } from "./format";
import { aspectValue } from "./aspect";
import type { Item } from "./types";

// AN ASPECT'S STAT LINE BELONGS TO WHOEVER THE GAME GIVES IT TO, AND THE TWO ARE NOT THE SAME QUANTITY.
//
//   BoostStat        an IEquipStatSource registered on the UNIT ∴ pools, like a module's line.
//   TurretBoostStat  folded by AbstractEquipment.GetStat into THAT WEAPON ∴ CalculateDamage reads it as
//                    sourceTurret.GetStat(CriticalDamage), and no other gun sees it.
//
// The bridge reports which (`scope`). Before it did, `AspectStats` read only the first component type, so an
// aspect carrying the second serialized as `stats: []` and the client priced it at ZERO by falling back to
// parsing its English description — which is how the optimizer came to offer a plan that threw away two
// +25% crit-damage aspects and called the ship stronger for it.
//
// Pooling one would be the opposite error and just as wrong: worth the whole battery instead of one gun.

const gun = (name: string, cp: number, aspects: Item["aspects"] = []): Item => ({
  key: 1, slot: 1, name, rarity: "Exotic", level: 64, size: "Medium", type: "Railgun",
  category: "Turret", gameplayType: "Combat", damageType: "Kinetic", sellValue: 0,
  mainStat: { name: "Combat Power", amount: String(cp) },
  stats: [{ stat: "Combat Power", amount: cp, multiplier: 1 }],
  powerUsage: 0, powerUsageBase: 0,
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects, substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

const critAspect = (scope: "ship" | "weapon") => ([{
  id: "TurretCriticalDamage", name: "Critical Attenuation",
  description: "Increases critical strike damage of this weapon by 25%.",
  stats: [{ stat: "Critical Damage", amount: 0.25, multiplier: 1, percent: true, scope }],
}] as unknown as Item["aspects"]);

const POOLS: ShipPools = {
  poolCombatPower: 60_000, poolPrecision: 12_300, equivalentTurrets: 4,
  precisionDivisor: 5_000, critDamage: 0.6, megaCrit: 5, critChance: 0.5, critChanceMult: 1,
  energy: { used: 4_000, capacity: 20_000, mod: 0.2 },
} as unknown as ShipPools;

describe("an aspect's stat line is priced at the scope the game gives it", () => {
  it("keeps a weapon-scope line out of the item's POOLED totals", () => {
    const t = statTotals(gun("g", 10_000, critAspect("weapon"))).get("Critical Damage")!;
    expect(t.add).toBe(0);            // nothing reaches the pool
    expect(t.localAdd).toBe(0.25);    // all of it stays on the weapon
    const c = contributionOf(gun("g", 10_000, critAspect("weapon")));
    expect(c.critDamage).toBe(0);
    expect(c.local.critDamage).toBe(0.25);
  });

  it("puts a ship-scope line in the pool instead", () => {
    const t = statTotals(gun("g", 10_000, critAspect("ship"))).get("Critical Damage")!;
    expect(t.add).toBe(0.25);
    expect(t.localAdd).toBe(0);
    expect(contributionOf(gun("g", 10_000, critAspect("ship"))).critDamage).toBe(0.25);
  });

  it("is worth MORE pooled than weapon-local — which is why the two must not be confused", () => {
    const plain = [gun("a", 10_000), gun("b", 10_000)];
    const local = [gun("a", 10_000, critAspect("weapon")), gun("b", 10_000)];
    const ship = [gun("a", 10_000, critAspect("ship")), gun("b", 10_000)];
    const bg = background(POOLS, plain);
    const base = setDps(plain, bg), withLocal = setDps(local, bg), withShip = setDps(ship, bg);
    expect(withLocal).toBeGreaterThan(base);          // it is worth something...
    expect(withShip).toBeGreaterThan(withLocal);      // ...but only one gun's worth, not the battery's
  });

  it("prices a crit-damage aspect at all — the defect was that it was worth exactly zero", () => {
    // The regression guard for an aspect with a served stat line must move the score even though its
    // description says nothing about "additional N% damage", which is all `aspectValue` can read.
    const bare = [gun("a", 10_000), gun("b", 10_000)];
    const withAspect = [gun("a", 10_000, critAspect("weapon")), gun("b", 10_000)];
    const bg = background(POOLS, bare);
    expect(setDps(withAspect, bg)).not.toBeCloseTo(setDps(bare, bg), 6);
  });

  it("treats a line with no scope as pooled, so an older bridge's payload still ranks", () => {
    const noScope = [{
      name: "Weakpoint Scan", description: "Increases critical chance by 5%.",
      stats: [{ stat: "Critical Damage", amount: 0.25, multiplier: 1 }],
    }] as unknown as Item["aspects"];
    expect(statTotals(gun("g", 10_000, noScope)).get("Critical Damage")!.add).toBe(0.25);
  });
});

// A BONUS GATED ON THE TARGET'S HEALTH IS WORTH ITS UPTIME.
//
// `Opening Blow` states its number — "Deals 40% bonus damage to targets above 90% total HP" — and scored
// exactly 0, because the extra-damage pattern wants "additional" or "dealing" before the percent and this says
// "bonus". Both halves of its value are now arguable separately: the 40% is read off the prefab
// (`BossFirstHitPayload.damageMultiplier 1.4`), the uptime is the player's judgement — a weak target dies before
// the gate closes and a real one spends a sliver of the fight above 90%.
describe("an HP-gated bonus", () => {
  const OPENING_BLOW = "Deals 40% bonus damage to targets above 90% total HP.";

  it("is credited at its uptime, not its headline", () => {
    const v = aspectValue(OPENING_BLOW);
    expect(v.kind).toBe("extraDamage");
    expect(v.damageFraction).toBeCloseTo(0.02, 6);   // 40% x 0.05
  });

  it("is no longer worth nothing, which is what the wording alone made it", () => {
    expect(aspectValue(OPENING_BLOW).damageFraction).toBeGreaterThan(0);
  });

  it("leaves an ungated bonus at its full stated value", () => {
    // The gate is what costs it, not the "bonus damage" phrasing.
    expect(aspectValue("Deals 40% bonus damage.").damageFraction).toBeCloseTo(0.4, 6);
  });

  it("composes the gate with a proc chance rather than picking one", () => {
    const v = aspectValue("Has a 20% chance on hit to deal 40% bonus damage to targets above 90% total HP.");
    expect(v.damageFraction).toBeCloseTo(0.4 * 0.2 * 0.05, 6);
  });
});
