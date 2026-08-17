// @vitest-environment jsdom
//
// A PIN is an instruction, and every suggest path owes it the same answer: leave that slot alone.
//
// Two kinds, and they are not the same instruction. `manual` (📌 pinned) says "I chose this slot myself" and
// carries the player's own item; `keep` (🔒) says "whatever is fitted stays" and carries nothing. A path that
// writes through either one contradicts a decision the player can see on screen, which is the worst kind of
// wrong answer an optimizer can give.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGearBuilder, type GearBuilder } from "./GearTab";
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

const turret = (name: string, cp: number, key: number): Item => ({
  key, slot: key, name, rarity: "Standard", level: 60, size: "Medium", type: "Railgun", category: "Turret",
  damageType: "Kinetic", gameplayType: "Combat", location: "armory",
  mainStat: { name: "Combat Power", amount: String(cp) },
  aspects: [], stats: [], substats: [],
} as unknown as Item);

/** A module of `slotType`, with `hp` of Armor HP so the heuristic can order two of them. */
const module_ = (slotType: string, name: string, hp: number, key: number): Item => ({
  key, slot: key, name, rarity: "Standard", level: 60, size: "Large", type: slotType, slotType,
  category: "Module", location: "armory", powerUsage: 100, powerUsageBase: 100,
  mainStat: { name: "Armor HP", amount: String(hp) },
  stats: [{ stat: "Armor HP", amount: hp, multiplier: 1 }],
  aspects: [], substats: [],
} as unknown as Item);

const layout = (): ShipLayout => ({
  shipGuid: "ship", name: "Manglor", image: { w: 100, h: 100 },
  hardpoints: [{ index: 0, size: "Medium", equipped: turret("fitted-gun", 100, 1) }] as never,
  modules: [
    { slot: "Reactor", size: "Large", equipped: module_("Reactor", "fitted-reactor", 100, 2) },
    { slot: "TractorBeam", size: "Large", equipped: module_("TractorBeam", "fitted-beam", 100, 3) },
  ],
} as unknown as ShipLayout);

// Everything in the armory beats what is fitted, so a suggest path that touches a pinned slot will show it.
const inv: Inventories = {
  stores: [{ id: "armory", items: [
    turret("better-gun", 900, 11),
    module_("Reactor", "better-reactor", 900, 12),
    module_("TractorBeam", "better-beam", 900, 13),
    module_("TractorBeam", "best-beam", 950, 14),
  ] }],
} as unknown as Inventories;

// EXPANDED mode's own inputs. The set-level search is a different code path from the per-slot heuristic, and it
// is the one a player with a live bridge actually runs.
const POOLS = {
  poolCombatPower: 40_000, poolPrecision: 12_300, equivalentTurrets: 2,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  energy: { used: 8_000, capacity: 20_000, mod: 0.2 },
} as never;

let seen: GearBuilder | null = null;
function Probe({ pools = null }: { pools?: typeof POOLS | null }) {
  seen = useGearBuilder(layout(), inv, "ship", { chance: 0.03, damage: 1, megaCrit: 0 }, pools, "Combat");
  return null;
}

// Auto-suggest OFF: these tests press the buttons themselves, and a live run would fill the slots first.
function render(pools: typeof POOLS | null = null) {
  localStorage.setItem("shipoptimizer.gearAuto", "false");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe pools={pools} />); });
}

const pick = (key: string, name: string) => {
  const it = (inv.stores[0].items as Item[]).find((x) => x.name === name)!;
  act(() => { seen!.setSlotItem(key, it, true); });
};

describe("a pinned slot is left alone", () => {
  it("keeps the player's own module through a Suggest run", () => {
    render();
    pick("m:TractorBeam", "better-beam");
    expect(seen!.pinned.has("m:TractorBeam")).toBe(true);

    act(() => { seen!.suggestModules(); });
    expect(seen!.assign["m:TractorBeam"]?.name).toBe("better-beam");   // not re-answered
    expect(seen!.assign["m:Reactor"]?.name).toBe("better-reactor");    // the open slot still is
  });

  it("keeps the player's own turret through a Suggest run", () => {
    render();
    pick("t:0", "better-gun");
    act(() => { seen!.suggestTurrets(); });
    expect(seen!.assign["t:0"]?.name).toBe("better-gun");
  });

  it("proposes nothing for a slot locked to what is fitted", () => {
    render();
    act(() => { seen!.toggleKeep("m:TractorBeam"); });
    act(() => { seen!.suggestModules(); });
    expect(seen!.assign["m:TractorBeam"]).toBeUndefined();
    expect(seen!.assign["m:Reactor"]).toBeTruthy();
  });

  // The set-level search, which is what runs with a live bridge. It scores whole assignments, so a pinned slot
  // takes part in every evaluation as the player left it — and must come out of the search unchanged.
  it("keeps the player's own module through an EXPANDED Suggest run", () => {
    render(POOLS);
    pick("m:TractorBeam", "better-beam");
    expect(seen!.pinned.has("m:TractorBeam")).toBe(true);
    act(() => { seen!.suggestModules(); });
    expect(seen!.assign["m:TractorBeam"]?.name).toBe("better-beam");
  });

  it("keeps the player's own turret through an EXPANDED Suggest run", () => {
    render(POOLS);
    pick("t:0", "better-gun");
    act(() => { seen!.suggestTurrets(); });
    expect(seen!.assign["t:0"]?.name).toBe("better-gun");
  });

  it("proposes nothing for a locked slot in EXPANDED mode either", () => {
    render(POOLS);
    act(() => { seen!.toggleKeep("m:TractorBeam"); });
    act(() => { seen!.suggestModules(); });
    expect(seen!.assign["m:TractorBeam"]).toBeUndefined();
  });

  // The per-slot ⚡ is a suggestion too, so it owes the pins the same answer the buttons do. It used to write
  // straight through both, replacing the player's own item while the badge still said "you set this".
  it("refuses the per-slot ⚡ on a pinned slot, and still answers an open one", () => {
    render(POOLS);
    pick("m:TractorBeam", "better-beam");
    act(() => { seen!.suggestSlot("m:TractorBeam"); });
    expect(seen!.assign["m:TractorBeam"]?.name).toBe("better-beam");

    act(() => { seen!.suggestSlot("m:Reactor"); });
    expect(seen!.assign["m:Reactor"]?.name).toBe("better-reactor");
  });

  it("refuses the per-slot ⚡ on a locked slot", () => {
    render(POOLS);
    act(() => { seen!.toggleKeep("m:TractorBeam"); });
    act(() => { seen!.suggestSlot("m:TractorBeam"); });
    expect(seen!.assign["m:TractorBeam"]).toBeUndefined();
  });

  it("refuses a pinned or locked slot on the JOINT run too", () => {
    render(POOLS);
    pick("m:TractorBeam", "better-beam");
    act(() => { seen!.toggleKeep("m:Reactor"); });
    act(() => { seen!.suggestShip(); });
    expect(seen!.assign["m:TractorBeam"]?.name).toBe("better-beam");
    expect(seen!.assign["m:Reactor"]).toBeUndefined();
  });

  it("does not spend a pinned slot's item on an open slot of the same kind", () => {
    // The pinned beam holds `better-beam`; the open beam slot must reach for `best-beam` instead of the item
    // already spoken for — one physical item cannot fill two slots.
    render();
    pick("m:TractorBeam", "better-beam");
    act(() => { seen!.suggestModules(); });
    expect(seen!.assign["m:TractorBeam"]?.name).toBe("better-beam");
  });
});
