import { describe, expect, it } from "vitest";
import { atMaxQuality, atScope, listAtScope, qualityCap, qualityFactor, qualityHeadroom, qualityOf,
         MAX_QUALITY, QUALITY_STEP } from "./quality";
import type { Item, StatLine } from "./types";

/**
 * WORKSHOP QUALITY, PINNED AGAINST THE GAME'S OWN ARITHMETIC (`AbstractEquipment`).
 *
 * Every claim below was read out of the assembly rather than inferred, and each is the kind that would be wrong
 * in a plausible way if guessed: that the MAIN stat is excluded, that a percent line grows by its EXCESS over 1,
 * that the step compounds, and that the ceiling belongs to the rarity.
 */

const line = (stat: string, amount: number, multiplier = 1): StatLine =>
  ({ stat, amount, multiplier, percent: false } as unknown as StatLine);

/** `stats` holds the main line too; `substats` is the game's own "everything but the main stat". */
const item = (over: Partial<Item> = {}): Item => ({
  name: "Gun", rarity: "Exotic", bonus: 0, level: 74, category: "Turret",
  mainStat: { name: "Combat Power", amount: "16,000" },
  stats: [line("Combat Power", 16_000), line("Power", 1_000), line("Armor HP", 0, 3)],
  substats: [line("Power", 1_000), line("Armor HP", 0, 3)],
  aspects: [],
  ...over,
} as unknown as Item);

describe("the ceiling belongs to the rarity", () => {
  it("is 25 / 20 / 15 and nothing below HighGrade", () => {
    expect(MAX_QUALITY).toEqual({ HighGrade: 15, Exotic: 20, Legendary: 25 });
    expect(qualityCap("Legendary")).toBe(25);
    expect(qualityCap("Standard")).toBe(0);
    expect(qualityCap("Enhanced")).toBe(0);
    expect(qualityCap(null)).toBe(0);
    expect(qualityCap("nonsense")).toBe(0);
  });

  it("reads the level off `bonus`, treating absent as none", () => {
    expect(qualityOf(item({ bonus: 12 }))).toBe(12);
    expect(qualityOf(item({ bonus: null }))).toBe(0);
    expect(qualityOf(item({ bonus: undefined }))).toBe(0);
  });

  it("reports the levels left, never a negative one", () => {
    expect(qualityHeadroom(item({ rarity: "Exotic", bonus: 0 }))).toBe(20);
    expect(qualityHeadroom(item({ rarity: "Exotic", bonus: 20 }))).toBe(0);
    expect(qualityHeadroom(item({ rarity: "HighGrade", bonus: 15 }))).toBe(0);
    // A save from a build whose cap was higher, or a hand-edited value: still nothing to gain, not -5 levels.
    expect(qualityHeadroom(item({ rarity: "HighGrade", bonus: 20 }))).toBe(0);
  });

  it("compounds rather than adding", () => {
    expect(QUALITY_STEP).toBe(1.01);
    expect(qualityFactor(15)).toBeCloseTo(1.160969, 6);
    expect(qualityFactor(20)).toBeCloseTo(1.220190, 6);
    expect(qualityFactor(25)).toBeCloseTo(1.282432, 6);
    // The difference from a linear reading is the whole reason to pin it: +25% is not +28.24%.
    expect(qualityFactor(25)).toBeGreaterThan(1.25);
    expect(qualityFactor(0)).toBe(1);
    expect(qualityFactor(-3)).toBe(1);
  });
});

describe("what a level actually scales", () => {
  it("leaves the MAIN stat alone and scales the rest", () => {
    // The main stat is the one figure the card leads with, and quality does not touch it: `BakeQualityStep` skips
    // `IsMainStat(i)`. An implementation that scaled it would inflate a gun's headline Combat Power by 22%.
    const at = atMaxQuality(item({ rarity: "Exotic", bonus: 0 }));
    const f = qualityFactor(20);
    expect(at.stats.find((s) => s.stat === "Combat Power")!.amount).toBe(16_000);
    expect(at.stats.find((s) => s.stat === "Power")!.amount).toBeCloseTo(1_000 * f, 6);
    expect(at.mainStat!.amount).toBe("16,000");
  });

  it("grows a percent line by its EXCESS over 1", () => {
    // `ScaleStatBy` sends `multiplier` to `1 + (multiplier - 1) * (1 + f)`. Scaling the multiplier itself would
    // turn an Armor Plating's ×171.43 into ×209, crediting quality with the plating's whole contribution.
    const at = atMaxQuality(item({ rarity: "Exotic", bonus: 0, stats: [line("Armor HP", 0, 171.43)],
                                   substats: [line("Armor HP", 0, 171.43)] }));
    const f = qualityFactor(20);
    expect(at.stats[0].multiplier).toBeCloseTo(1 + 170.43 * f, 4);
    expect(at.stats[0].multiplier).toBeLessThan(171.43 * f);      // NOT the naive reading
    expect(at.stats[0].amount).toBe(0);
  });

  it("scales from where the item already IS, not from zero", () => {
    const five = atMaxQuality(item({ rarity: "Exotic", bonus: 15 }));   // 5 levels left
    expect(five.stats.find((s) => s.stat === "Power")!.amount).toBeCloseTo(1_000 * qualityFactor(5), 6);
  });

  it("leaves aspect lines untouched", () => {
    // An aspect's boost is a separate component (`BoostStat`), not part of the equipment's own stat list.
    const aspects = [{ name: "Firestarter", stats: [line("Power", 500)] }];
    const at = atMaxQuality(item({ rarity: "Legendary", bonus: 0, aspects } as Partial<Item>));
    expect((at.aspects as typeof aspects)[0].stats[0].amount).toBe(500);
  });

  it("scales both copies when an item carries the same stat twice", () => {
    const two = item({ rarity: "HighGrade", bonus: 0,
                       stats: [line("Combat Power", 9_000), line("Power", 300), line("Power", 700)],
                       substats: [line("Power", 300), line("Power", 700)] });
    const f = qualityFactor(15);
    const at = atMaxQuality(two);
    expect(at.stats[1].amount).toBeCloseTo(300 * f, 6);
    expect(at.stats[2].amount).toBeCloseTo(700 * f, 6);
    expect(at.stats[0].amount).toBe(9_000);
  });

  it("does not scale a stat that is only in `stats`, since that is the main line's home", () => {
    // `substats` is the authority on what may move. A line absent from it is the main stat under a spelling this
    // app does not have to guess at.
    const odd = item({ rarity: "Exotic", bonus: 0,
                       stats: [line("EnergyCapacity", 20_000), line("Power", 100)],
                       substats: [line("Power", 100)] });
    const at = atMaxQuality(odd);
    expect(at.stats[0].amount).toBe(20_000);
    expect(at.stats[1].amount).toBeCloseTo(100 * qualityFactor(20), 6);
  });
});

describe("identity, because the search compares items by it", () => {
  it("returns the SAME object when there is nothing to gain", () => {
    // `pick === hp.equipped` is how "keep current" is expressed and `handle(it)` dedupes the armory ∴ cloning a
    // maxed item would make every slot look like a swap.
    const maxed = item({ rarity: "Exotic", bonus: 20 });
    expect(atMaxQuality(maxed)).toBe(maxed);
    const plain = item({ rarity: "Standard", bonus: 0 });
    expect(atMaxQuality(plain)).toBe(plain);
  });

  it("leaves a BOOSTER alone, because quality has nothing on one to scale", () => {
    // A booster's lines are ALL main stat — the bridge's `substats` (the game's own `includeMainStat: false`) comes
    // back empty — so its rarity's ceiling buys exactly nothing. Levels that move no number are not headroom.
    const booster = item({
      category: "Booster", rarity: "Exotic", bonus: 0,
      mainStat: { name: "Combat Power", amount: "1,675" },
      stats: [line("Combat Power", 1_674.685), line("Combat Power", 0, 1.04893625)],
      substats: [],
    });
    expect(qualityHeadroom(booster)).toBe(0);
    expect(atMaxQuality(booster)).toBe(booster);
    expect(atScope(booster, "potential")).toBe(booster);
  });

  it("returns the same object at `current` scope, whatever the headroom", () => {
    const raw = item({ rarity: "Legendary", bonus: 0 });
    expect(atScope(raw, "current")).toBe(raw);
    expect(atScope(raw, "potential")).not.toBe(raw);
  });

  it("keeps nulls in place over a list, so a positional pairing survives", () => {
    const a = item({ rarity: "Legendary", bonus: 0 });
    const out = listAtScope([a, null, a], "potential");
    expect(out).toHaveLength(3);
    expect(out[1]).toBeNull();
    expect(out[0]).not.toBeNull();
  });
});
