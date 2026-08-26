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

// THE FIRING-CYCLE STATS ARE CONDITIONAL ON GUN GEOMETRY, and pricing them linearly would over-value them on
// exactly the guns where they do nothing. Both effects fall out of the cycle rather than being special-cased, so
// what is pinned here is that the cycle keeps producing them.
describe("attack speed and magazine size are worth what the gun's geometry lets them be worth", () => {
  const gun = (mag: number, burst: number): Item => ({
    key: "g", fireDelayRaw: 0.2, magSizeRaw: mag, reloadDelayRaw: 2, burstAmount: burst, burstDelay: 0.05,
  } as unknown as Item);
  const gain = (g: Item, a: number, r: number, m: number) => speedRatio(g, a, r, m) / speedRatio(g, 0, 0, 0) - 1;

  it("prices attack speed at exactly nothing when the magazine empties as ONE burst", () => {
    // `fireDelay` never governs there: the burst is over in one go and the idle is the reload. Measured in game
    // on such a battery as +0.00% at every value, and the same falls out of the cycle here.
    const oneBurst = gun(3, 3);
    for (const v of [0.05, 0.15, 0.3, 0.6]) expect(gain(oneBurst, v, 0, 0)).toBe(0);
  });

  it("prices it as real on a magazine that holds several bursts", () => {
    // Same stat, same battery-wide pool, different gun: this is why it cannot be a constant per point.
    const several = gun(12, 3);
    expect(gain(several, 0.15, 0, 0)).toBeGreaterThan(0.02);
    expect(gain(several, 0.6, 0, 0)).toBeGreaterThan(gain(several, 0.3, 0, 0));
  });

  it("prices magazine size as a STEP, not a slope", () => {
    // `round(base * (1 + boost))` — on a 3-round magazine nothing happens until the boost buys a whole round.
    const g = gun(3, 3);
    expect(gain(g, 0, 0, 0.15)).toBe(0);      // round(3 * 1.15) = 3, still three rounds
    expect(gain(g, 0, 0, 0.3)).toBeGreaterThan(0.1);   // round(3 * 1.30) = 4
  });

  it("prices reload speed continuously, which is the one of the three that is a slope", () => {
    const g = gun(3, 3);
    expect(gain(g, 0, 0.15, 0)).toBeGreaterThan(0.1);
    expect(gain(g, 0, 0.3, 0)).toBeGreaterThan(gain(g, 0, 0.15, 0));
  });
});
