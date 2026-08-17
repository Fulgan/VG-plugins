import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setDps, type ShipPools } from "./fleetDps";
import type { Item } from "./types";

// The fleetDps half of the arena's residual report: score each build with the REAL objective
// so the comparison audits this code rather than a port of it.
//
// Inputs come from `vgtrainer.residual emit` and are NOT in this repo. Absent inputs SKIP — a bare
// `npm test` runs every *.test.* under src/, and a suite that goes red because a sibling repo has not
// produced a file is one people learn to ignore.

const BUILDS = process.env.RESIDUAL_BUILDS ?? resolve(__dirname, "../../../arena/out/residual-builds.json");
const OUT = process.env.RESIDUAL_OUT ?? resolve(__dirname, "../../../arena/out/residual-fleetdps.jsonl");

interface Build {
  id: string;
  profile: string;
  totalHP: number;
  megaCrit: number;
  items: unknown[];
}

// The background holds no shared power, so every gun contributes only its own main power. That is the
// one arrangement in which the pooled model and the harness's per-weapon model describe the same
// battery; any other needs a second mapping between them that nothing verifies.
const poolsFor = (b: Build): ShipPools => ({
  poolCombatPower: 0,
  poolPrecision: 0,
  equivalentTurrets: 0,      // 0 ⇒ derived from the set's own size ratings
  precisionDivisor: 3430,
  critDamage: 0,
  megaCrit: b.megaCrit,
});

describe("residual report — fleetDps half", () => {
  it("scores a hand-built battery, so the file proves it loads without any fixture", () => {
    // Fast and input-free: whatever else is skipped, an import break or a signature change fails here.
    const gun = {
      name: "gun0", damageType: "Kinetic", gameplayType: "Combat", category: "Turret", size: "Medium",
      mainStat: { name: "Combat Power", amount: "1000" },
      fireDelayRaw: 0.5, reloadDelayRaw: 0, magSizeRaw: 100, burstAmount: 1, burstDelay: 0,
      aspects: [], substats: [], stats: [{ stat: "Combat Power", amount: 1000, multiplier: 1 }],
    } as unknown as Item;

    const one = setDps([gun], poolsFor({ megaCrit: 0 } as Build));
    expect(one).toBeGreaterThan(0);
    // Two identical guns must out-damage one. If this ever ties, the per-gun loop has stopped summing.
    expect(setDps([gun, gun], poolsFor({ megaCrit: 0 } as Build))).toBeGreaterThan(one);
  });

  it.skipIf(!existsSync(BUILDS))("scores every emitted build", () => {
    const builds: Build[] = JSON.parse(readFileSync(BUILDS, "utf-8"));
    expect(builds.length).toBeGreaterThan(0);

    const lines = builds.map((b) => {
      const dps = setDps(b.items as Item[], poolsFor(b));
      // A zero here would silently become a rejected row downstream. Fail instead: it means the items
      // stopped classifying as combat turrets, which is a mapping break, not a datum.
      expect(dps, `${b.id} scored 0 — items no longer read as combat turrets`).toBeGreaterThan(0);
      return JSON.stringify({ id: b.id, profile: b.profile, totalHP: b.totalHP, dps });
    });

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
    expect(lines.length).toBe(builds.length);
  });
});
