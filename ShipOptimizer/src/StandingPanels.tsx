import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Conn } from "./api";
import { load, save } from "./storage";
import FactionMark from "./FactionMark";
import type { FactionStanding, Reputation, StandingEntry, StandingLog } from "./types";
import "./standing.css";

// Where you stand with every faction, as two panels mirroring the game's two Captain tabs — Reputation and
// Conquest. They are kept apart because they are unrelated ladders: reputation gates services and can put a
// faction at war with you, conquest contribution buys ranks in a war you opted into.
//
// Row order is the game's own (`Faction.corporations`) and is NOT re-sorted, so a row sits in the same place
// here as in the game's panel. Each panel carries its own change log — the history the game doesn't keep.
//
// Nothing is recomputed client-side: every level, rank, colour, threshold and perk comes from the game's own
// tables, and "at war" is the game's flag (a toggle you set at a station, not a reputation threshold).

const pct = (n: number) => `${Math.round(n * 100)}%`;
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const mult = (n: number) => `x${n.toFixed(2).replace(/\.?0+$/, "")}`;
// Perk fractions are the discount/bonus itself, so 0 means "no perk yet" — worth hiding rather than printing.
const has = (n: number | null | undefined) => n != null && n !== 0;

const rankNum = (rank?: string | null) => (rank && /^Rank(\d)$/.test(rank) ? rank.slice(4) : null);

const mmss = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// The change history. The bridge's buffer is bounded and empty on each game launch, so the long history is
// the client's: it appends the new tail and keeps it. Persisted through `save`, which means it lands in the
// bridge's client-state file and so follows the PLAYTHROUGH rather than this browser.
const HISTORY_KEY = "shipoptimizer.standingLog";
const HISTORY_MAX = 400;

interface History { playthrough: string | null; entries: StandingEntry[] }

type Sampler = NonNullable<StandingLog["sampler"]>;

function useStandingHistory(conn: Conn, bump: number) {
  const [hist, setHist] = useState<History>(() => load<History>(HISTORY_KEY, { playthrough: null, entries: [] }));
  const [sampler, setSampler] = useState<Sampler | null>(null);
  // The high-water mark this client has consumed. A bridge restart resets `seq` to 0, so a jump BACKWARDS
  // means a new run and the mark has to follow it down or the tail is never fetched again.
  const seen = useRef(0);

  const poll = useCallback(async () => {
    try {
      const r = await api.standingLog(conn, seen.current);
      setSampler(r.sampler ?? null);
      if (r.seq < seen.current) seen.current = 0;   // bridge restarted
      setHist((h) => {
        // A different playthrough is a different history, not a continuation of this one.
        const base = r.playthrough && h.playthrough && r.playthrough !== h.playthrough ? [] : h.entries;
        if (r.entries.length === 0 && base === h.entries && h.playthrough === (r.playthrough ?? h.playthrough))
          return h;
        const byKey = new Map(base.map((e) => [`${e.seq}|${e.factionId}|${e.ladder}`, e]));
        for (const e of r.entries) byKey.set(`${e.seq}|${e.factionId}|${e.ladder}`, e);
        const merged = [...byKey.values()].slice(-HISTORY_MAX);
        const next = { playthrough: r.playthrough ?? h.playthrough, entries: merged };
        save(HISTORY_KEY, next);
        return next;
      });
      seen.current = Math.max(seen.current, r.seq);
    } catch { /* the panels are still useful without the log */ }
  }, [conn]);

  useEffect(() => { void poll(); }, [poll, bump]);
  useEffect(() => {
    const t = setInterval(() => void poll(), 15_000);
    return () => clearInterval(t);
  }, [poll]);

  const clear = useCallback(() => {
    const empty = { playthrough: hist.playthrough, entries: [] };
    setHist(empty);
    save(HISTORY_KEY, empty);
  }, [hist.playthrough]);

  return { entries: hist.entries, clear, sampler };
}

export default function StandingPanels({ conn, conquestUnlocked = false, bump = 0 }: {
  conn: Conn; conquestUnlocked?: boolean; bump?: number;
}) {
  const [rep, setRep] = useState<Reputation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openRep, setOpenRep] = useState<string | null>(null);
  const [openConq, setOpenConq] = useState<string | null>(null);

  const fetchRep = useCallback(async () => {
    try { setRep(await api.reputation(conn)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [conn]);

  // Standing moves on mission turn-in and conquest ticks, i.e. minutes apart at best — but `bump` fires the
  // moment the bridge reports a change, so the panels don't lag behind their own logs.
  useEffect(() => { void fetchRep(); }, [fetchRep, bump]);
  useEffect(() => {
    const t = setInterval(() => void fetchRep(), 60_000);
    return () => clearInterval(t);
  }, [fetchRep]);

  const { entries, clear, sampler } = useStandingHistory(conn, bump);

  const rows = useMemo(() => rep?.factions ?? [], [rep]);
  const repRows = useMemo(() => rows.filter((f) => f.reputation), [rows]);
  const conqRows = useMemo(() => rows.filter((f) => f.conquest), [rows]);

  // Bar scales come from the LADDERS, not from the two "max" numbers the game exposes: `conquestRepMax` is
  // 30,000 against thresholds that reach 50,000, and contribution climbs past `topRankAt`. The reputation bar
  // is drawn against the end of the ladder on the value's own side, the way the game draws it (30000 / 50000,
  // -577 / -50000).
  const ends = useMemo(() => {
    const ats = (rep?.levels ?? []).map((l) => l.at);
    return ats.length ? { lo: Math.min(...ats), hi: Math.max(...ats) } : null;
  }, [rep]);
  const conqTop = useMemo(() => {
    const top = rep?.topRankAt ?? Math.max(0, ...(rep?.ranks ?? []).map((r) => r.at));
    const highest = Math.max(0, ...conqRows.map((f) => f.conquest?.contribution ?? 0));
    return Math.max(top, highest) || null;
  }, [rep, conqRows]);

  if (err) return <div className="std-wrap"><div className="err">{err}</div></div>;
  if (!rep) return <div className="std-wrap"><div className="muted">Loading standing…</div></div>;

  return (
    <div className="std-wrap">
      <section className="std-panel">
        <header className="std-panel-head">
          <h3>Reputation</h3>
          {rep.foeAt != null && (
            <span className="muted">below {rep.foeAt.toLocaleString()} war is forced; above it, it is a flag you set at a station</span>
          )}
        </header>
        <div className="std-rows">
          {repRows.map((f) => (
            <RepRow key={f.id} conn={conn} f={f} ends={ends}
              expanded={openRep === f.id} onToggle={() => setOpenRep(openRep === f.id ? null : f.id)} />
          ))}
          {repRows.length === 0 && <div className="muted">No faction reputation reported.</div>}
        </div>
        <ChangeLog conn={conn} title="Reputation changes" entries={entries} ladder="faction" onClear={clear}
          watching={sampler ? sampler.watchingFactions : null} sampler={sampler} />
      </section>

      {/* The conquest ladder is only meaningful once the conquest map is open to you — before that the panel
          would be a column of zeroes against an unreachable rank. */}
      {conquestUnlocked && conqRows.length > 0 && (
        <section className="std-panel">
          <header className="std-panel-head">
            <h3>Conquest</h3>
            {rep.topRankAt != null && (
              <span className="muted" title="Contribution is not capped there — it keeps climbing past it">
                top rank at {rep.topRankAt.toLocaleString()}
              </span>
            )}
          </header>
          <div className="std-rows">
            {conqRows.map((f) => (
              <ConqRow key={f.id} conn={conn} f={f} top={conqTop}
                expanded={openConq === f.id} onToggle={() => setOpenConq(openConq === f.id ? null : f.id)} />
            ))}
          </div>
          <ChangeLog conn={conn} title="Conquest contribution" entries={entries} ladder="conquest" onClear={clear}
            watching={sampler ? sampler.watchingConquest : null} sampler={sampler} />
        </section>
      )}
    </div>
  );
}

function RepRow({ conn, f, ends, expanded, onToggle }: {
  conn: Conn; f: FactionStanding; ends: { lo: number; hi: number } | null;
  expanded: boolean; onToggle: () => void;
}) {
  const r = f.reputation!;
  // Each side of the ladder is its own scale, so a small negative doesn't read as "nearly at the bottom".
  const end = r.value < 0 ? ends?.lo : ends?.hi;
  const fill = end ? Math.max(0, Math.min(1, r.value / end)) : 0;

  return (
    <div className={"std-row" + (expanded ? " open" : "") + (f.atWar ? " war" : "")}>
      <button className="std-main" onClick={onToggle} aria-expanded={expanded}>
        <FactionMark conn={conn} id={f.id} name={f.name} color={f.color} size={15} />
        <span className="std-bar">
          <i style={{ width: pct(fill), background: r.color ?? "#6d80a6" }} />
        </span>
        <span className="std-val">
          {r.value.toLocaleString()}{end != null && <em> / {end.toLocaleString()}</em>}
        </span>
        {f.atWar
          ? <span className="std-war" title="A flag you can clear at a station, unless your reputation is negative">At War</span>
          : <span className="std-lvl" style={{ color: r.color ?? undefined }}>{r.levelName ?? r.level ?? "—"}</span>}
      </button>

      {expanded && (
        <div className="std-detail">
          <div className="std-facts">
            {f.atWar && <span>Standing band: {r.levelName ?? r.level}</span>}
            {r.toNext != null && r.nextAt != null && (
              <span>{r.toNext.toLocaleString()} to next band (at {r.nextAt.toLocaleString()})</span>
            )}
            {r.group && <span>{r.group} standing</span>}
          </div>
          {r.perks && (
            <ul className="std-perks">
              {has(r.perks.shopDiscount) && <li>Shop {pct(r.perks.shopDiscount!)} off</li>}
              {has(r.perks.shipyardDiscount) && <li>Shipyard {pct(r.perks.shipyardDiscount!)} off</li>}
              {has(r.perks.repairCostDiscount) && <li>Repairs {pct(r.perks.repairCostDiscount!)} cheaper</li>}
              {has(r.perks.repairSpeed) && <li>Repair speed {mult(r.perks.repairSpeed!)}</li>}
              {has(r.perks.missionReward) && <li>Mission rewards {mult(r.perks.missionReward!)}</li>}
              {has(r.perks.bonusMissions) && <li>+{r.perks.bonusMissions} mission{r.perks.bonusMissions === 1 ? "" : "s"} on the board</li>}
              {has(r.perks.boardRefreshTimer) && <li>Board refresh {mmss(r.perks.boardRefreshTimer!)}</li>}
              {has(r.perks.shopRefreshTokens) && <li>{r.perks.shopRefreshTokens} shop reroll token{r.perks.shopRefreshTokens === 1 ? "" : "s"}</li>}
              {r.perks.canRefreshShop && <li>May reroll the shop</li>}
              {r.perks.canRefreshBoard && <li>May reroll the mission board</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ConqRow({ conn, f, top, expanded, onToggle }: {
  conn: Conn; f: FactionStanding; top: number | null; expanded: boolean; onToggle: () => void;
}) {
  const c = f.conquest!;
  const fill = c.contribution != null && top ? Math.max(0, Math.min(1, c.contribution / top)) : 0;

  return (
    <div className={"std-row" + (expanded ? " open" : "")}>
      <button className="std-main" onClick={onToggle} aria-expanded={expanded}>
        <FactionMark conn={conn} id={f.id} name={f.name} color={f.color} size={15} />
        <span className="std-bar">
          <i style={{ width: pct(fill), background: c.color ?? "#c07bff" }} />
        </span>
        <span className="std-val">{c.contribution?.toLocaleString() ?? "—"}</span>
        <span className="std-rankcell">
          {rankNum(c.rank) && <span className="std-rank" style={{ background: c.color ?? undefined }}>{rankNum(c.rank)}</span>}
          <span className="std-title">{c.rankName ?? (c.rank === "None" ? "Unranked" : c.rank)}</span>
        </span>
      </button>

      {expanded && (
        <div className="std-detail">
          <div className="std-facts">
            {c.areaMax != null && c.areaMax > 0 && (
              <span>Territory {c.areaHeld ?? 0} / {c.areaMax}
                {c.conqueredPct != null && ` (${pct(c.conqueredPct > 1 ? c.conqueredPct / 100 : c.conqueredPct)} conquered)`}</span>
            )}
            {c.rejoinCooldown != null && c.rejoinCooldown > 0 && <span>Rejoin locked for {mmss(c.rejoinCooldown)}</span>}
          </div>
          {c.perks && (
            <ul className="std-perks">
              {has(c.perks.creditMultiplier) && <li>Credits {mult(c.perks.creditMultiplier!)}</li>}
              {has(c.perks.reputationBonus) && <li>Reputation gain {mult(c.perks.reputationBonus!)}</li>}
              {has(c.perks.fleetStrengthBonus) && <li>Fleet strength {mult(c.perks.fleetStrengthBonus!)}</li>}
              {has(c.perks.commendationsBonus) && <li>Commendations {mult(c.perks.commendationsBonus!)}</li>}
              {c.perks.destroyer && <li>Destroyer hull unlocked</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Why the log is empty. "Nothing has happened yet" is only true when the sampler is alive and watching
// something — otherwise say so, because from here the two look identical.
function emptyReason(watching: number | null, sampler: Sampler | null): string {
  if (!sampler) return "No sampler status — the bridge is older than this view.";
  if (sampler.lastError) return `Sampler failing: ${sampler.lastError}`;
  if (!sampler.samples) return "Sampler has not run yet.";
  if (!watching) return "Nothing to watch here — the sampler runs but sees no values on this ladder.";
  const ago = sampler.lastSampleAgo;
  if (ago != null && ago > sampler.periodSeconds * 5)
    return `Sampler stalled — last check ${Math.round(ago)}s ago, expected every ${sampler.periodSeconds}s.`;
  return `Nothing recorded yet — watching ${watching} faction${watching === 1 ? "" : "s"}, checked every ${sampler.periodSeconds}s.`;
}

// One ladder's history, newest first, at the bottom of its own panel.
function ChangeLog({ conn, title, entries, ladder, onClear, watching, sampler }: {
  conn: Conn; title: string; entries: StandingEntry[]; ladder: StandingEntry["ladder"];
  onClear: () => void; watching: number | null; sampler: Sampler | null;
}) {
  const mine = useMemo(
    () => entries.filter((e) => e.ladder === ladder).slice().reverse(),
    [entries, ladder],
  );
  const net = mine.reduce((n, e) => n + e.delta, 0);

  return (
    <div className="std-log">
      <div className="std-log-head">
        <h4>{title}</h4>
        {mine.length > 0 && (
          <>
            <span className={"std-net " + (net < 0 ? "bad" : net > 0 ? "good" : "")}>net {signed(net)}</span>
            <button className="std-clear" onClick={onClear} title="Forget the recorded history (both ladders)">Clear</button>
          </>
        )}
      </div>
      {mine.length === 0 ? (
        <div className="muted std-log-empty">{emptyReason(watching, sampler)}</div>
      ) : (
        <ol className="std-log-rows">
          {mine.map((e) => (
            <li key={`${e.seq}-${e.factionId}`} className={e.delta < 0 ? "down" : "up"}>
              <span className="std-log-t">{e.t}</span>
              <span className="std-log-f">
                <FactionMark conn={conn} id={e.factionId} name={e.faction} size={12} />
              </span>
              <span className="std-log-d">{signed(e.delta)}</span>
              <span className="std-log-v">{e.value.toLocaleString()}</span>
              {/* A band crossing is the part worth seeing; an unchanged tier is noise. */}
              {e.tier && e.tier !== e.tierWas && <span className="std-log-tier">{e.tierWas} → {e.tier}</span>}
              {e.at && <span className="std-log-at">{e.at}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
