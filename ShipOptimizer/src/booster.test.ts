import { describe, it, expect } from "vitest";
import {
  boosterScore, boosterType, boosterValue, defaultSlotTypes, optimizeBoosters, resonanceCredit, resonanceLive,
  type BoosterCtx,
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
