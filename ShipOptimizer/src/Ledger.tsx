import { useCallback, useEffect, useState } from "react";
import { api, type Conn } from "./api";
import type { LedgerDto } from "./types";

const cr = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString()} cr`;

// Local time, since the row is stamped in UTC and a player reads it against their own clock.
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

// Purchases and sales, from the bridge's persisted ledger.
//
// The game log can't answer this: it's an in-memory tail that starts empty on every launch, whereas "what have
// I spent" is a question about the whole playthrough. Scoped bridge-side to the current save, so a reloaded
// playthrough shows its own money and not another one's.
export default function Ledger({ conn, reloadNonce }: { conn: Conn; reloadNonce?: number }) {
  const [dto, setDto] = useState<LedgerDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<"all" | "buy" | "sell">("all");

  const load = useCallback(() => {
    api.ledger(conn, 300)
      .then((d) => { setDto(d); setErr(null); })
      // An older bridge has no /ledger route at all — say so plainly rather than showing an empty ledger,
      // which would read as "you have never traded".
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [conn]);
  useEffect(load, [load, reloadNonce]);

  if (err) return <div className="panel"><div className="panel-title">Purchases & sales</div><div className="sum-msg err">Ledger unavailable — {err}</div></div>;
  if (!dto) return <div className="panel"><div className="panel-title">Purchases & sales</div><p className="hint">loading…</p></div>;

  const rows = dto.entries.filter((e) => kind === "all" || e.kind === kind);
  return (
    <div className="panel">
      <div className="gear-list-head">
        <div className="panel-title">Purchases &amp; sales <span className="dim">· {dto.count}</span></div>
        <span className="spacer" />
        <div className="seg-group">
          {(["all", "buy", "sell"] as const).map((k) => (
            <button key={k} className={`seg${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>
      </div>

      <div className="led-totals">
        <span>spent <b className="down">{cr(dto.spent)}</b></span>
        <span>earned <b className="up">{cr(dto.earned)}</b></span>
        <span>net <b className={dto.net >= 0 ? "up" : "down"}>{cr(dto.net)}</b></span>
        {/* Barter purchases cost goods, not credits, so they never appear in the credit totals — saying how
            many there were stops the net figure reading as the whole story. */}
        {dto.barters > 0 && <span className="dim">+ {dto.barters} bartered (paid in goods)</span>}
      </div>

      {rows.length === 0
        ? <p className="hint">Nothing recorded yet.</p>
        : (
          <div className="led-list">
            {rows.map((e, i) => (
              <div key={i} className={`led-row ${e.kind}`}>
                <span className="led-when dim">{when(e.at)}</span>
                <span className={`led-kind ${e.kind}`}>{e.kind === "buy" ? "bought" : "sold"}</span>
                <span className="led-item">{e.count > 1 ? `${e.count}× ` : ""}{e.item}</span>
                <span className="led-where dim">{[e.station, e.shop].filter(Boolean).join(" · ")}</span>
                <span className={`led-amt ${e.kind === "sell" ? "up" : "down"}`}>
                  {e.costItem
                    ? `${(e.costItemCount ?? 0).toLocaleString()}× ${e.costItem}`
                    : cr(e.credits)}
                </span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
