// DOES THE MODEL COUNT WHAT THE GAME COUNTS?
//
// Every magnitude defect in this objective has had one shape: a contribution the game pools and the client scores
// as zero. `MODULE_POOLS` maps each pool to a stat NAME, `part()` matches by name, and anything unmatched
// contributes nothing — silently, with no compiler error, no failing test and no warning. It surfaces as a
// suggestion a player cannot believe, days later, and is then traced by hand.
//
// The bridge has been serving the answer all along. `GET /stat/sources?stat=<pool>` is the game's own enumeration
// of what feeds a pool, and each entry carries a `via` naming the STAT the amount arrived through — so a
// contribution reaching CombatPower through `Power` says so. This asserts the only thing that has ever been wrong:
// that every stat the game routes into a pool is a stat the client folds into it.
//
// Asserted through the model's BEHAVIOUR, not against a restatement of its mapping: a synthetic item carrying one
// line named after the `via` is swapped in through `poolsWithModules` — the objective's own owner — and the pool
// must move. A rule the client does not know moves nothing, and the test names the `via` that was dropped.
//
// It asserts no MAGNITUDES, deliberately: those move with the save, and the enumeration is itself incomplete —
// `additiveSum` runs a little under `total / multiplier`, and the multiplier side has an unattributed factor (the
// bridge's own comment says a display breakdown is not a complete accounting). What CANNOT drift is which stats
// reach which pool, and that is what this pins.
import { describe, expect, it } from "vitest";
import { poolsWithModules, type ShipPools } from "./fleetDps";
import type { Item } from "./types";

interface Source { source: string; amount: number; multiplier: number; via: string }
// What the SHIP read as when the capture was taken. Without it two captures cannot be compared: a figure that
// moved between them has at least three candidate causes — the game's own balance, a fix to how the game counts
// turrets, and the player refitting or changing hull — and a capture that records none of them is unattributable
// forever after. `equivalentTurrets` is the divisor every pooled share is taken over and `poolCombatPower` the
// dividend, so the pair is what separates "the pool moved" from "the split moved". Both are COUNTS and
// MAGNITUDES, never an identity, so the fixture stays safe to commit.
interface Context {
  gameVersion: string; shipType: string; role: string;
  equivalentTurrets: number; poolCombatPower: number;
}
interface Sources {
  stat: string; total: number; multiplier: number; additiveSum: number; sources: Source[];
  context?: Context;
}

const FIXTURES = import.meta.glob("../fixtures/recon-sources-*.json", { eager: true, import: "default" }) as
  Record<string, Sources>;
const read = (name: string): Sources => {
  const hit = Object.entries(FIXTURES).find(([p]) => p.endsWith(`/recon-sources-${name}.json`));
  if (!hit) throw new Error(`fixture recon-sources-${name}.json not found — captured from GET /stat/sources`);
  return hit[1];
};

// Which reported pool each captured stat is, and the display name the client knows it by.
const POOLS = [
  { file: "combatpower", pool: "poolCombatPower", mult: "poolCombatPowerMult", stat: "Combat Power" },
  { file: "miningpower", pool: "poolMiningPower", mult: "poolMiningPowerMult", stat: "Mining Power" },
  { file: "salvagepower", pool: "poolSalvagePower", mult: "poolSalvagePowerMult", stat: "Salvage Power" },
  { file: "precision", pool: "poolPrecision", mult: "poolPrecisionMult", stat: "Precision" },
] as const;

const BASE = 100_000;

/** A module carrying exactly one additive line, named as the game named it. */
const oneLine = (stat: string, amount: number): Item => ({
  key: 1, slot: null, identifier: null, name: `carries ${stat}`, rarity: "Standard", level: 60,
  size: "Large", type: "Scanner", slotType: "Scanner", category: "Module", sellValue: 0,
  mainStat: { name: stat, amount: String(amount) }, powerUsage: 0, powerUsageBase: 0,
  stats: [{ stat, amount, multiplier: 1, percent: false }],
  substats: [], aspects: [], bonus: null, bonusStat: null,
} as unknown as Item);

const empty = (): Item => ({
  key: 2, slot: null, identifier: null, name: "carries nothing", rarity: "Standard", level: 60,
  size: "Large", type: "Scanner", slotType: "Scanner", category: "Module", sellValue: 0,
  mainStat: null, powerUsage: 0, powerUsageBase: 0,
  stats: [], substats: [], aspects: [], bonus: null, bonusStat: null,
} as unknown as Item);

const poolsWith = (pool: string, mult: string): ShipPools => ({
  poolCombatPower: 0, poolPrecision: 0, equivalentTurrets: 1, precisionDivisor: 3_676,
  critDamage: 0, megaCrit: 0,
  [pool]: BASE, [mult]: 1,
} as unknown as ShipPools);

// A CAPTURE THAT CANNOT BE ATTRIBUTED IS WORTH LESS THAN IT LOOKS, so the requirement is a check rather than a
// note in a doc: a re-capture that drops the context fails here instead of being discovered a patch later, when
// the figure it would have explained has already moved.
describe("every capture says what ship it was taken on", () => {
  for (const p of POOLS) {
    it(`${p.file}: carries the context a later diff needs`, () => {
      const ctx = read(p.file).context;
      expect(ctx, `recon-sources-${p.file}.json has no \`context\` — re-capture it with pull-live.ps1`).toBeDefined();
      expect(ctx!.gameVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      // Present and numeric, never asserted to a value: both move with the save, and pinning either would make
      // this fail for flying a different ship rather than for a defect.
      expect(typeof ctx!.equivalentTurrets).toBe("number");
      expect(typeof ctx!.poolCombatPower).toBe("number");
      expect(ctx!.shipType).toBeTruthy();
    });
  }
});

describe("the model counts what the game counts", () => {
  for (const p of POOLS) {
    const cap = read(p.file);
    // Multiplier-only entries carry `amount: 0` and are the hull/skill factors, which no item swap can move.
    const additive = cap.sources.filter((s) => s.amount !== 0);
    const vias = [...new Set(additive.map((s) => s.via))].sort();

    it(`${cap.stat}: every stat the game routes here is one the objective folds in (${vias.join(", ") || "none"})`, () => {
      expect(vias.length).toBeGreaterThan(0);
      const dropped: string[] = [];
      for (const via of vias) {
        const moved = poolsWithModules(poolsWith(p.pool, p.mult), [empty()], [oneLine(via, 1_000)]);
        const after = (moved as unknown as Record<string, number>)[p.pool];
        if (Math.abs(after - (BASE + 1_000)) > 1e-6) dropped.push(via);
      }
      expect(dropped, `${cap.stat} is fed through ${dropped.join(", ")}, which the objective scores as zero`)
        .toEqual([]);
    });

    it(`${cap.stat}: the game's own enumeration still reconciles with the reported total`, () => {
      // The bridge's own check: `additiveSum` should reach `total / multiplier`. It runs slightly under because
      // `GetStatsInfoItems` is a display breakdown — so this pins the SHORTFALL as small rather than as zero. A
      // capture where it grows means the game gained a contributor nothing here has looked at.
      const target = cap.total / cap.multiplier;
      const shortfall = (target - cap.additiveSum) / target;
      expect(shortfall).toBeGreaterThanOrEqual(-1e-6);
      expect(shortfall).toBeLessThan(0.05);
    });
  }

  it("would have caught the umbrella: a pool fed through `Power` needs the additive half folded", () => {
    // The regression this file exists for. Before the fix, `poolPart` folded the `Power` MULTIPLIER and not its
    // amount, so a reactor's `Power 2,289.86` moved no pool at all — and a reactor swap projected no mining
    // change whatsoever.
    //
    // The precondition is that this capture EXERCISES the umbrella — `Power` is among the stats the game routes
    // into mining — not that it is the only one. Asserting `every` pinned an accident of the hull that was
    // captured (no mining gun fitted, so every mining line arrived through `Power`) and broke the moment a hull
    // with one was captured, which is a wider capture and the opposite of a regression.
    const mining = read("miningpower");
    expect(mining.sources.filter((s) => s.amount !== 0).some((s) => s.via === "Power")).toBe(true);
    const moved = poolsWithModules(poolsWith("poolMiningPower", "poolMiningPowerMult"),
      [empty()], [oneLine("Power", 1_000)]);
    expect(moved.poolMiningPower).toBeCloseTo(BASE + 1_000, 6);
  });
});
