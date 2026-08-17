// @vitest-environment jsdom
//
// WHAT A PLAN COSTS IS REPORTED, NOT USED TO REFUSE IT.
//
// The layer cap used to decline a plan outright and leave a sentence explaining an absence — one that named
// neither the control which refused it nor any way to act on it, and that watched three layers while a swap
// spending 4.9% of Combat Power passed in silence. It is now a WARNING LEVEL over every tracked measurement: the
// plan is proposed, and everything it lowers past that level is named with its size. The only surviving refusal
// is the player's own goal order, which is them speaking rather than an app default.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGearBuilder, type GearBuilder } from "./GearTab";
import type { ShipPools } from "./fleetDps";
import type { Inventories, Item, ShipLayout, Vitals } from "./types";

const gun = (name: string, combat: number, hull = 0): Item => ({
  key: null, slot: null, identifier: null, name, rarity: "Standard", level: 60, size: "Medium",
  type: "Plasma Cannon", slotType: "Hardpoint", category: "Turret", gameplayType: "Combat",
  sellValue: 0, powerUsage: 100, powerUsageBase: 100, aspects: [], substats: [], bonus: null, bonusStat: null,
  mainStat: { name: "Combat Power", amount: String(combat) },
  stats: [{ stat: "Combat Power", amount: combat, multiplier: 1, percent: false },
          ...(hull ? [{ stat: "Hull HP", amount: hull, multiplier: 1, percent: false }] : [])],
} as unknown as Item);

// Fitted carries the hull line; the armory gun is far stronger and carries none, so any swap spends 10% of a
// 20,000 hull — a real trade with a real cost, which is exactly the case that must be shown rather than blocked.
const fitted = gun("fitted", 10_000, 2_000);
const stronger = gun("stronger", 40_000);

const layout = (): ShipLayout => ({
  shipGuid: "ship",
  hardpoints: [{ index: 0, size: "Medium", equipped: fitted }] as never,
  modules: [],
} as unknown as ShipLayout);

const inv = { stores: [{ id: "armory", items: [stronger] }] } as unknown as Inventories;

const POOLS: ShipPools = {
  poolCombatPower: 40_000, poolPrecision: 12_300, equivalentTurrets: 4,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  energy: { used: 1_000, capacity: 20_000, mod: 0.2 },
} as unknown as ShipPools;

const VITALS = { hull: { max: 20_000 }, armor: { max: 0 }, shield: { max: 0 } } as unknown as Vitals;

let seen: GearBuilder | null = null;
function Probe() {
  seen = useGearBuilder(layout(), inv, "ship", { chance: 0.03, damage: 1, megaCrit: 0 }, POOLS, "Combat", VITALS);
  return null;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
function render() {
  localStorage.setItem("shipoptimizer.gearAuto", "false");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe />); });
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); seen = null; localStorage.clear(); });

describe("a plan's cost is named, not used to refuse it", () => {
  it("still proposes the swap, and names the measurement it lowers", () => {
    render();
    act(() => { seen!.setLayerCap(0.05); });   // warn over 5%; this swap spends 10% of hull
    act(() => { seen!.suggestTurrets(); });

    // THE PLAN SURVIVES — that is the whole change. Under the old cap it was declined and nothing was proposed.
    expect(seen!.changes.length).toBeGreaterThan(0);
    expect(seen!.planDrops.map((d) => d.key)).toContain("hull");
    expect(seen!.goalNote).toContain("Hull");
    expect(seen!.goalNote).toContain("still proposed");
  });

  it("says nothing when nothing falls past the level the player set", () => {
    render();
    act(() => { seen!.setLayerCap(0.6); });    // a 10% hull cost is well inside this
    act(() => { seen!.suggestTurrets(); });
    expect(seen!.changes.length).toBeGreaterThan(0);
    expect(seen!.planDrops).toEqual([]);
    expect(seen!.goalNote).toBeNull();
  });

  it("reports the drop with its SIZE, so the player can weigh it rather than be told a verdict", () => {
    render();
    act(() => { seen!.setLayerCap(0.05); });
    act(() => { seen!.suggestTurrets(); });
    const hull = seen!.planDrops.find((d) => d.key === "hull");
    expect(hull).toBeDefined();
    expect(hull!.drop).toBeCloseTo(0.1, 2);
    expect(seen!.goalNote).toContain("10% Hull");
  });
});
