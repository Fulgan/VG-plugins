import { describe, it, expect } from "vitest";
import { speedRatio } from "./fleetDps";
import type { Item } from "./types";
import table from "../fixtures/cadence-structural.json";

// WHAT A GUN ACTUALLY FIRES AT, CHECKED AGAINST THE GAME RATHER THAN AGAINST A SECOND PORT.
//
// `CalculateDamage` divides a shot by `defaultAttacksPerSecond`, built from the RAW serialized fields with the
// reload charged in full and the burst-end delay added to it. The gun does not fire at that rate:
// `ReloadCoroutine` waits `reloadDelay * 0.8`, and the burst-end delay overlaps the reload instead of following
// it. The residue is per turret and spans two-fold — 1.044x to 2.077x — so it reorders a battery, and this model
// priced it at exactly 1.0 until the arena thread measured it.
//
// The fixture is THEIR measurement across all 71 prefabs at zero timing stats, captured from the running game.
// Asserting my derivation against it is the point: two ports of one source agreeing with each other would prove
// only that I copied the same lines. `structuralFactor` is stat-independent by construction, so `speedRatio`
// with no boosts must reproduce it exactly.

interface Row {
  identifier: string; type: string; size: string;
  fireDelay: number; reloadDelay: number; maxMagSize: number; burstAmount: number; burstDelay: number;
  nominalAttacksPerSecond: number; realCadenceAtZeroStats: number; structuralFactor: number;
}
const rows = (table as { turrets: Row[] }).turrets;

const gun = (r: Row): Item => ({
  key: 1, slot: 1, name: r.identifier, rarity: "Standard", level: 60, size: r.size, type: r.type,
  category: "Turret", gameplayType: "Combat", sellValue: 0,
  fireDelayRaw: r.fireDelay, reloadDelayRaw: r.reloadDelay, magSizeRaw: r.maxMagSize,
  burstAmount: r.burstAmount, burstDelay: r.burstDelay,
  stats: [], substats: [], aspects: [], bonus: null, bonusStat: null,
} as unknown as Item);

describe("the real fire cycle, against the game's own 71 prefabs", () => {
  it("has a fixture with every prefab in it", () => {
    expect(rows.length).toBe(71);
  });

  it("reproduces every structural factor at zero stats", () => {
    const off: { id: string; mine: number; theirs: number }[] = [];
    for (const r of rows) {
      const mine = speedRatio(gun(r));
      if (Math.abs(mine - r.structuralFactor) > 1e-4) off.push({ id: r.identifier, mine, theirs: r.structuralFactor });
    }
    // Named, not counted: a mismatch is a transcription bug and the identifier is what finds it.
    expect(off).toEqual([]);
  });

  it("spans the range that makes it worth modelling — it is not a constant to divide out", () => {
    const factors = rows.map((r) => r.structuralFactor);
    expect(Math.min(...factors)).toBeCloseTo(1.044, 2);
    expect(Math.max(...factors)).toBeCloseTo(2.077, 2);
    // If it were uniform it would cancel out of every comparison and could be ignored. It is not.
    expect(Math.max(...factors) / Math.min(...factors)).toBeGreaterThan(1.9);
  });

  it("still cancels the STAT half — a boost lifts the ratio above the structural figure, and by the cycle's own shape", () => {
    const r = rows.find((x) => x.identifier === "SmallGatlingTurret") ?? rows[0];
    const base = speedRatio(gun(r));
    const boosted = speedRatio(gun(r), 0.5, 0, 0);
    expect(base).toBeCloseTo(r.structuralFactor, 4);
    expect(boosted).toBeGreaterThan(base);
  });

  it("is 1 for an item carrying no cycle at all, so a module or a booster is untouched", () => {
    expect(speedRatio({ name: "Reactor" } as unknown as Item)).toBe(1);
  });
});
