import type { GalaxyEdge } from "./types";

/** How far a system is, and what stands in the way. */
export interface Reach {
  hops: number;        // jumps along the shortest route
  locked: number;      // jump gates on that route the ship cannot currently use
}

// Jump distance from one system to every other, over the galaxy's gate graph.
//
// A list of piles of ore is not a tool until it says how far away they are: the biggest stack is worth less
// than a smaller one two jumps out, and worth nothing at all behind a gate that needs a pass.
//
// Two routes are considered and the better one wins: fewest jumps ignoring locks, and fewest jumps using only
// usable gates. A system reachable without locks reports `locked: 0`; one that can only be reached through a
// locked gate reports how many, so the UI can say "3 jumps · 1 locked" rather than pretending it is open.
// Edges are undirected — a jump gate connects both ways — and an edge with no `to` leaves the known map, so it
// leads nowhere this graph can express.
export function reachFrom(edges: GalaxyEdge[], start: string | null | undefined): Map<string, Reach> {
  const out = new Map<string, Reach>();
  if (!start) return out;

  const all = new Map<string, { to: string; usable: boolean }[]>();
  const add = (a: string, b: string, usable: boolean) => {
    if (!all.has(a)) all.set(a, []);
    (all.get(a) as { to: string; usable: boolean }[]).push({ to: b, usable });
  };
  for (const e of edges) {
    if (!e.to) continue;
    // `usable` is the authoritative flag (it accounts for a jump pass the player holds); `open` alone is not
    // enough, and an absent flag is treated as usable so an older bridge degrades to plain distances.
    const usable = e.usable !== false;
    add(e.from, e.to, usable);
    add(e.to, e.from, usable);
  }

  // Breadth-first over usable gates only: these are the honest distances.
  const openHops = bfs(all, start, true);
  // Breadth-first over every gate: reaches systems the first pass cannot, at the cost of a lock.
  const anyHops = bfs(all, start, false);

  for (const [guid, hops] of anyHops) {
    if (guid === start) continue;
    const open = openHops.get(guid);
    out.set(guid, open != null ? { hops: open, locked: 0 } : { hops, locked: lockedOnRoute(all, start, guid) });
  }
  return out;
}

function bfs(graph: Map<string, { to: string; usable: boolean }[]>, start: string, usableOnly: boolean): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as string;
    const d = dist.get(at) as number;
    for (const edge of graph.get(at) ?? []) {
      if (usableOnly && !edge.usable) continue;
      if (dist.has(edge.to)) continue;
      dist.set(edge.to, d + 1);
      queue.push(edge.to);
    }
  }
  return dist;
}

// Fewest LOCKED gates needed to reach a target, minimising locks first and jumps second — "one locked gate,
// six jumps" is better news than "three locked gates, two jumps", because each lock is a thing to go and earn.
function lockedOnRoute(graph: Map<string, { to: string; usable: boolean }[]>, start: string, target: string): number {
  const best = new Map<string, number>([[start, 0]]);
  // 0-1 BFS: a usable gate costs nothing and goes to the front, a locked one costs a lock and goes to the back.
  const deque: string[] = [start];
  while (deque.length) {
    const at = deque.shift() as string;
    const cost = best.get(at) as number;
    for (const edge of graph.get(at) ?? []) {
      const next = cost + (edge.usable ? 0 : 1);
      if (next < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, next);
        if (edge.usable) deque.unshift(edge.to); else deque.push(edge.to);
      }
    }
  }
  return best.get(target) ?? 0;
}
