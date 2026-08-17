// @vitest-environment jsdom
//
// The joint button, through the tab that draws it.
//
// `shipSetSearch.test.ts` pins the SEARCH; this pins the wiring around it: the candidates each half contributes,
// the whole-plan floor, and that both halves are written into the same plan. The case is the reactor unlock — a
// gun that only becomes affordable once capacity rises — which is invisible to either single-block button, so
// pressing them in either order proposes nothing at all.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGearBuilder, type GearBuilder } from "./GearTab";
import type { ShipPools } from "./fleetDps";
import type { Inventories, Item, ShipLayout } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
  localStorage.clear();
});

const gun = (name: string, cp: number, draw: number, key: number): Item => ({
  key, slot: key, name, rarity: "Exotic", level: 64, size: "Medium", type: "Railgun", category: "Turret",
  damageType: "Kinetic", gameplayType: "Combat", location: "armory",
  mainStat: { name: "Combat Power", amount: String(cp) },
  powerUsage: draw, powerUsageBase: draw,
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects: [], stats: [], substats: [],
} as unknown as Item);

const reactor = (name: string, draw: number, energy: number, key: number): Item => ({
  key, slot: key, name, rarity: "Standard", level: 60, size: "Large", type: "Reactor", slotType: "Reactor",
  category: "Module", location: "armory",
  mainStat: { name: "Power", amount: "1000" },
  powerUsage: draw, powerUsageBase: draw,
  stats: energy ? [{ stat: "Energy", amount: energy, multiplier: 1 }] : [],
  aspects: [], substats: [],
} as unknown as Item);

// The fitted pair: 9,000 of 20,000 drawn — 45%, the top +20% band, which the small reactor is what keeps.
const smallReactor = reactor("small-reactor", 1_000, 0, 1);
const modestGun = gun("modest", 10_000, 1_000, 2);
// The pair that only pays TOGETHER: +16,000 capacity (worth nothing on its own, the band is already the top one)
// and a gun worth +40% power for nine times the draw, which on the old capacity costs that band on every pool.
const bigReactor = reactor("big-reactor", 1_000, 16_000, 3);
const thirstyGun = gun("thirsty", 14_000, 9_000, 4);

const layout = (): ShipLayout => ({
  shipGuid: "ship", name: "Manglor", image: { w: 100, h: 100 },
  hardpoints: [{ index: 0, size: "Medium", equipped: modestGun }] as never,
  modules: [{ slot: "Reactor", size: "Large", equipped: smallReactor }],
} as unknown as ShipLayout);

const inv: Inventories = {
  stores: [{ id: "armory", items: [bigReactor, thirstyGun] }],
} as unknown as Inventories;

const POOLS: ShipPools = {
  poolCombatPower: 40_000, poolPrecision: 12_300, equivalentTurrets: 4,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  energy: { used: 9_000, capacity: 20_000, mod: 0.2 },
} as unknown as ShipPools;

let seen: GearBuilder | null = null;
function Probe() {
  seen = useGearBuilder(layout(), inv, "ship", { chance: 0.03, damage: 1, megaCrit: 0 }, POOLS, "Combat");
  return null;
}

// Auto-suggest OFF: these tests press the buttons themselves, one at a time, which is the whole comparison.
function render() {
  localStorage.setItem("shipoptimizer.gearAuto", "false");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe />); });
}

describe("Suggest whole ship", () => {
  it("neither single-block button reaches the pair, in either order", () => {
    render();
    act(() => { seen!.suggestTurrets(); });
    expect(seen!.assign["t:0"]).toBeUndefined();          // the gun cannot be afforded on this capacity
    act(() => { seen!.suggestModules(); });
    act(() => { seen!.suggestTurrets(); });
    expect(seen!.assign["t:0"]).toBeUndefined();          // and the reactor alone buys nothing to change that
  });

  it("finds both halves in one press", () => {
    render();
    act(() => { seen!.suggestShip(); });
    expect(seen!.assign["m:Reactor"]?.name).toBe("big-reactor");
    expect(seen!.assign["t:0"]?.name).toBe("thirsty");
  });

  it("proposes nothing when the whole plan does not clear the floor", () => {
    // Same ship, but the only candidates are losses — so the joint plan fails the floor and falls through to the
    // two single-block answers, which have nothing to propose either.
    const poor: Inventories = {
      stores: [{ id: "armory", items: [gun("worse", 4_000, 9_000, 5), reactor("worse-reactor", 9_000, 0, 6)] }],
    } as unknown as Inventories;
    function PoorProbe() {
      seen = useGearBuilder(layout(), poor, "ship", { chance: 0.03, damage: 1, megaCrit: 0 }, POOLS, "Combat");
      return null;
    }
    localStorage.setItem("shipoptimizer.gearAuto", "false");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<PoorProbe />); });
    act(() => { seen!.suggestShip(); });
    expect(seen!.assign["t:0"]).toBeUndefined();
    expect(seen!.assign["m:Reactor"]).toBeUndefined();
  });
});
