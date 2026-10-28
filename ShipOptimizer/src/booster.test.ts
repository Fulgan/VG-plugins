import { describe, it, expect } from "vitest";
import {
  boosterScore, boosterType, boosterValue, defaultSlotTypes, optimizeBoosters, resonanceCredit, resonanceLive,
  boosterPinKey, dominates, swapVerdict, resonanceBase, resonanceBases, RESONANCE_WEIGHT, type BoosterCtx,
} from "./booster";
import { DEFAULT_PROFILE } from "./activityPresets";
import type { Item, Resonance } from "./types";

function booster(stat: string, amount: string): Item {
  return {
    key: null, slot: null, identifier: null, name: `${stat} booster`, rarity: "Standard", level: 1,
    size: null, type: `${stat} R-Booster`, category: "Booster", sellValue: 0,
    aspects: [], stats: [], substats: [], bonus: null, bonusStat: null,
    mainStat: { name: stat, amount },
  };
}

describe("booster optimizer", () => {
  it("classifies type by main stat and parses value (flat + percent)", () => {
    expect(boosterType(booster("Combat Power", "1,257"))).toBe("Combat Power");
    expect(boosterValue(booster("Combat Power", "1,257"))).toBe(1257);
    expect(boosterValue(booster("Officer Bonus", "6.25%"))).toBe(6.25);
  });

  it("fills each slot with the highest-value unused booster of its type", () => {
    const pool = [
      booster("Combat Power", "1000"), booster("Combat Power", "1500"),
      booster("Mining Power", "800"),
    ];
    const { picks } = optimizeBoosters(pool, ["Combat Power", "Combat Power", "Mining Power"]);
    expect(picks.map((p) => p.value)).toEqual([1500, 1000, 800]); // top-2 combat, then mining
    expect(picks[0].chosen).not.toBe(picks[1].chosen); // no reuse
  });

  it("empty slots default to the ship-role booster type", () => {
    const pool = [booster("Combat Power", "1000"), booster("Mining Power", "800")];
    const types = defaultSlotTypes([null, null], 2, "Mining", pool);
    expect(types).toEqual(["Mining Power", "Mining Power"]);
  });

  it("keeps the equipped booster's type on occupied slots", () => {
    const pool = [booster("Combat Power", "1000")];
    const types = defaultSlotTypes([booster("Combat Power", "900"), null], 2, "Mining", pool);
    expect(types[0]).toBe("Combat Power"); // kept from equipped
  });

  it("keeps an equipped booster over an equal-value armory one (no phantom swap)", () => {
    // Same type, same value. The equipped one must stay put rather than being displaced for a tiebreak.
    const eq = { ...booster("Combat Power", "1000"), location: "equipped", slot: 0 };
    const armory = { ...booster("Combat Power", "1000"), location: "armory", key: 5 };
    const { picks } = optimizeBoosters([armory, eq], ["Combat Power"]); // armory listed first on purpose
    expect(picks[0].chosen).toBe(eq);
  });
});

// Resonance, priced against the ship. The mechanics are the game's own (`the internal notes`,
// 0.8.1.23): the bonus pays `clamp01(progress/threshold)` of itself from the first point earned, and progress
// accrues only while the booster is FITTED on the player's ship — so what it pays today and what it will pay
// once flown are two different questions, and the player picks which is being asked.
describe("resonance", () => {
  const res = (over: Partial<Resonance> = {}): Resonance => ({
    unlocked: false, progress: 0, threshold: 100, unit: "kills", bonus: "+2.22% Reload Speed",
    bonusStat: "Reload Speed", ...over,
  });
  const withRes = (stat: string, amount: string, r: Resonance | null): Item =>
    ({ ...booster(stat, amount), resonance: r ?? undefined });
  const combat: BoosterCtx = {
    scope: "current", profile: { ...DEFAULT_PROFILE, main: "combat" },
    fit: { role: "Combat", activities: ["Combat"] },
  };

  it("pays a fraction of the bonus from the first point earned, not on unlock", () => {
    expect(resonanceLive(res({ progress: 0 }))).toBe(0);
    expect(resonanceLive(res({ progress: 50 }))).toBe(0.5);
    expect(resonanceLive(res({ progress: 100, unlocked: true }))).toBe(1);
    // and it stops growing at the threshold, as `AddProgress` clamps it in game
    expect(resonanceLive(res({ progress: 250, unlocked: true }))).toBe(1);
  });

  it("credits a half-progressed booster half of what a finished one gets", () => {
    const half = resonanceCredit(withRes("Combat Power", "1000", res({ progress: 50 })), combat);
    const done = resonanceCredit(withRes("Combat Power", "1000", res({ progress: 100, unlocked: true })), combat);
    expect(half.credit).toBeCloseTo(done.credit / 2, 6);
    expect(done.credit).toBeGreaterThan(0);
  });

  // The whole point of the two readings: nothing progresses in the armory, so "what will this be worth" is the
  // question that answers "what should I equip".
  it("credits the WHOLE bonus under potential, and only what is live under current", () => {
    const fresh = withRes("Combat Power", "1000", res({ progress: 0 }));
    expect(resonanceCredit(fresh, combat).credit).toBe(0);
    expect(resonanceCredit(fresh, { ...combat, scope: "potential" }).credit).toBeGreaterThan(0);
  });

  // A promise nobody can keep: an ore threshold on a hull with no mining gun never progresses, and crediting it
  // would rank that booster above one already paying.
  it("refuses potential credit for a unit this ship cannot generate, and says why", () => {
    const ore = withRes("Combat Power", "1000", res({ unit: "ore", progress: 0 }));
    const c = resonanceCredit(ore, { ...combat, scope: "potential" });
    expect(c.credit).toBe(0);
    expect(c.why).toContain("ore");
    // the same booster on a hull that mines DOES get the promise
    const miner: BoosterCtx = { ...combat, scope: "potential", profile: { ...DEFAULT_PROFILE, main: "mining" } };
    expect(resonanceCredit(ore, miner).credit).toBeGreaterThan(0);
  });

  // `profit` and `absorbed` come off a player-global bus, so any hull earns them while the booster is fitted.
  it("treats the player-global units as reachable on any hull", () => {
    for (const unit of ["profit", "absorbed"]) {
      const b = withRes("Cargo Capacity", "500", res({ unit, progress: 0 }));
      const hauler: BoosterCtx = { ...combat, scope: "potential", fit: { role: "Cargo", activities: [] } };
      expect(resonanceCredit(b, hauler).credit, unit).toBeGreaterThan(0);
    }
  });

  it("drops the credit for a blacklisted bonus stat, keeping the booster itself pickable", () => {
    const b = withRes("Combat Power", "1000", res({ progress: 100, unlocked: true }));
    const ctx: BoosterCtx = { ...combat, blacklist: new Set(["Reload Speed"]) };
    expect(resonanceCredit(b, ctx).credit).toBe(0);
    expect(resonanceCredit(b, ctx).why).toContain("blacklisted");
    // and it is still worth its raw main stat — a strong booster is still a strong booster
    expect(boosterScore(b, ctx)).toBe(1000);
  });

  it("gives no credit for a bonus the hull cannot use at all", () => {
    const drone = withRes("Combat Power", "1000", res({ progress: 100, unlocked: true, bonusStat: "Drone Power" }));
    const noBay: BoosterCtx = { ...combat, fit: { role: "Combat", activities: ["Combat"], hasDroneBay: false } };
    expect(resonanceCredit(drone, noBay).credit).toBe(0);
    expect(resonanceCredit(drone, noBay).why).toContain("Drone Power");
  });

  it("weights a bonus on the ship's own role stat above an incidental one", () => {
    const finished = res({ progress: 100, unlocked: true });
    const onRole = withRes("Combat Power", "1000", { ...finished, bonusStat: "Combat Power" });
    const offRole = withRes("Combat Power", "1000", { ...finished, bonusStat: "Shield HP" });
    expect(resonanceCredit(onRole, combat).credit).toBeGreaterThan(resonanceCredit(offRole, combat).credit);
  });

  // The scored figure and the shown figure are allowed to differ, but neither may quietly be the other.
  it("keeps the raw value out of the score, and the score out of the card", () => {
    const b = withRes("Combat Power", "1000", res({ progress: 100, unlocked: true }));
    expect(boosterValue(b)).toBe(1000);
    expect(boosterScore(b, combat)).toBeGreaterThan(1000);
    expect(boosterScore(b)).toBe(1000);         // no ship, no resonance reading
  });

  it("lets resonance decide between two boosters of the same type and value", () => {
    const plain = withRes("Combat Power", "1000", null);
    const resonant = withRes("Combat Power", "1000", res({ progress: 100, unlocked: true }));
    const { picks } = optimizeBoosters([plain, resonant], ["Combat Power"], undefined, combat);
    expect(picks[0].chosen).toBe(resonant);
    expect(picks[0].value).toBe(1000);          // the card still says what the booster is
    expect(picks[0].score).toBeGreaterThan(1000);
  });

  it("still prefers a much stronger booster with no resonance at all", () => {
    const strong = withRes("Combat Power", "2000", null);
    const weakResonant = withRes("Combat Power", "1000", res({ progress: 100, unlocked: true }));
    const { picks } = optimizeBoosters([strong, weakResonant], ["Combat Power"], undefined, combat);
    expect(picks[0].chosen).toBe(strong);
  });

  it("ranks the same as before when no ship context is given", () => {
    const a = withRes("Combat Power", "1500", null);
    const b = withRes("Combat Power", "1000", res({ progress: 100, unlocked: true }));
    expect(optimizeBoosters([a, b], ["Combat Power"]).picks[0].chosen).toBe(a);
  });
});

// The role match used to be a substring test against the role's own NAME, which worked for Combat by luck of the
// naming and for nothing else.
describe("defaultSlotTypes by role", () => {
  const pool = [
    booster("Combat Power", "3000"), booster("Salvage Power", "800"),
    booster("Cargo Capacity", "500"), booster("Mining Power", "900"),
  ];
  it("finds the type for every role the game has, not just Combat", () => {
    expect(defaultSlotTypes([null], 1, "Salvaging", pool)[0]).toBe("Salvage Power");
    expect(defaultSlotTypes([null], 1, "Cargo", pool)[0]).toBe("Cargo Capacity");
    expect(defaultSlotTypes([null], 1, "Mining", pool)[0]).toBe("Mining Power");
    expect(defaultSlotTypes([null], 1, "Combat", pool)[0]).toBe("Combat Power");
  });
  it("falls back to the pool's strongest type for a role with no stat of its own", () => {
    expect(defaultSlotTypes([null], 1, "Generic", pool)[0]).toBe("Combat Power");
  });
});

// A hull is what it CARRIES, not what its role label says — the reading `shipFit` gives every other optimizer.
describe("a ship judged by its fit rather than its role", () => {
  const res = (over: Partial<Resonance> = {}): Resonance => ({
    unlocked: false, progress: 0, threshold: 100, unit: "ore", bonus: "+2% Mining Power",
    bonusStat: "Mining Power", ...over,
  });
  const b = { ...booster("Combat Power", "1000"), resonance: res() } as Item;

  it("credits an ore resonance on a COMBAT hull that carries a mining laser", () => {
    const byRole: BoosterCtx = {
      scope: "potential", profile: { ...DEFAULT_PROFILE, main: "combat" }, fit: { role: "Combat", activities: [] },
    };
    const byFit: BoosterCtx = { ...byRole, fit: { role: "Combat", activities: ["Combat", "Mining"] } };
    // Judged by the label alone the threshold is unreachable AND the bonus stat is called inert — both wrong.
    expect(resonanceCredit(b, byRole).credit).toBe(0);
    expect(resonanceCredit(b, byFit).credit).toBeGreaterThan(0);
  });

  it("still refuses it on a hull that carries nothing of the kind", () => {
    const hauler: BoosterCtx = {
      scope: "potential", profile: { ...DEFAULT_PROFILE, main: "combat" }, fit: { role: "Cargo", activities: [] },
    };
    const c = resonanceCredit(b, hauler);
    expect(c.credit).toBe(0);
    // Two reasons are true here — the bonus stat is inert AND the unit is unreachable — and the STAT one is
    // reported, because it is the stronger statement: the bonus would do nothing even if it finished.
    expect(c.why).toContain("Mining Power");
  });
});

describe("a pin survives the apply that satisfies it", () => {
  // A PIN IS AN ANSWER, AND APPLYING IT MUST NOT UNDO IT. Pins used to be keyed by `boosterId`, which carries
  // the store the booster was sitting in. The moment the player applied the pinned booster it moved from
  // `cargo` to `equipped`, its id changed, the pin stopped resolving, and the optimizer went back to choosing
  // freely for a slot whose badge still read `pinned`.
  const withPlace = (b: Item, location: string, slot: number | null = null): Item =>
    ({ ...b, location, slot } as Item);

  it("resolves against the equipped copy after the pinned booster is fitted", () => {
    const chosen = booster("Drone Power", "1781");
    const rival = booster("Combat Power", "1600");
    // Before: the pick sits in cargo. The pin is keyed on what was CHOSEN.
    const before = optimizeBoosters([withPlace(chosen, "cargo"), withPlace(rival, "cargo")],
      ["Combat Power"], undefined, undefined, undefined, new Map([[0, boosterPinKey(chosen)]]));
    expect(before.picks[0].chosen?.name).toBe(chosen.name);

    // After the apply the same booster is equipped in that slot, and nothing else may take it.
    const after = optimizeBoosters([withPlace(chosen, "equipped", 0), withPlace(rival, "cargo")],
      ["Combat Power"], undefined, undefined, undefined, new Map([[0, boosterPinKey(chosen)]]));
    expect(after.picks[0].chosen?.name).toBe(chosen.name);
    expect(after.picks[0].pinUnresolved).toBeFalsy();
  });

  it("says so when the pinned booster is gone, instead of quietly optimizing the slot", () => {
    const rival = booster("Combat Power", "1600");
    const { picks } = optimizeBoosters([withPlace(rival, "cargo")], ["Combat Power"],
      undefined, undefined, undefined, new Map([[0, "Gone booster:9:Legendary"]]));
    // Silence here is the defect: the badge says pinned while a different booster is proposed.
    expect(picks[0].pinUnresolved).toBe(true);
    expect(picks[0].chosen).toBeNull();
  });
});

// Displacing a booster that has ALREADY earned its resonance. Two of one type reach the same ceiling, so under
// the full-potential reading the bonus is credited to both, cancels, and the raw main stat decides: without a
// second reading, a few points of headline buy away a finished bonus and the whole threshold has to be re-flown.
describe("a swap that would destroy earned resonance", () => {
  const res = (progress: number): Resonance => ({
    unlocked: progress >= 794, progress, threshold: 794, unit: "kills",
    bonus: "+4.89% Combat Power", bonusStat: "Combat Power",
  });
  const combat: BoosterCtx = {
    scope: "potential", profile: { ...DEFAULT_PROFILE, main: "combat" },
    fit: { role: "Combat", activities: ["Combat"] },
  };
  const fitted = (amount: string, r: Resonance | null): Item =>
    ({ ...booster("Combat Power", amount), resonance: r ?? undefined, location: "equipped", slot: 0 });
  const spare = (amount: string, r: Resonance | null): Item =>
    ({ ...booster("Combat Power", amount), resonance: r ?? undefined, location: "armory", key: 7 });

  it("keeps the incumbent over a larger booster that has earned nothing", () => {
    const eq = fitted("1666", res(794));
    const cand = spare("1675", res(0));
    expect(dominates(cand, eq, combat)).toBe(false);
    expect(optimizeBoosters([cand, eq], ["Combat Power"], undefined, combat).picks[0].chosen).toBe(eq);
  });

  it("takes a candidate that wins under BOTH readings", () => {
    const eq = fitted("1666", res(794));
    const cand = spare("4000", res(0));
    expect(dominates(cand, eq, combat)).toBe(true);
    expect(optimizeBoosters([cand, eq], ["Combat Power"], undefined, combat).picks[0].chosen).toBe(cand);
  });

  // The case the two readings exist FOR, and it has to keep working: nothing progresses in the armory, so an
  // incumbent with no progress of its own loses nothing and the promise is still worth ranking on.
  it("leaves the full-potential reading alone where the incumbent has nothing to lose", () => {
    const eq = fitted("1666", null);
    const cand = spare("1675", res(0));
    expect(dominates(cand, eq, combat)).toBe(true);
    expect(optimizeBoosters([cand, eq], ["Combat Power"], undefined, combat).picks[0].chosen).toBe(cand);
  });

  it("judges a newcomer against nothing while a slot of its type is still free", () => {
    const eq = fitted("1666", res(794));
    const cand = spare("1675", res(0));
    const { picks } = optimizeBoosters([cand, eq], ["Combat Power", "Combat Power"], undefined, combat);
    expect(picks.map((p) => p.chosen)).toContain(cand);
    expect(picks.map((p) => p.chosen)).toContain(eq);
  });

  it("states the wait, in the unit the resonance counts", () => {
    const v = swapVerdict(spare("1675", res(0)), fitted("1666", res(794)), combat);
    expect(v).not.toBeNull();
    // 794 x (1666 x 1.2 - 1675) / (1675 x 0.2): the candidate catching up at the rate its own threshold sets.
    expect(v!.payback!.amount).toBeCloseTo(768.4, 0);
    expect(v!.payback!.unit).toBe("kills");
  });

  it("says nothing about a candidate that loses under both readings", () => {
    expect(swapVerdict(spare("900", res(0)), fitted("1666", res(794)), combat)).toBeNull();
  });

  // A bonus this ship is told not to chase is credited nothing, so there is no wait to describe and no earned
  // progress to protect: the swap goes back to being an ordinary main-stat comparison.
  it("has no verdict where the bonus stat is blacklisted on this ship", () => {
    const ctx: BoosterCtx = { ...combat, blacklist: new Set(["Combat Power"]) };
    expect(swapVerdict(spare("1675", res(0)), fitted("1666", res(794)), ctx)).toBeNull();
  });
});

// The EXACT credit, where the bonus scales a pool this app holds a total for. The weight is a stand-in for an
// exchange rate that does not exist between two different stats; it is not a stand-in for arithmetic, and where
// the bonus and the headline are one quantity the arithmetic is available.
describe("pricing a whole-pool resonance instead of weighting it", () => {
  const POOL = 446529.219, MULT = 1.0489, VALUE = 1666;
  const res = (progress: number, over: Partial<Resonance> = {}): Resonance => ({
    unlocked: progress >= 794, progress, threshold: 794, unit: "kills",
    bonus: "+4.89% Combat Power", bonusStat: "Combat Power", bonusMultiplier: MULT, ...over,
  });
  const withRes = (stat: string, amount: string, r: Resonance): Item =>
    ({ ...booster(stat, amount), resonance: r });
  const base = POOL / MULT;   // the fitted booster's own multiplier taken back out
  const ctx = (pools?: Record<string, number>): BoosterCtx => ({
    scope: "potential", profile: { ...DEFAULT_PROFILE, main: "combat" },
    fit: { role: "Combat", activities: ["Combat"] }, pools,
  });

  it("divides a fitted resonance back out of the reported pool", () => {
    const fitted = [withRes("Combat Power", "1666", res(794))];
    expect(resonanceBase(POOL, fitted, "Combat Power")).toBeCloseTo(base, 3);
    // half-progressed pays half the multiplier, so half of it comes back out
    expect(resonanceBase(POOL, [withRes("Combat Power", "1666", res(397))], "Combat Power"))
      .toBeCloseTo(POOL / (1 + (MULT - 1) * 0.5), 3);
    // a stat nothing bonuses is returned untouched
    expect(resonanceBase(POOL, fitted, "Mining Power")).toBe(POOL);
  });

  it("credits what the multiplier is actually worth against the booster's own value", () => {
    const b = withRes("Combat Power", "1666", res(794));
    const c = resonanceCredit(b, ctx({ "Combat Power": base }));
    // (1.0489 - 1) x 425,712 / 1,666: about 12.5, where the weight alone said 0.2
    expect(c.credit).toBeCloseTo((MULT - 1) * base / VALUE, 3);
    expect(c.credit).toBeGreaterThan(12);
    expect(c.credit).toBeLessThan(13);
  });

  it("scales the measured credit by progress, exactly as the weighted one does", () => {
    const half = resonanceCredit(withRes("Combat Power", "1666", res(397)), { ...ctx({ "Combat Power": base }), scope: "current" });
    const done = resonanceCredit(withRes("Combat Power", "1666", res(794)), { ...ctx({ "Combat Power": base }), scope: "current" });
    expect(half.credit).toBeCloseTo(done.credit / 2, 6);
  });

  // Four unit conditions, each of which would otherwise divide one quantity by another.
  it("falls back to the weight where the units do not line up", () => {
    const weighted = RESONANCE_WEIGHT;
    const pools = { "Combat Power": base, "Reload Speed": 0.0182 };
    // the bonus is a DIFFERENT stat from the headline
    const other = withRes("Combat Power", "1666", res(794, { bonusStat: "Reload Speed", bonus: "+2.22% Reload Speed" }));
    expect(resonanceCredit(other, ctx(pools)).credit).toBeLessThanOrEqual(weighted);
    // a percent headline is parsed as 2.22 where its pool is stored as 0.0182. Reload Speed is not this hull's
    // role stat, so the weighted branch halves it, which is the softener the measured branch does without.
    const pct = withRes("Reload Speed", "2.22%", res(794, { bonusStat: "Reload Speed" }));
    expect(resonanceCredit(pct, ctx(pools)).credit).toBeCloseTo(weighted * 0.5, 6);
    // no multiplier on the bonus states no share of a pool
    const flat = withRes("Combat Power", "1666", res(794, { bonusMultiplier: undefined }));
    expect(resonanceCredit(flat, ctx(pools)).credit).toBeCloseTo(weighted, 6);
    // and no pool total in hand is nothing to measure against
    expect(resonanceCredit(withRes("Combat Power", "1666", res(794)), ctx()).credit).toBeCloseTo(weighted, 6);
  });

  it("builds one base per bonus stat off the ship's pools", () => {
    const fitted = [withRes("Combat Power", "1666", res(794))];
    const bases = resonanceBases({ poolCombatPower: POOL } as never, fitted, []);
    expect(bases["Combat Power"]).toBeCloseTo(base, 3);
    // a stat the app holds no pool for is absent rather than guessed at
    expect("Shield HP" in bases).toBe(false);
  });
});
