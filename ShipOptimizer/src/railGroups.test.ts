import { describe, it, expect } from "vitest";
import { railGroups, GENERAL_BLOCK, UNNAMED_LIST, type Opp } from "./opportunities";

const row = (name: string, over: Partial<Opp> = {}): Opp =>
  ({ item: { name } as never, delta: 0, ...over }) as Opp;

// One flat column with the wants merely first made a player with four lists recognise their own rules row by row.
describe("splitting the shop rail into blocks", () => {
  it("names a block after the list that claimed it, and keeps the plain upgrades apart", () => {
    const g = railGroups([
      row("A", { wanted: "cheap reactors", wantNames: ["Reactors"] }),
      row("B", { wanted: "cheap reactors", wantNames: ["Reactors"] }),
      row("C", { delta: 500 }),
    ]);
    expect(g.map((x) => x.label)).toEqual(["Reactors", GENERAL_BLOCK]);
    expect(g[0].rows.map((r) => r.item.name)).toEqual(["A", "B"]);
    expect(g[0].wanted).toBe(true);
    expect(g[1].wanted).toBe(false);
  });

  // The same offer under two headings is the same item twice on one screen; the row already names every claim.
  it("puts an offer claimed twice under the first list only", () => {
    const g = railGroups([row("A", { wanted: "…", wantNames: ["Reactors", "Spares"] })]);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("Reactors");
  });

  it("gives an unnamed rule a bucket that does not pretend to be a name", () => {
    const g = railGroups([row("A", { wanted: "anything legendary" })]);
    expect(g[0].label).toBe(UNNAMED_LIST);
  });

  it("keeps the order the flat list already had", () => {
    const g = railGroups([
      row("A", { delta: 9 }),
      row("B", { wanted: "x", wantNames: ["Guns"] }),
    ]);
    expect(g.map((x) => x.label)).toEqual([GENERAL_BLOCK, "Guns"]);
  });
});
