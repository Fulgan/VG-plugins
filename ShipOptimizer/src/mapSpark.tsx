import { useEffect, useState } from "react";

/**
 * Traffic on the jump-gate network: now and then, one dot runs down one edge.
 *
 * A static graph reads as a diagram; the map is of a galaxy that is being flown around, and one moving dot every
 * couple of seconds says so without adding anything to read. So it is deliberately SPARSE and unattributed — it
 * is not a ship, not a route preview, and carries no datum a player could misread as one. If it ever needs to
 * mean something (a convoy, your own last hop), it stops being this and gets its own layer.
 *
 * Kept OFF the nodes: sparks are drawn between the edges and the nodes, so a dot slides under a system rather
 * than over it. Motion over a node's digits would make the one number on the map flicker.
 */

/** One edge, as endpoints — the same geometry the map already computed for the line. */
export interface Lane {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Spark {
  id: number;
  lane: Lane;
  ms: number;
  /** Sparks run both ways, so the network doesn't look like it flows in one direction. */
  back: boolean;
}

/** Gap between two sparks. Randomised so the map never gets a rhythm — a metronome is noticed, traffic isn't. */
const GAP_MS: readonly [number, number] = [220, 1300];

/** One dot's pace, in svg units per second, rolled PER SPARK: uniform pace reads as a mechanism, not as traffic. */
const SPEED: readonly [number, number] = [26, 78];
const DUR_MS: readonly [number, number] = [550, 3400];

/** At most this many in flight. Past it the map has traffic rather than a hint of it. */
const MAX_LIVE = 6;

const between = ([lo, hi]: readonly [number, number], u: number) => lo + (hi - lo) * u;

/**
 * The next spark to launch, or null when there is nothing to launch it on.
 *
 * `rand` is passed in (⊥ `Math.random` inside) so the pacing is testable: the only thing worth pinning about a
 * decoration is that its numbers stay inside their bounds whatever the source rolls.
 */
export function nextSpark(lanes: readonly Lane[], rand: () => number): Spark | null {
  if (lanes.length === 0) return null;
  const lane = lanes[Math.min(lanes.length - 1, Math.floor(rand() * lanes.length))];
  const len = Math.hypot(lane.x2 - lane.x1, lane.y2 - lane.y1);
  const ms = Math.min(DUR_MS[1], Math.max(DUR_MS[0], (len / between(SPEED, rand())) * 1000));
  return { id: 0, lane, ms, back: rand() < 0.5 };
}

export const sparkGap = (rand: () => number) => between(GAP_MS, rand());

const reduced = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function MapSparks({ lanes }: { lanes: readonly Lane[] }) {
  const [live, setLive] = useState<Spark[]>([]);

  useEffect(() => {
    if (lanes.length === 0 || reduced()) {
      setLive([]);
      return;
    }
    // One chained timeout, ⊥ an interval: the gap is re-rolled per spark, and a chain cannot pile up behind a
    // tab that was backgrounded (which an interval does, then fires the whole backlog at once).
    let timer: ReturnType<typeof setTimeout>;
    let next = 1;
    let stopped = false;

    const launch = () => {
      if (stopped) return;
      const s = nextSpark(lanes, Math.random);
      if (s) {
        const spark = { ...s, id: next++ };
        setLive((cur) => [...cur, spark].slice(-MAX_LIVE));
        // Removed when its animation ends. Left mounted, each would keep its final frame — a dot parked on a node.
        setTimeout(() => { if (!stopped) setLive((cur) => cur.filter((x) => x.id !== spark.id)); }, spark.ms + 60);
      }
      timer = setTimeout(launch, sparkGap(Math.random));
    };
    timer = setTimeout(launch, sparkGap(Math.random));
    return () => { stopped = true; clearTimeout(timer); };
  }, [lanes]);

  if (live.length === 0) return null;
  return (
    <g className="map-sparks" aria-hidden="true">
      {live.map((s) => (
        // `offset-path` rather than an `animateMotion`: the path is per-spark, and a declarative CSS animation
        // needs no restart handling when React mounts the element mid-flight.
        <circle key={s.id} className="map-spark" cx={0} cy={0} r={1.9} style={{
          offsetPath: `path("M ${s.back ? s.lane.x2 : s.lane.x1} ${s.back ? s.lane.y2 : s.lane.y1} `
            + `L ${s.back ? s.lane.x1 : s.lane.x2} ${s.back ? s.lane.y1 : s.lane.y2}")`,
          animationDuration: `${Math.round(s.ms)}ms`,
        }} />
      ))}
    </g>
  );
}
