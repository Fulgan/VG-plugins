using Behaviour.Item;
using Source.Util;

namespace VG.Game
{
    // An item's name as a PERSON should read it.
    //
    // `InventoryItemType.displayName` is not always display text: for ammo and materials it is a localization
    // KEY like `@RailcannonAmmo`, which has to go through `Translation.Translate`. Printing it raw leaks keys
    // into notifications and into the web UI, and anything that then inflects the string mangles the key on top
    // (`@RailcannonAmmo` → `@RailcannonAmmos`).
    //
    // Shared by every plugin because it is the same question everywhere, and a second copy is how one of them
    // ends up printing keys while the other doesn't.
    internal static class ItemNames
    {
        // Display text for a translation key, or `fallback` when the key has no translation (Translate returns
        // the key itself when it doesn't know it, which is indistinguishable from success without this check).
        /// <summary>
        /// Localised text for a key, falling back to the KEY ITSELF when there is no entry.
        ///
        /// `Translate(x, x)` was written out at seven call sites. Passing the same expression twice reads as a
        /// mistake, and it hid the actual rule: an untranslated key is shown raw rather than blanked, because a
        /// visible `@RailcannonAmmo` is a reportable bug while an empty string is invisible.
        /// </summary>
        internal static string Text(string key) => Translate(key, key);

        internal static string Translate(string key, string fallback)
        {
            if (string.IsNullOrEmpty(key)) return fallback;
            try
            {
                var s = Translation.Translate(key);
                return string.IsNullOrEmpty(s) || s == key ? fallback : s;
            }
            catch { return fallback; }
        }

        // The best human-readable name for an item type: translated display name, else the raw display name,
        // else the identifier. Never null for a non-null item, because a nameless item still has to be
        // nameable in a sentence.
        internal static string Pretty(InventoryItemType item)
        {
            if (item == null) return null;
            var raw = item.displayName;
            return string.IsNullOrEmpty(raw) ? item.identifier : Translate(raw, raw);
        }
    }
}
