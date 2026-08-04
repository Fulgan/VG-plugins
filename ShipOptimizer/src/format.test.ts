import { describe, expect, it } from "vitest";
import { effectiveMainVal, statTotals, affordLine, affordTip, mainVal, subFmt, statPct, num, compareStats } from "./format";
import type { Item } from "./types";

// A stat-granting aspect is a `BoostStat` registered on the UNIT, so it never appears in the item's own
// `stats[]`. It still arrives with the item and leaves with it, so ranking has to count it — the reactor case
// where a 20.8K reactor with "+10% reactor energy" really beats a 21.2K one without.
const reactor = (energy: string, aspectMul?: number): Item => ({
  name: "Reactor", rarity: "Standard", level: 74, stats: [], substats: [],
  mainStat: { name: "Energy", amount: energy },
  aspects: aspectMul ? [{ name: "Microgenerators", description: "", stats: [{ stat: "EnergyCapacity", amount: 0, multiplier: aspectMul }] }] : [],
} as unknown as Item);

describe("aspect-granted stats", () => {
  it("counts an aspect boost on the item's own headline", () => {
    expect(effectiveMainVal(reactor("20.8K", 1.1))).toBeCloseTo(22880, 0);
    expect(effectiveMainVal(reactor("21.2K"))).toBeCloseTo(21200, 0);
  });

  // The whole point: the smaller-on-paper reactor wins once its aspect counts.
  it("makes the aspected reactor outrank the bigger plain one", () => {
    expect(effectiveMainVal(reactor("20.8K", 1.1))!).toBeGreaterThan(effectiveMainVal(reactor("21.2K"))!);
  });

  // The aspect reports the EquipStat spelling; the headline carries the display name.
  it("matches stat names loosely", () => {
    const it = reactor("100", 1.5);
    expect(effectiveMainVal(it)).toBeCloseTo(150);
  });

  it("folds aspect lines into the stat totals", () => {
    const t = statTotals(reactor("100", 1.25));
    expect(t.get("EnergyCapacity")?.mul).toBeCloseTo(1.25);
  });

  it("leaves an item without aspect stats alone", () => {
    expect(effectiveMainVal(reactor("500"))).toBeCloseTo(500);
    expect(statTotals(reactor("500")).get("EnergyCapacity")).toBeUndefined();
  });
});

// The "buy"/"hire" affordability wording. One owner, so the tab badges, both Buy buttons and Hire cannot word the
// same question four ways.
describe("affordLine / affordTip", () => {
  // Grouping comes from `toLocaleString`, so the separator is the RUNNER's locale (a Swiss one groups with an
  // apostrophe). Assertions build their expected numbers the same way rather than hard-coding a comma.
  const n = (v: number) => v.toLocaleString();
  it("prices in credits and names what you hold", () => {
    expect(affordLine({ name: "gun", cost: 5_999 }, 162_035_825))
      .toBe(`${n(5_999)} cr · you have ${n(162_035_825)} cr`);
  });

  it("says how far short you are", () => {
    expect(affordLine({ name: "gun", cost: 500 }, 200)).toContain(`(short ${n(300)} cr)`);
  });

  // A bartered offer leaves `cost` null and prices in ITEMS — reading `cost` alone reports it as free.
  it("prices a barter offer in its own currency, with the holding of THAT", () => {
    const line = affordLine({ name: "gun", costItem: "VanguardMark", costItemCount: 4_408, costItemOwned: 12_043 }, 99);
    expect(line).toBe(`${n(4_408)}× VanguardMark · you have ${n(12_043)}`);
    expect(line).not.toContain("cr");
  });

  it("marks a barter shortfall against the barter holding, not credits", () => {
    expect(affordLine({ name: "gun", costItem: "Mark", costItemCount: 10, costItemOwned: 4 }, 1e9))
      .toContain("(short 6)");
  });

  it("says so when an item is not for sale", () => {
    expect(affordLine({ name: "gun" }, 100)).toBe("not for sale");
  });

  it("omits the wallet when credits are unknown", () => {
    expect(affordLine({ name: "gun", cost: 10 }, null)).toBe("10 cr");
  });

  // Credit prices total; barter prices are separate currencies and must never be added together.
  it("totals credits only, and warns when the total exceeds the wallet", () => {
    const tip = affordTip("2 shop items", [
      { name: "a", cost: 600 },
      { name: "b", cost: 700 },
      { name: "c", costItem: "Mark", costItemCount: 5, costItemOwned: 5 },
    ], 1_000);
    expect(tip).toContain(`Total ${n(1_300)} cr`);
    expect(tip).toContain(`short by ${n(300)} cr`);
    expect(tip).not.toContain(n(1_305));
  });

  it("is just the heading when there is nothing to buy", () => {
    expect(affordTip("nothing", [], 10)).toBe("nothing");
  });
});

// `mainStat.amount` is a display string rounded to three significant figures, and the ranking floor that
// decides whether a swap is worth proposing is 0.1% — finer than that rounding. The exact figure is in
// `stats[]`, so the shown value is used only to identify which line is the headline.
describe("mainVal precision", () => {
  const mk = (over: Partial<Item>): Item => ({
    key: 1, slot: 1, identifier: null, name: "Gun", rarity: "HighGrade", level: 74,
    size: "Large", type: "Railgun", category: "Turret", sellValue: 0,
    aspects: [], stats: [], substats: [], ...over,
  } as unknown as Item);

  it("returns the exact line rather than the rounded headline", () => {
    // Measured on a live ship: the game displays "10.2K" for 10,152.7969.
    const gun = mk({
      mainStat: { name: "Combat Power", amount: "10.2K" },
      stats: [{ stat: "Combat Power", amount: 10_152.7969, multiplier: 1 }],
    } as Partial<Item>);
    expect(mainVal(gun)).toBeCloseTo(10_152.7969, 4);
    // What the old string-only reading gave, and how far off it was against a 0.1% floor.
    expect(Math.abs(10_200 - 10_152.7969) / 10_152.7969).toBeGreaterThan(0.001);
  });

  it("identifies the headline rather than summing repeats of the same stat", () => {
    // One real turret lists Combat Power twice; the game pools only the headline, the other being a
    // TurretBoostStat local to the gun. Summing would inflate its contribution by 22%.
    const gun = mk({
      mainStat: { name: "Combat Power", amount: "8,080" },
      stats: [
        { stat: "Combat Power", amount: 8_079.92139, multiplier: 1 },
        { stat: "Combat Power", amount: 1_772.03442, multiplier: 1 },
      ],
    } as Partial<Item>);
    expect(mainVal(gun)).toBeCloseTo(8_079.92139, 4);
  });

  it("ignores a percentage line when picking the headline", () => {
    const mod = mk({
      mainStat: { name: "Hull HP", amount: "2,997" },
      stats: [{ stat: "Hull HP", amount: 0, multiplier: 27.0861244 }, { stat: "Hull HP", amount: 2_997.4, multiplier: 1 }],
    } as Partial<Item>);
    expect(mainVal(mod)).toBeCloseTo(2_997.4, 3);
  });

  it("falls back to the parsed string when the headline is not in stats[] at all", () => {
    // A Tractor Beam's "12 Tractor Beams" never appears as a stat line.
    const tb = mk({ mainStat: { name: "Tractor Beams", amount: "12" }, stats: [] } as Partial<Item>);
    expect(mainVal(tb)).toBe(12);
  });

  it("does not mistake an unrelated line of a different magnitude for the headline", () => {
    const gun = mk({
      mainStat: { name: "Combat Power", amount: "5.9K" },
      stats: [{ stat: "Combat Power", amount: 12.5, multiplier: 1 }],
    } as Partial<Item>);
    expect(mainVal(gun)).toBe(5_900);      // 12.5 is nowhere near 5,900 — keep the shown figure
  });
});

// A percentage-valued stat's `amount` is a fraction: the game shows an Attack Speed roll of 0.0140774 as
// "+1.41%". Rendering it with the absolute formatter rounded it to "+0", i.e. the roll that decides a swap
// read as no roll at all.
describe("percentage-valued stats", () => {
  const gun = (attackSpeed: number, cp: number): Item => ({
    name: "Plasma Spitter Mk.XVI", rarity: "Exotic", level: 64, category: "Turret",
    mainStat: { name: "Combat Power", amount: String(cp) },
    stats: [
      { stat: "Combat Power", amount: cp, multiplier: 1 },
      { stat: "Attack Speed", amount: attackSpeed, multiplier: 1, percent: true },
    ],
    substats: [{ stat: "Attack Speed", amount: attackSpeed, multiplier: 1, percent: true }],
    aspects: [],
  } as unknown as Item);

  it("renders the game's own percentage, not a rounded absolute", () => {
    expect(subFmt({ stat: "Attack Speed", amount: 0.0140774129, multiplier: 1, percent: true }))
      .toBe("+1.41% Attack Speed");
    expect(num(0.0140774129)).toBe("0");     // what it used to render as
  });

  it("trims trailing zeros the way FormatPercentage does", () => {
    expect(statPct(0.02)).toBe("2%");
    expect(statPct(0.025)).toBe("2.5%");
    expect(statPct(0.1)).toBe("10%");
    expect(statPct(-0.015)).toBe("-1.5%");
  });

  it("leaves absolute stats alone", () => {
    expect(subFmt({ stat: "Precision", amount: 710.897034, multiplier: 1 })).toBe("+710.9 Precision");
    expect(subFmt({ stat: "Precision", amount: 710.897034, multiplier: 1, percent: false })).toBe("+710.9 Precision");
  });

  it("a multiplier line still reads as a multiplier on a percentage stat", () => {
    expect(subFmt({ stat: "Attack Speed", amount: 0, multiplier: 1.05, percent: true })).toBe("×1.05 Attack Speed");
  });

  it("keeps a percentage delta that the absolute noise threshold would discard", () => {
    // 0.0294 - 0.0141 = 1.53 percentage points — one of the biggest Attack Speed swings in the game, and
    // below the 0.05 absolute threshold that used to filter it out as a rounding artefact.
    const rows = compareStats(gun(0.02944012, 2688), gun(0.0140774129, 2688));
    const as = rows.find((r) => r.stat === "Attack Speed");
    expect(as).toBeDefined();
    expect(as!.percent).toBe(true);
    expect(statPct(as!.d)).toBe("1.54%");
  });

  it("marks the stat as percentage in statTotals", () => {
    expect(statTotals(gun(0.0294, 2688)).get("Attack Speed")!.percent).toBe(true);
    expect(statTotals(gun(0.0294, 2688)).get("Combat Power")!.percent).toBe(false);
  });
});
