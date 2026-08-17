import { itemIcon, type Conn } from "./api";
import type { Item } from "./types";
import { RARITY_COLOR, num, statPct, subFmt, effectiveMainVal, compareStats, priceLabel } from "./format";
import { aspectDamageFraction, damageAspects, aspectValue } from "./aspect";
import { isRoleStat } from "./roleStats";
import { resonanceLive, unlockBonusText } from "./booster";
import { activityLabel, isTurret, kindOf } from "./itemKind";
import { moduleStatChannel, pricesModuleStat } from "./fleetDps";
import AspectMark from "./AspectMark";
import Price from "./Price";
import PowerPie from "./PowerPie";
import { useCursorTip } from "./useCursorTip";

// THE item card, and the cursor-following tooltip built from it. One implementation for every tab — the
// inventory grid, the opportunity rails, the gear editor and the summary all render this.
//
// It is its own module on purpose: while the gear tab owned the good version and the inventory tab kept a
// second one, every field added to a card (aspect badges, price, relative value) had to be added twice and in
// practice was added once. A card is a shared surface, so it belongs to no single tab.

// One full in-game-style item panel. When `cmp` is given, appends a per-stat Δ (this − cmp) block.
export function ItemCard({ it, conn, imgUrl, cmp, cmpLabel, tag, pieStat, maxPower, rel, role }: { it: Item; conn: Conn; imgUrl?: string | null; cmp?: Item | null; cmpLabel?: string; tag?: string; pieStat?: string | null; maxPower?: number; rel?: { pct: number; note: string; metric?: string } | null; role?: string | null }) {
  // Store items resolve by handle; equipped ones (no handle) by their ship slot — see Item.slotKey.
  const img = imgUrl !== undefined ? imgUrl : itemIcon(conn, it);
  const deltas = cmp && cmp !== it ? compareStats(it, cmp) : [];
  // A TURRET's own lines are priced through `setDps` (its damage, its firing cycle), so the priced/unpriced mark
  // is a module question: one hardcoded list for both kinds would be wrong on one of them.
  const isModule = kindOf(it) === "Module";
  // `cmp` (the hovered item) is only passed to comparison cards, so its absence marks the hovered one.
  // "Better" = beats the hovered item on the SAME main stat; across different main stats there's nothing
  // meaningful to rank.
  const better = !!cmp && cmp !== it && !!it.mainStat && it.mainStat.name === cmp.mainStat?.name
    && (effectiveMainVal(it) ?? 0) > (effectiveMainVal(cmp) ?? 0);
  return (
    <div className={`git git-static${cmp ? " git-vs" : " hovered"}${better ? " better" : ""}`}>
      <div className="git-top">
        <div>
          <div className="git-cls">{[it.size, it.type].filter(Boolean).join(" ")}{tag ? <span className="git-tag"> · {tag}</span> : null}</div>
          <div className="git-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
          {it.manufacturer && <div className="git-mfr">{it.manufacturer}</div>}
        </div>
        <div className="git-lvl">Lv {it.level}{it.bonus ? <span className="git-q"> Q{it.bonus}</span> : null}</div>
      </div>
      {img && <span className="git-img" style={{ backgroundImage: `url("${img}")` }} />}
      {it.mainStat && (
        <div className="git-main-row">
          <div className={`git-main${isRoleStat(role, it.mainStat.name) ? " role" : ""}`}>{it.mainStat.amount} {it.mainStat.name}</div>
          {it.mainStat.name === pieStat && <PowerPie value={effectiveMainVal(it) ?? 0} max={maxPower ?? 0} label={it.mainStat.name} />}
        </div>
      )}
      {rel && (
        // Directly under the headline stat, because it exists to contradict it: the biggest number is not
        // always the biggest DPS once aspects, crit and the shared power pool are counted.
        <div className={`git-rel${rel.pct >= 99.95 ? " best" : ""}`} title={rel.note}>
          {rel.pct.toFixed(rel.pct >= 99.95 ? 0 : 1)}% <span className="dim">of best ship {rel.metric ?? "DPS"}</span>
        </div>
      )}
      {it.fireRate != null && <div className="git-line">{Number(it.fireRate.toFixed(2))} attacks per second</div>}
      {it.damageType && <div className="git-line">{it.damageType} damage</div>}
      {isTurret(it) && activityLabel(it) && <div className="git-line dim">{activityLabel(it)}</div>}
      {damageAspects(it).length > 0 && (
        // Why this item outranks a bigger headline number: each payload adds a cut of every hit.
        <div className="git-line">
          aspects add +{Math.round(aspectDamageFraction(it) * 100)}% damage
          <span className="dim"> ({damageAspects(it).map((a) => `${a.name} +${Math.round(a.fraction * 100)}%${a.overTime ? " dot" : ""}`).join(", ")})</span>
        </div>
      )}
      <div className="git-icons">
        {it.range != null && <span title="range">→ {num(it.range)}</span>}
        {it.emp ? <span title="EMP">◇ {num(it.emp)}</span> : null}
        {it.powerUsage != null && <span title="power use">⚡ {num(it.powerUsage)}</span>}
      </div>
      {(it.substats?.length ?? 0) > 0 && <div className="git-subs">{(it.substats ?? []).map((s, i) => <div key={i} className={`git-sub${isRoleStat(role, s.stat) ? " role" : ""}`}>{subFmt(s)}</div>)}</div>}
      {it.resonance && (() => {
        // RESONANCE, where an item is actually read. The bonus is the game's own formatted line (percent stats are
        // stored fractionally, so rebuilding the string by hand is wrong) and it is the FULL bonus — what the
        // booster pays today is that times its progress, which is stated beside it rather than left to be guessed.
        const r = it.resonance;
        const pct = Math.round(resonanceLive(r) * 100);
        return (
          <div className="git-res">
            {/* Both lines, the way the game's own tooltip reads: what it pays NOW and what it pays at full. The
                current figure comes from the game (`bonusNow`) rather than being rescaled here — a percent line is
                stored fractionally, so only its own formatter can print it correctly. An older bridge sends no
                `bonusNow`, and then the fraction is stated in words instead. */}
            {r.bonusNow
              ? <div className="git-res-bonus">{r.bonusNow}<span className="dim"> · max {unlockBonusText(r)}</span></div>
              : <div className="git-res-bonus">{unlockBonusText(r) || r.bonusStat}<span className="dim"> · paying {pct}% of it</span></div>}
            <div className="git-line dim">
              {r.unlocked ? "resonance finished" : `${pct}% earned`}
              {" · "}{Math.round(r.progress).toLocaleString()} / {Math.round(r.threshold).toLocaleString()} {r.unit}
              {/* WHICH pool it lifts: a multiplier line scales the ship's whole total for that stat, ⊥ this
                  booster's own contribution, and that is the difference between a small bonus and a large one. */}
              {(r.bonusMultiplier ?? 1) !== 1 && <> · scales the ship's whole {r.bonusStat} pool</>}
            </div>
          </div>
        );
      })()}
      {it.ammo && <div className="git-line dim">Requires {it.ammo} Ammo{it.ammoPerMin != null ? ` · ~${Math.round(it.ammoPerMin)}/min` : ""}</div>}
      {(it.aspects ?? []).map((a, i) => (
        // The badge beside the name, so the tooltip and the list row identify an aspect the same way.
        <div key={i} className="git-asp">
          <div className="git-asp-name">
            <AspectMark conn={conn} aspect={a} size={15} />
            <span>{a.name}</span>
            {aspectValue(a.description).damageFraction > 0 && (
              <span className="git-asp-worth">+{Math.round(aspectValue(a.description).damageFraction * 100)}% dmg</span>
            )}
          </div>
          {a.description && <div className="git-asp-desc">{a.description}</div>}
        </div>
      ))}
      {cmp && cmp !== it && (
        <div className="git-cmp">
          <div className="git-cmp-head">{cmpLabel ?? "Δ vs hovered"}</div>
          {/* WHICH lines the objective can act on. `MODULE_POOLS` is the whole set a module swap moves, so a
              stat outside it changes the score by nothing — and a panel listing "+3,892 Torpedo Power" beside
              "−1,220 Precision" as though they weighed against each other is why an offer could look absurd and
 be correct, or look reasonable and be wrong. Unpriced is ⊥ worthless: it means the objective
              has no opinion and the call is the player's, which is what the note says. */}
          {deltas.length ? deltas.map((r) => {
            const channel = isModule ? moduleStatChannel(r.stat) : "pool";
            const priced = channel !== null;
            // A stat priced through the BRACKET says so: capacity and draw move the reactor load, which scales every
            // pool on the ship — the heaviest thing a module can do, and it used to be marked "not scored".
            const why = channel === "bracket"
              ? `${r.stat} is scored through the reactor bracket — it moves the load every pool is scaled by`
              : channel === null
                ? `${r.stat} does not enter the score — the optimizer has no opinion on it`
                : undefined;
            return (
              <div key={r.stat} className={`git-cmp-row${priced ? "" : " unpriced"}`} title={why}>
                <span>{r.stat}{priced ? "" : " *"}</span>
                <span className={r.d > 0 ? "up" : "down"}>{r.d > 0 ? "+" : ""}{r.percent ? statPct(r.d) : num(r.d)}</span>
              </div>
            );
          }) : <div className="git-cmp-row dim">identical stats</div>}
          {isModule && deltas.some((r) => !pricesModuleStat(r.stat)) && (
            <div className="git-cmp-note dim">* not scored — your call</div>
          )}
        </div>
      )}
      <div className="git-foot">
        <span>Vol {it.volume ?? "?"} m³</span>
        {/* An item on sale shows what it COSTS, not just what it's worth: a barter offer has no credit price,
            so "Value" was the only number on the card and read as the price. */}
        {priceLabel(it) && <span className="git-price" title="asking price">Price <Price it={it} conn={conn} size={13} /></span>}
        <span>Value ¢{(it.sellValue ?? 0).toLocaleString()}</span>
        <span className="dim">◆ {(it.aspects ?? []).length}/{it.aspectSlots ?? 0}</span>
      </div>
    </div>
  );
}

// Cursor-following tooltip. Panels, left to right: the hovered item, the item mounted in the slot you
// clicked (`vs`), then the rest of the equipped gear the hovered item could replace (`others` — every
// hardpoint of the same size, or the matching module slot). Each equipped panel carries a per-stat Δ vs
// the hovered item, mirroring the inventory tab. With neither `vs` nor `others` it's a single panel
// (Summary tab reuse).
const MAX_PANELS = 5; // panels are 264px — beyond this the row can't fit a normal screen
export function ItemTip({ it, x, y, conn, imgUrl, vs, others, rel, role }: { it: Item; x: number; y: number; conn: Conn; imgUrl?: string | null; vs?: Item | null; others?: { it: Item; label: string }[]; rel?: (it: Item) => { pct: number; note: string; metric?: string } | null; role?: string | null }) {
  const compare = vs && vs !== it ? vs : null;
  // Drop the hovered item and the slot's own item — the latter already has its own panel.
  const extra = (others ?? []).filter((o) => o.it !== it && o.it !== compare).slice(0, MAX_PANELS - 1 - (compare ? 1 : 0));
  // Follows the cursor without any per-move React render — see useCursorTip. The key covers every panel,
  // so the tooltip is re-measured whenever the set of compared items changes, not just the hovered one.
  const { ref, style } = useCursorTip(x, y);
  // Power pie: only cards sharing the hovered item's main stat take part; denominator is the
  // strongest of those, bonus lines on that stat included (see PowerPie / effectiveMainVal).
  const pieStat = it.mainStat?.name ?? null;
  const inPie = [it, ...(compare ? [compare] : []), ...extra.map((o) => o.it)].filter((p) => p.mainStat?.name === pieStat);
  const maxPower = Math.max(0, ...inPie.map((p) => effectiveMainVal(p) ?? 0));
  return (
    <div className="gits" ref={ref} style={style}>
      <ItemCard it={it} conn={conn} imgUrl={imgUrl} tag={compare || extra.length ? "hovered" : undefined} pieStat={pieStat} maxPower={maxPower} rel={rel?.(it)} role={role} />
      {compare && <ItemCard it={compare} conn={conn} cmp={it} cmpLabel="Δ vs hovered" tag="equipped" pieStat={pieStat} maxPower={maxPower} rel={rel?.(compare)} role={role} />}
      {extra.map((o, i) => (
        <ItemCard key={`${o.label}:${i}`} it={o.it} conn={conn} cmp={it} cmpLabel="Δ vs hovered" tag={o.label} pieStat={pieStat} maxPower={maxPower} rel={rel?.(o.it)} role={role} />
      ))}
    </div>
  );
}

