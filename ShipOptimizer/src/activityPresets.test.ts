import { describe, it, expect } from "vitest";
import { composeActivity, defensiveSkillNames, mergeByWeight, DEFAULT_PROFILE, STANCE_WEIGHT } from "./activityPresets";

describe("what counts as defensive", () => {
  // `Sort by value` prices skills through the DAMAGE model, which holds no defensive stats at all: an Armor HP
  // node is not priced low there, it is UNPRICED, and it falls to the end beside everything else the model
  // cannot speak about. Right for an offence profile, wrong the moment the player says `def`, so the stance
  // reorders instead of the model inventing a number for armour it has never measured. This is the list it
  // reorders by, and it is the same table the suggestions come from rather than a second opinion on the word.
  it("follows the chosen layer, so an armor ship and a shield ship differ", () => {
    const armor = defensiveSkillNames({ ...DEFAULT_PROFILE, combatStance: "defence", combatLayer: "armor" });
    const shield = defensiveSkillNames({ ...DEFAULT_PROFILE, combatStance: "defence", combatLayer: "shield" });
    expect(armor).toContain("Armor Plating");
    expect(armor).not.toContain("Shield Boost");
    expect(shield).toContain("Shield Boost");
    expect(shield).not.toContain("Armor Plating");
    // The layer-independent defensive core is in both.
    expect(armor).toContain("Overwhelming Resolve");
    expect(shield).toContain("Overwhelming Resolve");
  });

  it("is empty away from combat, where the word means nothing here", () => {
    expect(defensiveSkillNames({ ...DEFAULT_PROFILE, main: "mining" })).toEqual([]);
  });
});

describe("how much defence, not whether", () => {
  // A crew is no more a binary choice than a build is, and what a stance can honestly change is HOW SOON a
  // defensive skill is taken rather than what any one skill is worth. So it is a ratio, and the two ends have
  // to reproduce exactly what the old two-way switch did or this is a regression wearing a feature.
  const D = ["d1", "d2", "d3", "d4"];
  const O = ["o1", "o2", "o3", "o4"];

  it("collapses to either pure list at the ends", () => {
    expect(mergeByWeight(D, O, 0)).toEqual([...O, ...D]);
    expect(mergeByWeight(D, O, 1)).toEqual([...D, ...O]);
  });

  it("alternates at even, and takes one in four at the low step", () => {
    expect(mergeByWeight(D, O, 0.5)).toEqual(["d1", "o1", "d2", "o2", "d3", "o3", "d4", "o4"]);
    expect(mergeByWeight(D, O, 0.25).slice(0, 4)).toEqual(["d1", "o1", "o2", "o3"]);
  });

  it("keeps every element exactly once, whatever the weight", () => {
    for (const w of Object.values(STANCE_WEIGHT)) {
      const out = mergeByWeight(D, O, w);
      expect([...out].sort()).toEqual([...D, ...O].sort());
    }
  });

  it("a mixed stance suggests skills from both lists", () => {
    const even = composeActivity({ ...DEFAULT_PROFILE, combatStance: "balanced", combatLayer: "armor" });
    expect(even).toContain("Fire Control Officer");   // offence
    expect(even).toContain("Armor Plating");          // defence, this layer
  });
});
