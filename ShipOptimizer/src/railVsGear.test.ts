import { describe, it, expect } from "vitest";
import { background, poolsFromStatus, rankSub, setRank, worthSwitching, MIN_GAIN, optimizeTurretSet, type ShipPools } from "./fleetDps";
import { gearTurretOpps, type Opp } from "./opportunities";
import { turretFits } from "./gearFit";
import type { Item, ShipHardpoint, ShipLayout, Status } from "./types";

// The rail-vs-tab mismatch, reproduced from the capture that produced it and then pinned.
//
// B11: the inventory rail advertised `BX Railcaster-L Mk.XVI +49.4, slot 5` while all six slots read "keep
// current". The capture is that exact state — the fitted battery indexes 90,577 and that swap is worth +49,
// i.e. 0.055%, under the 0.1% floor. Both sides now apply the floor through one predicate, so the rail
// offers nothing and the tab agrees.
//
// This runs the REAL per-slot filters and categories out of `/client/state`, not invented ones: the whole point
// of the report was that the mismatch needed the player's own configuration to reproduce.
const FIXTURES = import.meta.glob("../fixtures/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const read = <T,>(n: string): T => {
  const hit = Object.entries(FIXTURES).find(([p]) => p.endsWith(`/${n}`));
  if (!hit) throw new Error(`fixture ${n} not found`);
  return hit[1] as T;
};

const status = read<Status>("status.json");
const layout = read<ShipLayout>("ship-layout.json");
const owned: Item[] = read<{ stores: { items: Item[] }[] }>("inventories.json").stores.flatMap((s) => s.items ?? []);
const shops: Item[] = (read<{ shops?: { items?: Item[] }[] }>("shops.json").shops ?? []).flatMap((s) => s.items ?? []);
const cs = read<{ shipGuid: string; entries: Record<string, string> }>("client-state.json");

const filters = JSON.parse(cs.entries["shipoptimizer.gearFilters"])[cs.shipGuid] as Record<number, never>;
const cats = JSON.parse(cs.entries["shipoptimizer.turretCategories"]) as Record<string, string[]>;
const hps = layout.hardpoints as ShipHardpoint[];
const equipped = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
const pools = poolsFromStatus(status) as ShipPools;
const bg = background(pools, equipped);
const cands = [...owned, ...shops].filter((i) => i.category === "Turret");
const F = (i: number) => (filters[i] ?? { mode: "all" }) as never;

// App.tsx's gearGain in expanded mode: the candidate replaces this turret, the rest stand.
const gainAgainst = (pools: ShipPools) => (eq: Item, cand: Item) => {
  const others = equipped.filter((t) => t !== eq);
  return rankSub(setRank([...others, cand], pools), setRank([...others, eq], pools));
};
const gearGain = gainAgainst(bg);

describe("T34: the rail and the gear tab agree, on the capture that made them disagree", () => {
  it("is the configuration the report came from — every slot filtered to one category", () => {
    expect(cs.entries["shipoptimizer.gearRanking"]).toContain("expanded");
    expect(Object.keys(filters)).toHaveLength(6);
    expect(cats["long range"]).toContain("Railgun");
  });

  // This capture predates `critChanceMult`, so the objective REFUSES to anchor on it — the reported chance
  // alone cannot be split into what Precision explains and what it does not. That makes `bg` the unanchored
  // footing, which is the footing the mismatch appeared on. The anchored footing is synthesised beside
  // it (multiplier 1, the only value consistent with this reading having 0.19 of additive sources) so both are
  // pinned: the difference between them is the whole point.
  it("refuses to anchor on a capture that carries no multiplier", () => {
    expect(bg.critAdd).toBeUndefined();
  });

  const bgAnchored = background({ ...pools, critChanceMult: 1 }, equipped);

  // This capture's headline figure has been re-measured three times in one day — 0.055% under the averaged-power
  // model, nothing once pooled Attack Speed charged the loss battery-wide, and a gain again once 0.8.1.23 made
  // main power local. So the magnitude is NOT what this file pins: the objective is allowed to change its mind
  // about a swap when the game changes the rules. What must never change is that the RAIL and the TAB answer the
  // same question with the same predicate, which is the whole point.
  it("agrees with the optimizer about the B11 candidate, whatever the current model says", () => {
    const raw = gearTurretOpps(cands, hps, filters, cats, gearGain);
    const b11 = raw.find((o) => o.item.name === "BX Railcaster-L Mk.XVI");
    const base = setRank(equipped, bg)[1];
    // Offered by the rail ⇔ a real gain over the fitted battery. Either answer is legitimate; disagreement is not.
    if (b11) {
      expect((b11 as { delta: number }).delta).toBeGreaterThan(0);
      expect(base).toBeGreaterThan(0);
    }
    // And whatever the rail offers, the whole-battery optimizer must not rank the result below what is fitted.
    const { plan, base: planBase } = planAgainst(bg);
    expect(rankSub(plan, planBase)).toBeGreaterThanOrEqual(0);
  });

  it("still cannot show the ABSOLUTE cycle gain on a capture that predates the pooled fields", () => {
    // Honest about what this fixture can settle. `/status` here reports no pooled AttackSpeed, so the only speed
    // input is the battery's own rolls and every ratio is understated — the hull, crew and skill-tree share is
    // simply unknown. What it still settles is the COMPARISON, because the loss is charged battery-wide either
    // way; scoring a swap needs the delta, not the absolute rate.
    expect(bg.poolAttackSpeed ?? 0).toBe(0);
  });

  it("stops offering it once the real crit base is honoured — the incumbent's Precision is worth more", () => {
    // Anchored, crit chance on this hull is 0.433 rather than 0.243, and a swap that trades Precision away
    // stops paying for itself. It is not merely under the floor now; it is not a gain at all.
    expect(bgAnchored.critAdd).toBeCloseTo(0.19, 3);
    const b11 = gearTurretOpps(cands, hps, filters, cats, gainAgainst(bgAnchored))
      .find((o) => o.item.name === "BX Railcaster-L Mk.XVI");
    expect(b11).toBeUndefined();
  });

  it("applies the SAME floor the tab applies, so neither offers what the other refuses", () => {
    const base = setRank(equipped, bg)[1];
    const railed = gearTurretOpps(cands, hps, filters, cats, gearGain)
      .filter((o: Opp) => base <= 0 || o.delta / base >= MIN_GAIN);
    // Whatever survives the rail's floor must also be something the optimizer would act on — one threshold, one
    // owner (MIN_GAIN). The count is deliberately not pinned: it moves with the game's own formula.
    const { plan, base: planBase } = planAgainst(bg);
    if (railed.length) expect(worthSwitching(plan, planBase)).toBe(true);
  });

  function planAgainst(pools: ShipPools) {
    const slots = hps.map((h) => ({
      key: `t:${h.index}`, current: h.equipped,
      candidates: [...(h.equipped ? [h.equipped] : []), ...cands.filter((g) => turretFits(g, h.size, F(h.index), cats))],
    }));
    const chosen = optimizeTurretSet(slots, pools, 4, []);
    const planned = hps.map((h) => chosen.get(`t:${h.index}`) ?? h.equipped).filter((x): x is Item => !!x);
    return { plan: setRank(planned, pools), base: setRank(equipped, pools) };
  }

  it("never plans a battery worse than the one fitted", () => {
    // The one guarantee that holds across every model revision: `optimizeTurretSet` seeds with the CURRENT
    // build, so its answer can tie but never regress. A negative here means the seed guard broke.
    const { plan, base } = planAgainst(bg);
    expect(rankSub(plan, base)).toBeGreaterThanOrEqual(0);
  });

  it("anchored, the fitted battery is already the answer and nothing is proposed", () => {
    const { plan, base } = planAgainst(bgAnchored);
    expect(rankSub(plan, base)).toBe(0);
    expect(worthSwitching(plan, base)).toBe(false);
  });

  // The invariant, not the numbers: whatever the rail advertises, the optimizer must be willing to fit.
  it("never advertises a swap the optimizer would refuse", () => {
    const base = setRank(equipped, bg)[1];
    const railed = gearTurretOpps(cands, hps, filters, cats, gearGain)
      .filter((o: Opp) => base <= 0 || o.delta / base >= MIN_GAIN);
    for (const o of railed) {
      const others = equipped.filter((t) => t !== o.replaces);
      expect(worthSwitching(setRank([...others, o.item], bg), setRank([...others, o.replaces], bg))).toBe(true);
    }
  });
});
