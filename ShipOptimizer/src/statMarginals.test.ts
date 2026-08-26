// WHAT A STAT IS WORTH DEPENDS ON THE GUNS, AND THE RANKING HAS TO SAY SO.
//
// These run on SYNTHETIC batteries rather than on a live snapshot, so they hold in CI where `live/` does not exist.
// Two guns, both real in shape: a single-shot lance whose cycle is its reload, and a gatling with a 250-round
// magazine. Every claim the ranking feature rests on is asserted against one of them.
import { describe, it, expect } from "vitest";
import { statMarginals, rankByValue, rankSkillsByValue, valueOfEffect, type StatusPools } from "./statMarginals";
import type { Item } from "./types";

const gun = (over: Partial<Item>): Item => ({
  key: 1, slot: 0, identifier: null, name: "gun", rarity: "Standard", level: 60, size: "Large",
  slotType: "Hardpoint", type: "Cannon", category: "Turret", gameplayType: "Combat", damageType: "Kinetic",
  sellValue: 0, powerUsage: 0, powerUsageBase: 0, aspects: [], substats: [], stats: [], bonus: null, bonusStat: null,
  mainStat: { name: "Combat Power", amount: "8000" },
  burstAmount: 1, burstDelay: 0,
  ...over,
} as unknown as Item);

// SINGLE SHOT, LONG RELOAD: the cycle is `max(fireDelay, reload * 0.8)` and fire delay never binds ⇒ attack speed
// cannot buy anything, while reload speed buys the whole cycle.
const lance = gun({ name: "lance", type: "Cryo Lance", fireDelayRaw: 0.2, magSizeRaw: 1, reloadDelayRaw: 2 });
// 250 ROUNDS AT 0.05s: almost all of the cycle is fire delay ⇒ the reverse.
const gatling = gun({ name: "gatling", type: "Double Gatling", fireDelayRaw: 0.05, magSizeRaw: 250, reloadDelayRaw: 3 });

const status: StatusPools & Record<string, unknown> = {
  poolCombatPower: 400_000, poolPrecision: 24_000, precisionDivisor: 3430,
  critChance: 0.68, critDamage: 0.53, megaCrit: 8,
  poolAttackSpeed: 0.6, poolReloadSpeed: 0.03, poolMagazineSize: 0.03,
  equivalentTurrets: 15,
};

const value = (turrets: Item[], stat: string) =>
  statMarginals(status, turrets).find((m) => m.stat === stat)?.perPoint ?? null;

describe("statMarginals", () => {
  it("says nothing when it has nothing to say", () => {
    expect(statMarginals(null, [lance])).toEqual([]);
    expect(statMarginals(status, [])).toEqual([]);
    // No pool reading ⇒ no score ⇒ no ranking, rather than a ranking built on zeroes.
    expect(statMarginals({ poolCombatPower: null }, [lance])).toEqual([]);
  });

  it("comes back strongest first", () => {
    const rows = statMarginals(status, [gatling, gatling]);
    expect(rows.length).toBeGreaterThan(3);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].perPoint).toBeGreaterThanOrEqual(rows[i].perPoint);
  });

  it("prices attack speed at nothing on a single-shot gun, and reload as the cycle stat that pays", () => {
    const speed = value([lance, lance], "Attack Speed");
    const reload = value([lance, lance], "Reload Speed");
    expect(speed).toBeCloseTo(0, 6);
    expect(reload).toBeGreaterThan(0.001);
  });

  it("reverses that on a large magazine: attack speed pays, reload barely", () => {
    const speed = value([gatling, gatling], "Attack Speed") ?? 0;
    const reload = value([gatling, gatling], "Reload Speed") ?? 0;
    expect(speed).toBeGreaterThan(reload);
  });

  it("prices the pure multipliers identically on both batteries — they do not care what fires them", () => {
    for (const stat of ["Critical Chance", "Critical Damage"]) {
      const onLance = value([lance, lance], stat);
      const onGatling = value([gatling, gatling], stat);
      expect(onLance).not.toBeNull();
      expect(onLance).toBeCloseTo(onGatling as number, 9);
    }
  });

  it("flags Precision as indicative, since the reported crit chance cannot be factorised", () => {
    const p = statMarginals(status, [gatling]).find((m) => m.stat === "Precision");
    expect(p?.approximate).toBe(true);
  });
});

describe("rankByValue", () => {
  const rows = statMarginals(status, [lance, lance]);

  it("orders the names it can value and hands back the ones it cannot, separately", () => {
    const { ranked, unranked } = rankByValue(["Hull HP", "Attack Speed", "Critical Damage", "Cargo Capacity"], rows);
    expect(ranked[0]).toBe("Critical Damage");
    expect(ranked).toContain("Attack Speed");
    // NOT sorted to the bottom: "not a damage stat" is a different claim from "worth nearly nothing".
    expect(unranked).toEqual(["Hull HP", "Cargo Capacity"]);
  });
});

describe("valueOfEffect", () => {
  const rows = statMarginals(status, [gatling, gatling]);

  it("reads an officer skill's own words and scales the marginal by the amount", () => {
    const one = valueOfEffect("Crit Chance +1%", rows);
    const five = valueOfEffect("Crit Chance +5%", rows);
    expect(one?.stat).toBe("Critical Chance");
    expect(five?.gain).toBeCloseTo((one?.gain ?? 0) * 5, 9);
  });

  it("refuses a conditional effect rather than assuming an uptime", () => {
    expect(valueOfEffect("wreck kill → Salvage Power +20% (2min)", rows)).toBeNull();
  });

  it("refuses an effect about something that does not touch damage", () => {
    expect(valueOfEffect("Cargo Capacity +10%", rows)).toBeNull();
    expect(valueOfEffect(undefined, rows)).toBeNull();
  });

  it("takes the first clause it can value out of a multi-part effect", () => {
    const v = valueOfEffect("Mining Power +1%, Crit Damage +5%", rows);
    expect(v?.stat).toBe("Critical Damage");
    expect(v?.amount).toBe(5);
  });
});

describe("rankSkillsByValue", () => {
  const crew = [
    { id: "Precise Targeting", effect: "Crit Chance +1%" },
    { id: "Annihilator", effect: "Crit Damage +5%" },
    { id: "Rapid Fire", effect: "Attack Speed +12%" },
    { id: "Hoarder", effect: "Cargo Capacity +10%" },
    { id: "Mystery", effect: undefined },
  ];

  it("names the skills it cannot judge instead of ranking them low", () => {
    const { unrankable } = rankSkillsByValue(crew, statMarginals(status, [gatling, gatling]));
    expect(unrankable).toEqual(["Hoarder", "Mystery"]);
  });

  it("comes back in descending order of what each is worth", () => {
    const { ranked } = rankSkillsByValue(crew, statMarginals(status, [gatling, gatling]));
    expect(ranked.map((r) => r.id)).toHaveLength(3);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].gain).toBeGreaterThanOrEqual(ranked[i].gain);
  });

  // THE POINT OF RANKING PER SHIP, in one assertion. A big Attack Speed skill beats a Crit Damage one on a gatling
  // battery and loses to it outright on single-shot guns, where attack speed buys nothing — so a crew order copied
  // from someone else's fit, or from a wiki, is wrong for one of the two.
  it("flips the crew order when the guns change", () => {
    const onGatling = rankSkillsByValue(crew, statMarginals(status, [gatling, gatling])).ranked.map((r) => r.id);
    const onLance = rankSkillsByValue(crew, statMarginals(status, [lance, lance])).ranked.map((r) => r.id);
    expect(onGatling[0]).toBe("Rapid Fire");
    expect(onLance[0]).toBe("Annihilator");
    expect(onLance[onLance.length - 1]).toBe("Rapid Fire");
  });
});
