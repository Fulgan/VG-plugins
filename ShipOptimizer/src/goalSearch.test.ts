import { describe, expect, it } from "vitest";
import { optimizeGearSet, goalAccepts, goalUnread, GOAL_KEYS, OBJECTIVE_TIE,
         type GoalKey, type GoalReading, type Rank, type SlotChoice } from "./fleetDps";
import type { Item } from "./types";

// Synthetic items: the ascent only ever compares what `score` returns, so an item needs an identity and the
// numbers the fake objective reads off it. Nothing here touches the real stat model on purpose — this file is
// about the ORDERING, and a test that also has to be right about pooling cannot fail for one reason.
const it_ = (id: string, dps: number, armor: number): Item =>
  ({ id, name: id, dps, armor } as unknown as Item);
const dpsOf = (x: Item) => (x as unknown as { dps: number }).dps;
const armorOf = (x: Item) => (x as unknown as { armor: number }).armor;

const slot = (key: string, candidates: Item[], current?: Item): SlotChoice => ({ key, candidates, current });

/** The set's figures, as a caller would read them off pools it had projected. */
const readingOf = (chosen: ReadonlyMap<string, Item>): GoalReading => {
  let dps = 0, armor = 0;
  for (const x of chosen.values()) { dps += dpsOf(x); armor += armorOf(x); }
  return { dps, armor };
};
const rankOf = (chosen: ReadonlyMap<string, Item>): Rank => [2, readingOf(chosen).dps ?? 0];

describe("an ordered goal inside the ascent", () => {
  it("separates two candidates the objective cannot, by the second key", () => {
    // Same DPS, different armor. Without an order the objective is indifferent and the incumbent stays; with
    // `armor` ranked, the set carrying more of it wins — which is the whole claim of.
    const thin = it_("thin", 100, 10);
    const thick = it_("thick", 100, 90);
    const slots = [slot("t:0", [thin, thick], thin)];
    const fitted = readingOf(new Map([["t:0", thin]]));

    const blind = optimizeGearSet({ slots, score: rankOf });
    expect(blind.get("t:0")).toBe(thin);          // indifferent ⇒ incumbency holds

    const ranked = optimizeGearSet({
      slots, score: rankOf,
      goal: { order: ["armor"], fitted, reading: (c) => readingOf(c) },
    });
    expect(ranked.get("t:0")).toBe(thick);
  });

  it("reads a lower key only where the higher one ties", () => {
    // `big` wins on DPS and loses on armor. With DPS ranked first it must win outright: armor is never consulted
    // where the first key already spoke, which is what makes an order not a weight.
    const big = it_("big", 200, 10);
    const tough = it_("tough", 100, 90);
    const slots = [slot("t:0", [big, tough], tough)];
    const fitted = readingOf(new Map([["t:0", tough]]));

    const chosen = optimizeGearSet({
      slots, score: rankOf,
      goal: { order: ["dps", "armor"], fitted, reading: (c) => readingOf(c) },
    });
    expect(chosen.get("t:0")).toBe(big);
  });

  it("refuses to displace the fitted item on a tie across every ranked key", () => {
    // Incumbency, and it comes from the comparison being STRICT rather than from a rule of its own.
    const a = it_("a", 100, 50);
    const b = it_("b", 100, 50);
    const slots = [slot("t:0", [a, b], a)];
    const fitted = readingOf(new Map([["t:0", a]]));

    const chosen = optimizeGearSet({
      slots, score: rankOf,
      goal: { order: ["dps", "armor"], fitted, reading: (c) => readingOf(c) },
    });
    expect(chosen.get("t:0")).toBe(a);
  });

  it("keeps the TIER above the player's order", () => {
    // A tier rise is a different JOB, not a bigger number, and no ordering of stats may overturn it: a set that
    // scores tier 1 must lose to one at tier 2 however good its armor is.
    const gun = it_("gun", 100, 0);
    const laser = it_("laser", 999, 999);
    const slots = [slot("t:0", [gun, laser], gun)];
    const tiered = (chosen: ReadonlyMap<string, Item>): Rank =>
      [chosen.get("t:0") === laser ? 1 : 2, readingOf(chosen).dps ?? 0];

    const chosen = optimizeGearSet({
      slots, score: tiered,
      goal: { order: ["armor"], fitted: { armor: 0 }, reading: (c) => readingOf(c) },
    });
    expect(chosen.get("t:0")).toBe(gun);
  });

  it("never picks a candidate the ranked key calls worse or equal when a better one is offered", () => {
    // A sign is EXACT and three-valued: every candidate above the band is simply "better on armor", so the
    // comparator does not order them among themselves and the objective's own scalar — equal here — is all that
    // is left. What is guaranteed is the boundary, not which of the improvers wins.
    const items = [it_("a", 100, 10), it_("b", 100, 40), it_("c", 100, 90), it_("d", 100, 25)];
    const fitted = readingOf(new Map([["t:0", items[0]]]));
    for (const perm of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]]) {
      const chosen = optimizeGearSet({
        slots: [slot("t:0", perm.map((i) => items[i]), items[0])],
        score: rankOf,
        goal: { order: ["armor"], fitted, reading: (c) => readingOf(c) },
      });
      expect((chosen.get("t:0") as unknown as { id: string }).id).not.toBe("a");
    }
  });

  it("is deterministic for a given candidate order", () => {
    // The comparator is a total preorder against a FIXED reference, so the same inputs answer the same way every
    // time — which is the property a coordinate ascent needs to converge. It is NOT a claim that the answer
    // survives a shuffle: ties are broken by incumbency and arrival, as they were before there was an order.
    const items = [it_("a", 100, 10), it_("b", 100, 40), it_("c", 100, 90)];
    const fitted = readingOf(new Map([["t:0", items[0]]]));
    const run = () => optimizeGearSet({
      slots: [slot("t:0", items, items[0])],
      score: rankOf,
      goal: { order: ["armor"], fitted, reading: (c) => readingOf(c) },
    }).get("t:0");
    expect(run()).toBe(run());
  });

  it("behaves exactly as before when the order is empty", () => {
    const small = it_("small", 100, 90);
    const large = it_("large", 300, 0);
    const slots = [slot("t:0", [small, large], small)];

    const blind = optimizeGearSet({ slots, score: rankOf });
    const empty = optimizeGearSet({
      slots, score: rankOf,
      goal: { order: [], fitted: { dps: 100 }, reading: (c) => readingOf(c) },
    });
    expect(empty.get("t:0")).toBe(blind.get("t:0"));
    expect(empty.get("t:0")).toBe(large);
  });
});

describe("goalAccepts — where the worth-it floor still applies", () => {
  const now: Rank = [2, 1000];

  it("uses the floor untouched when no order is stated", () => {
    // +0.5%: under MIN_GAIN, so not worth a hangar trip. Unchanged for a player who has stated nothing.
    expect(goalAccepts([], {}, {}, [2, 1005], now)).toBe(false);
    expect(goalAccepts([], {}, {}, [2, 1200], now)).toBe(true);
  });

  it("lets the band decide where a ranked key speaks, without consulting the floor", () => {
    // Armor is up decisively while the battery's own scalar moved less than MIN_GAIN. The floor would withhold
    // this; the order the player stated is what they asked to be optimised, so it is offered.
    const fitted: GoalReading = { armor: 100, dps: 1000 };
    const planned: GoalReading = { armor: 200, dps: 1002 };
    expect(goalAccepts(["armor"], fitted, planned, [2, 1002], now)).toBe(true);
  });

  it("refuses where the first key that speaks says worse, whatever the scalar does", () => {
    const fitted: GoalReading = { armor: 200, dps: 1000 };
    const planned: GoalReading = { armor: 100, dps: 2000 };
    expect(goalAccepts(["armor"], fitted, planned, [2, 2000], now)).toBe(false);
  });

  it("falls back to the floor when every ranked key tied", () => {
    // The objective is silent ∴ the tie-break may decide, and the floor is that tie-break.
    const fitted: GoalReading = { armor: 100 };
    const tied: GoalReading = { armor: 100 * (1 + OBJECTIVE_TIE / 2) };
    expect(goalAccepts(["armor"], fitted, tied, [2, 1005], now)).toBe(false);   // under the floor
    expect(goalAccepts(["armor"], fitted, tied, [2, 1200], now)).toBe(true);    // clears it
  });
});

describe("goalUnread — the keys a plan cannot answer", () => {
  it("names a ranked key missing from either reading", () => {
    expect(goalUnread(["combat", "armor"], { combat: 10 }, { combat: 12 })).toEqual(["armor"]);
  });

  it("says nothing about a key both sides can read, even when they are equal", () => {
    // Equal is a measurement; absent is not. Reporting a genuine tie here would turn a verdict into a gap.
    expect(goalUnread(["combat"], { combat: 10 }, { combat: 10 })).toEqual([]);
  });

  it("reports in the player's own order, not the vocabulary's", () => {
    const order: GoalKey[] = ["shield", "combat", "hull"];
    expect(goalUnread(order, { combat: 1 }, { combat: 1 })).toEqual(["shield", "hull"]);
  });

  it("covers every key the vocabulary offers", () => {
    // A key nothing can read is worse than a key nobody chose: it would sit in the list looking rankable.
    expect(goalUnread([...GOAL_KEYS], {}, {})).toEqual([...GOAL_KEYS]);
  });
});
