using System.Collections.Generic;
using System.IO;
using System.Linq;
using Behaviour.Item;
using Behaviour.UI.NotificationAlert;
using Behaviour.Util;
using Source.SpaceShip;
using Source.Util;
using UnityEngine;
using VG.Text;

namespace StationAssistant
{
    // Small within-plugin helpers, one owner each rather than a copy per file (reflection member read,
    // filename sanitiser, ship display name, toast notification). One home so they can't drift.
    internal static class Util
    {
        // Read a property or field by name via reflection (null-safe). Used for cross-version game members.
        internal static object Member(object o, string name)
        {
            if (o == null) return null;
            var t = o.GetType();
            var p = t.GetProperty(name); if (p != null) return p.GetValue(o);
            var f = t.GetField(name); return f?.GetValue(o);
        }

        // Replace filesystem-invalid characters so a string is safe as a filename; empty → "default".
        internal static string Sanitize(string s)
        {
            foreach (var c in Path.GetInvalidFileNameChars())
                s = s.Replace(c, '_');
            return string.IsNullOrEmpty(s) ? "default" : s;
        }

        // "stowed 12 Flak Shells, pulled 3 Ion Cells and bought 240 Railcannon Rounds" — the moved-goods half
        // of a restock report.
        //
        // Per item, because "stowed 12" leaves the reader to guess what moved. Falls back to a plain count
        // plus `noun` when no per-item detail was recorded, so a caller that doesn't track it still reads as a
        // sentence. Zero-count clauses are dropped rather than printed as "0", so the report only claims what
        // actually happened. The verbs live in `.lang` (a translator must be able to reword them); only the
        // assembly happens here.
        internal static string Moved(MoveLog log, int stowed, int pulled, int bought, string noun)
        {
            var parts = new List<string>();
            Clause(parts, "act.stowed", log?.Stowed, stowed, noun);
            Clause(parts, "act.pulled", log?.Pulled, pulled, noun);
            Clause(parts, "act.bought", log?.Bought, bought, noun);
            return Say.List(parts);
        }

        private static void Clause(List<string> into, string key, Dictionary<string, int> items, int total, string noun)
        {
            if (total <= 0) return;
            var detail = items != null && items.Count > 0
                // Biggest mover first, name as the tie-break: dictionary order is an implementation detail and
                // a report that reshuffles between runs reads as though different things happened.
                ? Say.List(items.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key)
                                .Select(kv => Say.Count(kv.Value, kv.Key)))
                : Say.Count(total, noun);
            into.Add(Loc.F(key, detail));
        }

        // An item's display name. Shared with the other plugins (VG.Game.ItemNames): for ammo and materials
        // `displayName` is a localization KEY, so a report built from it prints "@RailcannonAmmo" — and then the
        // inflector pluralises the key into "@RailcannonAmmos".
        internal static string ItemName(InventoryItemType item) => VG.Game.ItemNames.Pretty(item);

        // A ship's display name: custom name if set, else its class display name, else the guid.
        internal static string ShipName(SpaceShipData ship)
            => ship == null ? null
             : !string.IsNullOrEmpty(ship.customShipName) ? ship.customShipName
             : (ship.shipClass?.displayName ?? ship.guid);

        // In-game toast. warn = red + longer dwell (couldn't-do message); otherwise the green success tint.
        internal static void Notify(string text, bool warn = false)
        {
            try
            {
                Singleton<NotificationManager>.Instance
                    .CreateNotification(text)
                    .WithColor(warn ? ColorHelper.red90 : ColorHelper.greenish)
                    .WithCustomTime(warn ? 6f : 3f).Show();
            }
            catch { }
        }
    }

    // Which items a restock actually moved, per direction. Counts alone can't say WHAT moved, and the player
    // needs that to tell a useful restock from one that bought the wrong thing.
    //
    // Keyed by display name rather than by identifier: the name is what gets printed, and two entries that
    // print identically would read as a duplicate. Names arrive already resolved and localized — a supply's
    // `LabelKey`, or an item's `displayName` — so the same item never lands under two keys.
    internal sealed class MoveLog
    {
        internal readonly Dictionary<string, int> Stowed = new Dictionary<string, int>();
        internal readonly Dictionary<string, int> Pulled = new Dictionary<string, int>();
        internal readonly Dictionary<string, int> Bought = new Dictionary<string, int>();

        internal static void Add(Dictionary<string, int> into, string name, int units)
        {
            if (into == null || units <= 0 || string.IsNullOrEmpty(name)) return;
            into.TryGetValue(name, out var had);
            into[name] = had + units;
        }
    }
}
