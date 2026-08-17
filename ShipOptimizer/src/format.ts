// Shared display/formatting helpers + rarity tables. ONE owner, rather than a copy per tab, across
// every tab — consolidated here so one edit changes them everywhere and the variants can't drift.
import type { Item } from "./types";

// Rarity → colour. NOTE: the same values are mirrored as `.r-<Rarity>` classes in App.css (for CSS-only
// coloring); keep the two in sync if you change a colour.
export const RARITY_COLOR: Record<string, string> = {
  Standard: "#cfcfcf", Enhanced: "#58c26b", HighGrade: "#4aa3ff", Exotic: "#c07bff", Legendary: "#ffb020",
};
// Rarity ordering (worst → best) — used by the officer comparator's rarity tiebreak.
export const RARITY_RANK: Record<string, number> = { Standard: 0, Enhanced: 1, HighGrade: 2, Exotic: 3, Legendary: 4 };

// Compact number: ≥1000 → locale grouping, no decimals; smaller → 1 decimal. Stats / power / deltas.
export const num = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toFixed(1)).toString());

/** The mark credits are shown with, app-wide. The game has no registry item for credits, so there is no icon to
 *  fetch — this IS the icon, and one owner keeps the item card, the officer tab and the wallet saying it once. */
export const CREDIT_MARK = "¢";

/**
 * A currency name in the plural, for "23,118 Vanguard Marks".
 *
 * Deliberately naive — add an `s` unless it already ends in one — and safe only because the subject is a CLOSED
 * set of a few currency names the bridge reports in the singular. Anything with real inflection to do belongs in
 * a port of `Shared/Say.cs`, not here; this exists so a tooltip stops reading "23,118 Vanguard Mark".
 */
export const pluralName = (name: string) => (/s$/i.test(name) ? name : name + "s");
// Like `num` but 2 decimals for small values — booster magnitudes and other finer readouts.
export const fmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toFixed(2)).toString());

// A percentage-valued stat's amount is a FRACTION: an Attack Speed roll of 0.0140774 is +1.41%. Rendered the
// way the game renders it (`GameMath.FormatPercentage`): scale by 100, two decimals, then drop trailing zeros
// so a flat 2% reads "2%" and not "2.00%". Which stats these are is the game's own call and arrives per line as
// `percent` — it cannot be recovered from the number, since 0.0141 is a perfectly plausible absolute amount.
export const statPct = (fraction: number) => {
  let s = (fraction * 100).toFixed(2);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return `${s}%`;
};

// A stat/substat line as text: "×1.234 Stat" for multipliers, "+1.41% Stat" for percentage stats, else
// "+/-N Stat".
export const subFmt = (l: { stat: string; amount: number; multiplier?: number; percent?: boolean }) =>
  l.multiplier && l.multiplier !== 1
    ? `×${Number(l.multiplier.toFixed(3))} ${l.stat}`
    : `${l.amount >= 0 ? "+" : ""}${l.percent ? statPct(l.amount) : num(l.amount)} ${l.stat}`;

// Numeric value of a named stat line on an item (multiplier if present, else amount; 0 if absent).
export const statVal = (it: Item, name: string): number => {
  const l = it.stats.find((s) => s.stat === name);
  return l ? (l.multiplier && l.multiplier !== 1 ? l.multiplier : l.amount) : 0;
};

// Stat names are compared loosely: an aspect reports the EquipStat spelling ("EnergyCapacity") while a
// headline carries the display name ("Energy").
const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

// Numeric value of an item's main stat (Combat Power for weapons; the key stat per module type).
// Parses the game's formatted amount: "4,338", "540.9", "1.2M", and signed/percent forms like
// "+68%" or "-5%" (% is a plain multiplier-style headline — take the number, drop the sign glyph).
// null if the item has no main stat or nothing numeric to parse.
export function mainVal(it: Item): number | null {
  if (!it.mainStat) return null;
  const m = it.mainStat.amount.replace(/,/g, "").match(/([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return null;
  const scale: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12, "%": 1 };
  const shown = parseFloat(m[1]) * (scale[m[2].toUpperCase()] ?? 1);

  // `mainStat.amount` is a DISPLAY string, rounded to three significant figures: "10.2K" stands for
  // 10,152.80 and "15.8K" for 15,842.79 — a 0.3-0.5% error, where the ranking floor that decides whether a
  // swap is worth proposing is 0.1%. So the shown figure is used to IDENTIFY the headline among the item's
  // stat lines, and that line's exact amount is returned.
  //
  // Identify rather than sum: an item can carry the same stat twice — one turret lists Combat Power at
  // 8,079.92 and again at 1,772.03, and the game pools only the first (the second arrives as a
  // `TurretBoostStat`, which is local to the gun). Adding them would inflate its contribution.
  const want = norm(it.mainStat.name);
  let best: number | null = null;
  for (const s of it.stats ?? []) {
    if (norm(s.stat) !== want) continue;
    if (s.multiplier && s.multiplier !== 1) continue;   // a %-style line is not the headline amount
    if (best == null || Math.abs(s.amount - shown) < Math.abs(best - shown)) best = s.amount;
  }
  // Within rounding of what the game displayed ⇒ the exact line. Further off means the headline is not in
  // `stats[]` at all (a Tractor Beam's "12 Tractor Beams"), so the parsed string stands.
  return best != null && Math.abs(best - shown) <= Math.abs(shown) * 0.02 + 1 ? best : shown;
}

/**
 * One stat's totals on an item, with the WEAPON-LOCAL half kept separate.
 *
 * `add`/`mul` are what reaches the ship's pool; `localAdd`/`localMul` are what an aspect folds into that weapon
 * only. A reader that wants "everything this item carries" — a card, a comparison — wants `shownAdd`/`shownMul`;
 * a reader that is composing a POOL must use `add`/`mul` alone, or a weapon-local bonus is credited to every gun.
 */
export interface StatTotal { add: number; mul: number; percent: boolean; localAdd: number; localMul: number }

/** Everything the item carries for display: pooled and weapon-local together. */
export const shownAdd = (t: StatTotal): number => t.add + t.localAdd;
export const shownMul = (t: StatTotal): number => t.mul * t.localMul;

// Additive + multiplier totals per stat name, folding in EVERY line carrying that name. Items really
// do repeat a name: a Hull Kit lists "Hull HP" twice — once as its headline multiplier (×149.6) and
// once as an additive bonus line (+2,997) — and `statVal` only ever saw the first of the two.
export function statTotals(it: Item): Map<string, StatTotal> {
  const out = new Map<string, StatTotal>();
  const bump = (name: string, add: number, mul: number, percent = false, local = false) => {
    const cur = out.get(name) ?? { add: 0, mul: 1, percent: false, localAdd: 0, localMul: 1 };
    out.set(name, local
      ? { ...cur, localAdd: cur.localAdd + add, localMul: cur.localMul * mul, percent: cur.percent || percent }
      : { ...cur, add: cur.add + add, mul: cur.mul * mul, percent: cur.percent || percent });
  };
  for (const s of it.stats ?? []) {
    if (s.multiplier && s.multiplier !== 1) bump(s.stat, 0, s.multiplier, s.percent);
    else bump(s.stat, s.amount, 1, s.percent);
  }
  // Stats an ASPECT grants count as the item's own: they are not in `stats[]` (the aspect is a separate stat
  // source on the unit), but they arrive with the item and leave with it, so any comparison that ignores them
  // undervalues a fitted aspect — a reactor's "+10% reactor energy" against a plainly bigger reactor.
  //
  // SPLIT BY SCOPE, because the two are different quantities and summing them overstates the second by the whole
  // battery: a `BoostStat` line pools at the unit, a `TurretBoostStat` line is folded into that weapon alone
  // (`Critical Attenuation`, +25% critical strike damage, is one). A line with no scope is treated as pooled —
  // that is what an older bridge's payload means, and what every non-aspect line is.
  for (const a of it.aspects ?? [])
    for (const s of a.stats ?? []) {
      const local = s.scope === "weapon";
      if (s.multiplier && s.multiplier !== 1) bump(s.stat, 0, s.multiplier, s.percent, local);
      else bump(s.stat, s.amount, 1, s.percent, local);
    }
  // Some items keep their headline out of `stats` altogether (a Tractor Beam's "12 Tractor Beams"),
  // which made it invisible to comparisons — fold the parsed main stat in when it's missing.
  const mn = it.mainStat?.name;
  if (mn && !out.has(mn)) {
    const v = mainVal(it);
    if (v != null) bump(mn, v, 1);
  }
  return out;
}

// Per-stat delta (a − b), only where they differ. Additive and multiplier parts are reported
// separately (a "× " prefix marks the multiplier row) — they aren't the same unit and can't be summed.
// Shared by the inventory and gear tooltips so the two read identically.
export function compareStats(a: Item, b: Item): { stat: string; d: number; percent?: boolean }[] {
  const ta = statTotals(a);
  const tb = statTotals(b);
  const rows: { stat: string; d: number; percent?: boolean }[] = [];
  for (const name of new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(name) ?? { add: 0, mul: 1, percent: false };
    const y = tb.get(name) ?? { add: 0, mul: 1, percent: false };
    const percent = x.percent || y.percent;
    if (x.add !== y.add) rows.push({ stat: name, d: x.add - y.add, percent });
    // A multiplier delta is a ratio difference whatever the stat is, so it is never a percentage-stat amount.
    if (x.mul !== y.mul) rows.push({ stat: `× ${name}`, d: x.mul - y.mul });
  }
  const dPower = (a.powerUsage ?? 0) - (b.powerUsage ?? 0);
  if (dPower !== 0) rows.push({ stat: "Power use", d: dPower });
  const dEmp = (a.emp ?? 0) - (b.emp ?? 0);
  if (dEmp !== 0) rows.push({ stat: "EMP", d: dEmp });
  // Drop deltas that round away to 0 at display precision — noise "+0"/"0" rows. The threshold has to follow
  // the UNIT: an absolute stat displays to 1 decimal, but a percentage stat's amount is a fraction shown to
  // 0.01%, so a 1.5pp Attack Speed difference (0.015) is one of the largest rolls in the game and testing it
  // against the absolute threshold would discard it as nothing.
  return rows
    .filter((r) => (r.percent ? Math.round(r.d * 1e4) !== 0 : Math.round(r.d * 10) !== 0))
    .sort((r1, r2) => r1.stat.localeCompare(r2.stat));
}

/**
 * Headline stats whose worth SATURATES: past the named figure, more of it does nothing the player can feel.
 *
 * A count is not a magnitude, and this is where the two part company. A tractor beam's headline is `Tractor
 * Beams` — 6, 10 — and beyond about five the extra beams only gather loot marginally faster (player-reported on
 * game 0.8.1.23, `the internal notes`). Priced as a magnitude it dominates every comparison it enters:
 * `compareModules` reads the headline FIRST, so a 10-beam module beat a 6-beam one that was better at everything
 * else, which is a swap the player would undo by hand.
 *
 * A JUDGEMENT, and narrow on purpose: only stats whose ceiling is known go in here, and the ceiling is the point
 * beyond which the game itself stops paying — not a taste about how much the stat matters.
 */
export const STAT_SATURATION: Record<string, number> = { "Tractor Beams": 5 };

/**
 * The headline as a DECISION reads it: `effectiveMainVal`, clamped where the stat saturates.
 *
 * Every comparison of two modules goes through this; the raw figure stays what the CARD shows and what the pools
 * are folded from, because a saturated stat is still really there — it just cannot win an argument.
 */
export function saturatedMainVal(it: Item): number | null {
  const v = effectiveMainVal(it);
  if (v == null) return null;
  const cap = it.mainStat ? STAT_SATURATION[it.mainStat.name] : undefined;
  return cap == null ? v : Math.min(v, cap);
}

// Main stat *including item bonuses on that same stat* — a turret whose headline is Combat Power and
// that also rolled "+240 Combat Power" as a bonus really has 240 more. `substats` never contains the
// main stat line itself (the bridge builds it with includeMainStat:false), so nothing double-counts.
// Additive lines add; multiplier lines (subFmt's "×1.234") scale the total. null when `mainVal` is.
export function effectiveMainVal(it: Item): number | null {
  const base = mainVal(it);
  if (base == null || !it.mainStat) return null;
  let add = 0;
  let mult = 1;
  // The same stat reaches us under two spellings: an aspect reports the EquipStat name ("EnergyCapacity")
  // while a headline carries the display name ("Energy"). Equal-after-normalising is the safe case; otherwise
  // one containing the other catches the Energy/EnergyCapacity pair. Deliberately not fuzzier than that.
  const same = (name: string) => {
    const a = norm(name), b = norm(it.mainStat!.name);
    return a === b || a.includes(b) || b.includes(a);
  };
  for (const s of it.substats ?? []) {
    if (!same(s.stat)) continue;
    if (s.multiplier && s.multiplier !== 1) mult *= s.multiplier;
    else add += s.amount;
  }
  // An aspect that boosts the item's OWN headline counts too: a reactor's "+10% reactor energy" makes a 20.8K
  // reactor worth 22.9K, which beats a 21.2K one without it — the case that made a downgrade look like an
  // upgrade. Names are matched loosely because the aspect reports the EquipStat spelling ("EnergyCapacity")
  // while the headline carries the display name ("Energy").
  for (const a of it.aspects ?? [])
    for (const s of a.stats ?? []) {
      if (!same(s.stat)) continue;
      if (s.multiplier && s.multiplier !== 1) mult *= s.multiplier;
      else add += s.amount;
    }
  return (base + add) * mult;
}

// Loose stat-name match: the game reports the same stat as "EnergyCapacity" from an aspect and "Energy
// Capacity" (or "Energy") on a headline, and a comparison must not care which spelling it got.

// ---- refusals -----------------------------------------------------------------------------------
// A blocked purchase/hire explains itself in plain terms, with the actual shortfall. The quips rotate
// so the tenth refusal of a session still reads as a person talking; the numbers never change.
const BROKE_QUIPS = [
  "You're too broke for this",
  "Try winning the lottery first",
  "Your wallet says no",
  "That's a lot of wishful thinking",
  "Sell something shiny first",
  "Credits: insufficient. Optimism: noted",
];
let quipAt = 0;
const quip = () => BROKE_QUIPS[quipAt++ % BROKE_QUIPS.length];

// Credits shortfall, e.g. "You're too broke for this — 206,906 cr needed, 88,400 held (short 118,506)."
export const brokeMsg = (cost: number, credits: number) =>
  `${quip()} — ${cost.toLocaleString()} cr needed, ${credits.toLocaleString()} held (short ${(cost - credits).toLocaleString()}).`;

// Barter shortfall, e.g. "Need 4x Titanium Plate, you have 2 - two short of a deal."
export const barterMsg = (need: number, have: number, item: string) =>
  `Need ${need}× ${item}, you have ${have} — ${need - have} short of a deal.`;

export const undockedMsg = "You're out in space — dock at a station to trade.";

// What an offer costs: "4,408× VanguardMark" for a barter offer, "5,999 cr" for a credit one, null when the
// item carries no price at all (anything not currently on sale). A bartered item has no meaningful `cost`,
// so a formatter that reads `cost` alone renders it as free.
export const priceLabel = (it: Item): string | null =>
  it.costItem ? `${(it.costItemCount ?? 0).toLocaleString()}× ${it.costItem}`
  : it.cost != null ? `${it.cost.toLocaleString()} cr`
  : null;

/** One priced line in an affordability tooltip: what it is, what it costs, and what you hold of that currency. */
export interface Priced {
  name: string;
  /** Credit price, when it is priced in credits. */
  cost?: number | null;
  /** Barter currency and its price, when it is not. `owned` is how many of it you hold. */
  costItem?: string | null;
  costItemCount?: number | null;
  costItemOwned?: number | null;
}

/**
 * "<price> · you have <holdings>" for one offer — the phrase behind every buy and hire affordance.
 *
 * ONE owner because it appears on the tab badges, both Buy buttons and the Hire button, and a player comparing
 * them must not meet four wordings. Barter offers price in ITEMS, so the holding shown is of that currency, not
 * credits — reading `cost` alone reports a bartered item as free.
 */
export function affordLine(it: Priced, credits: number | null): string {
  if (it.costItem) {
    const owned = it.costItemOwned;
    const need = it.costItemCount ?? 0;
    const have = owned != null ? ` · you have ${owned.toLocaleString()}` : "";
    const short = owned != null && need > owned ? ` (short ${(need - owned).toLocaleString()})` : "";
    return `${need.toLocaleString()}× ${it.costItem}${have}${short}`;
  }
  if (it.cost == null) return "not for sale";
  const have = credits != null ? ` · you have ${credits.toLocaleString()} cr` : "";
  const short = credits != null && it.cost > credits ? ` (short ${(it.cost - credits).toLocaleString()} cr)` : "";
  return `${it.cost.toLocaleString()} cr${have}${short}`;
}

/**
 * The tooltip behind a "buy" or "hire" BADGE: what the opportunities cost and whether you can cover them.
 *
 * Credit prices total, so the sum is worth stating against the wallet. Barter prices do NOT: each is its own
 * currency, so they are listed with the holding beside them and never added together.
 */
export function affordTip(heading: string, items: Priced[], credits: number | null): string {
  if (!items.length) return heading;
  const lines = [heading, ""];
  let creditTotal = 0;
  for (const it of items) {
    if (!it.costItem && it.cost != null) creditTotal += it.cost;
    lines.push(`${it.name}: ${affordLine(it, credits)}`);
  }
  if (creditTotal > 0) {
    lines.push("");
    const wallet = credits != null ? ` · you have ${credits.toLocaleString()} cr` : "";
    const short = credits != null && creditTotal > credits ? `  ⚠ short by ${(creditTotal - credits).toLocaleString()} cr` : "";
    lines.push(`Total ${creditTotal.toLocaleString()} cr${wallet}${short}`);
  }
  return lines.join("\n");
}

// What we believe we are buying, sent with the purchase so the bridge can refuse a stale one. A shop
// offer is addressed by its inventory SLOT, and a restock refills the same slots with different goods —
// so a list fetched before the hourly refresh would otherwise buy whatever now sits in that slot. Barter
// offers are priced in items, so the count is the cost there.
export const buyExpect = (it: Item) => ({
  name: it.name,
  // IDENTITY, not display text: an item whose `displayName` is a localisation key resolves to a `name` that can
  // never match the raw value the bridge compares against (Hypercom).
  id: it.identifier ?? null,
  cost: it.costItem ? (it.costItemCount ?? 0) : (it.cost ?? 0),
});
