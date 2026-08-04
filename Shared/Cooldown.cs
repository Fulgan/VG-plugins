using System;

namespace VG.Game
{
    // A re-entry guard for an operation that finishes LATER than the call that started it, where a `bool` cleared
    // in `finally` would already be clear while the operation is still running.
    //
    // It is a DEADLINE, not a latch: a latch cleared by a completion callback sticks forever if the callback never
    // arrives, and a stuck guard is a dead hotkey until the game restarts, while a deadline always expires. Claim
    // it BEFORE handing work off, never after.
    //
    // A claim may carry a completion predicate, which can only ever SHORTEN the window — the deadline still
    // governs, so a predicate that never turns true leaves plain timeout behaviour and there is no latch to stick.
    // It is read only when `Blocked` is read, so nothing has to poll it.
    //
    // The predicate also gets a FLOOR: for the first frames of an operation the old state is still standing, so
    // whatever the predicate reads describes the PREVIOUS state and would answer "done" for work not yet started.
    //
    // The clock is injected so this is testable without Unity, `Time.realtimeSinceStartup` being main-thread-only.
    public sealed class Cooldown
    {
        private readonly Func<float> _now;
        private float _until;
        private float _floor;
        private Func<bool> _done;
        private string _reason = "";

        /// <param name="now">Monotonic seconds. In a plugin: `() => Time.realtimeSinceStartup`.</param>
        public Cooldown(Func<float> now)
        {
            _now = now ?? throw new ArgumentNullException(nameof(now));
        }

        /// <summary>What is currently in flight, or "" when nothing is.</summary>
        public string Reason => Blocked ? _reason : "";

        /// <summary>True while a claimed window is still open and the operation has not reported itself finished.</summary>
        public bool Blocked
        {
            get
            {
                var now = _now();
                if (now >= _until) return false;
                return !(now >= _floor && Done());
            }
        }

        /// <summary>
        /// Claim the window for <paramref name="seconds"/> under a name callers can report back.
        ///
        /// Deliberately unconditional: the caller checks <see cref="Blocked"/> first and decides what to say. A
        /// claim that silently refused would hide a double-press instead of reporting it.
        /// </summary>
        /// <param name="done">
        /// Optional "the operation is over" test. Only ever shortens the window, never extends it, and is read
        /// no earlier than <paramref name="floorSeconds"/> after the claim.
        /// </param>
        public void Claim(string reason, float seconds, Func<bool> done = null, float floorSeconds = 0f)
        {
            var now = _now();
            _reason = reason;
            _until = now + seconds;
            _floor = now + floorSeconds;
            _done = done;
        }

        // A predicate that throws answers nothing, and the safe reading of "nothing" is "still running": opening
        // the guard on a failed check would re-admit the very re-entry it exists to refuse.
        private bool Done()
        {
            if (_done == null) return false;
            try { return _done(); }
            catch { return false; }
        }
    }
}
