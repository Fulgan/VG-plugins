import { RARITY_COLOR } from "./format";
import { useCursorTip } from "./useCursorTip";
import type { Officer } from "./types";

// THE OFFICER CURSOR CARD, one owner for every surface that shows one.
//
// The summary tab grew it first, to explain a crew change it was about to apply. The officers tab needed the
// same thing on its own crew grid, where the card can only show a handful of chips and the rest of an officer
// is invisible until something says it. Reproducing it there would have been the defect `the build checks.ps1`
// exists for: two answers to "what does an officer look like when you point at one".
export function OfficerTip({ o, x, y, portraitUrl }: {
  o: Officer; x: number; y: number; portraitUrl: (g: string | null) => string | null;
}) {
  // Same cursor tracking as the item tip: measured + clamped in the DOM, no re-render per move.
  const { ref, style } = useCursorTip(x, y);
  const pu = portraitUrl(o.guid);
  const skills = (o.potential ?? []).slice(0, 10);
  return (
    <div className="git" ref={ref} style={style}>
      <div className="git-top">
        <div>
          <div className="git-cls">{o.profession}</div>
          <div className="git-name" style={{ color: RARITY_COLOR[o.rarity] ?? "#cfcfcf" }}>{o.name}</div>
          {o.callsign && <div className="git-mfr">“{o.callsign}”</div>}
        </div>
        <div className="git-lvl">Lv {o.level}</div>
      </div>
      {pu && <span className="git-img" style={{ backgroundImage: `url("${pu}")` }} />}
      {o.bonusValue ? <div className="git-main">+{(o.bonusValue * 100).toFixed(1)}% {o.chosenBonus}</div> : null}
      {skills.length > 0 && <div className="git-subs">{skills.map((s, i) => <div key={i} className="git-sub">{s.name}</div>)}</div>}
    </div>
  );
}
