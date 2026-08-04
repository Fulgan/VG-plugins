// @vitest-environment jsdom
//
// The reactor bracket is a STEP, and it scales every power pool at once. Two suggesters share it — turrets and
// modules — and each was choosing against the load on the ship rather than the load its own plan would produce.
// Measured on a live Manglor: five proposals, per-slot gains of +24.4% and +20.8%, and the whole build's own DPS
// index falling 133,646 → 132,763 as the load crossed 50% and the bonus stepped +20% → +10%.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGearBuilder, type GearBuilder } from "./GearTab";
import type { Inventories, Item, ShipLayout } from "./types";
import type { ShipPools } from "./fleetDps";
import { reactorModifier } from "./reactor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
  localStorage.clear();
});

const engine = (name: string, headline: number, draw: number, key: number): Item => ({
  key, slot: key, location: "armory", name, rarity: "Standard", level: 60, size: "Large",
  category: "Module", slotType: "Engine", type: "Engine",
  mainStat: { name: "Thrust", amount: String(headline) },
  powerUsage: draw, powerUsageBase: draw,
  aspects: [], stats: [], substats: [],
} as unknown as Item);

const gun = (name: string, cp: number, draw: number, key: number): Item => ({
  key, slot: key, location: "armory", name, rarity: "Standard", level: 60, size: "Large",
  category: "Turret", slotType: "Hardpoint", type: "Railgun", damageType: "Kinetic", gameplayType: "Combat",
  mainStat: { name: "Combat Power", amount: String(cp) },
  powerUsage: draw, powerUsageBase: draw,
  aspects: [], stats: [{ stat: "Combat Power", amount: cp, multiplier: 1 }], substats: [],
} as unknown as Item);

// 480 of 1000 drawn — just inside the top bracket, which ends at half capacity. The fitted engine accounts for
// 80 of that, so a replacement drawing more than 180 tips the ship out of the +20%.
const CAPACITY = 1000;
const USED = 480;
const FITTED_ENGINE_DRAW = 80;

const layout: ShipLayout = {
  shipGuid: "brackety", name: "Manglor", image: { w: 100, h: 100 },
  hardpoints: [{ index: 0, size: "Large", equipped: gun("fitted gun", 1000, 100, 2) }] as never,
  modules: [{ slot: "Engine", size: "Large", equipped: engine("fitted engine", 100, FITTED_ENGINE_DRAW, 1) }],
} as unknown as ShipLayout;

const pools: ShipPools = {
  poolCombatPower: 20_000, poolPrecision: 5_000, equivalentTurrets: 3, precisionDivisor: 5_000,
  critDamage: 1, megaCrit: 0,
  energy: { used: USED, capacity: CAPACITY, mod: reactorModifier(USED / CAPACITY) },
} as unknown as ShipPools;

// `cheap` is a plain upgrade. `greedy` has the bigger headline and would win the comparator outright — its own
// draw is what costs the bracket.
const cheap = engine("cheap upgrade", 200, FITTED_ENGINE_DRAW, 11);
const greedy = engine("greedy upgrade", 300, 400, 12);
const inv: Inventories = { stores: [{ id: "armory", items: [cheap, greedy, gun("spare gun", 1200, 100, 13)] }] } as unknown as Inventories;

let seen: GearBuilder | null = null;
function Probe() {
  seen = useGearBuilder(layout, inv, "brackety", { chance: 0.03, damage: 1, megaCrit: 0 }, pools, "Combat");
  return null;
}

function render() {
  localStorage.setItem("shipoptimizer.gearAuto", "false");
  localStorage.setItem("shipoptimizer.gearRanking", JSON.stringify("expanded"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe />); });
}

describe("the reactor bracket constrains what gets suggested", () => {
  it("the fixture really does sit on a bracket edge", () => {
    expect(reactorModifier(USED / CAPACITY)).toBeGreaterThan(reactorModifier((USED - FITTED_ENGINE_DRAW + 400) / CAPACITY));
  });

  it("refuses a module whose draw gives up the bracket, and takes the lesser one instead", () => {
    render();
    act(() => { seen!.suggestModules(); });
    const picked = seen!.assign["m:Engine"];
    // The greedy engine wins on headline — `compareModules` ranks the main stat above the bracket — so this is
    // the whole point: it must not be offered, because stepping the bonus down scales EVERY power pool and the
    // comparator has no unit in which to trade a Thrust figure against that.
    expect(picked?.name).not.toBe("greedy upgrade");
    expect(picked?.name).toBe("cheap upgrade");
  });

  it("never proposes a plan that scores below the fitted build", () => {
    render();
    act(() => { seen!.suggestModules(); });
    act(() => { seen!.suggestTurrets(); });
    // Whatever it settles on, the projected battery must beat what is already fitted — the one guarantee a
    // "suggest" button owes. Before the bracket was a constraint this came out negative on a live ship while
    // every individual slot still displayed a gain.
    // Non-vacuous by construction: the spare gun out-powers the fitted one at the same draw, so there IS a
    // change to make and `planRegresses` has something to judge.
    expect(seen!.changes.length).toBeGreaterThan(0);
    expect(seen!.planRegresses).not.toBe(true);
  });
});
