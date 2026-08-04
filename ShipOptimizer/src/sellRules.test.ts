// The sell model. Every test pins a rule the spec calls load-bearing, because this is the one objective in
// the app whose output spends something irreversibly.
import { describe, it, expect } from "vitest";
import {
  cantSell, clauses, defaultDir, evaluate, explain, exportList, listProblems, mergeCats, newRule,
  orderOptions, parseList, pinsUnit, proceeds, rankVal, sentence, subjectPhrase, typeOf,
  type FieldCtx, type Kind, type Rule, type RuleSet,
} from "./sellRules";
import type { Item } from "./types";

let seq = 0;
const gun = (o: Partial<Item> & { power?: number; mainStatName?: string } = {}): Item => {
  const power = o.power ?? 1000;
  return {
    key: seq++, slot: null, identifier: null, name: o.name ?? "gun",
    rarity: o.rarity ?? "Standard", level: o.level ?? 50, size: o.size ?? "Small",
    slotType: "Hardpoint", type: o.type ?? "Salvage Laser", category: o.category ?? "Turret",
    sellValue: o.sellValue ?? 100, gameplayType: o.gameplayType ?? "Salvage",
    mainStat: { name: o.mainStatName ?? "Salvage Power", amount: String(power) },
    stats: [], substats: [], aspects: [], bonus: null, bonusStat: null,
    location: "armory",
    ...o,
  } as unknown as Item;
};
const ctx: FieldCtx = { cats: {}, myLevel: 74 };
const rule = (over: Partial<Rule> = {}): Rule => ({ ...newRule("sell", "r1"), ...over });
const set = (defaultKind: Kind, rules: Rule[], extra: Partial<RuleSet> = {}): RuleSet =>
  ({ defaultKind, rules, cats: {}, myLevel: 74, ...extra });

describe("default stance and exceptions (V34)", () => {
  it("with no rules, everything takes the default", () => {
    const items = [gun(), gun(), gun()];
    expect(evaluate(items, set("keep", []))).toEqual(["keep", "keep", "keep"]);
    expect(evaluate(items, set("sell", []))).toEqual(["sell", "sell", "sell"]);
  });

  it("an item matched by an exception takes the OPPOSITE of the default", () => {
    const items = [gun({ name: "leg", rarity: "Legendary" }), gun({ name: "std", rarity: "Standard" })];
    const keepLeg = rule({ where: { r: { values: ["Legendary"] } } });
    expect(evaluate(items, set("sell", [keepLeg]))).toEqual(["keep", "sell"]);
  });

  // Two rules cannot disagree, because both say the same word — which is why there is no precedence.
  it("two exceptions matching one item agree by construction (a second rule is OR)", () => {
    const it0 = gun({ rarity: "Legendary", size: "Large" });
    const byRarity = rule({ id: "r1", where: { r: { values: ["Legendary"] } } });
    const bySize = rule({ id: "r2", where: { s: { values: ["Large"] } } });
    expect(evaluate([it0], set("sell", [byRarity, bySize]))).toEqual(["keep"]);
    expect(evaluate([it0], set("sell", [bySize, byRarity]))).toEqual(["keep"]);
  });
});

describe("the pipeline (V35)", () => {
  it("no TAKE means the filter decides alone", () => {
    const items = [gun({ level: 20 }), gun({ level: 80 })];
    const r = rule({ where: { l: { min: null, max: 59 } }, take: null });
    expect(evaluate(items, set("keep", [r]))).toEqual(["sell", "keep"]);
  });

  it("TAKE `except` spares the named end and acts on the rest", () => {
    const items = Array.from({ length: 6 }, (_, i) => gun({ name: `g${i}`, power: 1000 - i }));
    const r = rule({ take: { mode: "except", n: 2 }, order: { f: "m", dir: "desc" } });
    const v = evaluate(items, set("keep", [r]));
    expect(v.slice(0, 2)).toEqual(["keep", "keep"]);      // the two strongest spared
    expect(v.slice(2)).toEqual(["sell", "sell", "sell", "sell"]);
  });

  it("TAKE `only` acts on the named end", () => {
    const items = Array.from({ length: 4 }, (_, i) => gun({ name: `g${i}`, power: 1000 - i }));
    const r = rule({ take: { mode: "only", n: 1 }, order: { f: "m", dir: "asc" } });
    // lowest power is the LAST item; it alone is sold.
    expect(evaluate(items, set("keep", [r]))).toEqual(["keep", "keep", "keep", "sell"]);
  });

  it("GROUP BY partitions the count", () => {
    const a = Array.from({ length: 3 }, (_, i) => gun({ type: "Salvage Laser", power: 100 - i }));
    const b = Array.from({ length: 3 }, (_, i) => gun({ type: "Mining Laser", gameplayType: "Mining", power: 100 - i }));
    const r = rule({ take: { mode: "except", n: 1 }, group: ["t"], order: { f: "m", dir: "desc" } });
    const v = evaluate([...a, ...b], set("keep", [r]));
    // one spared PER TYPE, not one overall
    expect(v.filter((x) => x === "keep")).toHaveLength(2);
    expect(v.filter((x) => x === "sell")).toHaveLength(4);
  });

  // HAVING is not a count: `except 4` on a group of 3 quietly does nothing, where HAVING makes the whole
  // rule sit out.
  it("HAVING makes a rule sit out on a small group", () => {
    const items = Array.from({ length: 3 }, (_, i) => gun({ name: `g${i}`, power: 100 - i }));
    const r = rule({ take: { mode: "except", n: 1 }, having: { op: "gt", n: 5 }, order: { f: "m", dir: "desc" } });
    expect(evaluate(items, set("keep", [r]))).toEqual(["keep", "keep", "keep"]);
    const { groups } = explain(r, items, ctx);
    expect(groups[0].sitsOut).toBe(true);
  });
});

describe("the end of the ranking follows kind AND mode", () => {
  // Keying on kind alone made "sell everything except the 4" spare the four WORST and sell the good ones.
  it("only → the kind's own extreme; except → the other end", () => {
    expect(defaultDir("sell", "only")).toBe("asc");
    expect(defaultDir("sell", "except")).toBe("desc");
    expect(defaultDir("keep", "only")).toBe("desc");
    expect(defaultDir("keep", "except")).toBe("asc");
  });

  it("a sell rule with `except` spares the strongest", () => {
    const items = [gun({ name: "strong", power: 9000 }), gun({ name: "weak", power: 10 })];
    const r = rule({ take: { mode: "except", n: 1 }, order: { f: "m", dir: defaultDir("sell", "except") } });
    const v = evaluate(items, set("keep", [r]));
    expect(v[0]).toBe("keep");   // strongest spared
    expect(v[1]).toBe("sell");
  });
});

describe("power is comparable only inside one unit (V35)", () => {
  it("pinsUnit requires a type, activity or main-stat pin", () => {
    expect(pinsUnit(rule({ group: ["t", "s"] }))).toBe(true);
    expect(pinsUnit(rule({ group: ["s"] }))).toBe(false);
    expect(pinsUnit(rule({ group: ["s"], where: { a: { values: ["Salvage"] } } }))).toBe(true);
    expect(pinsUnit(rule({ group: ["s"], where: { a: { values: ["Salvage", "Mining"] } } }))).toBe(false);
  });

  it("power is not offered when no unit is pinned", () => {
    const items = [gun({ power: 10 }), gun({ power: 20, type: "Mining Laser", gameplayType: "Mining" })];
    const keys = orderOptions(rule({ group: ["s"] }), items, ctx).map(([k]) => k);
    expect(keys).not.toContain("m");
    expect(orderOptions(rule({ group: ["t"] }), items, ctx).map(([k]) => k)).toContain("m");
  });

  // A measure that never varies makes the cut arbitrary and says nothing about it.
  it("a constant measure is not offered", () => {
    const items = [gun({ level: 50 }), gun({ level: 50 })];
    expect(orderOptions(rule({ group: ["t"] }), items, ctx).map(([k]) => k)).not.toContain("l");
  });

  it("a saved rule whose measure went constant says so", () => {
    const items = [gun({ level: 50 }), gun({ level: 50 })];
    const r = rule({ take: { mode: "except", n: 1 }, order: { f: "l", dir: "desc" } });
    expect(clauses(r, "sell", items).some((c) => c.lead === "⚠")).toBe(true);
  });
});

describe("a booster's type is its main stat", () => {
  // Every booster reports type "Booster", so grouping by type alone pooled all of them.
  it("typeOf reports the main stat for boosters and the type for everything else", () => {
    const b = gun({ category: "Booster", type: "Booster", mainStatName: "Combat Power" });
    expect(typeOf(b)).toBe("Combat Power");
    expect(typeOf(gun({ type: "Railgun" }))).toBe("Railgun");
  });

  it("grouping by type separates boosters that share the type string", () => {
    const items = [
      gun({ name: "cp1", category: "Booster", type: "Booster", mainStatName: "Combat Power", power: 9 }),
      gun({ name: "cp2", category: "Booster", type: "Booster", mainStatName: "Combat Power", power: 8 }),
      gun({ name: "sh1", category: "Booster", type: "Booster", mainStatName: "Shield HP", power: 7 }),
    ];
    const { groups } = explain(rule({ take: { mode: "except", n: 1 }, group: ["t"] }), items, ctx);
    expect(groups).toHaveLength(2);
  });
});

describe("the sell guards (Hypercom V6)", () => {
  it("names the reason, favourite first", () => {
    expect(cantSell(gun({ favourite: true } as Partial<Item>))).toBe("favourited");
    expect(cantSell(gun({ canSell: false } as Partial<Item>))).toBe("the game refuses to sell it");
    expect(cantSell(gun({ missionItem: true } as Partial<Item>))).toBe("mission item");
    expect(cantSell(gun({ criticalItem: true } as Partial<Item>))).toBe("critical item");
    expect(cantSell(gun({ sellValue: 0 }))).toBe("no sell value");
    expect(cantSell(gun())).toBeNull();
  });

  // Protected items are out of the question entirely: not candidates, not "out", not "not selected".
  it("a protected item never enters a rule's candidate set", () => {
    const items = [gun({ name: "fav", favourite: true } as Partial<Item>), gun({ name: "ok" })];
    const r = rule({ take: null });
    const ex = explain(r, items, ctx);
    expect(ex.protected.map((i) => i.name)).toEqual(["fav"]);
    expect(ex.groups.flatMap((g) => g.rows).map((x) => x.it.name)).toEqual(["ok"]);
    expect(evaluate(items, set("keep", [r]))).toEqual(["cant", "sell"]);
  });

  it("credits count sold units only, and never a protected one", () => {
    const items = [gun({ sellValue: 50, count: 3 }), gun({ favourite: true, sellValue: 9999 } as Partial<Item>)];
    const v = evaluate(items, set("sell", []));
    expect(proceeds(items, v)).toBe(150);
  });
});

describe("reading it back", () => {
  it("the sentence is independent of the order conditions were added", () => {
    const a = rule({ where: { r: { values: ["Legendary"] }, l: { min: 50, max: null }, lrel: { min: -10, max: null } } });
    const b = rule({ where: { lrel: { min: -10, max: null }, l: { min: 50, max: null }, r: { values: ["Legendary"] } } });
    expect(subjectPhrase(a.where)).toBe(subjectPhrase(b.where));
  });

  it("the relative level clause borrows its noun only when the absolute one is absent", () => {
    expect(subjectPhrase({ lrel: { min: -10, max: null } })).toContain("whose level is no more than 10 below my level");
    const both = subjectPhrase({ l: { min: 50, max: null }, lrel: { min: -10, max: null } });
    expect(both).toContain("whose level is at least 50 and no more than 10 below my level");
    expect(both.match(/whose level is/g)).toHaveLength(1);
  });

  it("counts read most/fewest, magnitudes highest/lowest", () => {
    const byCount = rule({ take: { mode: "except", n: 2 }, order: { f: "aspN", dir: "desc" }, group: ["t"] });
    expect(sentence(byCount, "sell")).toContain("the 2 with the most aspect slots");
    const byPower = rule({ take: { mode: "except", n: 2 }, order: { f: "m", dir: "desc" }, group: ["t"] });
    expect(sentence(byPower, "sell")).toContain("the 2 with the highest power");
  });

  it("a filter's values join with or, a grouping with and", () => {
    expect(subjectPhrase({ r: { values: ["Exotic", "Legendary"] } })).toContain("Exotic or Legendary");
    expect(sentence(rule({ take: { mode: "except", n: 1 }, group: ["t", "s", "ms"] }), "sell"))
      .toContain("each type, size and main stat separately");
  });
});

describe("rankVal", () => {
  it("orders rarity by rank, not alphabetically", () => {
    expect(rankVal(gun({ rarity: "Legendary" }), "r")).toBeGreaterThan(rankVal(gun({ rarity: "Exotic" }), "r"));
    expect(rankVal(gun({ rarity: "Standard" }), "r")).toBe(0);
  });
});

// ---- portable lists --------------------------------------------------------------------------
describe("a saved rule list", () => {
  const catRule = (): Rule => ({
    id: "r1", where: { cat: { values: ["railguns"], not: false }, t: { values: ["Plasma Beam"], not: false } },
    group: [], order: { f: "l", dir: "asc" }, take: null, having: null,
  });

  it("exports the definitions of the categories its rules name, and nothing else", () => {
    const cats = { railguns: ["Railgun", "Heavy Railgun"], "long range": ["Sniper"] };
    const file = exportList("scrap", "keep", [catRule()], cats);
    expect(Object.keys(file.cats)).toEqual(["railguns"]); // "long range" is unreferenced ∴ not carried
    expect(file.cats.railguns).toEqual(["Railgun", "Heavy Railgun"]);
    expect(file.defaultKind).toBe("keep");
  });

  it("survives the trip through JSON", () => {
    const file = exportList("scrap", "sell", [catRule()], { railguns: ["Railgun"] });
    const { list, error } = parseList(JSON.parse(JSON.stringify(file)));
    expect(error).toBeNull();
    expect(list!.rules).toEqual(file.rules);
    expect(list!.cats).toEqual(file.cats);
  });

  it("refuses a file that is not one, rather than importing an empty rule set", () => {
    expect(parseList(null).list).toBeNull();
    expect(parseList({ rules: [] }).list).toBeNull();
    expect(parseList({ rules: [catRule()] }).error).toMatch(/default stance/);
    expect(parseList({ v: 99, defaultKind: "keep", rules: [catRule()] }).error).toMatch(/newer version/);
  });

  it("adds an unknown category but never overwrites one the player already defined", () => {
    const mine = { railguns: ["Railgun"] };
    const m = mergeCats(mine, { railguns: ["Something Else"], EMP: ["Ion Cannon"] });
    expect(m.cats.railguns).toEqual(["Railgun"]); // theirs loses: every other tab filters by mine
    expect(m.cats.EMP).toEqual(["Ion Cannon"]);
    expect(m.added).toEqual(["EMP"]);
    expect(m.kept).toEqual(["railguns"]);
  });

  it("names what a list cannot resolve here, per rule", () => {
    const items = [gun({ type: "Railgun" })];
    const probs = listProblems([catRule()], {}, items);
    expect(probs).toHaveLength(2);
    expect(probs[0]).toMatch(/no category named railguns/);
    expect(probs[1]).toMatch(/nothing of type Plasma Beam/);
    // with the category defined and the type owned, the same rule is silent
    expect(listProblems([catRule()], { railguns: ["Railgun"] },
      [gun({ type: "Railgun" }), gun({ type: "Plasma Beam" })])).toEqual([]);
  });
});
