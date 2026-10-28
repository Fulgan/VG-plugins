import type { ReactNode } from "react";
import GearTotals, { type TotalsInputs } from "./GearTotals";

// The ship and the figures for the build being assembled, as ONE block.
//
// They belong together for a layout reason as much as a reading one: `.gear-totals` is a flex CHILD sized to sit
// beside the art (`flex: 0 1 260px`), so on its own in an ordinary container it stretches to the full width of
// whatever holds it and pushes the page down. `.gear-ship` is that flex row, and it wraps under 900px.
export interface ShipView {
  img: string | null;
  name: string | null;
  totals: TotalsInputs;
}

export default function ShipCard({ img, name, totals, publish = false, strip = false, column = false, children }: ShipView & {
  // On a tab where the build is REFERENCE rather than the thing being edited, the figures lay across the width
  // instead of down it: a 260px column of numbers above the content pushes the content itself off the fold.
  strip?: boolean;
  // In a sidebar the ship and its figures stack down the track instead of sitting side by side.
  column?: boolean;
  // Exactly one mount may publish the diagnosis record; the rest of the tabs draw the same figures and stay quiet.
  publish?: boolean;
  // The gear tab's hardpoint markers, which are positioned over the art and belong to that tab alone.
  children?: ReactNode;
}) {
  return (
    <div className={`gear-ship${strip ? " strip" : ""}${column ? " col" : ""}`}>
      {img && (
        <div className="gear-ship-wrap">
          <img className="gear-img" src={img} alt={name ?? "ship"} />
          {children}
        </div>
      )}
      <GearTotals {...totals} publish={publish} />
    </div>
  );
}
