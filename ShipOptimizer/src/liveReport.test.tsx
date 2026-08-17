// @vitest-environment jsdom
//
// WHAT THE OPTIMIZER PROPOSES ON THE LIVE SHIP, AND EVERY FIGURE IT PREDICTS, IN ONE TEXT FILE.
//
// This exists because the diagnosis loop was: the player loads a ship, screenshots an absurd suggestion, and the
// defect is traced by hand from a picture. That is slow, it only ever samples one build, and it puts the person
// with the least context in the loop. The bridge serves everything the objective reads, so the objective can be
// run against the live ship directly and its own predictions printed beside the game's own numbers.
//
// It drives the REAL builder — `useGearBuilder`, the same hook the tab mounts — rather than re-implementing the
// suggestion path here. A harness that recomposed the search would be a second answer to "what goes in this slot",
// which is the defect this repo keeps paying for.
//
// SKIPS ITSELF when `live/` is absent, so `npm test` is unaffected. To use:
//     pwsh tools\pull-live.ps1
//     npx vitest run src/liveReport.test.tsx
//     read ShipOptimizer\live\report.txt
import { describe, it, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGearBuilder, type GearBuilder } from "./GearTab";
import {
  background, contributionOf, loadAsRead, poolsFromStatus, poolsWithModules, precisionCrit,
  reactorBudgetOf, setRank, worthSwitching, BASE_CRIT_CHANCE, type ShipPools,
} from "./fleetDps";
import { energyDraw, reactorModifier } from "./reactor";
import type { Inventories, Item, ShipLayout, Status, Vitals } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIVE = import.meta.glob("../live/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const have = (n: string) => Object.keys(LIVE).some((p) => p.endsWith(`/${n}`));
const read = <T,>(n: string): T =>
  Object.entries(LIVE).find(([p]) => p.endsWith(`/${n}`))?.[1] as T;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

const n0 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US");
const pc1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const delta = (a: number | null, b: number | null) =>
  a == null || b == null || !a ? "" : `  (${b - a >= 0 ? "+" : ""}${(((b - a) / Math.abs(a)) * 100).toFixed(2)}%)`;
const row = (label: string, a: number | null, b: number | null, f = n0) =>
  `  ${label.padEnd(22)} ${f(a).padStart(14)}${b == null || b === a ? "" : ` → ${f(b).padStart(14)}${delta(a, b)}`}`;

const nameOf = (it: Item | null | undefined) =>
  !it ? "(empty)" : `${it.name} Lv${it.level}${it.bonus ? ` Q${it.bonus}` : ""}`;
const lineOf = (it: Item) =>
  (it.stats ?? []).filter((s) => (s.amount ?? 0) !== 0 || (s.multiplier ?? 1) !== 1)
    .map((s) => `${s.stat} ${(s.multiplier ?? 1) !== 1 ? `×${s.multiplier}` : n0(s.amount)}`).join(", ");

describe.skipIf(!have("status.json"))("live gear report", () => {
  it("writes what is mounted, what is proposed, and what is predicted", async () => {
    const status = read<Status>("status.json");
    // `/ship/layout` is the read to use: it carries each slot's `equipped` item AND answers undocked, where
    // `/loadout` is docked-only (Hypercom V4). It is also the shape `useGearBuilder` takes, so the harness feeds
    // the builder exactly what the tab feeds it.
    const layout = read<ShipLayout>("layout.json") ?? read<ShipLayout>("loadout.json");
    const inv = read<Inventories>("inventories.json");
    const vitals = have("vitals.json") ? read<Vitals>("vitals.json") : null;
    const pools = poolsFromStatus(status as never);   // null when the unit is not live

    const out: string[] = [];
    const say = (s = "") => out.push(s);
    const NL = String.fromCharCode(10);
    const stop = async (why: string) => {
      say(why);
      const fs = await import("node:fs");
      fs.writeFileSync("live/report.txt", out.join(NL) + NL, "utf8");
      process.stdout.write(NL + out.join(NL) + NL);
    };

    say(`SHIP  ${status.shipType ?? "?"} · ${status.role ?? "?"} · game ${status.gameVersion ?? "?"}`);
    say(`      docked=${status.docked} statsLive=${status.statsLive} equivalentTurrets=${status.equivalentTurrets}`);
    say();

    if (!layout) {
      return stop([
        "CANNOT REPORT — no layout.json and no loadout.json.",
        "  Re-run tools/pull-live.ps1 with the game running.",
      ].join(NL));
    }
    if (!pools) {
      return stop([
        `CANNOT REPORT — /status sent no pools (statsLive=${status.statsLive}).`,
        "  The unit's equipment is not registered, which happens around a scene change and while undocked.",
        "  The tab would be in SIMPLE mode here, and there is no set objective to report on.",
      ].join(NL));
    }

    // ---- what is mounted -------------------------------------------------------------------------
    // `/ship/layout`'s hardpoints and module slots each WRAP their item in `equipped` — the same shape
    // `useGearBuilder` reads. Printing the slot as though it were the item is how this first reported a
    // battery of `undefined`.
    say("MOUNTED — hardpoints");
    for (const h of layout.hardpoints ?? []) {
      const it = h.equipped;
      say(`  [${h.index}] ${(h.size ?? "?").padEnd(6)} ${nameOf(it)}  draw ${n0(it?.powerUsage)}`);
      if (it) say(`        ${lineOf(it)}`);
    }
    const mods = ((layout as unknown as { modules?: { slot: string; equipped: Item | null }[] }).modules ?? []);
    say("MOUNTED — modules");
    for (const m of mods) {
      say(`  ${m.slot.padEnd(12)} ${nameOf(m.equipped)}  draw ${n0(m.equipped?.powerUsage)}`);
      if (m.equipped) say(`        ${lineOf(m.equipped)}`);
    }
    say();


    // ---- the PLAYER'S OWN TAB STATE, or this reports a plan they cannot be offered ------------------
    // `useGearBuilder` reads slot filters, keep locks, the ranking mode and the turret categories from
    // `storage.load`, i.e. from localStorage — which the browser hydrates from the bridge at boot and which is
    // EMPTY in jsdom. Mounting without it runs a different tab: measured on the live Monsoon, whose seven
    // hardpoints are all filtered to `category: EMP`, the unfiltered harness proposed Kinetic guns that the
    // player's own tab filters out, and the report was read as describing suggestions nobody had seen.
    // Seeded BEFORE the first render, because the builder reads them in `useState` initializers.
    const state = have("client-state.json")
      ? read<{ entries?: Record<string, string> }>("client-state.json")
      : null;
    for (const [k, v] of Object.entries(state?.entries ?? {})) {
      if (typeof v === "string") localStorage.setItem(k, v);
    }
    say(state ? `TAB STATE  ${Object.keys(state.entries ?? {}).length} keys loaded from /client/state`
              : "TAB STATE  ⚠ NOT LOADED — no client-state.json in the snapshot ∴ default filters, and the plan " +
                "below is not the one the player's tab shows. Re-run tools\\pull-live.ps1.");

    // WHAT THE PLAYER'S OWN TAB PUBLISHED, which is the answer this file used to only approximate. `GearTotals`
    // writes its rendered figures to `shipoptimizer.lastPlan` on every plan it draws, so this is not a
    // reconstruction: it is the panel's own numbers, taken from a browser that had the real filters, the real
    // keep-locks and the real categories. Where it disagrees with the re-mount below, believe THIS one and treat
    // the difference as an input the harness is missing.
    try {
      const raw = state?.entries?.["shipoptimizer.lastPlan"];
      const pub = raw ? JSON.parse(raw) as {
        ship?: string; ranking?: string;
        swaps?: { out: string; in: string; outPower: string | null; inPower: string | null;
                  outDraw: number; inDraw: number; outAspects: string[]; inAspects: string[] }[];
        figures?: Record<string, { cur: number | null; next: number | null; label?: string }>;
      } : null;
      if (!pub) {
        say("PUBLISHED   (none — open the Gear tab in the browser once, then re-pull)");
      } else {
        say(`PUBLISHED — what the player's tab last drew (ship ${pub.ship ?? "?"}, ${pub.ranking ?? "?"})`);
        for (const s of pub.swaps ?? []) {
          say(`  ${s.out}  →  ${s.in}`);
          say(`     main ${s.outPower ?? "—"} → ${s.inPower ?? "—"}   draw ${n0(s.outDraw)} → ${n0(s.inDraw)}`);
          if (s.outAspects.length || s.inAspects.length)
            say(`     aspects [${s.outAspects.join(", ")}] → [${s.inAspects.join(", ")}]`);
        }
        if (!(pub.swaps ?? []).length) say("  (the tab proposes nothing)");
        // A fraction printed with the integer formatter reads as `1 → 1`, which is how a crit chance of 56.5%
        // and one of 58.5% became the same number on this line.
        const asFraction = new Set(["critChance", "load"]);
        for (const [k, v] of Object.entries(pub.figures ?? {}))
          say(row(`  ${v.label ?? k}`, v.cur, v.next, asFraction.has(k) ? pc1 : n0));
      }
    } catch (e) {
      say(`PUBLISHED   unreadable: ${(e as Error).message}`);
    }
    say();

    // ---- run the REAL builder and let it propose --------------------------------------------------
    let seen: GearBuilder | null = null;
    const Probe = () => {
      seen = useGearBuilder(layout, inv, status.shipGuid ?? null,
        { chance: status.critChance ?? 0.03, damage: status.critDamage ?? 1, megaCrit: status.megaCrit ?? 0 },
        pools, status.role ?? null, vitals);
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Probe />); });
    await act(async () => { seen!.setRanking("expanded"); });
    await act(async () => { seen!.suggestShip(); });

    const b = seen! as GearBuilder;
    const curT = b.hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const nextT = b.hps.map((h) => b.assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
    const curM = b.mslots.map((m) => m.equipped).filter((x): x is Item => !!x);
    const nextM = b.mslots.map((m) => b.assign[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x);

    say("PROPOSED (Suggest whole ship, expanded)");
    let any = false;
    for (const h of b.hps) {
      const p = b.assign[`t:${h.index}`];
      if (p) { any = true; say(`  slot ${h.index} ${h.size}  ${nameOf(h.equipped)}\n        → ${nameOf(p)}   draw ${n0(h.equipped?.powerUsage)} → ${n0(p.powerUsage)}\n        → ${lineOf(p)}`); }
    }
    for (const m of b.mslots) {
      const p = b.assign[`m:${m.slot}`];
      if (p) { any = true; say(`  ${m.slot}  ${nameOf(m.equipped)}\n        → ${nameOf(p)}   draw ${n0(m.equipped?.powerUsage)} → ${n0(p.powerUsage)}\n        → ${lineOf(p)}`); }
    }
    if (!any) say("  (nothing — the objective proposes no change)");
    say();

    // ---- what it PREDICTS, from the same owners the panel uses ------------------------------------
    {
      // TWO projections, exactly as `GearTotals` keeps them, and they are not interchangeable:
      //
      //   planPools — the whole plan, turrets AND modules. What the ship's POOLS would read, so it is what the
      //               pool rows below print.
      //   projPools — the MODULE swaps only. What the battery is scored AGAINST, because `setDps` adds each
      //               candidate turret's own contribution itself: fold the turrets into the pool as well and
      //               every proposed gun is counted twice, once in the background and once as its own.
      //
      // Scoring off the all-items projection is what made this report announce +13.52% on a plan the tab itself
      // rates +1.44% — the instrument overstating every plan a defect was then hunted in.
      const planPools = poolsWithModules(pools, [...curT, ...curM], [...nextT, ...nextM]);
      const projPools = poolsWithModules(pools, curM, nextM);
      const bud = reactorBudgetOf(pools)!;
      const usedNext = (bud.used ?? 0) + (energyDraw([...nextT, ...nextM]) - energyDraw([...curT, ...curM]));
      const capNext = planPools.energy?.capacity ?? bud.capacity;
      const loadNow = bud.usage, loadNext = capNext ? usedNext / capNext : null;
      const critOf = (p: ShipPools, prec: number) => {
        if (p.critChance == null) return null;
        const mult = p.critChanceMult ?? 1;
        const add = p.critChance / mult - BASE_CRIT_CHANCE - precisionCrit(p.poolPrecision, p.precisionDivisor);
        return (BASE_CRIT_CHANCE + precisionCrit(prec, p.precisionDivisor) + add) * mult;
      };
      const cur = setRank(curT, background(pools, curT));
      const next = setRank(nextT, background(projPools, curT));

      say("PREDICTED — current → planned");
      say(row(`${cur[0] === 2 ? "DPS index" : "Power"} (tier ${cur[0]})`, cur[1], next[1]));
      say(row("Combat power", pools.poolCombatPower, planPools.poolCombatPower));
      say(row("Precision", pools.poolPrecision, planPools.poolPrecision));
      say(row("Crit chance", critOf(pools, pools.poolPrecision), critOf(pools, planPools.poolPrecision), pc1));
      say(row("Mining power", pools.poolMiningPower ?? null, planPools.poolMiningPower ?? null));
      say(row("Salvage power", pools.poolSalvagePower ?? null, planPools.poolSalvagePower ?? null));
      say(row("Energy used", bud.used, usedNext));
      say(row("Reactor capacity", bud.capacity, capNext));
      say(row("Load", loadNow, loadNext, pc1));
      say(row("Reactor bonus", loadNow == null ? null : reactorModifier(loadNow),
        loadNext == null ? null : reactorModifier(loadNext), pc1));
      if (vitals) {
        say(row("Hull (game)", vitals.hull?.max ?? null, null));
        say(row("Armor (game)", vitals.armor?.max ?? null, null));
        say(row("Shield (game)", vitals.shield?.max ?? null, null));
      }
      say();
      say(`  VERDICT  worthSwitching = ${worthSwitching(next, cur)}   ` +
          `rank ${cur[1].toFixed(1)} → ${next[1].toFixed(1)}${delta(cur[1], next[1])}`);
      say(`  loadAsRead(now) = ${pc1(loadAsRead(pools.energy!))}   ` +
          `loadAsRead(proj) = ${pc1(loadAsRead(planPools.energy!))}   (must be equal — V73)`);
      say();

      // ---- does the model count what the game counts, on THIS build? ------------------------------
      say("RECONCILE — the game's own sources vs the model");
      for (const [file, statName] of [
        ["sources-combatpower.json", "Combat Power"],
        ["sources-miningpower.json", "Mining Power"],
        ["sources-salvagepower.json", "Salvage Power"],
        ["sources-precision.json", "Precision"],
      ] as const) {
        if (!have(file)) { say(`  ${statName.padEnd(14)} (not captured)`); continue; }
        const cap = read<{ total: number; multiplier: number; additiveSum: number;
                           sources: { source: string; amount: number; via: string }[] }>(file);
        const vias = [...new Set(cap.sources.filter((x) => x.amount).map((x) => x.via))].sort();
        const target = cap.total / cap.multiplier;
        say(`  ${statName.padEnd(14)} total ${n0(cap.total).padStart(12)}  mult ${cap.multiplier.toFixed(4)}` +
            `  additive ${n0(cap.additiveSum).padStart(10)} of ${n0(target).padStart(10)}` +
            `  (short ${(((target - cap.additiveSum) / target) * 100).toFixed(2)}%)  via: ${vias.join(", ")}`);
      }
      say();
      say("MAIN POWER the model subtracts as each gun's own (GetMainPowerSum):");
      say(`  ${n0(curT.reduce((s, t) => s + contributionOf(t).combatPower, 0))}`);
    }

    const fs = await import("node:fs");
    const path = "live/report.txt";   // vitest runs from the ShipOptimizer root
    fs.writeFileSync(path, out.join("\n") + "\n", "utf8");
    // Also to stdout, for a run that only wants the tail.
    process.stdout.write("\n" + out.join("\n") + "\n");
  });
});
