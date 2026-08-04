// The one verdict on the WHOLE plan, rendered wherever a plan is decided or committed.
//
// Rendered ONLY when the answer is `true`. `null` means the objective cannot judge this plan at all (simple
// ranking, no pools, or a module-only change), and an absent warning must never read as "checked, and fine" —
// so there is no reassuring variant of this component to fall into.
export default function PlanNotice({ regresses }: { regresses: boolean | null }) {
  if (regresses !== true) return null;
  return (
    <div className="sum-msg warn">
      ⚠ This plan scores <b>lower</b> than what is fitted. Each slot gains on its own, but turrets and modules
      compete for one stepped reactor budget, so together they cross a bracket edge and the build ends up weaker.
      Drop a change — or keep a lighter module — and the figure recovers.
    </div>
  );
}
