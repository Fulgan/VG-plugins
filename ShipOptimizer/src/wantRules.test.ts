import { describe, it, expect } from "vitest";
import { isInert, newWant, ownedCounts, wantMatches, wantSentence, wantedBy, type WantRule } from "./wantRules";
import { wantedOpps } from "./opportunities";
import type { FieldCtx } from "./sellRules";
import type { Item } from "./types";

// The shopping list. It puts rows on the rail that has the buy buttons, so a rule that claims the wrong offer
// is a rule that points the player's credits at the wrong thing — and the two clauses that exist only here
// (price, copies owned) are the ones no sell-list test covers.

const offer = (over: Partial<Item> = {}): Item => ({
  key: 1, slot: 1, identifier: null, name: "Rail Cannon", rarity: "Legendary", level: 42, size: "Large",
  slotType: "Hardpoint", type: "Rail Cannon", category: "Turret", sellValue: 100, cost: 100_000,
  location: "shop:general", aspects: [], stats: [], substats: [], bonus: null, bonusStat: null,
  ...over,
} as unknown as Item);

const ctx = (owned: Record<string, number> = {}): FieldCtx => ({ cats: {}, myLevel: 40, owned });

const rule = (where: WantRule["where"]): WantRule => ({ id: "w1", where });

describe("a want rule", () => {
  it("matches nothing until it has a clause", () => {
    const empty = newWant("w1");
    expect(isInert(empty)).toBe(true);
    // The whole shop floor arriving on the rail the moment "add a want" is pressed reads as a broken feature.
    expect(wantMatches([offer(), offer({ name: "Cutter" })], empty, ctx())).toEqual([]);
    expect(wantedBy(offer(), [empty], ctx())).toBe(null);
  });

  it("narrows by the sell list's own clauses", () => {
    const r = rule({ r: { values: ["Legendary"] }, s: { values: ["Large"] } });
    expect(wantMatches([offer(), offer({ rarity: "Exotic" }), offer({ size: "Medium" })], r, ctx())).toHaveLength(1);
  });

  it("caps a price in credits and leaves a barter offer outside any cap", () => {
    const r = rule({ p: { max: 150_000 } });
    const cheap = offer({ cost: 90_000 });
    const dear = offer({ cost: 400_000 });
    // A barter offer prices itself in goods and reports no credit cost. Reading that absence as 0 would make it
    // the cheapest thing in the shop and let a credit cap claim it.
    const barter = offer({ cost: undefined, costItem: "VanguardMark", costItemCount: 12 });
    expect(wantMatches([cheap, dear, barter], r, ctx()).map((i) => i.cost)).toEqual([90_000]);
  });

  it("stops offering something once the shelf at home is full", () => {
    const r = rule({ t: { values: ["Rail Cannon"] }, own: { max: 1 } });
    expect(wantMatches([offer()], r, ctx({ "Rail Cannon": 1 }))).toHaveLength(1);
    expect(wantMatches([offer()], r, ctx({ "Rail Cannon": 2 }))).toHaveLength(0);
    // Nothing owned is the case a missing count must read as, not as "unknown, so skip it".
    expect(wantMatches([offer()], r, ctx())).toHaveLength(1);
  });

  it("asks for how many bonus lines, whichever they are — ticked like aspect slots", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ stat: "S" + i, amount: 1, multiplier: 1 }));
    const offers = [offer({ name: "bare", substats: [] }), offer({ name: "one", substats: lines(1) }),
                    offer({ name: "two", substats: lines(2) }), offer({ name: "three", substats: lines(3) })];
    // Several counts ticked read as OR, which is how "at least two" is said in a tick list.
    const r = rule({ subN: { values: ["2", "3"] } });
    expect(wantMatches(offers, r, ctx()).map((i) => i.name)).toEqual(["two", "three"]);
    expect(wantMatches(offers, rule({ subN: { values: ["2"] } }), ctx()).map((i) => i.name)).toEqual(["two"]);
    // An item with no bonus lines is a count of 0, not an absence, so `is not` reaches it.
    expect(wantMatches(offers, rule({ subN: { values: ["0"], not: true } }), ctx()).map((i) => i.name))
      .toEqual(["one", "two", "three"]);
    // The field is `substats count` in the picker so it cannot be read as `substat`; the sentence counts things.
    expect(wantSentence(r)).toBe("Flag anything on offer with 2 or 3 substats.");
    expect(wantSentence(rule({ subN: { values: ["1"] } }))).toBe("Flag anything on offer with 1 substat.");
  });

  it("says what it selects, in the words the editor wrote", () => {
    const r = rule({ r: { values: ["Legendary"] }, p: { max: 200_000 }, own: { max: 1 } });
    expect(wantSentence(r)).toBe(
      "Flag everything Legendary whose price is at most 200000 and that I already own at most 1 of.");
    expect(wantSentence(newWant("w1"))).toBe("Flag anything on offer.");
  });
});

describe("ownedCounts", () => {
  it("counts stacks by name, across every store", () => {
    const held = [
      offer({ name: "Rail Cannon", count: 2 }),
      offer({ name: "Rail Cannon" }),          // no count = one item
      offer({ name: "Cutter", count: 3 }),
    ];
    expect(ownedCounts(held)).toEqual({ "Rail Cannon": 3, Cutter: 3 });
  });
});

describe("wantedOpps", () => {
  const r = rule({ c: { values: ["Turret"] } });

  it("offers a match with no incumbent to beat, cheapest first", () => {
    const opps = wantedOpps([offer({ cost: 300_000 }), offer({ name: "Cutter", cost: 50_000 })], [r], ctx());
    expect(opps.map((o) => o.item.name)).toEqual(["Cutter", "Rail Cannon"]);
    expect(opps[0].replaces).toBeUndefined();
    expect(opps[0].delta).toBe(0);
    expect(opps[0].wanted).toContain("Flag everything Turret");
  });

  it("keeps one row per name, the cheapest of them", () => {
    const opps = wantedOpps([offer({ key: 1, cost: 120_000 }), offer({ key: 2, cost: 80_000 })], [r], ctx());
    expect(opps).toHaveLength(1);
    expect(opps[0].item.key).toBe(2);
  });

  it("leaves an offer the upgrade rows already carry to them", () => {
    // An upgrade row says strictly more about the same offer (what it displaces, and by how much), so two rows
    // for one item would be the rail contradicting itself.
    const opps = wantedOpps([offer()], [r], ctx(), new Set(["Rail Cannon"]));
    expect(opps).toEqual([]);
  });

  it("sorts a barter offer last rather than as though it were free", () => {
    const barter = offer({ name: "Marked Cannon", cost: undefined, costItem: "VanguardMark", costItemCount: 12 });
    const opps = wantedOpps([barter, offer({ cost: 300_000 })], [r], ctx());
    expect(opps.map((o) => o.item.name)).toEqual(["Rail Cannon", "Marked Cannon"]);
  });
});
