import { describe, it, expect } from "vitest";
import { evaluateRecruits, optimize, type RecruitOfficer } from "./officer";
import type { Officer, OfficerSkill } from "./types";

const sk = (id: string): OfficerSkill => ({ id, name: id, tier: 1, major: false });
function officer(guid: string, skills: string[], rarity = "Standard", level = 1): Officer {
  const nodes = skills.map(sk);
  return {
    guid, name: guid, callsign: "", profession: "Combat", rarity, level, gender: "Male",
    icon: null, chosenBonus: "", current: nodes, potential: nodes,
  };
}
const base = { role: null, hasDroneBay: true, scope: "potential" as const, forced: new Set<string>() };

describe("officer optimizer (§V30 — top-N lexicographic)", () => {
  it("picks the top-N officers by priority coverage and stacks ranks", () => {
    const officers = [officer("X", ["A"]), officer("Y", ["B"]), officer("Z", [])];
    const r = optimize({ ...base, officers, slots: 2, priorities: ["A", "B"] });
    expect(r.chosen.map((o) => o.guid).sort()).toEqual(["X", "Y"]);
    expect(r.ranks.find((x) => x.id === "A")!.rank).toBe(1);
    expect(r.ranks.find((x) => x.id === "B")!.rank).toBe(1);
  });

  it("stacks the same skill across multiple officers (+1 each)", () => {
    const officers = [officer("X", ["A"]), officer("Y", ["A"]), officer("Z", [])];
    const r = optimize({ ...base, officers, slots: 2, priorities: ["A"] });
    expect(r.ranks.find((x) => x.id === "A")!.rank).toBe(2);
  });

  it("prefers covering a higher-priority skill over more low-priority ones", () => {
    // X covers only A (highest); Y covers B and C. X must rank above Y.
    const officers = [officer("X", ["A"]), officer("Y", ["B", "C"])];
    const r = optimize({ ...base, officers, slots: 1, priorities: ["A", "B", "C"] });
    expect(r.chosen.map((o) => o.guid)).toEqual(["X"]);
  });

  it("forces a pinned officer into a slot even when it covers nothing", () => {
    const officers = [officer("X", ["A"]), officer("Y", ["B"]), officer("Z", [])];
    const r = optimize({ ...base, officers, slots: 2, priorities: ["A", "B"], forced: new Set(["Z"]) });
    expect(r.chosen.map((o) => o.guid)).toContain("Z");
    expect(r.chosen.length).toBe(2);
  });

  it("idle income counts only benched officers", () => {
    const officers = [officer("X", ["A"], "Standard", 10), officer("Y", ["B"], "Standard", 10)];
    // slots=1 → one benched. idle = level*40*mult(Standard=1) = 400.
    const r = optimize({ ...base, officers, slots: 1, priorities: ["A", "B"] });
    expect(r.benchedCount).toBe(1);
    expect(r.idleTotal).toBe(400);
  });

  it("flags a recruit that out-ranks the weakest assigned officer", () => {
    const officers = [officer("X", ["A"]), officer("Y", ["B"])];
    const ctx = { ...base, officers, slots: 2, priorities: ["A", "B"] };
    const r = optimize(ctx); // chosen [X,Y]; weakest = Y (covers only B, the lower priority)
    const recruit = (guid: string, skills: string[]): RecruitOfficer => ({ ...officer(guid, skills), hireCost: 1000 });
    const view = evaluateRecruits([recruit("R", ["A", "B"]), recruit("R2", [])], ctx, r.chosen);
    const R = view.find((v) => v.guid === "R")!;
    const R2 = view.find((v) => v.guid === "R2")!;
    expect(R.isOpp).toBe(true);      // covers A (which Y misses) → out-ranks weakest
    expect(R.replaces).toBe("Y");
    expect(R2.isOpp).toBe(false);    // covers nothing → not an upgrade
  });
});
