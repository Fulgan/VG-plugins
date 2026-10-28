// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useBans, itemSignature, reconciled } from "./bans";
import type { Item } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; });

const offer = (over: Partial<Item> = {}): Item => ({
  key: 7, slot: null, name: "Reactor Mk.XVI", rarity: "Standard", level: 64, size: "Large",
  category: "Module", location: "shop", sellValue: 0, aspects: [], stats: [], substats: [],
  bonus: null, bonusStat: null, mainStat: { name: "Energy", amount: "20,000" },
  ...over,
} as unknown as Item);

// The state a ban lives in has to answer the NEXT render, or a row the player refused is still on the rail.
describe("the ban set as a component sees it", () => {
  it("reads back as banned on the render after the click", () => {
    const it0 = offer();
    const seen: boolean[] = [];
    let click: () => void = () => {};
    function Probe() {
      const bans = useBans("ship-1");
      seen.push(bans.has(it0, "fit"));
      click = () => bans.toggle(it0, "fit");
      return <span>{String(bans.has(it0, "fit"))}</span>;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    expect(seen[0]).toBe(false);
    act(() => click());
    expect(host.textContent).toBe("true");
    act(() => click());
    expect(host.textContent).toBe("false");
  });

  // "Not on this ship" is the whole statement, so the set has to carry the ship. ONE hook instance, the ship
  // changed under it: two instances could never see each other's state and would pass whatever the code did.
  it("keeps one ship's refusals off another", () => {
    const it0 = offer();
    let toggle: () => void = () => {};
    let seen = false;
    function Probe({ ship }: { ship: string }) {
      const bans = useBans(ship);
      toggle = () => bans.toggle(it0, "fit");
      seen = bans.has(it0, "fit");
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe ship="ship-a" />));
    act(() => toggle());
    expect(seen).toBe(true);
    act(() => root!.render(<Probe ship="ship-b" />));
    expect(seen).toBe(false);
    act(() => root!.render(<Probe ship="ship-a" />));
    expect(seen).toBe(true);
  });
});

// An officer is refused by guid, and one rule covers both kinds: a crew member's guid is stable so the ban
// follows the person, while a recruit's dies with the roster it was rolled into.
describe("refusing an officer", () => {
  it("reads back on the next render and is scoped to the ship", () => {
    const o = { guid: "off-1", name: "Alice Cain" };
    let toggle: () => void = () => {};
    let seen = false;
    function Probe({ ship }: { ship: string }) {
      const bans = useBans(ship);
      toggle = () => bans.toggleOfficer(o, "fit");
      seen = bans.hasOfficer(o, "fit");
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe ship="ship-a" />));
    act(() => toggle());
    expect(seen).toBe(true);
    act(() => root!.render(<Probe ship="ship-b" />));
    expect(seen).toBe(false);
  });

  // An officer guid and an item key share one store, so the prefix is what stops them colliding.
  it("does not collide with an item's key", () => {
    const it0 = offer();
    let banItem: () => void = () => {};
    let officerSeen = false;
    function Probe() {
      const bans = useBans("ship-a");
      banItem = () => bans.toggle(it0, "fit");
      officerSeen = bans.hasOfficer({ guid: it0.name }, "fit");
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    act(() => banItem());
    expect(officerSeen).toBe(false);
  });
});

// Each surface counts what IT hides, so the control beside that count must lift the same set and no more.
describe("lifting part of the ban list", () => {
  it("leaves the bans another list is holding", () => {
    const a = offer({ name: "Reactor Mk.XVI" } as never);
    const b = offer({ name: "Engine Mk.XVI" } as never);
    let banBoth: () => void = () => {};
    let liftA: () => void = () => {};
    let seen: [boolean, boolean] = [false, false];
    function Probe() {
      const bans = useBans("ship-a");
      banBoth = () => { bans.toggle(a, "fit"); bans.toggle(b, "fit"); };
      liftA = () => bans.liftAll([`fit:${itemSignature(a)}`]);
      seen = [bans.has(a, "fit"), bans.has(b, "fit")];
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    act(() => banBoth());
    expect(seen).toEqual([true, true]);
    act(() => liftA());
    expect(seen).toEqual([false, true]);
  });
});

// A refusal is checked against the WORLD, not a clock: the app knows what the player holds and what they have
// fitted, so an entry can be judged by whether the thing it names still exists.
describe("reconciling a refusal against what the player has", () => {
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const at = (t: number) => ({ n: "Reactor Mk.XVI", t });

  it("lifts a refusal of something now fitted", () => {
    const out = reconciled({ s: { sig: at(Date.now()) } }, "s",
                           { held: new Set(["sig"]), fitted: new Set(["sig"]), ready: true });
    expect(out.s).toEqual({});
  });

  it("keeps a refusal of something still held, however old", () => {
    const old = at(Date.now() - 400 * day);
    const out = reconciled({ s: { sig: old } }, "s",
                           { held: new Set(["sig"]), fitted: new Set(), ready: true });
    expect(out.s.sig).toEqual(old);
  });

  // Sold, dropped, or a shop offer the restock rerolled: nothing it could match exists any more.
  it("spends a refusal of something nowhere to be found, after the grace hour", () => {
    const world = { held: new Set<string>(), fitted: new Set<string>(), ready: true };
    expect(reconciled({ s: { sig: at(Date.now() - 30 * 60_000) } }, "s", world).s.sig).toBeDefined();
    expect(reconciled({ s: { sig: at(Date.now() - 2 * hour) } }, "s", world).s).toEqual({});
  });

  // A fetch in flight is not an empty world; pruning against one would lift refusals for a loading spinner.
  it("changes nothing while the payloads are still arriving", () => {
    const all = { s: { sig: at(Date.now() - 400 * day) } };
    expect(reconciled(all, "s", { held: new Set(), fitted: new Set(), ready: false })).toBe(all);
  });
});


// The two questions are separate: "never fit this" and "stop pointing this out" are refused, counted and lifted
// apart, or clearing one list empties the other.
describe("the question a refusal answers", () => {
  it("keeps fit and notice apart on the same item", () => {
    const it0 = offer();
    let banFit: () => void = () => {};
    let seen: [boolean, boolean] = [false, false];
    function Probe() {
      const bans = useBans("ship-a");
      banFit = () => bans.toggle(it0, "fit");
      seen = [bans.has(it0, "fit"), bans.has(it0, "notice")];
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    act(() => banFit());
    expect(seen).toEqual([true, false]);
  });

  // The one control that existed before the split lived on the gear pool, so that is what its entries meant.
  it("reads a key saved before the split as a fit refusal", () => {
    const it0 = offer();
    localStorage.setItem("shipoptimizer.bans",
      JSON.stringify({ "ship-a": { [itemSignature(it0)]: { n: "old", t: Date.now() } } }));
    let seen: [boolean, boolean] = [false, false];
    function Probe() {
      const bans = useBans("ship-a");
      seen = [bans.has(it0, "fit"), bans.has(it0, "notice")];
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    expect(seen).toEqual([true, false]);
    localStorage.clear();
  });
});
