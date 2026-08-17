using System;
using System.Diagnostics;

namespace VG.Shared
{
    /// <summary>
    /// Time a block that runs ON THE UNITY MAIN THREAD and name it when it holds the frame.
    ///
    /// A mod's automation runs inside Harmony patches, which is work the game cannot schedule around: for however
    /// long the body takes, the game is frozen. That cost is invisible on a fresh save and grows with the
    /// playthrough — one ammo pass moved 1,269 items on a reported save — so the only way to attribute a freeze
    /// is to have measured the candidates BEFORE it happens.
    ///
    /// Deliberately not a profiler: one line, only when the block was slow enough for a player to feel it, naming
    /// the step and (where the caller knows it) how much work it did. A freeze nobody can attribute is the defect
    /// this exists to close — reading a summary line as innocent because it printed is exactly the mistake.
    /// </summary>
    internal static class Stall
    {
        /// <summary>
        /// OFF unless a developer turns it on. A player's log is for what went wrong, ⊥ for measurements nobody
        /// asked for, so each mod binds a HIDDEN config entry to this (`Browsable = false`, default false) — the
        /// pattern Hypercom's own `EnableDebugEndpoints` already uses.
        ///
        /// Deliberately a runtime flag and ⊥ `#if DEBUG`: the plugin a developer RUNS is the Release build (the
        /// deploy target and the game's own load path), so compiling it out would remove it from the only build it
        /// could ever help — which is the opposite of the intent.
        /// </summary>
        internal static bool Enabled;

        /// <summary>Below this, the frame was not held long enough to see.</summary>
        internal const double WarnMs = 50;

        /// <summary>
        /// Run <paramref name="body"/>, and log when it took longer than <see cref="WarnMs"/>.
        /// <paramref name="detail"/> is evaluated only if the line is written, so counting the work it did costs
        /// nothing on the fast path.
        /// </summary>
        internal static void Timed(Action<Action<string>> body, string step, Action<string> log)
        {
            // Switched off, the body still runs and nothing is measured: this wraps real work, and a disabled
            // measurement that skipped its own subject would be a bug of the worst kind.
            if (!Enabled) { body(_ => { }); return; }
            var t0 = Stopwatch.GetTimestamp();
            string detail = null;
            try { body(d => detail = d); }
            finally
            {
                var ms = (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency;
                if (ms >= WarnMs)
                    log($"{step} held the frame for {ms:F0}ms{(detail == null ? "" : " — " + detail)}");
            }
        }

        /// <summary>The no-detail form, for a step whose cost is the whole story.</summary>
        internal static void Timed(Action body, string step, Action<string> log) =>
            Timed(_ => body(), step, log);
    }
}
