import { describe, it, expect } from "vitest";
import {
  buildFullCatalog, exportPriorities, importPriorities, isNamePrio, namePrio, namePrioLabel,
  optimize, type CatalogSkill,
} from "./officer";
import type { Officer, OfficerSkill } from "./types";

// Two real skill names from the curated table, so the "all skills" catalog and the name matching are
// exercised against actual data rather than invented strings.
const REAL_A = "Iron Rage";
const REAL_B = "Fire Control Officer";

const cat = (id: string, name: string): CatalogSkill => ({ id, name, major: false, roles: [], drone: false });

const sk = (id: string, name = id): OfficerSkill => ({ id, name, tier: 1, major: false });
function officer(guid: string, skills: [string, string][]): Officer {
  const nodes = skills.map(([id, name]) => sk(id, name));
  return {
    guid, name: guid, callsign: "", profession: "Combat", rarity: "Standard", level: 1, gender: "Male",
    icon: null, chosenBonus: "", current: nodes, potential: nodes,
  };
}
const base = { role: null, hasDroneBay: true, scope: "potential" as const, forced: new Set<string>() };

describe("priority list export / import", () => {
  const catalog = [cat("id-a", REAL_A), cat("id-b", REAL_B)];

  it("round-trips a list through export and import", () => {
    const file = exportPriorities(["id-b", "id-a"], (id) => catalog.find((c) => c.id === id)!.name);
    const back = importPriorities(file, catalog);
    expect(back.prio).toEqual(["id-b", "id-a"]);   // order preserved — order IS the priority
    expect(back.matched).toBe(2);
  });

  it("matches by NAME when the ids are from another save", () => {
    const file = exportPriorities(["id-a"], () => REAL_A);
    // Same skill, different internal id — as after switching playthrough.
    const other = [cat("totally-different-id", REAL_A)];
    const back = importPriorities(file, other);
    expect(back.prio).toEqual(["totally-different-id"]);
    expect(back.matched).toBe(1);
  });

  it("keeps an unmatched name as a name-only priority instead of dropping it", () => {
    const back = importPriorities({ kind: "shipoptimizer.priorities", v: 1, skills: [{ name: REAL_B }] }, []);
    expect(back.prio).toEqual([namePrio(REAL_B)]);
    expect(back.byName).toBe(1);
    expect(back.matched).toBe(0);
  });

  it("accepts a hand-written bare array of names", () => {
    const back = importPriorities([REAL_A, REAL_B], catalog);
    expect(back.prio).toEqual(["id-a", "id-b"]);
    expect(back.matched).toBe(2);
  });

  it("de-duplicates repeated entries", () => {
    const back = importPriorities([REAL_A, REAL_A, REAL_B], catalog);
    expect(back.prio).toEqual(["id-a", "id-b"]);
  });

  it("carries scope when the file has one, and rejects rubbish", () => {
    expect(importPriorities({ skills: [REAL_A], scope: "current" }, catalog).scope).toBe("current");
    expect(() => importPriorities({ nope: 1 }, catalog)).toThrow();
    expect(() => importPriorities(42, catalog)).toThrow();
  });

  it("restores a name-only priority as a name-only priority (idempotent)", () => {
    const key = namePrio(REAL_A);
    const file = exportPriorities([key], (id) => id);
    expect(file.skills).toEqual([{ name: REAL_A }]);      // proper-cased, no bogus id
    expect(importPriorities(file, []).prio).toEqual([key]);
  });
});

describe("name-only priorities in scoring", () => {
  it("credits an officer whose skill matches a name-only priority", () => {
    // The point of the feature: prioritise a skill nobody has an id for in this save, and the officer who
    // actually carries it still ranks above one who doesn't.
    const officers = [officer("HAS", [["x1", REAL_A]]), officer("HASNT", [["x2", REAL_B]])];
    const r = optimize({ ...base, officers, slots: 1, priorities: [namePrio(REAL_A)] });
    expect(r.chosen.map((o) => o.guid)).toEqual(["HAS"]);
    expect(r.ranks.find((x) => x.id === namePrio(REAL_A))!.rank).toBe(1);
  });

  it("matches case-insensitively", () => {
    const officers = [officer("HAS", [["x1", REAL_A.toUpperCase()]])];
    const r = optimize({ ...base, officers, slots: 1, priorities: [namePrio(REAL_A.toLowerCase())] });
    expect(r.chosen[0].cov[0]).toBe(true);
  });
});

describe("full skill catalog", () => {
  it("adds every table skill not already owned, flagged unowned", () => {
    const owned = [cat("id-a", REAL_A)];
    const full = buildFullCatalog(owned);
    expect(full.find((c) => c.name === REAL_A)).toMatchObject({ id: "id-a", owned: true });
    const unowned = full.find((c) => c.name === REAL_B)!;
    expect(unowned.owned).toBe(false);
    expect(isNamePrio(unowned.id)).toBe(true);
    expect(namePrioLabel(unowned.id)).toBe(REAL_B);   // proper-cased for display
    expect(full.length).toBeGreaterThan(owned.length);
  });

  it("does not duplicate an owned skill", () => {
    const full = buildFullCatalog([cat("id-a", REAL_A)]);
    expect(full.filter((c) => c.name === REAL_A)).toHaveLength(1);
  });
});
