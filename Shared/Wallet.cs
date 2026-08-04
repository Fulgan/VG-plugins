namespace VG.Game
{
    // The player's credit balance — read, written and spent by name, in one place for every plugin.
    //
    // NEVER `player.credits` directly: the member is a FIELD on some game builds and a PROPERTY on others,
    // and `RemoveCredits` takes a spend-category parameter on some and not others. A compiled access binds to
    // exactly one shape and throws MissingField/MissingMethodException on the other, when its whole enclosing
    // method is JITted — so one wrong access takes down every feature that method serves, not just the
    // balance. Name-based access is what makes the shape the caller's non-problem.
    public static class Wallet
    {
        /// <summary>The player's balance, or 0 when it cannot be read.</summary>
        public static long Balance(object player)
        {
            var v = GameMembers.Get(player, "credits");
            switch (v)
            {
                case long l: return l;
                case int i: return i;
                default: return 0L;
            }
        }

        /// <summary>
        /// Set the balance. False when the write did not happen — a caller that has already moved goods needs
        /// to know it failed to charge for them.
        /// </summary>
        public static bool SetBalance(object player, long value) => GameMembers.Set(player, "credits", value);

        /// <summary>
        /// Charge the player through the game's own method, so its bookkeeping (spend categories, autopilot
        /// stats, the clamp at zero) runs rather than being reproduced here. The category is passed only where
        /// the build takes one; otherwise the spend still happens, uncategorised. False means nothing was
        /// charged — the caller must not treat the purchase as paid for.
        /// </summary>
        public static bool Spend(object player, float amount, string category = null)
        {
            if (player == null) return false;
            var t = player.GetType();
            var two = GameMembers.Method(t, "RemoveCredits", 2);
            if (two != null)
            {
                try { two.Invoke(player, new object[] { amount, category ?? "Other" }); return true; }
                catch { return false; }
            }
            var one = GameMembers.Method(t, "RemoveCredits", 1);
            if (one != null)
            {
                try { one.Invoke(player, new object[] { amount }); return true; }
                catch { return false; }
            }
            return false;
        }
    }
}
