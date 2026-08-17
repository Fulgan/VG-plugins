using System.Collections.Generic;

namespace VG.Game
{
    // Does a rendered list still match the data behind it?
    //
    // The game keeps inventory data in one array and what a panel draws in another, reconciled only by an explicit
    // call. When that call is missed the two disagree, and to a player that is indistinguishable from an item never
    // arriving. Comparing them is the only way to observe it.
    //
    // Game-free on purpose: the comparison is the part worth pinning with tests, and it must not need Unity to run.
    public sealed class ViewDivergence
    {
        public int Data;
        public int View;
        public readonly List<string> MissingFromView = new List<string>();
        public readonly List<string> OnlyInView = new List<string>();

        // A count mismatch counts even when neither list has an unmatched key: identical keys in different
        // multiplicities is still a view that cannot be trusted.
        public bool Diverged => MissingFromView.Count > 0 || OnlyInView.Count > 0 || Data != View;

        public static ViewDivergence Compare(IList<string> dataKeys, IList<string> viewKeys)
        {
            var d = new ViewDivergence { Data = dataKeys?.Count ?? 0, View = viewKeys?.Count ?? 0 };
            var remaining = new List<string>(viewKeys ?? new List<string>());
            if (dataKeys != null)
                foreach (var k in dataKeys)
                {
                    // Remove-on-match rather than set membership: two identical rows in the data and one in the
                    // view IS the divergence, and a set would collapse exactly that case.
                    if (!remaining.Remove(k)) d.MissingFromView.Add(k);
                }
            d.OnlyInView.AddRange(remaining);
            return d;
        }

        public string Summary(string store) =>
            $"{store}: data {Data} rows, view {View}" +
            (MissingFromView.Count > 0 ? ". Not drawn: " + string.Join(", ", MissingFromView.ToArray()) : "") +
            (OnlyInView.Count > 0 ? ". Drawn but gone: " + string.Join(", ", OnlyInView.ToArray()) : "");
    }
}
