using System;
using VG.Game;
using Xunit;

namespace QuickSave.Tests
{
    // Pinned. Quick load calls `GameManager.LoadGame`, which starts the work and RETURNS, so the guard has
    // to outlive the call. It was a bool cleared in `finally`, i.e. already clear when the next keypress landed, and
    // a second load applied over the first duplicated every ship in the world.
    //
    // The clock is injected precisely so this is reachable: `Time.realtimeSinceStartup` is a main-thread Unity
    // static, and the piece whose failure costs an hour of progress must not be the piece no test can touch.
    public class CooldownTests
    {
        private float _now;
        private Cooldown New() { _now = 100f; return new Cooldown(() => _now); }

        [Fact]
        public void StartsUnblocked()
        {
            var c = New();
            Assert.False(c.Blocked);
            Assert.Equal("", c.Reason);
        }

        // The regression itself: the window must still be closed on a press that arrives AFTER the call returned.
        // A boolean cleared in `finally` passes every other test here and fails this one.
        [Fact]
        public void StaysBlockedAfterTheCallThatClaimedItReturns()
        {
            var c = New();
            c.Claim("load", 12f);
            Assert.True(c.Blocked);          // same frame
            _now += 0.05f;
            Assert.True(c.Blocked);          // the double-tap
            _now += 5f;
            Assert.True(c.Blocked);          // still loading
        }

        [Fact]
        public void ExpiresOnItsOwn()
        {
            var c = New();
            c.Claim("load", 12f);
            _now += 12f;
            Assert.False(c.Blocked);         // deadline reached — never needs a callback to clear it
        }

        // Why a deadline rather than a latch: nothing has to arrive for the guard to release. A latch waiting on a
        // completion signal that never comes leaves the hotkey dead until the game restarts.
        [Fact]
        public void NeedsNoCompletionSignalToRelease()
        {
            var c = New();
            c.Claim("load", 12f);
            _now += 10_000f;                 // no callback, no Release() call, nothing
            Assert.False(c.Blocked);
        }

        [Fact]
        public void ReportsWhatIsInFlight()
        {
            var c = New();
            c.Claim("save", 1.5f);
            Assert.Equal("save", c.Reason);
            c.Claim("load", 12f);
            Assert.Equal("load", c.Reason);
        }

        // Reason is only meaningful while blocked: reporting a stale one would name an operation that has finished.
        [Fact]
        public void ForgetsTheReasonOnceExpired()
        {
            var c = New();
            c.Claim("load", 12f);
            _now += 20f;
            Assert.Equal("", c.Reason);
        }

        // Save and load share ONE guard, so they cannot interleave with each other — a save must not run while a
        // load is tearing the scene down.
        [Fact]
        public void OneGuardCoversBothOperations()
        {
            var c = New();
            c.Claim("load", 12f);
            Assert.True(c.Blocked);          // a save attempt now sees the load's window
            Assert.Equal("load", c.Reason);
        }

        // A later claim extends; it never shortens a window that is still open.
        [Fact]
        public void ReclaimingMovesTheDeadlineOut()
        {
            var c = New();
            c.Claim("save", 1.5f);
            _now += 1f;
            c.Claim("load", 12f);
            _now += 1.5f;
            Assert.True(c.Blocked);          // the save window alone would have expired by now
        }

        [Fact]
        public void RejectsAMissingClock()
        {
            Assert.Throws<ArgumentNullException>(() => new Cooldown(null));
        }

        // The point of the predicate: a load that finishes in two seconds returns the hotkey in two seconds
        // instead of holding it for the worst case.
        [Fact]
        public void ACompletedOperationReleasesBeforeTheDeadline()
        {
            var c = New();
            var done = false;
            c.Claim("load", 12f, () => done, 1f);
            _now += 2f;
            Assert.True(c.Blocked);          // still loading: the predicate says so, not the clock
            done = true;
            Assert.False(c.Blocked);
        }

        // Inside the floor the predicate is not consulted at all: for the first frames of a load, everything it
        // could read still describes the world the key was pressed in.
        [Fact]
        public void TheFloorOutranksThePredicate()
        {
            var c = New();
            c.Claim("load", 12f, () => true, 1f);
            Assert.True(c.Blocked);          // same frame
            _now += 0.9f;
            Assert.True(c.Blocked);
            _now += 0.2f;
            Assert.False(c.Blocked);         // past the floor, the predicate is believed
        }

        // The predicate SHORTENS a window; it can never hold one open past its deadline.
        [Fact]
        public void APredicateThatNeverFiresStillExpires()
        {
            var c = New();
            c.Claim("load", 12f, () => false, 1f);
            _now += 12f;
            Assert.False(c.Blocked);
        }

        // A throwing check answers nothing, and "nothing" must read as "still running" — the opposite would open
        // the guard on exactly the frames where the game state is least readable.
        [Fact]
        public void AThrowingPredicateLeavesTheGuardClosed()
        {
            var c = New();
            c.Claim("load", 12f, () => throw new InvalidOperationException("boom"), 1f);
            _now += 2f;
            Assert.True(c.Blocked);
            _now += 10f;
            Assert.False(c.Blocked);         // and the deadline still ends it
        }

        [Fact]
        public void ForgetsTheReasonOnceReleasedEarly()
        {
            var c = New();
            c.Claim("load", 12f, () => true, 0f);
            Assert.Equal("", c.Reason);
        }

        // A claim with no predicate is the old contract exactly: nothing releases it but time.
        [Fact]
        public void APlainClaimHasNoCompletionTest()
        {
            var c = New();
            c.Claim("save", 1.5f);
            _now += 0.1f;
            Assert.True(c.Blocked);
            _now += 1.5f;
            Assert.False(c.Blocked);
        }
    }
}
