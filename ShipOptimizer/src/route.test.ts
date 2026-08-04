import { describe, expect, it } from "vitest";
import { reachFrom } from "./route";
import type { GalaxyEdge } from "./types";

const e = (from: string, to: string | null, usable = true): GalaxyEdge =>
  ({ from, to, gate: `${from}-${to}`, name: "gate", kind: "jump", crossSector: false, usable } as GalaxyEdge);

describe("reachFrom", () => {
  it("counts jumps along the shortest route", () => {
    const r = reachFrom([e("a", "b"), e("b", "c"), e("c", "d")], "a");
    expect(r.get("b")).toEqual({ hops: 1, locked: 0 });
    expect(r.get("d")).toEqual({ hops: 3, locked: 0 });
    expect(r.has("a")).toBe(false); // where you already are is not a destination
  });

  it("treats gates as two-way", () => {
    expect(reachFrom([e("b", "a")], "a").get("b")).toEqual({ hops: 1, locked: 0 });
  });

  it("prefers a longer open route over a short locked one", () => {
    // a→c directly but locked; a→b→c open. The open route is the honest distance.
    const r = reachFrom([e("a", "c", false), e("a", "b"), e("b", "c")], "a");
    expect(r.get("c")).toEqual({ hops: 2, locked: 0 });
  });

  it("reports the locks when there is no open route", () => {
    const r = reachFrom([e("a", "b"), e("b", "c", false)], "a");
    expect(r.get("c")).toEqual({ hops: 2, locked: 1 });
  });

  it("minimises locks before jumps", () => {
    // a→x→t needs two locks; a→p→q→r→t needs one. One lock, four jumps is the better answer.
    const r = reachFrom([
      e("a", "x", false), e("x", "t", false),
      e("a", "p"), e("p", "q"), e("q", "r"), e("r", "t", false),
    ], "a");
    expect(r.get("t")?.locked).toBe(1);
  });

  it("omits systems no route reaches, and ignores gates that leave the map", () => {
    const r = reachFrom([e("a", "b"), e("a", null), e("y", "z")], "a");
    expect(r.get("b")).toEqual({ hops: 1, locked: 0 });
    expect(r.has("z")).toBe(false);
  });

  it("returns nothing without a starting system", () => {
    expect(reachFrom([e("a", "b")], null).size).toBe(0);
  });

  // An older bridge sends no `usable` flag; distances must still work rather than reading as all-locked.
  it("treats a missing usable flag as usable", () => {
    const bare = { from: "a", to: "b", gate: "g", name: "n", kind: "jump", crossSector: false } as GalaxyEdge;
    expect(reachFrom([bare], "a").get("b")).toEqual({ hops: 1, locked: 0 });
  });
});
