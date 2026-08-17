using System;
using VG.Game;
using Xunit;

namespace StationAssistant.Tests
{
    // `GameMembers.RemoveItems` stands between every mutation this mod makes and the game's `Inventory.Remove`,
    // and the game has TWO overloads with DIFFERENT RETURN TYPES: the one taking an item TYPE returns the count
    // it removed, the one taking an ENTRY returns a bool and answers false whenever the entry is not that
    // store's. A shim that reads the bool as "not an int, so assume it worked" reports success while removing
    // nothing, which is how a sale pays for an item the player still holds.
    //
    // The stubs below reproduce both shapes by NAME and arity, since that is all the shim ever sees.
    public class RemoveItemsTests
    {
        private sealed class FakeType { public override string ToString() => "FakeType"; }
        private sealed class FakeEntry { public override string ToString() => "FakeEntry"; }

        // The game's `Remove(InventoryItemType, int, bool skipFavourited = false)` — returns what it removed.
        private sealed class CountingStore
        {
            public int Removed = -1;
            public bool SawSkipFavourited = true;
            public int Give = int.MaxValue;
            public int Remove(FakeType item, int amount, bool skipFavourited = false)
            {
                SawSkipFavourited = skipFavourited;
                Removed = Math.Min(amount, Give);
                return Removed;
            }
        }

        // The game's `Remove(InventoryItem, int)` — returns bool, false when it removed nothing.
        private sealed class EntryStore
        {
            public bool Answer = true;
            public int Calls;
            public bool Remove(FakeEntry item, int count) { Calls++; return Answer; }
        }

        // Both overloads on one type, as the real `Inventory` has them: selection is by what the FIRST
        // parameter accepts, because both forms can be two-argument and arity alone cannot choose.
        private sealed class BothStore
        {
            public string Chose = "";
            public int Remove(FakeType item, int amount, bool skipFavourited = false) { Chose = "type"; return amount; }
            public bool Remove(FakeEntry item, int count) { Chose = "entry"; return true; }
        }

        private sealed class LegacyStore   // pre-0.8.1.26: two-argument counting form, no skipFavourited
        {
            public int Remove(FakeType item, int amount) => amount;
        }

        private sealed class ThrowingStore
        {
            public bool Remove(FakeEntry item, int count) => throw new InvalidOperationException("boom");
        }

        private sealed class VoidStore
        {
            public void Remove(FakeEntry item, int count) { }
        }

        private sealed class NoRemoveStore
        {
            public bool Discard(FakeEntry item, int count) => true;
        }

        [Fact]
        public void CountingOverloadReportsWhatItRemoved()
        {
            var store = new CountingStore { Give = 4 };
            Assert.Equal(4, GameMembers.RemoveItems(store, new FakeType(), 10));
            Assert.Equal(4, store.Removed);
        }

        [Fact]
        public void CountingOverloadIsCalledWithSkipFavouritedFalse()
        {
            // The mod's own keep-rules decide what survives; asking the game to skip favourites would silently
            // spare items the player told US to sell.
            var store = new CountingStore();
            GameMembers.RemoveItems(store, new FakeType(), 1);
            Assert.False(store.SawSkipFavourited);
        }

        [Fact]
        public void EntryOverloadTrueMeansTheWholeAmountLeft()
        {
            var store = new EntryStore { Answer = true };
            Assert.Equal(7, GameMembers.RemoveItems(store, new FakeEntry(), 7));
            Assert.Equal(1, store.Calls);
        }

        [Fact]
        public void EntryOverloadFalseMeansNOTHINGLeft()
        {
            // THE REGRESSION. `false` is the game refusing — the entry belongs to another store, or the handle
            // is stale — and it must never read as a successful removal.
            var store = new EntryStore { Answer = false };
            Assert.Equal(0, GameMembers.RemoveItems(store, new FakeEntry(), 7));
        }

        [Fact]
        public void OverloadIsChosenByWhatTheFirstParameterAccepts()
        {
            var byType = new BothStore();
            GameMembers.RemoveItems(byType, new FakeType(), 1);
            Assert.Equal("type", byType.Chose);

            var byEntry = new BothStore();
            GameMembers.RemoveItems(byEntry, new FakeEntry(), 1);
            Assert.Equal("entry", byEntry.Chose);
        }

        [Fact]
        public void TheTwoArgumentCountingFormStillWorks()
        {
            // The release branch has no `skipFavourited`, and one binary has to serve both.
            Assert.Equal(3, GameMembers.RemoveItems(new LegacyStore(), new FakeType(), 3));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        public void NonPositiveAmountsCannotSucceed(int amount)
        {
            Assert.Equal(-1, GameMembers.RemoveItems(new EntryStore(), new FakeEntry(), amount));
        }

        [Fact]
        public void UncallableCasesAnswerMinusOneRatherThanZero()
        {
            // -1 is "this build cannot do it", 0 is "the game refused this item". A caller has to tell them
            // apart: the first is a broken shim, the second is a fact about one row.
            Assert.Equal(-1, GameMembers.RemoveItems(new NoRemoveStore(), new FakeEntry(), 1));
            Assert.Equal(-1, GameMembers.RemoveItems(new ThrowingStore(), new FakeEntry(), 1));
            Assert.Equal(-1, GameMembers.RemoveItems(new VoidStore(), new FakeEntry(), 1));
            Assert.Equal(-1, GameMembers.RemoveItems(null, new FakeEntry(), 1));
            Assert.Equal(-1, GameMembers.RemoveItems(new EntryStore(), null, 1));
        }

        [Fact]
        public void ResolutionIsCachedPerStoreAndItemTypeWithoutCrossingThem()
        {
            // The cache key is (store type, item type); getting that wrong would serve the entry overload an
            // item type, which throws rather than removes.
            var s = new BothStore();
            GameMembers.RemoveItems(s, new FakeEntry(), 1);
            Assert.Equal("entry", s.Chose);
            GameMembers.RemoveItems(s, new FakeType(), 1);
            Assert.Equal("type", s.Chose);
            GameMembers.RemoveItems(s, new FakeEntry(), 1);
            Assert.Equal("entry", s.Chose);
        }
    }
}
