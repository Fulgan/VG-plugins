using System;
using System.Collections.Generic;
using System.Globalization;

namespace Hypercom
{
    // Request-body accessors for the loosely-typed JSON dictionaries the API works with. Game-free, so
    // it compiles into the headless test project. ONE owner for Api and Presets both (Str/Dbl
    // had two separate impls); one home now.
    internal static class Body
    {
        // String value for `key`, or null when missing/null.
        internal static string Str(Dictionary<string, object> body, string key)
            => body != null && body.TryGetValue(key, out var v) && v != null ? v.ToString() : null;

        // Int value for `key` (0 when missing/non-numeric).
        internal static int Int(Dictionary<string, object> body, string key)
            => TryInt(body, key, out var n) ? n : 0;

        // True + parsed int when `key` is present and numeric; false when missing/non-numeric.
        // (Distinguishes an absent key from a legitimate 0.)
        internal static bool TryInt(Dictionary<string, object> body, string key, out int val)
        {
            val = 0;
            if (body == null || !body.TryGetValue(key, out var v) || v == null)
                return false;
            try { val = (int)Math.Round(Convert.ToDouble(v, CultureInfo.InvariantCulture)); return true; }
            catch { return false; }
        }

        // Bool value for `key` (true only when the value is a boolean true).
        internal static bool Bool(Dictionary<string, object> d, string key)
            => d != null && d.TryGetValue(key, out var v) && v is bool b && b;

        // Double value for `key` (0 when missing/non-numeric).
        internal static double Dbl(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v) || v == null) return 0;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return 0; }
        }
    }
}
