// SCRATCH — delete after reading. How a suggestion scales with the size of the armory.
import { describe, it } from "vitest";
import { shortlist, optimizeGearSet, setRank, background, type ShipPools } from "./fleetDps";
import type { Item } from "./types";

const gun = (i: number): Item => ({
  key: i, slot: i, name: `Laserturret I Mk.XVI #${i}`, rarity: "Exotic", level: 60 + (i % 15),
  size: "Medium", type: "Laser", category: "Turret", gameplayType: "Combat", damageType: "Energy",
  sellValue: 0, powerUsage: 1000 + (i % 40), powerUsageBase: 1000, powerMultiplier: 0.95,
  // ALMOST IDENTICAL on purpose: that is the case in question, and it is the worst one for a per-axis
  // shortlist, since nothing separates the candidates until the last decimal.
  mainStat: { name: "Combat Power", amount: String(9000 + (i % 50)) },
  fireDelayRaw: 1, reloadDelayRaw: 3, magSizeRaw: 2, burstAmount: 1, burstDelay: 0.2,
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

const pools: ShipPools = {
  poolCombatPower: 100_000, poolPrecision: 15_000, equivalentTurrets: 6,
  precisionDivisor: 5_000, critDamage: 0.5, megaCrit: 0, critChance: 0.4, critChanceMult: 1,
  energy: { used: 9_000, capacity: 22_000, mod: 0.2 },
};

describe("scratch scale", () => {
  it("times the shortlist and the ascent as the armory grows", () => {
    const bg = background(pools, []);
    const out: string[] = [`${"owned".padStart(8)} ${"shortlist ms".padStart(13)} ${"kept".padStart(5)} ${"ascent ms".padStart(10)} ${"evals".padStart(6)}`];
    for (const n of [100, 1_000, 5_000, 20_000]) {
      const all = Array.from({ length: n }, (_, i) => gun(i));
      // SIX hardpoints, as a wide combat hull has: the shortlist runs once per slot.
      const t0 = performance.now();
      const slots = Array.from({ length: 6 }, (_, s) => ({
        key: `t:${s}`, current: all[s], candidates: shortlist(all),
      }));
      const t1 = performance.now();
      let evals = 0;
      optimizeGearSet({
        slots, maxPasses: 4,
        score: (chosen) => { evals++; return setRank([...chosen.values()], bg); },
        alone: (it) => setRank([it], bg),
      });
      const t2 = performance.now();
      out.push(`${String(n).padStart(8)} ${(t1 - t0).toFixed(0).padStart(13)} ${String(slots[0].candidates.length).padStart(5)} ${(t2 - t1).toFixed(0).padStart(10)} ${String(evals).padStart(6)}`);
    }
    process.stdout.write("\n" + out.join("\n") + "\n");
  }, 120_000);
});
