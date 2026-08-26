import { itemIcon, type Conn } from "./api";
import type { Item } from "./types";
import { RARITY_COLOR, num, statPct, subFmt, effectiveMainVal, compareStats, priceLabel } from "./format";
import { aspectDamageFraction, damageAspects, aspectValue } from "./aspect";
import { isRoleStat } from "./roleStats";
import { isBooster, resonanceFigure, resonanceLive } from "./booster";
import { activityLabel, isTurret, kindOf } from "./itemKind";
import { moduleStatChannel, pricesModuleStat, vsRollsOf } from "./fleetDps";
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

// WHAT A PANEL IS TO THE HOVERED ITEM, which is a different question from whether it is equipped: every
// compared panel is equipped, and only ONE of them is the item the hovered one would displace. `target` is
// that one, `alt` is a slot the hovered item also fits but is not being offered for.
export type CardTone = "hovered" | "target" | "alt";

// One full in-game-style item panel. When `cmp` is given, appends a per-stat Δ (this − cmp) block.
export function ItemCard({ it, conn, imgUrl, cmp, cmpLabel, tag, tone, pieStat, maxPower, rel, role }: { it: Item; conn: Conn; imgUrl?: string | null; cmp?: Item | null; cmpLabel?: string; tag?: string; tone?: CardTone; pieStat?: string | null; maxPower?: number; rel?: { pct: number; note: string; metric?: string } | null; role?: string | null }) {
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
    <div className={`git git-static${cmp ? " git-vs" : " hovered"}${better ? " better" : ""}${tone ? ` git-${tone}` : ""}`}>
      {/* The role gets its own strip rather than a grey suffix on the class line: as a suffix it read as part
          of the size and type, and it is the one thing that tells two otherwise identical equipped panels
          apart. Border colour cannot carry it — `better` already owns the border and can land on any panel. */}
      {tag && <div className={`git-role git-role-${tone ?? "alt"}`}>{tag}</div>}
      <div className="git-top">
        <div>
          <div className="git-cls">{[it.size, it.type].filter(Boolean).join(" ")}</div>
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
      {/* A BAY'S NUMBERS ARE PERIODS, so they are printed as waits and never as a rate: `fireRate` on a turret is
          attacks per second and on a bay it is the seconds BETWEEN launches, and one line reading "8 attacks per
          second" for the slowest bay in the game is the confusion this spells out instead. The sustained rate
          needs the hull's latch count, which is not on the item, so the card states what the item knows. */}
      {it.torpedoFireDelay != null && (
        <div className="git-line">
          {Number(it.torpedoFireDelay.toFixed(2))}s between launches
          {it.torpedoReloadTime != null ? ` · ${Number(it.torpedoReloadTime.toFixed(2))}s to re-arm a latch` : ""}
        </div>
      )}
      {it.damageType && <div className="git-line">{it.damageType} damage</div>}
      {isTurret(it) && activityLabel(it) && <div className="git-line dim">{activityLabel(it)}</div>}
      {damageAspects(it).length > 0 && (
        // Why this item outranks a bigger headline number: each payload adds a cut of every hit.
        <div className="git-line">
          aspects add +{Math.round(aspectDamageFraction(it) * 100)}% damage
          <span className="dim"> ({damageAspects(it).map((a) => `${a.name} +${Math.round(a.fraction * 100)}%${a.overTime ? " dot" : ""}`).join(", ")})</span>
        </div>
      )}
      {(() => {
        // THE VS-LAYER BONUS, PRICED AND LABELLED AS AN EXPECTATION. It fires only while the layer it names still
        // holds capacity, and the target is not an input here, so what the objective credits is a rate over a
        // population of real units. Printing the bare figure would read as what this gun does to THIS enemy, which
        // is the one thing nobody here knows. In practice it arrives from an aspect (`Shield Slapper`,
        // `Armorbreaker`), no equipment recipe carrying either stat.
        const vs = vsRollsOf(it);
        if (!vs.shield && !vs.armor) return null;
        const parts = [
          vs.shield ? `vs shield +${Math.round(vs.shield * 100)}%` : null,
          vs.armor ? `vs armor +${Math.round(vs.armor * 100)}%` : null,
        ].filter(Boolean).join(", ");
        return (
          <div className="git-line">
            layer bonus adds +{(vs.credit * 100).toFixed(1)}% damage
            <span className="dim"> ({parts}, credited at what it averages over real targets in a fight that
              lasts; armor is inert on most of them)</span>
          </div>
        );
      })()}
      <div className="git-icons">
        {it.range != null && <span title="range">→ {num(it.range)}</span>}
        {it.emp ? <span title="EMP">◇ {num(it.emp)}</span> : null}
        {/* A BOOSTER NEVER DRAWS, so `⚡ 0` on one is a row that can only ever say the same thing. On a TURRET or a
            MODULE a zero is a fact worth reading (a Solar Powered gun costs the reactor nothing), so the row stays
            wherever draw is a variable of the item. */}
        {it.powerUsage != null && !isBooster(it) && <span title="power use">⚡ {num(it.powerUsage)}</span>}
      </div>
      {(it.substats?.length ?? 0) > 0 && <div className="git-subs">{(it.substats ?? []).map((s, i) => <div key={i} className={`git-sub${isRoleStat(role, s.stat) ? " role" : ""}`}>{subFmt(s)}</div>)}</div>}
      {it.resonance && (() => {
        // RESONANCE, where an item is actually read. The bonus is the game's own formatted line (percent stats are
        // stored fractionally, so rebuilding the string by hand is wrong) and it is the FULL bonus — what the
        // booster pays today is that times its progress, which is stated beside it rather than left to be guessed.
        const r = it.resonance;
        const pct = Math.round(resonanceLive(r) * 100);
        // THE FIGURE IS THE POINT, and it used to be the one thing missing: the bridge's formatted line answered
        // null (`ToReadableString` takes an argument) and the card printed a bare stat name — `Combat Power · paying
        // 100% of it`, a sentence with no value in it. The game's own string is still preferred where it arrives;
        // where it does not, the MULTIPLIER can be stated exactly, since a whole-pool scale is a percentage by
        // construction. A bare `amount` is NOT guessed at: percent stats are stored fractionally and only the
        // game's formatter knows which is which, so it is shown as the game's own units and labelled a flat bonus.
        const mult = r.bonusMultiplier ?? 1;
        const figure = resonanceFigure(r, it);
        return (
          <div className="git-res">
            {/* ONE LABELLED LINE FOR THE VALUE, because two figures on one line with no labels (what it pays now,
                what it pays at full) read as one number and a rounding of it. `bonusNow` is the game's own scaled
                string and is shown as the live figure whenever it arrives. */}
            <div className="git-res-bonus">
              <span className="git-res-tag">resonance</span>
              {r.bonusNow ? <>{r.bonusNow}<span className="dim"> now · {figure} at full</span></>
                          : <>{figure}<span className="dim"> at full{r.unlocked ? "" : ` · paying ${pct}%`}</span></>}
            </div>
            {/* WHICH pool it lifts, on its own line: a multiplier scales the ship's whole total for that stat, ⊥
                this booster's own contribution, and that is the difference between a small bonus and a large one. */}
            {mult !== 1 && <div className="git-line dim">scales the ship's whole {r.bonusStat} pool</div>}
            <div className="git-line dim">
              {Math.round(r.progress).toLocaleString()} / {Math.round(r.threshold).toLocaleString()} {r.unit}
              {" · "}{r.unlocked ? "finished" : `${pct}% earned`}
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
          {/* WHICH WAY THE SIGNS RUN, said on the panel. Every card beside the hovered one lists ITS OWN stats
              minus the hovered item's, and with three cards open at once a bare `Δ vs hovered` leaves the reader to
              work out which side is which from the arithmetic — the direction is the whole meaning of a signed
              list. So the head names the item being subtracted, and the tooltip spells the sentence out. */}
          <div className="git-cmp-head" title={`Each row is this item minus ${cmp.name}: a plus means this item has more.`}>
            {cmpLabel ?? "Δ vs hovered"}
          </div>
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
              : channel === "layer"
                ? `${r.stat} is scored through the layer projection — your goal order can rank it, and a plan that sheds more than your warning threshold of it is named`
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
  // Which slot the displaced item sits in, taken from `others` rather than asked of the caller: every tab that
  // has a slot to name already lists it there, and one that has none (the inventory grid) names no slot at all.
  const vsLabel = compare ? (others ?? []).find((o) => o.it === compare)?.label ?? null : null;
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
      <ItemCard it={it} conn={conn} imgUrl={imgUrl} tag={compare || extra.length ? "hovered" : undefined} tone="hovered" pieStat={pieStat} maxPower={maxPower} rel={rel?.(it)} role={role} />
      {compare && <ItemCard it={compare} conn={conn} cmp={it} cmpLabel={`Δ this − ${it.name}`} tag={vsLabel ? `being replaced · ${vsLabel}` : "being replaced"} tone="target" pieStat={pieStat} maxPower={maxPower} rel={rel?.(compare)} role={role} />}
      {extra.map((o, i) => (
        <ItemCard key={`${o.label}:${i}`} it={o.it} conn={conn} cmp={it} cmpLabel={`Δ this − ${it.name}`} tag={o.label} tone="alt" pieStat={pieStat} maxPower={maxPower} rel={rel?.(o.it)} role={role} />
      ))}
    </div>
  );
}

