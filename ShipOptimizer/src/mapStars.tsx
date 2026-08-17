import type React from "react";

/**
 * The backdrop the graph sits on: a dim field of stars, each one twinkling on its own slow cycle.
 *
 * Deliberately meaningless. Every other mark on this map is a reading of something — a fill is a measurement, a
 * ring is a headquarters, a moving dot is traffic — so the one purely decorative layer has to be unmistakably
 * decorative: too faint and too numerous to count, placed with no relation to the systems drawn over it. A
 * backdrop that looked like data would be read as data.
 *
 * Positions are deterministic from an index, ⊥ `Math.random`: the field is generated during render, and a random
 * one would jump to a new sky on every re-render — which is what makes a background suddenly the most animated
 * thing on screen.
 */

/** Enough to read as a sky at this size; past this it starts to compete with the nodes for attention. */
const COUNT = 110;

/** A star's own cycle. Long and spread, so the field never pulses together — that reads as a flicker, not a sky. */
const PERIOD_S: readonly [number, number] = [4.5, 13];

/**
 * A hash-based generator: the same `i` always yields the same values, and consecutive `i` yield unrelated ones,
 * so the field looks scattered without a random source that would change between renders.
 */
const spread = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export function MapStars({ w, h }: { w: number; h: number }) {
  return (
    <g className="map-stars" aria-hidden="true">
      {Array.from({ length: COUNT }, (_, i) => {
        const [fx, fy, fr, ft, fd] = [0, 1, 2, 3, 4].map((s) => spread(i, s));
        const period = PERIOD_S[0] + (PERIOD_S[1] - PERIOD_S[0]) * ft;
        return (
          <circle key={i} cx={+(fx * w).toFixed(1)} cy={+(fy * h).toFixed(1)}
            // Sub-pixel radii are the point: most stars should be at the threshold of visible, with a few larger.
            r={+(0.35 + fr * fr * 1.15).toFixed(2)}
            style={{
              animationDuration: `${period.toFixed(1)}s`,
              // A negative delay starts each star PART-WAY through its cycle, so the field is already scattered
              // in time on the first frame instead of every star fading up together.
              animationDelay: `-${(fd * period).toFixed(1)}s`,
              // The star's own brightness; the stylesheet's keyframes swing opacity between a third of this and
              // all of it. Bigger stars are brighter, which is what keeps the field from reading as a grid.
              // Low on purpose: this is the only layer on the map carrying no information, so it sits at the
              // threshold of noticeable and the brightest star here stays dimmer than the dimmest node fill.
              "--o": (0.09 + fr * 0.16).toFixed(2),
            } as React.CSSProperties} />
        );
      })}
    </g>
  );
}
