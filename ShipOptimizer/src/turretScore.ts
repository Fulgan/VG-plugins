import type { Item } from "./types";
import { aspectDamageFraction } from "./aspect";
import { mainVal, statTotals } from "./format";

// How good a turret is, relative to the others competing for the same slot. NOT an absolute DPS figure: what the
// ship, hull and crew contribute is identical for every candidate, and including it would break the comparison
// anyway, since `GetStat` aggregates ship-wide bonuses on a FITTED turret and only the item's own rolls on a loose
// one — making equipped gear look better for reasons that aren't the gear.
//
// `DamageData.CalculateDamage` divides by the fire rate (`num /= defaultAttacksPerSecond`), so per-shot damage is
// power ÷ rate and multiplying the rate back in cancels it: headline power ÷ 5 already is a per-second figure.
// That is why ranking by main stat works as well as it does, and what it cannot see is what this module adds:
//
//   speed rolls   the game's division uses the RAW rate while the gun fires on boosted delays, so an
//                 AttackSpeed / ReloadSpeed / MagazineSize roll is a straight rate gain
//   crit rolls    CriticalChance / CriticalDamage on the item itself
//   damage rolls  a typed or generic damage percentage on the item itself
//   aspects       an extra-damage payload takes a cut of every hit (see aspect.ts)

export const POWER_PER_DAMAGE = 5;

export interface TurretScore {
  score: number;         // relative, comparable only within a slot
  base: number;          // power / 5 — the rate-cancelled baseline, i.e. the old ranking
  speedGain: number;     // boosted rate ÷ base rate, from the item's OWN speed rolls
  critGain: number;      // expected multiplier from the item's own crit rolls
  damageGain: number;    // 1 + the item's own typed/generic damage rolls
  aspectGain: number;    // 1 + Σ aspect damage fractions
  /** false when the bridge sent no rate components — speed rolls then can't be valued (older plugin). */
  complete: boolean;
}

// Sustained attacks per second, reproducing `AbstractTurret.defaultAttacksPerSecond` with whatever delays
// it is handed — the raw ones for the baseline, the item's own boosted ones for the gain.
function sustainedRate(fireDelay: number, reloadDelay: number, mag: number, burst: number, burstDelay: number): number {
  const b = Math.max(1, burst);
  const m = Math.max(1, mag);
  const group = (b - 1) * burstDelay + fireDelay;
  const cycle = Math.ceil(m / b) * group + reloadDelay;
  return cycle > 0 ? m / cycle : 0;
}

// The player's crit setup. Ship-wide, so it is the same for every candidate — but it is NOT a constant that
// cancels: the higher your crit chance, the more a turret's own "Critical Damage" roll is worth, which is
// exactly what makes a crit build a build. Read off the live ship via /status.
export interface CritContext {
  chance: number;    // effective CriticalChance (ship + hull + crew + gear)
  damage: number;    // effective CriticalDamage
  megaCrit: number;  // combatMegaCrit skill points — how many times one hit may crit
}

export const BASE_CRIT: CritContext = { chance: 0.03, damage: 1, megaCrit: 0 };

// Expected damage multiplier from the crit CASCADE. The game rolls repeatedly at a halving chance, not once:
//
//   int n = 0; float c = criticalChance;
//   while (RandomBool(c)) { n++; c *= 0.5f; if (n > combatMegaCrit) break; }
//   num *= Mathf.Pow(2f + GetStat(CriticalDamage), n);
//
// So P(k crits) needs every roll before the k-th to have succeeded at a halving chance, and the cap decides
// how deep it can go. The multiplier per crit is `2 + CriticalDamage`.
export function expectedCritFactor(chance: number, critDamage: number, megaCrit = 0): number {
  const c = Math.max(0, Math.min(1, chance || 0));
  if (c <= 0) return 1;
  const mult = 2 + (critDamage || 0);
  const cap = Math.max(0, Math.floor(megaCrit || 0)) + 1;   // `n > megaCrit` breaks, so cap+1 crits can land

  let expected = 0;
  let pReached = 1;   // P(at least k crits so far)
  for (let k = 0; k <= cap; k++) {
    const next = k === cap ? 0 : Math.min(1, c * Math.pow(0.5, k));
    expected += pReached * (1 - next) * Math.pow(mult, k);
    pReached *= next;
    if (pReached <= 0) break;
  }
  return expected;
}

// Stat lines arrive under the game's DISPLAY names — "Attack Speed", "Critical Damage", "Magazine Size" —
// not the `EquipStat` enum spelling. Looking one up as "AttackSpeed" silently returns 0, which is not a
// missing feature but a wrong answer: 48 of this save's turrets roll Attack Speed and every one of them was
// being scored as if it rolled nothing. Both spellings are accepted, so neither a display-name change nor a
// bridge that starts sending enum names can quietly zero a factor again.
const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

function normalised(totals: Map<string, { add: number; mul: number }>): Map<string, { add: number; mul: number }> {
  const out = new Map<string, { add: number; mul: number }>();
  for (const [k, v] of totals) {
    const key = norm(k);
    const cur = out.get(key);
    out.set(key, cur ? { add: cur.add + v.add, mul: cur.mul * v.mul } : v);
  }
  return out;
}

// A stat's value from the item's OWN lines. `stats` is the game's baked `GetStats()` output, already scaled
// per item and parent-free — so it holds the gun's rolls and nothing else.
//
// Via `statTotals`, not `statVal`: an item can list the same stat TWICE (a headline multiplier plus an
// additive bonus line), and `statVal` only ever sees the first of the two.
const own = (totals: Map<string, { add: number; mul: number }>, stat: string): number => {
  const t = totals.get(norm(stat));
  if (!t) return 0;
  // These stats are all fractional bonuses (+0.05 = +5%); a multiplier line means the same thing expressed
  // as ×1.05, so it is normalised to the additive form the game's `1f + GetStat(...)` expects.
  return t.add + (t.mul !== 1 ? t.mul - 1 : 0);
};

export function turretScore(it: Item, crit: CritContext = BASE_CRIT): TurretScore {
  // `mainVal` handles the game's formatting ("4,338", "1.2M", "+68%") — hand-parsing it here would be a
  // second, worse copy of that.
  const power = mainVal(it);
  const base = power != null ? power / POWER_PER_DAMAGE : 0;
  const totals = normalised(statTotals(it));

  const haveRates = it.fireDelayRaw != null && it.magSizeRaw != null;
  let speedGain = 1;
  if (haveRates) {
    const fd = it.fireDelayRaw as number;
    const rd = it.reloadDelayRaw ?? 0;
    const mag = it.magSizeRaw as number;
    const burst = it.burstAmount ?? 1;
    const bd = it.burstDelay ?? 0;
    const raw = sustainedRate(fd, rd, mag, burst, bd);
    // The boosted properties, applied with the item's own rolls only.
    const boosted = sustainedRate(
      fd / (1 + own(totals, "AttackSpeed")),
      rd / (1 + own(totals, "ReloadSpeed")),
      Math.round(mag * (1 + own(totals, "MagazineSize"))),
      burst, bd,
    );
    if (raw > 0) speedGain = boosted / raw;
  }

  // The item's OWN crit rolls, valued against the ship's crit setup: the gain is what its Critical Damage
  // (or Chance) adds on top of what you already have, so a +1 Critical Damage roll is worth far more on a
  // crit build than on a ship that crits 3% of the time.
  const withItem = expectedCritFactor(
    crit.chance + own(totals, "CriticalChance"),
    crit.damage + own(totals, "CriticalDamage"),
    crit.megaCrit,
  );
  const without = expectedCritFactor(crit.chance, crit.damage, crit.megaCrit);
  const critGain = without > 0 ? withItem / without : 1;
  // The typed stat that this turret's shots actually read, plus the untyped one that applies to any type.
  const typed = it.damageType ? own(totals, `${it.damageType}Damage`) : 0;
  const damageGain = 1 + typed + own(totals, "Damage");
  const aspectGain = 1 + aspectDamageFraction(it);

  return {
    score: base * speedGain * critGain * damageGain * aspectGain,
    base, speedGain, critGain, damageGain, aspectGain,
    complete: haveRates,
  };
}

// The parts that actually moved the score away from the plain headline value, for explaining a ranking.
export function scoreReasons(s: TurretScore): string[] {
  const out: string[] = [];
  const pct = (v: number) => `${v > 1 ? "+" : ""}${Math.round((v - 1) * 100)}%`;
  if (Math.abs(s.speedGain - 1) > 0.001) out.push(`fire rate ${pct(s.speedGain)}`);
  if (Math.abs(s.critGain - 1) > 0.001) out.push(`crit ${pct(s.critGain)}`);
  if (Math.abs(s.damageGain - 1) > 0.001) out.push(`damage ${pct(s.damageGain)}`);
  if (Math.abs(s.aspectGain - 1) > 0.001) out.push(`aspects ${pct(s.aspectGain)}`);
  return out;
}
