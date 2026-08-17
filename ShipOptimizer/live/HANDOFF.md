# Handoff — optimizer session, 2026-08-07 08:2x

`live/` is gitignored ∴ this file never enters the repo. Nothing below is committed yet; `private/`
was clean at the last check and I hold no staged work.

## Mailbox

Role for THIS thread is `optimizer` (persisted to the old session's scratchpad, which a restart
replaces — rewrite `mailbox-role` = `optimizer` in the new scratchpad). Inbox `to-optimizer\`, outbox
`to-ml\`. Inbox empty. My message `20260807-082600-optimizer-claims-and-torpedo-formula.md` is still
sitting unread in `to-ml\` — leave it there, deleting is the reader's act.

Ids announced to the ML session and therefore MINE to write: `T153`, `T154`, `B90`, `B91`. They hold
`T152`'s number history (they renumbered a collided `T149` into it) but the torpedo row is the user's
assignment to this thread. Root `SPEC.md` runs to `T152`, `§B` to `B89`.

## What the user asked for, in order

1. "resume on torpedoes" → §T152. Settled with them: **path (b), the real thing** — one scale, guns and
   torpedoes in ONE combat number. Explicitly NOT the `GOAL_KEY` shortcut: *"turrets and torpedoes share
   the same role: combat DPS"*, so a lexicographic key below combat is the wrong shape.
2. "hold. The default balancer is still outputting stupid suggestions. check it out now" → diagnosis
   below. Torpedo work is PAUSED mid-write, nothing lost but the decompiles (re-runnable, §4).

## Diagnosis of the bad suggestions — MEASURED, live Monsoon, game 0.8.1.23

Reproduce: `pwsh tools\pull-live.ps1` then `npx vitest run src/liveReport.test.tsx` from `ShipOptimizer\`.

### B90 / T154 — the report overstates every plan (client-only, no game restart needed)

`liveReport.test.tsx:152,164`:

```ts
const proj = poolsWithModules(pools, [...curT, ...curM], [...nextT, ...nextM]);  // NEW guns folded in
const next = setRank(nextT, background(proj, curT));                             // only OLD guns taken out
```

Each proposed turret is counted twice — once inside the projected pool, once as its own contribution in
`setDps`. The tab does it correctly (`GearTab.tsx:844`): it projects MODULES only and subtracts
`fittedTurrets` on both sides. `GearTotals.tsx:94` builds the same all-items projection — check whether
line 94's `projPools` reaches a `background(..., curTurrets)` call before calling it clean.

Measured: report says **+13.52%**; same plan on one honest background is **+1.44%**.

### B91 / T153 — aspect stat lines are priced at ZERO (the real defect)

`aspect.ts:49` — `aspectValue` matches only `(?:additional|dealing)\s+([\d.]+)\s*%…damage`; everything
else returns `NONE`. But the game applies aspects as real stat lines:
`Behaviour.Equipment.Aspect.TurretBoostStat.GetStats` yields `new EquipStatLine(stat, statBoost,
statMultiplier)`, folded through `AbstractEquipment.GetStat`, and `DamageData.CalculateDamage` reads
`2f + sourceTurret.GetStat(CriticalDamage)`.

Live consequence — the plan sells:

```
out Plasma Spitter Mk.XVII  cp=3,417  draw=0   ["Solar Powered", "Critical Attenuation: +25% crit strike damage"]
out Plasma Spitter Mk.XVII  cp=3,718  draw=0   same two aspects
in  Shredder Mk.XVI         cp=2,009  draw=352 no aspects        slot 0 ALONE: -3.25%
in  Autocannon Mk.XVI       cp=2,665  draw=377 ["Punch Through: +10% Kinetic damage"]
```

`contributionOf(spitter).critDamage === 0.0000` ∴ dropping a +25% crit-damage aspect costs the objective
nothing. V75's own family: a contribution the game counts, scored as zero.

FIX SHAPE (not an English parser — the repo already regrets those): the numbers are SERIALIZED on the
aspect prefab, so they want the `/catalog/prefabs` treatment — bridge reads each `EquipAspect`'s
`TurretBoostStat`/`BoostStat` components, serves `{stat, statBoost, statMultiplier}`, and
`contributionOf` folds them like any other line. NEEDS A GAME RESTART to verify.

UNVERIFIED, do not assert: whether `Punch Through`-style typed payloads should be credited type-blind
(current behaviour). The description reads as a separate payload, which would make type-blind correct,
but nobody has read the aspect prefab to confirm.

### Sequencing recommended to the user (they had not answered when the restart came)

T154 first — client-only, and until it lands every measurement of T153's fix is overstated.

## §T152 torpedoes — the assembly read is DONE, write-up is NOT

Read off `refs/beta-0.8.1.23` with `ilspycmd` (global tool, installed). Re-decompile with:

```pwsh
ilspycmd -t Behaviour.Equipment.Module.TorpedoBayModule <refs>\Managed\Assembly-CSharp.dll
```

`TorpedoBayModule.CreateDamageData` → `new DamageData(base.parent)` ∴ **`sourceTurret == null`**:

```cs
power = parent.GetStat(TorpedoPower) + parent.GetNormalizedPower(CombatPower);
criticalChance = GetStat(EquipStat.CriticalChance);   // the BAY's own
type = DamageType.Heat;                               // always
targetLayer = TargetLayer.Surface;
```

∴ `CalculateDamage` SKIPS `num /= sourceTurret.defaultAttacksPerSecond` — `power/5` is the per-HIT alpha —
and crit damage / damage boost fall to the `sourceUnit` branch (ship pooled stats, not gun aspects).
`GetNormalizedPower(s) = GetStat(s)/GetEquivalentTurretsCount(s)`, undivided at count 0 (§T151 trap).
A torpedo takes ONE equivalent-turret share of Combat Power ∴ fitting another Large gun (15 → 18 on this
ship) dilutes every torpedo. That coupling is why this is one scale, not two keys.

**⚠ §T151 and §T152 both state `min(1/fireRate, latches/reloadSpeed)`. WRONG — `firing` serializes the
launch and there is uncounted fixed overhead:**

```
shot period = fireRate + 3f (FinishFiring) + 0.5f (latch deploy) + 0.5f (FadeInAndGrow) + door anim
latch busy  = 4f + door + reloadSpeed          (ReloadTorpedo, per latch)
sustained   = 1 / max(fireRate + 4 + door, (4 + door + reloadSpeed) / latches)
```

`fireRate` is a PERIOD. `/catalog/prefabs` (verified serving live today — §T149 can lose its "NOT YET
VERIFIED" caveat): Medium `fireRate 1 / reloadSpeed 3` → ~5 s/torpedo at 2+ latches, 7 s at one; Small
`fireRate 8 / reloadSpeed 4` → ~12 s. Door time is animation-driven, not a constant in the assembly.

Splash unmodelled: `Torpedo.Explode` re-applies `dropoff × damageAmount` inside `explosionRadius 6`,
`dropoff = max(1 - d/6, 0.1)`, primary target included.

Still owed before anything scores it: this text into `doc/vanguard-galaxy-rules.md` (ASK the ML session
first — they own that file and were writing the defender-scaling section), the api-doc members, then
`/status` gaining `poolTorpedoPower` (+ multiplier) via `EquipStat.TorpedoPower` — a new COMPILE-TIME
game reference ∴ run `tools\check-typerefs.ps1`. User approved: build + deploy, they restart later.

Live blocker: the current ship carries NO bay (`torpedoLatches: null`, `/stat/sources?stat=TorpedoPower`
total 0, sources []) ∴ the end-to-end torpedo path cannot be measured on this save.

## Loose ends to clean up

- `ShipOptimizer/src/probeBalancer.test.ts` — TEMPORARY diagnostic probe I wrote, UNTRACKED, writes
  `live/probe.txt`. It self-skips without `live/`. Delete it before any commit, or keep it deliberately.
- Decompiles sit in the OLD session's scratchpad and will be unreachable after the restart. Everything
  load-bearing from them is quoted above; re-run `ilspycmd` if more is needed.
- Nothing has been written to `SPEC.md` this session. `T148`'s row still says `.` while its comparator,
  `goalRefuses` and veto text are live in `fleetDps.ts:1506-1617` / `GearTab.tsx:600,667,746,855,969` —
  that row is stale and wants a status flip when someone next runs `/spec`.
