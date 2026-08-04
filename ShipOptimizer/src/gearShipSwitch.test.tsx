// @vitest-environment jsdom
//
// Switching to an IDENTICAL ship must not inherit the previous one's pins.
//
// A slot key is `t:<index>` / `m:<EquipmentSlot>`, so two hulls of the same class have exactly the same keys. Any
// per-plan state left behind therefore lands on the next ship silently — and a pinned slot is skipped by every
// suggest path, so the symptom is a ship that refuses to propose anything for no visible reason. Outfitting
// several identical ships is when that bites.
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

// A distinct store handle per item: `handle()` is location:key, and equal handles mean one physical item.
const k = (it: Item, key: number): Item => ({ ...it, key, slot: key } as Item);
const turret = (name: string, cp: number): Item => ({
  key: 1, slot: 1, name, rarity: "Standard", level: 60, size: "Medium", type: "Railgun", category: "Turret",
  damageType: "Kinetic", gameplayType: "Combat", location: "armory",
  mainStat: { name: "Combat Power", amount: String(cp) },
  aspects: [], stats: [], substats: [],
} as unknown as Item);

// Two hulls of the SAME class: same slot keys, different guids — the reported case.
const layoutFor = (guid: string): ShipLayout => ({
  shipGuid: guid, name: "Manglor", image: { w: 100, h: 100 },
  hardpoints: [{ index: 0, size: "Medium", equipped: turret("fitted", 100) }] as never,
  modules: [{ slot: "Reactor", size: "Medium", equipped: null }],
} as unknown as ShipLayout);

const inv: Inventories = { stores: [{ id: "armory", items: [turret("spare", 900)] }] } as unknown as Inventories;

// Three hardpoints and three spares, so an item can be displaced from one slot to another and the freed slot has
// something else to fall back on.
const wide = (): ShipLayout => ({
  shipGuid: "wide", name: "Manglor", image: { w: 100, h: 100 },
  hardpoints: [0, 1, 2].map((i) => ({ index: i, size: "Medium", equipped: turret(`fitted-${i}`, 100 + i) })) as never,
  modules: [],
} as unknown as ShipLayout);
const wideInv: Inventories = {
  stores: [{ id: "armory", items: [k(turret("top", 900), 11), k(turret("mid", 800), 12), k(turret("low", 700), 13)] }],
} as unknown as Inventories;

// The hook under test, surfaced so the assertions can read it.
let seen: GearBuilder | null = null;
function WideProbe() {
  seen = useGearBuilder(wide(), wideInv, "wide", { chance: 0.03, damage: 1, megaCrit: 0 }, null, "Combat");
  return null;
}
function Probe({ guid }: { guid: string }) {
  seen = useGearBuilder(layoutFor(guid), inv, guid, { chance: 0.03, damage: 1, megaCrit: 0 }, null, "Combat");
  return null;
}

// Auto-suggest OFF for these: they are about which BUCKET a decision lands in, and a live optimizer run would
// fill the slots on its own and mask that. One test below turns it back on to check the opposite.
function render(guid: string) {
  localStorage.setItem("shipoptimizer.gearAuto", "false");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe guid={guid} />); });
}

describe("switching ships", () => {
  it("does not apply one ship's pins to an identical hull", () => {
    render("ship-A");
    act(() => { seen!.setSlotItem("t:0", turret("spare", 900), true); });
    expect(seen!.pinned.has("t:0")).toBe(true);
    expect(seen!.assign["t:0"]).toBeTruthy();

    // Same class, different hull: its own bucket, so it starts clean.
    act(() => { root!.render(<Probe guid="ship-B" />); });
    expect(seen!.pinned.has("t:0")).toBe(false);
    expect(seen!.assign["t:0"]).toBeUndefined();
  });

  // The other half of bucketing: a plan is not DISCARDED by looking at another ship, which is what outfitting
  // several hulls in one sitting needs.
  it("keeps each ship's own plan when switching back and forth", () => {
    render("ship-A");
    act(() => { seen!.setSlotItem("t:0", turret("for-A", 900), true); });
    act(() => { root!.render(<Probe guid="ship-B" />); });
    act(() => { seen!.setSlotItem("t:0", turret("for-B", 800), true); });
    expect(seen!.assign["t:0"]?.name).toBe("for-B");

    act(() => { root!.render(<Probe guid="ship-A" />); });
    expect(seen!.assign["t:0"]?.name).toBe("for-A");
    expect(seen!.pinned.has("t:0")).toBe(true);

    act(() => { root!.render(<Probe guid="ship-B" />); });
    expect(seen!.assign["t:0"]?.name).toBe("for-B");
  });

  // The complement: a ship with no plan of its own DOES get one, so bucketing has not simply disabled suggestions.
  it("still suggests for a ship that has no plan yet", () => {
    localStorage.setItem("shipoptimizer.gearAuto", "true");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Probe guid="ship-A" />); });
    expect(seen!.assign["t:0"]?.name).toBe("spare");   // the optimizer's own answer, not an inherited one
    expect(seen!.pinned.has("t:0")).toBe(false);       // and a suggestion is not a pin
  });

  it("keeps the LOCK, which is persisted per ship on purpose", () => {
    render("ship-A");
    act(() => { seen!.toggleKeep("t:0"); });
    expect(seen!.keep.has("t:0")).toBe(true);

    // Ship B never locked that slot, so it must not inherit the lock either.
    act(() => { root!.render(<Probe guid="ship-B" />); });
    expect(seen!.keep.has("t:0")).toBe(false);

    // Back to A: its own lock is still there, because a lock is a lasting statement about one hull.
    act(() => { root!.render(<Probe guid="ship-A" />); });
    expect(seen!.keep.has("t:0")).toBe(true);
  });

  // Picking an item that the optimizer had proposed for ANOTHER slot takes it away from that slot (one
  // item, one slot). The freed slot must not be left blank silently.
  it("re-answers the slot a pick took an item from, and leaves the rest alone", () => {
    localStorage.setItem("shipoptimizer.gearAuto", "true");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<WideProbe />); });

    // The optimizer proposes the three spares across the three slots.
    const before = { ...seen!.assign };
    expect(Object.keys(before).sort()).toEqual(["t:0", "t:1", "t:2"]);
    const topSlot = Object.keys(before).find((key) => before[key].name === "top") as string;
    const otherSlot = Object.keys(before).find((key) => key !== topSlot && key !== "t:0") as string;

    // Pin "top" into a slot it was NOT proposed for, displacing it from topSlot.
    const target = ["t:0", "t:1", "t:2"].find((key) => key !== topSlot) as string;
    const untouched = ["t:0", "t:1", "t:2"].find((key) => key !== topSlot && key !== target) as string;
    const keptBefore = before[untouched]?.name;
    act(() => { seen!.setSlotItem(target, before[topSlot], true); });

    expect(seen!.assign[target]?.name).toBe("top");
    // The freed slot is answered, not blanked.
    expect(seen!.assign[topSlot]).toBeTruthy();
    expect(seen!.assign[topSlot]?.name).not.toBe("top");
    // And the slot that had nothing to do with it did not move.
    expect(seen!.assign[untouched]?.name).toBe(keptBefore);
    void otherSlot;
  });
});
