// Orange power pie for the comparison tooltips: an item's MAIN stat (Combat Power for combat
// turrets, Mining Power for mining ones, Reactor Power for reactors, …) drawn as a share of the
// strongest item shown in that same tooltip. The best item gets a full disc; the rest get a
// proportional sector. Purely relative — the denominator is per-tooltip, never a global scale.

// Sector path starting at 12 o'clock, sweeping clockwise. A full turn can't be drawn as a single
// arc (start point == end point), so 100% renders as two half-arcs instead.
function sector(cx: number, cy: number, r: number, frac: number): string {
  if (frac >= 0.9995) return `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${r} ${r} 0 0 1 ${cx} ${cy - r} Z`;
  const a = frac * 2 * Math.PI;
  const x = cx + r * Math.sin(a);
  const y = cy - r * Math.cos(a);
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x} ${y} Z`;
}

export default function PowerPie({ value, max, label, size = 30 }: { value: number; max: number; label?: string; size?: number }) {
  if (!(max > 0) || !(value > 0)) return null; // nothing to scale against (or a non-numeric main stat)
  const frac = Math.min(1, value / max);
  const c = size / 2;
  const r = c - 1.25; // leave room for the ring stroke
  const pct = Math.round(frac * 100);
  return (
    <span className="pow-pie" title={`${label ?? "Power"}: ${pct}% of the strongest item compared`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="pow-pie-bg" cx={c} cy={c} r={r} />
        <path className="pow-pie-fill" d={sector(c, c, r, frac)} />
        <circle className="pow-pie-ring" cx={c} cy={c} r={r} />
      </svg>
    </span>
  );
}
