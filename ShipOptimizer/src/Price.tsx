import { useState } from "react";
import { api, type Conn } from "./api";
import type { Item } from "./types";

// What an offer costs, as the game shows it: a count and the CURRENCY's own icon for a barter price, plain
// credits otherwise. The icon carries the identity, so the raw identifier ("VanguardMark") is only needed as
// the tooltip and as the fallback when the art can't be fetched — an older bridge has no /item/icon route.
export default function Price({ it, conn, size = 14 }: { it: Item; conn: Conn; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (it.costItem) {
    const n = (it.costItemCount ?? 0).toLocaleString();
    const url = failed ? null : api.itemIconByIdUrl(conn, it.costItem);
    return (
      <span className="price barter" title={`${n} × ${it.costItem}`}>
        {n}
        {url
          ? <img className="price-icon" src={url} alt={it.costItem} width={size} height={size}
                 loading="lazy" draggable={false} onError={() => setFailed(true)} />
          : <span className="price-name">× {it.costItem}</span>}
      </span>
    );
  }
  if (it.cost == null) return null;
  return <span className="price">{it.cost.toLocaleString()} cr</span>;
}
