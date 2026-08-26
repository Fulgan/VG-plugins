// @vitest-environment jsdom
//
// WHAT EACH COMBAT STAT IS ACTUALLY WORTH ON THE LIVE SHIP'S OWN TURRETS, printed rather than reasoned about.
//
// `Sort by value` orders the priority list by these numbers, so "are you sure crit beats attack speed on my
// guns" is answerable only by asking the battery in front of the player. V80 is the reason it is not a general
// fact: attack speed reaches only the `(bursts-1)·fireDelay` half of a gun's cycle, so it is worth EXACTLY zero
// on a gun whose magazine empties as one burst, and a fifth of its neighbour's value where reload dominates.
//
// SKIPS ITSELF when `live/` is absent, like `liveReport`. To use:
//     pwsh tools\pull-live.ps1
//     npx vitest run src/liveMarginals.test.tsx
import { describe, it } from "vitest";
import { statMarginals } from "./statMarginals";
import { poolsFromStatus, speedRatio } from "./fleetDps";
import type { Item, Loadout, Status } from "./types";

const LIVE = import.meta.glob("../live/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const have = (n: string) => Object.keys(LIVE).some((p) => p.endsWith(`/${n}`));
const read = <T,>(n: string): T =>
  Object.entries(LIVE).find(([p]) => p.endsWith(`/${n}`))?.[1] as T;

describe.skipIf(!have("status.json") || !have("loadout.json"))("live stat marginals", () => {
  it("prints what each stat buys on this battery", () => {
    const status = read<Status>("status.json");
    const loadout = read<Loadout>("loadout.json");
    // The hardpoint IS the item here: `/loadout` inlines it rather than nesting one under `item`.
    const turrets = ((loadout as unknown as { hardpoints?: Item[] }).hardpoints ?? [])
      .filter((it): it is Item => !!it && it.category === "Turret");

    const rows = statMarginals(poolsFromStatus(status) as never, turrets);

    const out: string[] = [];
    out.push("");
    out.push("STAT MARGINALS on the live ship, strongest first");
    out.push(`  ship ${status.shipType}  ${turrets.length} turrets`);
    out.push("");
    for (const r of rows) {
      const per = r.unit === "point" ? "per +0.01 of the stat" : "per +1% of the pool";
      out.push(`  ${r.stat.padEnd(18)} ${(r.perPoint * 100).toFixed(4).padStart(9)}%   ${per}${r.approximate ? "   (approximate)" : ""}`);
    }
    out.push("");

    // WHY attack speed lands where it does, per gun: the cycle geometry V80 describes. `speedRatio` is the one
    // owner of that, so this asks it rather than restating the formula.
    out.push("ATTACK SPEED PER GUN, its own cycle deciding what it is worth");
    for (const t of turrets) {
      const at0 = speedRatio(t, 0, 0, 0);
      const at10 = speedRatio(t, 0.10, 0, 0);
      const mag = (t as unknown as { magSizeRaw?: number }).magSizeRaw;
      const burst = (t as unknown as { burstAmount?: number }).burstAmount;
      const fd = (t as unknown as { fireDelayRaw?: number }).fireDelayRaw;
      const rl = (t as unknown as { reloadDelayRaw?: number }).reloadDelayRaw;
      const gain = at0 > 0 ? (at10 / at0 - 1) * 100 : 0;
      out.push(`  ${String(t.name).slice(0, 30).padEnd(31)} +10% attack speed => ${gain.toFixed(2).padStart(6)}% rate`
        + `   mag ${mag} burst ${burst} fireDelay ${fd} reload ${rl}`);
    }
    out.push("");
    // eslint-disable-next-line no-console
    console.log(out.join("\n"));
  });
});
