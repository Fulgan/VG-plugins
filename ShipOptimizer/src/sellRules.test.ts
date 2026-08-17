// The sell model. Every test pins a rule the spec calls load-bearing, because this is the one objective in
// the app whose output spends something irreversibly.
import { describe, it, expect } from "vitest";
import {
  cantSell, clauses, defaultDir, evaluate, explain, exportList, FIELDS, freeKey, listProblems, mergeCats, needCount, newRule,
  NO_VALUE, REL_EXACT, isRelExact, orderOptions, parseList, pinsUnit, proceeds, rankVal, relAbs, relBound, relFixed,
  relFixedQ, relTermOf, sentence, setCondFor, setQOf, setQWords, SET_QS, subjectPhrase, typeOf, valueLabel,
  fieldVaries,
  type FieldCtx, type Kind, type Rule, type RuleSet, type SetCond,
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

describe("an item that serves no activity", () => {
  // The trap the user hit: "keep everything whose activity is Combat, Mining or Salvage" cannot match a
  // reactor, so the default stance sells every module and booster and the rule never mentioned them.
  const mod = gun({ name: "reactor", category: "Module", type: "Reactor", gameplayType: null, mainStatName: "Power" });
  const cannon = gun({ name: "cannon", category: "Turret", type: "Railgun", gameplayType: "Combat" });

  it("falls outside a rule that names the activities — the matcher does not guess", () => {
    const keepCombat = rule({ where: { a: { values: ["Combat"], not: false } } });
    expect(evaluate([cannon, mod], set("sell", [keepCombat]))).toEqual(["keep", "sell"]);
  });

  it("is a value the rule CAN name, and it reads as what it is", () => {
    const keepBoth = rule({ where: { a: { values: ["Combat", "Other"], not: false } } });
    expect(evaluate([cannon, mod], set("sell", [keepBoth]))).toEqual(["keep", "keep"]);
    // "Other" is a stored key and stays one; what the player reads says which items it means.
    expect(valueLabel("a", "Other")).toBe("no activity (modules, boosters)");
    expect(subjectPhrase({ a: { values: ["Other"], not: false } })).toContain("no activity");
    expect(valueLabel("t", "Other")).toBe("Other");     // only the activity field means it this way
  });
});

describe("a field an item has NONE of", () => {
  it("is `none`, so a rule can name it instead of sweeping those items silently", () => {
    const kinetic = gun({ name: "k", damageType: "Kinetic" });
    const noDamage = gun({ name: "mod", category: "Module", type: "Reactor", damageType: null });
    const keepKinetic = rule({ where: { dt: { values: ["Kinetic"], not: false } } });
    expect(evaluate([kinetic, noDamage], set("sell", [keepKinetic]))).toEqual(["keep", "sell"]);
    const keepBoth = rule({ where: { dt: { values: ["Kinetic", NO_VALUE], not: false } } });
    expect(evaluate([kinetic, noDamage], set("sell", [keepBoth]))).toEqual(["keep", "keep"]);
  });
});

// Several values in one clause used to be OR and nothing else, so "carries BOTH of these" had to be built out
// of inverted clauses — the reason `all` exists. Negation interacts with it, and the two negations are
// different questions: none of them, versus missing at least one.
describe("several values in one clause: OR, AND, and their negations", () => {
  const subs = (name: string, ...stats: string[]) =>
    gun({ name, substats: stats.map((stat) => ({ stat, amount: 1, multiplier: 1 })) } as Partial<Item>);
  const both = subs("both", "Armor HP", "Shield HP");
  const one = subs("one", "Armor HP");
  const neither = subs("neither", "Hull HP");
  const items = [both, one, neither];
  const verdicts = (where: Rule["where"]) =>
    items.map((it) => evaluate([it], set("sell", [rule({ where })]))[0] === "keep");

  it("OR takes any one of them, AND takes only every one", () => {
    expect(verdicts({ sub: { values: ["Armor HP", "Shield HP"] } })).toEqual([true, true, false]);
    expect(verdicts({ sub: { values: ["Armor HP", "Shield HP"], all: true } })).toEqual([true, false, false]);
  });

  it("a negated OR is none of them; a negated AND is missing at least one", () => {
    expect(verdicts({ sub: { values: ["Armor HP", "Shield HP"], not: true } })).toEqual([false, false, true]);
    expect(verdicts({ sub: { values: ["Armor HP", "Shield HP"], all: true, not: true } })).toEqual([false, true, true]);
  });

  it("takes a threshold: at least N of them, and fewer than N of them", () => {
    const three = subs("three", "Armor HP", "Shield HP", "Hull HP");
    const two = subs("two", "Armor HP", "Shield HP");
    const list = ["Armor HP", "Shield HP", "Hull HP"];
    const on = (where: Rule["where"], items: Item[]) =>
      items.map((it) => evaluate([it], set("sell", [rule({ where })]))[0] === "keep");
    expect(on({ sub: { values: list, need: 2 } }, [three, two, one, neither])).toEqual([true, true, false, false]);
    // Its negation is the other side of the same threshold, which is what "fewer than" says.
    expect(on({ sub: { values: list, need: 2, not: true } }, [three, two, one, neither])).toEqual([false, false, true, true]);
  });

  it("names each reading in the words the control offers", () => {
    const list = ["Armor HP", "Shield HP", "Hull HP"];
    const q = (c: Partial<SetCond>) => setQOf({ values: list, ...c });
    expect(q({})).toBe("any");
    expect(q({ need: "all" })).toBe("all");
    expect(q({ need: 2 })).toBe("atLeast");
    expect(q({ not: true })).toBe("none");
    expect(q({ not: true, need: "all" })).toBe("notAll");
    expect(q({ not: true, need: 2 })).toBe("fewer");
    // The words are the player's, not the model's: no NOT, no AND, no arithmetic to compose.
    expect(SET_QS.map((x) => setQWords(x, true))).toEqual([
      "has any of", "has all of", "has at least", "has none of", "is missing at least one of", "has fewer than"]);
    // A one-value field can only be one of them or not, and says so without the plural machinery.
    expect(setQWords("any", false)).toBe("is one of");
    expect(setQWords("none", false, true)).toBe("is not");
    // Picking a reading writes the clause that reading means, and reading it back returns the same reading.
    for (const x of SET_QS) expect(setQOf(setCondFor(x, { values: list }, 2))).toBe(x);
    // `all` follows the LIST: ticking a fourth value still means every one, where a stored 3 would not.
    const all = setCondFor("all", { values: list });
    expect(needCount({ ...all, values: [...list, "Energy Resistance"] })).toBe(4);
  });

  it("says which mode it is in, and never says 'none' for a negated AND", () => {
    const list = ["Armor HP", "Shield HP", "Hull HP"];
    expect(subjectPhrase({ sub: { values: list, need: 2 } }))
      .toBe("everything I own with at least 2 of Armor HP, Shield HP or Hull HP");
    expect(subjectPhrase({ sub: { values: list, need: 2, not: true } }))
      .toBe("everything I own with fewer than 2 of Armor HP, Shield HP or Hull HP");
    expect(subjectPhrase({ asp: { values: list, need: 2 } }))
      .toBe("everything I own carrying at least 2 of Armor HP, Shield HP or Hull HP");
    const vals = ["Armor HP", "Shield HP"];
    expect(subjectPhrase({ sub: { values: vals } })).toBe("everything I own with Armor HP or Shield HP");
    expect(subjectPhrase({ sub: { values: vals, all: true } })).toBe("everything I own with Armor HP and Shield HP");
    expect(subjectPhrase({ sub: { values: vals, not: true } })).toBe("everything I own without Armor HP or Shield HP");
    expect(subjectPhrase({ sub: { values: vals, all: true, not: true } }))
      .toBe("everything I own missing at least one of Armor HP and Shield HP");
    // One value is one value: `all` cannot make a negation read as a shortfall of a single thing.
    expect(subjectPhrase({ sub: { values: ["Armor HP"], all: true, not: true } }))
      .toBe("everything I own without Armor HP");
    expect(subjectPhrase({ asp: { values: vals, all: true } })).toBe("everything I own carrying Armor HP and Shield HP");
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

describe("the main stat AMOUNT clause", () => {
  it("selects on the EFFECTIVE headline, and reads as a floor", () => {
    // `ms` says WHICH stat the headline is; this says what it is WORTH — "any gun over 11K Combat Power".
    const weak = gun({ name: "weak", power: 9_000 });
    const strong = gun({ name: "strong", power: 12_000 });
    const r = rule({ where: { mv: { min: 11_000, max: null } } });
    expect(evaluate([weak, strong], set("keep", [r]))).toEqual(["keep", "sell"]);
    expect(subjectPhrase(r.where)).toBe("everything I own whose main stat amount is at least 11000");
  });

  it("is a floor by CONSTRUCTION, since a ceiling would ask for a weaker item", () => {
    expect(FIELDS.mv.onlyMin).toBe(true);
    expect(FIELDS.mv.kind).toBe("range");
  });
});

describe("several clauses over one field", () => {
  const withSubs = (...subs: string[]) =>
    gun({ substats: subs.map((stat) => ({ stat, amount: 1, multiplier: 1 })) });

  it("ANDs them, which one ticked list cannot say at any threshold", () => {
    // "any of crit AND any of rate" — a single clause over all three values is an OR, and `need: 2` over it
    // also accepts the two crit stats together.
    const r = rule({ where: {
      sub: { values: ["Crit Chance", "Crit Damage"] },
      "sub#2": { values: ["Fire Rate"] },
    } });
    const both = withSubs("Crit Damage", "Fire Rate");
    const critOnly = withSubs("Crit Chance", "Crit Damage");
    const rateOnly = withSubs("Fire Rate");
    expect(evaluate([both, critOnly, rateOnly], set("keep", [r]))).toEqual(["sell", "keep", "keep"]);
  });

  it("names the clause that turned an item away, not just its field", () => {
    const r = rule({ where: {
      sub: { values: ["Crit Chance"] },
      "sub#2": { values: ["Fire Rate"] },
    } });
    const ex = explain(r, [withSubs("Crit Chance"), withSubs("Fire Rate")], ctx);
    expect(ex.excluded.map((x) => x.k)).toEqual(["sub#2", "sub"]);
  });

  it("mints a key that leaves every clause already there alone", () => {
    expect(freeKey({}, "sub")).toBe("sub");
    expect(freeKey({ sub: { values: ["a"] } }, "sub")).toBe("sub#2");
    expect(freeKey({ sub: { values: ["a"] }, "sub#2": { values: ["b"] } }, "sub")).toBe("sub#3");
    expect(freeKey({ "sub#2": { values: ["b"] } }, "sub")).toBe("sub");
  });

  it("says each of them, since the adjective form would read as one clause's own OR", () => {
    // "everything Legendary, Exotic" is what ONE clause reading `any` already says, so a repeated field is
    // worded instead of stacked into the noun phrase.
    const s = subjectPhrase({ r: { values: ["Legendary"] }, "r#2": { values: ["Exotic"], not: true } });
    expect(s).toBe("everything I own whose quality is Legendary and whose quality is not Exotic");
    expect(subjectPhrase({ sub: { values: ["Crit Chance"] }, "sub#2": { values: ["Fire Rate"] } }))
      .toBe("everything I own with Crit Chance and with Fire Rate");
  });

  it("carries every clause's categories into a saved list, and reports every unresolved one", () => {
    const r = rule({ where: { cat: { values: ["EMP"] }, "cat#2": { values: ["burst"] } } });
    const cats = { EMP: ["Ion Cannon"], burst: ["Salvage Laser"] };
    expect(exportList("l", "keep", [r], cats).cats).toEqual(cats);
    expect(listProblems([r], { EMP: ["Ion Cannon"] }, [gun()])[0]).toContain("burst");
  });
});

describe("reading it back", () => {
  it("the sentence is independent of the order conditions were added", () => {
    const a = rule({ where: { r: { values: ["Legendary"] }, l: { min: 50, max: null }, lrel: { min: -10, max: null } } });
    const b = rule({ where: { lrel: { min: -10, max: null }, l: { min: 50, max: null }, r: { values: ["Legendary"] } } });
    expect(subjectPhrase(a.where)).toBe(subjectPhrase(b.where));
  });

  it("the relative level clause borrows its noun only when the absolute one is absent", () => {
    expect(subjectPhrase({ lrel: { min: -10, max: null } })).toContain("whose level is at most 10 below my level");
    const both = subjectPhrase({ l: { min: 50, max: null }, lrel: { min: -10, max: null } });
    expect(both).toContain("whose level is at least 50 and at most 10 below my level");
    expect(both.match(/whose level is/g)).toHaveLength(1);
  });

  it("says a relative bound the way the editor writes it, and round trips", () => {
    // "at least 10 below" is the FAR side of me, `max: -10`; "at most 10 below" is the near one, `min: -10`.
    expect(relBound({ q: "at least", n: 10, dir: "below" })).toEqual({ side: "max", value: -10 });
    expect(relBound({ q: "at most", n: 10, dir: "below" })).toEqual({ side: "min", value: -10 });
    expect(relBound({ q: "at least", n: 2, dir: "above" })).toEqual({ side: "min", value: 2 });
    expect(relBound({ q: "at most", n: 2, dir: "above" })).toEqual({ side: "max", value: 2 });
    expect(relTermOf({ min: null, max: -10 }, "max")).toEqual({ q: "at least", n: 10, dir: "below" });
    expect(relTermOf({ min: -10, max: null }, "min")).toEqual({ q: "at most", n: 10, dir: "below" });
    expect(relTermOf({ min: null, max: null }, "min")).toBeNull();
  });

  it("reads a distance of ZERO off the bound, since the sign cannot carry it", () => {
    // `min: 0` is "my level or above", `max: 0` is "or below" — both store the same number.
    expect(relBound({ q: "at least", n: 0, dir: "above" })).toEqual({ side: "min", value: 0 });
    expect(relBound({ q: "at least", n: 0, dir: "below" })).toEqual({ side: "max", value: 0 });
    expect(relTermOf({ min: 0, max: null }, "min")).toEqual({ q: "at least", n: 0, dir: "above" });
    expect(relTermOf({ min: null, max: 0 }, "max")).toEqual({ q: "at least", n: 0, dir: "below" });
    expect(subjectPhrase({ lrel: { min: 0, max: null } })).toContain("at or above my own level");
  });

  it("the distance-free readings are the quantifier's own, and inclusive of my level", () => {
    expect(relFixed("at or below")).toEqual({ min: null, max: 0 });
    expect(relFixed("at or above")).toEqual({ min: 0, max: null });
    expect(relFixed("at least")).toBeNull();                    // this one needs a distance
    expect(relFixedQ({ min: null, max: 0 })).toBe("at or below");
    expect(relFixedQ({ min: null, max: -10 })).toBeNull();
    expect(subjectPhrase({ lrel: { min: null, max: 0 } })).toContain("at or below my own level");
    // inclusive: my own level is in, one above is not
    const mine = gun({ level: 74 }), over = gun({ level: 75 });
    expect(evaluate([mine, over], set("keep", [rule({ where: { lrel: { min: null, max: 0 } } })])))
      .toEqual(["sell", "keep"]);
  });

  it("MY OWN LEVEL is one reading, not two bounds that happen to agree", () => {
    expect(isRelExact({ min: 0, max: 0 })).toBe(true);
    expect(isRelExact({ min: 0, max: null })).toBe(false);
    expect(subjectPhrase({ lrel: { ...REL_EXACT } })).toContain("exactly my own level");
    expect(relAbs({ ...REL_EXACT }, 60)).toBe("= Lv 60");
    // and it still selects what it says
    const mine = gun({ level: 74 }), under = gun({ level: 73 });
    expect(evaluate([mine, under], set("keep", [rule({ where: { lrel: { ...REL_EXACT } } })])))
      .toEqual(["sell", "keep"]);
  });

  it("resolves a relative clause into the levels a player can read off the column", () => {
    expect(relAbs({ min: null, max: -10 }, 60)).toBe("= Lv 50 or less");
    expect(relAbs({ min: -10, max: null }, 60)).toBe("= Lv 50 or more");
    expect(relAbs({ min: -5, max: 5 }, 60)).toBe("= Lv 55–65");
    expect(relAbs({ min: null, max: -70 }, 60)).toBe("= Lv 1 or less");   // levels start at 1
    expect(relAbs({ min: null, max: null }, 60)).toBe("");
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

// RESONANCE clauses. The game feature is BETA-ONLY (`ResonantBooster` is absent from the release build, so the
// bridge sends `resonance: null` for every item) ∴ these fields must disappear from the picker on their own, by
// the same `fieldVaries` mechanism that keeps `price` out of a list of things you already own — a build check kept
// beside them would be a second thing to update when the feature ships.
describe("resonance clauses", () => {
  const boost = (r: Partial<NonNullable<Item["resonance"]>> | null, over: Partial<Item> = {}): Item => gun({
    category: "Booster", type: "Booster", mainStatName: "Combat Power",
    resonance: r ? { unlocked: false, progress: 0, threshold: 100, unit: "kills", bonusStat: "Reload Speed", ...r } : undefined,
    ...over,
  } as Partial<Item> & { power?: number; mainStatName?: string });

  it("reads the three states a player acts on differently, plus none at all", () => {
    const state = (it: Item) => FIELDS.res.get(it, ctx);
    expect(state(boost(null))).toBe("none");
    expect(state(boost({ progress: 0 }))).toBe("unstarted");
    expect(state(boost({ progress: 40 }))).toBe("in progress");
    expect(state(boost({ progress: 100, unlocked: true }))).toBe("finished");
  });

  it("offers the bonus stat and the unit it needs, so a want can say what it will finish", () => {
    const b = boost({ bonusStat: "Reload Speed", unit: "ore" });
    expect(FIELDS.resS.get(b, ctx)).toBe("Reload Speed");
    expect(FIELDS.resU.get(b, ctx)).toBe("ore");
  });

  it("reports progress as a PERCENTAGE, the only figure comparable between units", () => {
    // 1 per kill against a credit count: raw progress across two units means nothing.
    expect(FIELDS.resP.get(boost({ progress: 25, threshold: 100 }), ctx)).toBe(25);
    expect(FIELDS.resP.get(boost({ progress: 5_000, threshold: 20_000, unit: "profit" }), ctx)).toBe(25);
    expect(FIELDS.resP.get(boost(null), ctx)).toBe(0);
  });

  it("selects on state, and a rule that says `finished` leaves the rest alone", () => {
    const done = boost({ progress: 100, unlocked: true }, { name: "done" });
    const part = boost({ progress: 50 }, { name: "part" });
    const plain = boost(null, { name: "plain" });
    const r = rule({ where: { res: { values: ["finished"] } } });
    expect(evaluate([done, part, plain], set("keep", [r]))).toEqual(["sell", "keep", "keep"]);
  });

  it("selects on progress as a range", () => {
    const low = boost({ progress: 10 }, { name: "low" });
    const high = boost({ progress: 90 }, { name: "high" });
    expect(evaluate([low, high], set("keep", [rule({ where: { resP: { min: 50, max: null } } })])))
      .toEqual(["keep", "sell"]);
  });

  // THE BETA GUARD, and it is the whole reason these are ordinary fields: on a build without the feature every
  // item answers the same, so the picker drops all four without knowing the feature exists.
  it("offers nothing at all on a build with no resonance", () => {
    const release = [boost(null), boost(null)];
    for (const k of ["res", "resS", "resU", "resP"]) expect(fieldVaries(release, k, ctx), k).toBe(false);
  });

  it("offers each clause as soon as it has something to tell apart", () => {
    // `res` and `resP` answer for EVERY item ("none", 0) ∴ one resonant booster among plain ones is enough.
    const oneResonant = [boost(null), boost({ progress: 50 })];
    expect(fieldVaries(oneResonant, "res", ctx)).toBe(true);
    expect(fieldVaries(oneResonant, "resP", ctx)).toBe(true);
    // `resS`|`resU` are ABSENT on a non-resonant item rather than "none", and `fieldVaries` counts values that
    // exist ∴ they appear once two different bonuses or units are in front of the player, which is the
    // point at which ticking one of them narrows anything.
    expect(fieldVaries(oneResonant, "resS", ctx)).toBe(false);
    const twoBonuses = [boost({ bonusStat: "Reload Speed", unit: "kills" }), boost({ bonusStat: "Shield HP", unit: "ore" })];
    expect(fieldVaries(twoBonuses, "resS", ctx)).toBe(true);
    expect(fieldVaries(twoBonuses, "resU", ctx)).toBe(true);
  });
});
