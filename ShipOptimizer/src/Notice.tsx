import { useEffect } from "react";

/** What an action reports back: it went through, or it did not, and in words the player can act on. */
export interface Msg { ok: boolean; text: string }

/**
 * The result of a press, said once.
 *
 * ONE owner because there were five copies of the same ternary — the sell list, both buy paths, the officer
 * hire and the apply bar — and not one of them could be dismissed: a banner appeared, stayed for the life of
 * the tab, and the next press replaced it. "Saved your list" was still on screen an hour later, over a rule
 * set that had since changed, and only a reload cleared it.
 *
 * A SUCCESS clears itself: it is news, not state, and it stops being true the moment anything else happens. A
 * FAILURE stays until it is dismissed or replaced — it is the only record of what went wrong, and a message
 * that vanishes while the player is reading the thing it refers to cannot be acted on.
 */
export function Notice({ msg, onClose, holdMs = 8000 }: { msg: Msg | null; onClose?: () => void; holdMs?: number }) {
  useEffect(() => {
    // `holdMs: 0` keeps a success up until it is dismissed — for a result that is a RECORD rather than a
    // confirmation (a sale moved money), and for one the player may not be looking at when it lands.
    if (!msg?.ok || !onClose || holdMs <= 0) return;
    const t = window.setTimeout(onClose, holdMs);
    return () => window.clearTimeout(t);
  }, [msg, onClose, holdMs]);

  if (!msg) return null;
  return (
    <div className={"sum-msg " + (msg.ok ? "ok" : "err")}>
      <span className="sum-msg-t">{msg.ok ? "✓" : "⚠"} {msg.text}</span>
      {onClose && <button className="sum-msg-x" title="dismiss" onClick={onClose}>×</button>}
    </div>
  );
}
