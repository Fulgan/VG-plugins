using System;
using System.Collections.Generic;
using System.Linq;

namespace VG.Text
{
    // Phrasing helpers for notification text: "3 items" rather than "3 item(s)", "Titanium, Silicon and
    // Iridium" rather than a bare join.
    //
    // Self-contained on purpose. Humanizer does this better in general, but its inflector builds a vocabulary
    // on first use and that path needs BCL assemblies (System.Buffers et al.) at versions Unity's Mono does not
    // carry — it throws inside the notification, i.e. AFTER the transaction it is reporting has already
    // happened. A plugin is a lone DLL beside a game runtime we don't control, so text formatting is not worth
    // a dependency that can fail at that point.
    //
    // English-only, and deliberately narrow: anything a translator must be able to reword belongs in a
    // `.lang` value. These only compose COUNTS and LISTS to pass into those values as {0} placeholders.
    internal static class Say
    {
        // Plurals the -s rules get wrong. Only what this codebase actually says: nouns for goods, ships, slots
        // and crew. Grow it when a real string needs it rather than pre-loading a dictionary.
        private static readonly Dictionary<string, string> Irregular = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["analysis"] = "analyses", ["basis"] = "bases", ["crisis"] = "crises", ["axis"] = "axes",
            ["index"] = "indices", ["matrix"] = "matrices", ["vertex"] = "vertices", ["appendix"] = "appendices",
            ["person"] = "people", ["man"] = "men", ["woman"] = "women", ["child"] = "children",
            ["foot"] = "feet", ["tooth"] = "teeth", ["mouse"] = "mice", ["goose"] = "geese",
            ["life"] = "lives", ["knife"] = "knives", ["wife"] = "wives", ["leaf"] = "leaves", ["half"] = "halves",
            ["shelf"] = "shelves", ["thief"] = "thieves", ["wolf"] = "wolves",
            ["datum"] = "data", ["medium"] = "media", ["nucleus"] = "nuclei", ["radius"] = "radii",
            ["cactus"] = "cacti", ["focus"] = "foci", ["stimulus"] = "stimuli",
            ["phenomenon"] = "phenomena", ["criterion"] = "criteria",
        };

        // Nouns with no distinct plural. "Ammo" is the one that matters here — the game names ammo items that
        // way and "3 Ammos" is wrong.
        private static readonly HashSet<string> Uncountable = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "ammo", "equipment", "gear", "cargo", "fuel", "ore", "scrap", "salvage", "debris",
            "information", "data", "series", "species", "aircraft", "fish", "sheep", "deer", "news",
            "software", "hardware", "money", "cash",
        };

        // "1 item" / "3 items" / "1,204 rounds" / "12 Ion Cells". Counts are grouped, because a bare 1204 reads
        // as a different magnitude at a glance. Pass `plural` only to override an inflection the rules below get
        // wrong for a game-specific term.
        internal static string Count(long n, string singular, string plural = null)
            => n == 1
                 ? "1 " + singular
                 : n.ToString("N0") + " " + (plural ?? Plural(singular));

        // English plural of a noun phrase. Only the LAST word inflects ("other ship" → "other ships"), which is
        // what lets an item's display name go through unchanged in shape.
        internal static string Plural(string word)
        {
            if (string.IsNullOrEmpty(word)) return word;
            var cut = word.LastIndexOf(' ');
            var head = cut < 0 ? "" : word.Substring(0, cut + 1);
            var last = cut < 0 ? word : word.Substring(cut + 1);
            return head + PluralWord(last);
        }

        private static string PluralWord(string w)
        {
            if (w.Length == 0 || Uncountable.Contains(w)) return w;
            if (Irregular.TryGetValue(w, out var irr)) return MatchCase(w, irr);
            // Already plural — an item called "Flak Shells" must not become "Flak Shellses". A trailing -s only
            // means singular in the -ss/-us/-is shapes (mass, bus, analysis), which the rules below handle.
            if (w.EndsWith("s", StringComparison.OrdinalIgnoreCase)
                && !EndsWithAny(w, "ss", "us", "is")) return w;
            if (w.EndsWith("y", StringComparison.OrdinalIgnoreCase) && w.Length > 1
                && !"aeiou".Contains(char.ToLowerInvariant(w[w.Length - 2])))
                return w.Substring(0, w.Length - 1) + (char.IsUpper(w[w.Length - 1]) ? "IES" : "ies");
            if (EndsWithAny(w, "s", "x", "z", "ch", "sh"))
                return w + (char.IsUpper(w[w.Length - 1]) ? "ES" : "es");
            return w + (char.IsUpper(w[w.Length - 1]) ? "S" : "s");
        }

        private static bool EndsWithAny(string w, params string[] suffixes)
            => suffixes.Any(sfx => w.EndsWith(sfx, StringComparison.OrdinalIgnoreCase));

        // An irregular is stored lower-case; a capitalised input ("Analysis") must not come back lower.
        private static string MatchCase(string source, string result)
            => source.Length > 0 && char.IsUpper(source[0])
                 ? char.ToUpperInvariant(result[0]) + result.Substring(1)
                 : result;

        // "a", "a and b", "a, b and c" — no Oxford comma.
        internal static string List(IEnumerable<string> parts)
        {
            var all = parts?.Where(p => !string.IsNullOrEmpty(p)).ToList() ?? new List<string>();
            if (all.Count == 0) return "";
            if (all.Count == 1) return all[0];
            return string.Join(", ", all.Take(all.Count - 1)) + " and " + all[all.Count - 1];
        }

        // Money, always grouped: "966,778 cr".
        internal static string Credits(long n) => n.ToString("N0") + " cr";
    }
}
