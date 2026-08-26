// @vitest-environment jsdom
//
// A CREW SLOT PIN NAMES A PERSON *AND* A PLACE, which is the whole difference between it and the roster's ★.
// The optimizer takes a flat set of guids and picks a crew; nothing in it knows about slot 3. So the pin lives
// beside that set, feeds into it, and then overrides where the answer is DRAWN, and the two halves have to
// agree, because the star and the slot card both claim to report the same decision.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useOfficerBuilder, type BuilderShip, type OfficerBuilder } from "./OfficersTab";
import type { Officer } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
  localStorage.clear();
});

const officer = (guid: string, skills: string[]): Officer => ({
  guid, name: guid, callsign: "", profession: "Combat", rarity: "Standard", level: 60, gender: "Male",
  icon: null, chosenBonus: "",
  current: skills.map((id) => ({ id, name: id, tier: 1, major: false })),
  potential: skills.map((id) => ({ id, name: id, tier: 1, major: false })),
});

/** Mount the real hook and hand back a live handle to it. */
function mount(roster: Officer[], ship: BuilderShip): () => OfficerBuilder {
  let latest: OfficerBuilder | null = null;
  function Probe() {
    latest = useOfficerBuilder(roster, [ship], ship.guid);
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return () => latest!;
}

const SHIP: BuilderShip = { guid: "S1", name: "Test", role: null, slots: 2, hasDroneBay: true, hasHangarBay: false, defenseLayer: null, assigned: [null, null] };
const ROSTER = [officer("A", ["s1"]), officer("B", ["s1"]), officer("C", [])];

describe("crew slot pins", () => {
  it("a pinned officer reaches the optimizer, because `forced` is the union of both pin surfaces", () => {
    const get = mount(ROSTER, SHIP);
    // C covers nothing, so the comparator would never choose it on its own.
    expect(get().result!.chosen.map((o) => o.guid)).not.toContain("C");
    act(() => get().pinSlot(1, "C"));
    expect(get().forced.has("C")).toBe(true);
    expect(get().result!.chosen.map((o) => o.guid)).toContain("C");
    expect(get().slotPins.get(1)).toBe("C");
  });

  it("pinning an officer already pinned elsewhere MOVES them, one of each exists", () => {
    const get = mount(ROSTER, SHIP);
    act(() => get().pinSlot(0, "C"));
    act(() => get().pinSlot(1, "C"));
    expect([...get().slotPins.entries()]).toEqual([[1, "C"]]);
    // One pin, so one forced guid: a stale second entry would ask for the same person twice and cost a slot.
    expect([...get().forced]).toEqual(["C"]);
  });

  it("clearing a slot releases the officer from `forced` as well", () => {
    const get = mount(ROSTER, SHIP);
    act(() => get().pinSlot(0, "C"));
    act(() => get().pinSlot(0, null));
    expect(get().slotPins.size).toBe(0);
    expect(get().forced.has("C")).toBe(false);
  });

  it("every forced officer names a slot", () => {
    // The roster used to carry a second way to force an officer, a star that said WHO without saying WHERE, so
    // `forced` was a union of two sources and the two could disagree. There is one source now.
    const get = mount(ROSTER, SHIP);
    act(() => get().pinSlot(0, "C"));
    expect([...get().forced]).toEqual(["C"]);
    expect([...get().slotPins.values()]).toEqual(["C"]);
    act(() => get().pinSlot(0, null));
    expect(get().forced.size).toBe(0);
  });

  it("a pin past the end of a shorter slot count is dropped, not left unreachable", () => {
    const get = mount(ROSTER, SHIP);
    act(() => get().pinSlot(1, "C"));
    act(() => root!.unmount());
    root = null;

    // Same ship guid, one slot fewer: the stored pin at index 1 has no card to release it from.
    const get2 = mount(ROSTER, { ...SHIP, slots: 1, assigned: [null] });
    expect(get2().slotPins.size).toBe(0);
    expect(get2().forced.has("C")).toBe(false);
  });

  it("pins survive a remount, which is what makes them a decision rather than a gesture", () => {
    const get = mount(ROSTER, SHIP);
    act(() => get().pinSlot(1, "C"));
    act(() => root!.unmount());
    root = null;

    const get2 = mount(ROSTER, SHIP);
    expect(get2().slotPins.get(1)).toBe("C");
    expect(get2().result!.chosen.map((o) => o.guid)).toContain("C");
  });
});
