namespace VG.Game
{
    // Whether the player has protected an item — the one flag a sell path must never get wrong.
    //
    // The flag lives in one of two places depending on the game build: on the STACK the item sits in
    // (`InventoryItem.favourite`) or on the item TYPE (`InventoryItemType.favouriteItem`). They are different
    // claims — per-stack marks the pile in front of you, per-type marks every copy you own — so the stack
    // answers when it can and the type is the fallback, never the other way round.
    //
    // Absent (null) is not false: "cannot tell" and "not favourited" must stay distinguishable all the way to
    // the client, because collapsing them sells protected gear.
    public static class ItemFlags
    {
        /// <param name="entry">the stack the item sits in, when the caller has one</param>
        /// <param name="itemType">the item type, for builds that keep the flag there</param>
        public static bool? Favourite(object entry, object itemType)
        {
            if (entry != null && GameMembers.Get(entry, "favourite") is bool onStack) return onStack;
            if (itemType != null && GameMembers.Get(itemType, "favouriteItem") is bool onType) return onType;
            return null;
        }

        /// <summary>The same question where only a refusal matters: unknown counts as NOT protected, so a
        /// caller must combine it with the other guards rather than rely on it alone.</summary>
        public static bool IsFavourited(object entry, object itemType) => Favourite(entry, itemType) == true;
    }
}
