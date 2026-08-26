import { describe, it, expect } from "vitest";
import { buildCatalog, defaultPriorities, dedupeOfficers, effectLookup, evaluateRecruits, optimize, visibleRecruits, type CatalogSkill, type RecruitOfficer } from "./officer";
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

describe("officer optimizer — top-N lexicographic", () => {
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

  it("keeps an assigned officer over a benched sidegrade that only ties on coverage", () => {
    // Both cover only A; Y is a higher rarity. Without incumbency the comparator swaps to Y for the
    // rarity tiebreak → a pointless "change". Incumbency keeps the assigned X.
    const officers = [officer("X", ["A"], "Standard"), officer("Y", ["A"], "Legendary")];
    const r = optimize({ ...base, officers, slots: 1, priorities: ["A"], assigned: new Set(["X"]) });
    expect(r.chosen.map((o) => o.guid)).toEqual(["X"]);
  });

  it("still displaces an incumbent when a benched officer covers a higher priority", () => {
    // X (assigned) covers only B; Y covers A (higher). Incumbency must NOT protect X here.
    const officers = [officer("X", ["B"], "Legendary"), officer("Y", ["A"], "Standard")];
    const r = optimize({ ...base, officers, slots: 1, priorities: ["A", "B"], assigned: new Set(["X"]) });
    expect(r.chosen.map((o) => o.guid)).toEqual(["Y"]);
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

// A HIRED RECRUIT LEAVES THE LIST BEFORE THE REFETCH AGREES. The list describes the station, the hire changes it, and
// the fetch that would confirm lands later — until then the row keeps a live hire button for someone already crewed.
describe("visibleRecruits", () => {
  const r = (guid: string) => ({ guid, name: guid });

  it("drops the ones just hired and keeps the rest in order", () => {
    const out = visibleRecruits([r("a"), r("b"), r("c")], new Set(["b"]));
    expect(out.map((o) => o.guid)).toEqual(["a", "c"]);
  });

  it("returns the same array identity when nothing was hired, so no render churn", () => {
    const list = [r("a")];
    expect(visibleRecruits(list, new Set())).toBe(list);
  });

  it("hides nothing for a guid that is not on this station's list", () => {
    const out = visibleRecruits([r("a")], new Set(["elsewhere"]));
    expect(out.map((o) => o.guid)).toEqual(["a"]);
  });
});

// THE TWO KEYINGS. A priority list holds skill IDs; the curated effect table is keyed by NAME. Reading the table with
// an id returns undefined for every entry, which surfaced as "nothing here can be ranked" — a lookup bug wearing the
// costume of an empty result.
describe("effectLookup", () => {
  const catalog = [
    { id: "sk_1", name: "Annihilator", major: false, roles: ["Combat"], drone: false, effect: "Crit Damage +5%" },
    { id: "sk_2", name: "Quartermaster", major: false, roles: ["Industrial"], drone: false },
  ] as CatalogSkill[];

  it("answers for a real id out of the catalog", () => {
    expect(effectLookup(catalog)("sk_1")).toBe("Crit Damage +5%");
  });

  it("answers for a name: priority, which has no id because nobody carries it", () => {
    expect(effectLookup(catalog)("name:precise targeting")).toBe("Crit Chance +1%");
  });

  it("returns undefined for an id it has never heard of, and for a catalogued skill with no effect", () => {
    expect(effectLookup(catalog)("sk_missing")).toBeUndefined();
    expect(effectLookup(catalog)("sk_2")).toBeUndefined();
  });
});

// A ROSTER CAN LIST ONE OFFICER TWICE. Seen live: three entries sharing guid 488be2cb (root put them there).
// The optimizer picks per ENTRY, so repeats do not just look untidy — they cost slots, because the picks collapse back
// to one officer when they are mapped onto the ship.
describe("dedupeOfficers", () => {
  const off = (guid: string, name = guid) => ({ guid, name, level: 60, rarity: "Standard", potential: [], current: [] } as unknown as Officer);

  it("keeps the first entry of each guid, in order, and counts what it dropped", () => {
    const { officers, duplicates } = dedupeOfficers([off("a"), off("b"), off("a"), off("a"), off("c")]);
    expect(officers.map((o) => o.guid)).toEqual(["a", "b", "c"]);
    expect(duplicates).toBe(2);
  });

  it("leaves a clean roster untouched and reports nothing", () => {
    const clean = [off("a"), off("b")];
    const { officers, duplicates } = dedupeOfficers(clean);
    expect(officers.map((o) => o.guid)).toEqual(["a", "b"]);
    expect(duplicates).toBe(0);
  });

  it("does not treat two officers with no guid as each other", () => {
    const { officers, duplicates } = dedupeOfficers([off("", "x"), off("", "y")]);
    expect(officers).toHaveLength(2);
    expect(duplicates).toBe(0);
  });
});

describe("skills a hull cannot use", () => {
  // A HANGAR SLOT IS NOT A PERCENTAGE, so it does not get sorted among the percentages. On a hull with a bay it
  // adds a whole slot, which no stat bonus competes with; on a hull without one it does nothing at all, and
  // crediting an officer for it would rank them on a skill that cannot fire.
  const withHangar = (guid: string) => officer(guid, ["Hangar Extension"]);

  it("ignores Hangar Extension on a hull with no hangar bay", () => {
    // One officer and one slot, so the assertion is about THAT officer's skills rather than about who won.
    const { chosen } = optimize({ ...base, officers: [withHangar("H")], slots: 1, priorities: [], role: null });
    expect(chosen[0].guid).toBe("H");
    expect(chosen[0].scopeSkills.some((sk) => sk.name === "Hangar Extension")).toBe(false);
  });

  it("counts it once the hull has a bay", () => {
    const officers = [withHangar("H")];
    const { chosen } = optimize({ ...base, officers, slots: 1, priorities: [], role: null, hasHangarBay: true });
    expect(chosen[0].scopeSkills.some((sk) => sk.name === "Hangar Extension")).toBe(true);
  });

  it("leads the default priorities on a hull with a bay, and is absent without one", () => {
    const catalog = buildCatalog([withHangar("H"), officer("A", ["Armor Plating"])]);
    const lead = defaultPriorities(catalog, "Engineering", true)[0];
    expect(catalog.find((c) => c.id === lead)?.name).toBe("Hangar Extension");
    expect(defaultPriorities(catalog, "Engineering", false)[0]).not.toBe(lead);
  });
});
