import type { Bans } from "./bans";

// HOW MANY ROWS THIS LIST IS HOLDING BACK, and the way to get them.
//
// A ban shrinks a pool the player is looking at, and a pool that shrank for a reason the screen does not state
// reads as an optimizer with nothing to offer.
//
// It counts and lifts THE SAME SET: what this list is hiding, never the ship's whole ban list. A count taken per
// surface with a button that cleared everything meant emptying the shop's list also emptied the inventory's.
export default function BanChip({ bans, keys }: { bans?: Bans; keys: string[] }) {
  if (!bans || keys.length === 0) return null;
  return (
    <button className="ban-chip" onClick={() => bans.liftAll(keys)}
            title="Rows kept out of this list because you told this ship to skip them. Click to show these again.">
      {keys.length} ignored
    </button>
  );
}
