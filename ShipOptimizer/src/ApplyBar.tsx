import type { ApplyApi } from "./useApply";

// The apply affordance for ONE tab's section, so Officers, Boosters and Ship gear offer it identically.
//
// Applying used to live only on the Summary tab, which meant deciding on one screen and committing on another.
// Each tab can now commit its own section — but through the shared owner (see useApply), so `busy`, the gate and
// the resulting message are the same everywhere and two tabs cannot disagree about whether a refit is possible.
//
// Deliberately NOT a copy per tab: three buttons with three slightly different disabled conditions is exactly how
// the rails came to offer what the gear tab declined.
export default function ApplyBar({ apply, section, label }: {
  apply: ApplyApi;
  section: "officers" | "boosters" | "gear";
  label: string;   // what is being applied, for the button's tooltip
}) {
  const count = apply.counts[section];
  const act = section === "officers" ? apply.applyOfficers
    : section === "boosters" ? apply.applyBoosters
    : apply.applyGear;
  return (
    <button
      className="apply"
      disabled={apply.gate || count === 0}
      // The gate's reason wins: "Dock to apply" is more useful than restating what the button does.
      title={apply.cannotApply ?? (count === 0 ? `No ${label} changes to apply` : `Apply ${count} ${label} change${count === 1 ? "" : "s"} to this ship`)}
      onClick={act}
    >
      Apply{count > 0 ? ` (${count})` : ""}
    </button>
  );
}

// How the last apply went. OUTCOME ONLY — deliberately not the gate.
//
// The gate is a standing condition, and every screen already states it: the app-level bar says the data is from
// the last dock, and each tab's own notice says what that costs it. Adding a third "Dock to apply." bar stacked
// three warnings for one fact. The reason still reaches the player where the action is — on the disabled button's
// tooltip — which is where it is actionable.
export function ApplyMsg({ apply }: { apply: ApplyApi }) {
  // The one gate that nothing else announces: docked, but this station has no hangar. Undocked is already said by
  // the app-level bar and by each tab's own notice, so repeating it here was the third warning for one fact.
  const gate = apply.gateReason === "no-hangar" ? apply.cannotApply : null;
  if (!gate && !apply.msg) return null;
  return (
    <>
      {gate && <div className="sum-msg err">⚠ {gate}</div>}
      {apply.msg && <div className={apply.msg.ok ? "sum-msg ok" : "sum-msg err"}>{apply.msg.ok ? "✓" : "⚠"} {apply.msg.text}</div>}
    </>
  );
}
