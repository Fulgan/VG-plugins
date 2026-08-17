// Which layers a build can REACH, and why it has to be measured over what the hull can mount.
//
// Reported from live play: every hardpoint on a mining ship read "kept — best of 24" and the optimizer never
// proposed a core gun. The chain is worth stating because no single step looks wrong: all slots on
// `Mining - mixed` leave every slot's layer role `any` → the ship target becomes `balanced` → a balanced target
// scores `min(surface, core)` → with only surface guns fitted that is 0 → nothing can beat 0 → every slot is
// "kept". The degrade rule exists to break exactly that chain, and it was measuring the wrong set.
import { describe, expect, it } from "vitest";
import { reachableLayers, type GearFilter } from "./gearFit";
import type { Item } from "./types";

const gun = (over: Partial<Item>): Item => ({
  key: 1, slot: null, identifier: null, name: "gun", rarity: "Standard", level: 60,
  size: "Small", type: "Mining Cutter", category: "Turret", slotType: "Hardpoint",
  gameplayType: "Mining", targetLayer: "Surface", sellValue: 0,
  mainStat: { name: "Mining Power", amount: "1000" },
  stats: [], substats: [], aspects: [], bonus: null, bonusStat: null,
  ...over,
} as unknown as Item);

const MIXED: GearFilter = { mode: "activity", value: "Mining" };
const CORE_ONLY: GearFilter = { mode: "activity", value: "Mining-core" };
const smallSlots = (n: number, filter: GearFilter = MIXED) =>
  Array.from({ length: n }, () => ({ size: "Small", filter }));

describe("reachableLayers", () => {
  it("reports both layers when the ship can mount a gun for each", () => {
    const r = reachableLayers("Mining", [], [
      gun({ targetLayer: "Surface" }), gun({ targetLayer: "Core" }),
    ], smallSlots(2), {});
    expect(r).toEqual({ surface: true, core: true });
  });

  // THE BUG: a Large core drill in the armory of a hull with only Small hardpoints. Counting it made the app
  // demand a balance the ship could not field, and the whole tab went silent.
  it("does not count a gun the hull has no slot for", () => {
    const r = reachableLayers("Mining", [gun({ targetLayer: "Surface" })], [
      gun({ targetLayer: "Core", size: "Large" }),
    ], smallSlots(3), {});
    expect(r.core).toBe(false);
    expect(r.surface).toBe(true);
  });

  it("does not count a gun the slot's own filter refuses", () => {
    // Every slot pinned to core, and the only core gun is... there is none; a surface gun cannot be mounted there.
    const r = reachableLayers("Mining", [], [gun({ targetLayer: "Surface" })], smallSlots(2, CORE_ONLY), {});
    expect(r).toEqual({ surface: false, core: false });
  });

  it("counts what is FITTED whatever a filter now says", () => {
    // A gun already on the hull is mounted — a filter changed afterwards does not unmount it, and pretending the
    // ship cannot reach that layer would misreport the build in front of the player.
    const r = reachableLayers("Mining", [gun({ targetLayer: "Core" })], [], smallSlots(1, CORE_ONLY), {});
    expect(r.core).toBe(true);
  });

  it("treats a Both gun as covering either layer", () => {
    const r = reachableLayers("Mining", [], [gun({ targetLayer: "Both" })], smallSlots(1), {});
    expect(r).toEqual({ surface: true, core: true });
  });

  it("ignores guns of another activity", () => {
    const r = reachableLayers("Mining", [], [
      gun({ gameplayType: "Salvage", targetLayer: "Core", type: "Salvage Beam" }),
    ], smallSlots(2), {});
    expect(r.core).toBe(false);
  });

  it("reaches nothing with no slots at all", () => {
    const r = reachableLayers("Mining", [], [gun({ targetLayer: "Core" })], [], {});
    expect(r).toEqual({ surface: false, core: false });
  });
});
