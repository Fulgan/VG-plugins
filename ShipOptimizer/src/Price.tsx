import { useState } from "react";
import { api, type Conn } from "./api";
import type { Item } from "./types";

/**
 * A currency's own icon, with its NAME as the fallback.
 *
 * A currency is an item in the game's registry, so the art comes from `/item/icon?id=` — the one route that can
 * address an item the player holds no store slot for. Two places need this (a barter price, the wallet pill), and
 * a second copy would be a second answer to "what happens when the art cannot be fetched": an older bridge has no
 * such route, and a build that retired a currency answers 404 for it. Both must read as the WORD, not a broken
 * image, which is also why `name` is the accessible name rather than the identifier.
 */
export function CurrencyMark({ id, conn, name, fallback, size = 14 }: {
  id: string; conn: Conn; name: string; fallback?: string; size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="price-name">{fallback ?? name}</span>;
  return (
    <img className="price-icon" src={api.itemIconByIdUrl(conn, id)} alt={name} title={name}
         width={size} height={size} loading="lazy" draggable={false} onError={() => setFailed(true)} />
  );
}

// What an offer costs, as the game shows it: a count and the CURRENCY's own icon for a barter price, plain
// credits otherwise. The icon carries the identity, so the raw identifier ("VanguardMark") is only needed as
// the tooltip and as the fallback when the art can't be fetched — an older bridge has no /item/icon route.
export default function Price({ it, conn, size = 14 }: { it: Item; conn: Conn; size?: number }) {
  if (it.costItem) {
    const n = (it.costItemCount ?? 0).toLocaleString();
    return (
      <span className="price barter" title={`${n} × ${it.costItem}`}>
        {n}
        <CurrencyMark id={it.costItem} conn={conn} name={it.costItem} fallback={`× ${it.costItem}`} size={size} />
      </span>
    );
  }
  if (it.cost == null) return null;
  return <span className="price">{it.cost.toLocaleString()} cr</span>;
}
