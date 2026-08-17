// The view layer: how a result is laid out, and the one rule it must never break — laying it out differently
// cannot change what the rules decided.
import { describe, it, expect } from "vitest";
import { evaluate, explain, whereFail, type Cats, type FieldCtx, type Rule } from "./sellRules";
import {
  compareRows, sanitizeView, sortRows, toggleSort, viewRows, viewTree,
} from "./sellView";
import type { Item } from "./types";

const ctx: FieldCtx = { cats: {} as Cats, myLevel: 60 };

const item = (over: Partial<Item>): Item => ({
  key: 1, slot: 1, identifier: "x", name: "Thing", rarity: "Standard", level: 60,
  size: "Small", slotType: "Hardpoint", type: "Mining Laser", category: "Turret", sellValue: 100,
  ...over,
} as Item);

// The reported case: a keep rule of four clauses over an armory whose reactors carry the wrong aspect.
const REACTOR = item({ key: 10, name: "Reactor Mk.XVI", type: "Reactor", slotType: "Reactor", size: "Large",
  category: "Module", rarity: "Exotic", level: 63, sellValue: 520_000, aspectSlots: 2,
  aspects: [{ name: "Repair Nanites" }] as Item["aspects"] });
const KEEPER = item({ key: 11, name: "Reactor Mk.XVIII", type: "Reactor", slotType: "Reactor", size: "Large",
  category: "Module", rarity: "Exotic", level: 71, sellValue: 640_000, aspectSlots: 2,
  aspects: [{ name: "Microgenerators" }] as Item["aspects"] });
const LOW = item({ key: 12, name: "Reactor Mk.XII", type: "Reactor", slotType: "Reactor", size: "Medium",
  category: "Module", rarity: "Exotic", level: 41, sellValue: 90_000, aspectSlots: 2,
  aspects: [{ name: "Microgenerators" }] as Item["aspects"] });

const RULE: Rule = {
  id: "r1",
  where: {
    lrel: { min: 0 },
    r: { values: ["Exotic", "Legendary"] },
    asp: { values: ["Microgenerators", "Solar Powered"] },
  },
  group: ["s"],
  order: { f: "v", dir: "desc" },
  take: null,
  having: null,
};

const ITEMS = [KEEPER, REACTOR, LOW];

describe("which clause turned an item away", () => {
  it("names the FIRST clause the item fails, not just that it failed", () => {
    // The reactor clears level and quality and fails on the aspect list — the clause the player would fix.
    expect(whereFail(REACTOR, RULE.where, ctx)).toBe("asp");
    expect(whereFail(LOW, RULE.where, ctx)).toBe("lrel");
    expect(whereFail(KEEPER, RULE.where, ctx)).toBe(null);
  });

  it("carries the reason into the split, so a 520K reactor can be found and asked about", () => {
    const ex = explain(RULE, ITEMS, ctx);
    const rows = viewRows(ex);
    const gone = rows.find((r) => r.it.name === "Reactor Mk.XVI");
    expect(gone?.bucket).toBe("excluded");
    expect(gone?.why).toBe("asp");
    expect(rows.find((r) => r.it.name === "Reactor Mk.XVIII")?.bucket).toBe("in");
  });

  it("has no reason to give when a rule has no clauses at all", () => {
    const ex = explain({ ...RULE, where: {} }, ITEMS, ctx);
    expect(ex.excluded).toHaveLength(0);
  });
});

describe("the layout the player chooses", () => {
  it("nests by the fields they picked, in their order", () => {
    const rows = viewRows(explain(RULE, ITEMS, ctx));
    const bySize = viewTree(rows, ["s", "r"], [], ctx);
    expect(bySize.map((n) => n.label)).toEqual(["Large", "Medium"]);
    expect(bySize[0].kids.map((n) => n.label)).toEqual(["Exotic"]);
    // Reordering the same two fields turns the tree inside out rather than producing something else.
    const byQuality = viewTree(rows, ["r", "s"], [], ctx);
    expect(byQuality.map((n) => n.label)).toEqual(["Exotic"]);
    expect(byQuality[0].kids.map((n) => n.label)).toEqual(["Large", "Medium"]);
  });

  it("counts every bucket at the node, so a group says what the default takes from it", () => {
    const rows = viewRows(explain(RULE, ITEMS, ctx));
    const large = viewTree(rows, ["s"], [], ctx).find((n) => n.label === "Large")!;
    expect(large.held).toBe(2);
    expect(large.nIn).toBe(1);
    expect(large.nExcluded).toBe(1);
    expect(large.credits).toBe(640_000 + 520_000);
  });

  it("sorts quality by RANK and text alphabetically, numbers as numbers", () => {
    const common = item({ key: 20, rarity: "Common", level: 9 });
    const exotic = item({ key: 21, rarity: "Exotic", level: 70 });
    expect(compareRows(common, exotic, [{ k: "r", dir: "desc" }], ctx)).toBeGreaterThan(0);
    expect(compareRows(common, exotic, [{ k: "l", dir: "asc" }], ctx)).toBeLessThan(0);
  });

  it("breaks a tie on the next sort key", () => {
    const a = item({ key: 30, rarity: "Exotic", level: 60, sellValue: 10 });
    const b = item({ key: 31, rarity: "Exotic", level: 60, sellValue: 90 });
    const keys = [{ k: "l" as const, dir: "asc" as const }, { k: "v" as const, dir: "desc" as const }];
    expect(compareRows(a, b, keys, ctx)).toBeGreaterThan(0);
  });

  it("keeps the rule's own row order while no sort key is in force", () => {
    const rows = viewRows(explain(RULE, ITEMS, ctx));
    expect(sortRows(rows, [], ctx)).toBe(rows);
  });

  it("toggles a column's direction, and shift keeps the keys already there", () => {
    const first = toggleSort([], "v", false);
    expect(first).toEqual([{ k: "v", dir: "desc" }]);       // a measure opens at its high end
    expect(toggleSort(first, "v", false)).toEqual([{ k: "v", dir: "asc" }]);
    expect(toggleSort(first, "r", true)).toEqual([{ k: "v", dir: "desc" }, { k: "r", dir: "asc" }]);
  });
});

describe("a view control never changes the answer", () => {
  it("leaves every verdict identical however the result is grouped and sorted", () => {
    const set = { defaultKind: "sell" as const, rules: [RULE], cats: {} as Cats, myLevel: 60 };
    const before = evaluate(ITEMS, set);
    for (const group of [[], ["s"], ["r", "s"], ["t"]])
      for (const sort of [[], [{ k: "v", dir: "desc" as const }], [{ k: "l", dir: "asc" as const }]]) {
        const rows = viewRows(explain(RULE, ITEMS, ctx));
        viewTree(rows, group, sort, ctx);
        expect(evaluate(ITEMS, set)).toEqual(before);
      }
  });
});

describe("a stored view outliving the build that wrote it", () => {
  it("drops fields this build does not have instead of refusing the layout", () => {
    const v = sanitizeView({ group: ["s", "notAField"], cols: ["l", "nope"], sort: [{ k: "v", dir: "desc" }, { k: "x", dir: "desc" }], hide: ["excluded", "nonsense"] });
    expect(v.group).toEqual(["s"]);
    expect(v.cols).toEqual(["l"]);
    expect(v.sort).toEqual([{ k: "v", dir: "desc" }]);
    expect(v.hide).toEqual(["excluded"]);
  });

  it("gives a fresh view every column it opens with, and hides nothing", () => {
    expect(sanitizeView(null).cols.length).toBeGreaterThan(0);
    expect(sanitizeView(null).hide).toEqual([]);
    expect(sanitizeView(undefined).group).toEqual([]);
  });
});
