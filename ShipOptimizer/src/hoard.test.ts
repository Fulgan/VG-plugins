// The gear search against a LONG PLAYTHROUGH'S armory, which is where its cost stops being theoretical.
//
// Volumes here are the shape of a real reported save: 7,902 instanced gear items, of which ~4,400 are Small
// turrets, ~440 Medium and ~230 Large, spread over ~18 Small types with many near-duplicates differing only
// in level; hulls of 5 and 7 hardpoints. Synthesised rather than copied — the numbers are the fixture, the
// player's save is not in this repo.
//
// Two things are pinned: the search finishes in a time a click can wait for, and the shortlist it depends on
// keeps the guns that can actually win (a small gun carrying Precision, a zero-draw gun holding a bracket).
import { describe, it, expect } from "vitest";
import { optimizeTurretSet, optimizeTurretSetLayered, shortlist, background, setRank, type ShipPools } from "./fleetDps";
import { gearTurretOpps } from "./opportunities";
import type { Item } from "./types";

const SMALL_TYPES = [
  "Small Salvage Laser", "Small Structural Salvage Grinder", "Small Autocannon", "Small Hailfire Launcher",
  "Small Gatling Turret", "Small Laser", "Small Rail Cannon", "Small Shotgun", "Small Plasma Autocannon",
  "Small Missile Turret", "Small Mining Laser", "Small Mining Core Explosive Launcher",
  "Small Mining AutoCannon", "Small Corropult", "Small Laser Repeater", "Small Microcell Missile Turret",
  "Small Plasma Lance", "Small Cryo Lance",
];

// `StatLine.amount` is a NUMBER (types.ts) while `mainStat.amount` is a string — the shapes differ, and
// stringifying a stat line here made every score NaN.
const stat = (s: string, v: number) => ({ stat: s, amount: v });

// One gun, in the shape the objective actually reads: `category`, `gameplayType`, `mainStat.amount` (see the
// factories in fleetDps.test.ts). `seed` moves the level and the rolls, so the pool is near-duplicates the way
// a real armory is — dozens of one type, a few levels apart.
function turret(type: string, size: "Small" | "Medium" | "Large", seed: number, act: "Combat" | "Mining" | "Salvage"): Item {
  const level = 40 + (seed % 30);
  const power = 1000 + level * 90 + (seed % 7) * 40;
  return {
    key: `${type}#${seed}`, name: `${type} Mk.${seed % 20}`, type, size, level,
    category: "Turret", gameplayType: act, damageType: "Kinetic",
    mainStat: { name: `${act} Power`, amount: String(power) },
    rarity: seed % 11 === 0 ? "Exotic" : seed % 3 === 0 ? "HighGrade" : "Standard",
    location: "armory",
    stats: [
      stat("Precision", (seed % 13) * 120),
      stat("Critical Damage", (seed % 5) * 0.02),
      stat("Attack Speed", (seed % 4) * 0.03),
    ],
    substats: [], aspects: [],
    powerUsage: seed % 29 === 0 ? 0 : 400 + (seed % 9) * 120,
    powerUsageBase: seed % 29 === 0 ? 0 : 400 + (seed % 9) * 120,
    fireDelayRaw: 1.2, reloadDelayRaw: 2.5, magSizeRaw: 8, burstAmount: 1, burstDelay: 0.2,
  } as unknown as Item;
}

function hoard(): Item[] {
  const out: Item[] = [];
  let seed = 1;
  // ~4,400 Small across 18 types, ~440 Medium, ~230 Large — the reported ratio.
  for (const [size, total] of [["Small", 4400], ["Medium", 440], ["Large", 230]] as const) {
    for (let i = 0; i < total; i++) {
      const type = SMALL_TYPES[i % SMALL_TYPES.length].replace("Small", size);
      const act = /Salvage|Grinder/.test(type) ? "Salvage" : /Mining/.test(type) ? "Mining" : "Combat";
      out.push(turret(type, size, seed++, act));
    }
  }
  return out;
}

const POOLS: ShipPools = {
  poolCombatPower: 210_000, poolPrecision: 18_000, equivalentTurrets: 7, precisionDivisor: 3200,
  critDamage: 1.4, megaCrit: 0, poolSalvagePower: 90_000, equivalentTurretsSalvage: 7,
  poolMiningPower: 80_000, equivalentTurretsMining: 7,
  // Roomy on purpose: a tight reactor makes REFUSING a second gun the right answer (the bracket loss
  // outweighs its own power), and then the test measures the bracket rule rather than the search.
  energy: { used: 8000, capacity: 60_000, mod: 0.2 },
} as unknown as ShipPools;

const ALL = hoard();
const ofSize = (size: string) => ALL.filter((g) => (g as { size: string }).size === size);

describe("the search survives a long playthrough's armory", () => {
  it("shortlists thousands of Small turrets down to a searchable set", () => {
    const smalls = ofSize("Small");
    expect(smalls.length).toBeGreaterThan(4000);

    const short = shortlist(smalls);

    expect(short.length).toBeLessThanOrEqual(130); // ≤ 11 axes × 12, minus overlap
    expect(short.length).toBeGreaterThan(20);      // and not so tight that the ascent has nothing to choose
  });

  // The case the whole set model exists for: a gun whose own power is unremarkable but whose Precision lifts
  // every gun. Cutting by main stat alone would drop it, and the ascent would never see it.
  it("keeps a low-power gun with the best Precision", () => {
    const smalls = ofSize("Small");
    const best = [...smalls].sort((a, b) => prec(b) - prec(a))[0];
    expect(shortlist(smalls)).toContain(best);
  });

  // And the one no stat of its own reveals: a Solar Powered gun, drawing nothing, winning by holding a reactor
  // bracket for the whole battery. Admitted as a CATEGORY, not ranked by draw or by power-per-draw — draw
  // tracks power, so both of those would spend the slots on weak or merely-efficient guns.
  it("keeps a zero-draw gun", () => {
    const smalls = ofSize("Small");
    const free = smalls.find((g) => (g as unknown as { powerUsage: number }).powerUsage === 0)!;
    expect(free).toBeDefined();
    expect(shortlist(smalls)).toContain(free);
  });

  it("optimises a 5-hardpoint combat battery inside a click's patience", () => {
    const slots = Array.from({ length: 5 }, (_, i) => ({
      key: `t:${i}`, current: undefined, candidates: shortlist(ofSize("Small")),
    }));
    const bg = background(POOLS, []);

    const t0 = performance.now();
    // No `act`: that parameter names a non-combat POOL (`PowerActivity` is Mining|Salvage), and a combat set
    // is judged on the combat tier instead.
    const picked = optimizeTurretSet(slots, bg, 4, [], "balanced");
    const ms = performance.now() - t0;

    expect(picked.size).toBe(5);
    // Generous against CI jitter, tight enough to catch the shortlist or its cache being lost: without either,
    // this same case ran ~16x slower.
    expect(ms).toBeLessThan(600);
  });

  // The layered path runs that same ascent once per layer assignment, so it is the one that could freeze the
  // tab. 7 hardpoints is the largest hull in the reported save.
  it("optimises a 7-hardpoint SALVAGE battery, layers and all, inside a click's patience", () => {
    const salvage = ofSize("Small").filter((g) => /Salvage|Grinder/.test((g as { type: string }).type));
    const slots = Array.from({ length: 7 }, (_, i) => ({
      key: `t:${i}`, current: undefined, candidates: shortlist(salvage), layerRole: "any" as const,
    }));
    const bg = background(POOLS, []);

    const t0 = performance.now();
    const picked = optimizeTurretSetLayered(slots, bg, "Salvage", { target: "balanced", maxPasses: 4 });
    const ms = performance.now() - t0;

    expect(picked.size).toBeGreaterThan(0);
    expect(ms).toBeLessThan(900);
  });
});

// The opportunity rail, MEASURED and not yet fixed. It is the one large-list surface the shortlist cannot help:
// the rail must see every item to pick the best per NAME, so its cost is hardpoints × candidates calls to
// `gain`, and in expanded mode each of those scores a whole set. Its OUTPUT is safely bounded (deduped by item
// name into a Map), so this is about the scan, and it runs on render rather than on a click.
//
// The threshold is deliberately loose: this test exists to put a number on the scan and to fail loudly if it
// grows by an order of magnitude, not to assert that the current cost is acceptable.
//
// The figure it prints UNDERSTATES the app: `gearGain` rebuilds `background(shipPools, equippedTurrets)` inside
// every call, which this hoists out of the loop. Hoisting it there is the cheapest thing to try first.
describe("the opportunity rail's scan over a long playthrough's armory", () => {
  it("reports what one rail pass costs", () => {
    const smalls = ofSize("Small");
    const bg = background(POOLS, []);
    const equipped = shortlist(smalls).slice(0, 5);
    const hps = equipped.map((eq, i) => ({ index: i, size: "Small", equipped: eq } as never));

    // The gain function the tab uses in expanded mode: a set rank per candidate, not a stat comparison.
    const gain = (eq: Item, cand: Item) => {
      const withCand = [...equipped.filter((e) => e !== eq), cand];
      return setRank(withCand, bg)[1] - setRank(equipped, bg)[1];
    };

    const t0 = performance.now();
    const opps = gearTurretOpps(smalls, hps, {}, {}, gain);
    const ms = performance.now() - t0;

    // Bounded output, unbounded scan: that asymmetry is the finding.
    expect(opps.length).toBeLessThan(smalls.length / 4);
    // eslint-disable-next-line no-console -- the number is the point of this test
    console.log(`rail scan: ${smalls.length} candidates × ${hps.length} hardpoints in ${ms.toFixed(0)}ms → ${opps.length} offers`);
    expect(ms).toBeLessThan(20_000);
  });
});

function prec(it: Item): number {
  return (it as unknown as { stats: { stat: string; amount: number }[] }).stats
    .find((s) => s.stat === "Precision")?.amount ?? 0;
}
