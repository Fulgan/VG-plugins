using System;
using System.Linq;
using System.Reflection;

namespace VG.Game
{
    // The game's own on-screen notification, shared by the plugins that want it (Hypercom, Quick Save).
    // Station Assistant calls the game directly — it needs per-message colour and dwell — which is why it
    // never carried missing `Show`.
    //
    // A mod that changes the world must be able to SAY so on the game's screen, not only in a log the player is
    // not reading — acting on the game from a hotkey or a second device should not be invisible on the first one.
    //
    // Resolved by reflection rather than bound directly: a UI method's shape (static vs singleton instance) is
    // exactly the kind of thing that shifts between builds, and failing to toast must never fail the action that
    // already succeeded. Every call is best-effort and swallows its own failure.
    //
    // Call on the Unity main thread.
    public static class GameToast
    {
        private static MethodInfo _create;
        private static MethodInfo _show;
        private static MethodInfo _withColor;
        private static object _target;
        private static bool _looked;

        // The game NEVER shows an uncoloured notification — every call site passes a `ColorHelper` tint, and the
        // builder leaves an unset one at `default(Color)`, which is BLACK on a dark banner and unreadable
        //. These are the game's own `greenish` and `red90`, copied rather than reflected: they are two
        // constants, and reaching into `ColorHelper` to read them would be a second thing that can fail.
        private static readonly UnityEngine.Color Ok = new UnityEngine.Color(0.2593894f, 87f / 106f, 0.2593894f);
        private static readonly UnityEngine.Color Bad = new UnityEngine.Color(0.907547f, 0.1093894f, 0.1093894f);

        /// <summary>Where a resolution failure goes. Set once at startup; a plugin's own logger.</summary>
        public static Action<string> Warn;

        private static void Resolve()
        {
            if (_looked) return;
            _looked = true;
            try
            {
                var t = GameMembers.FindType("Behaviour.UI.NotificationAlert.NotificationManager");
                if (t == null) return;
                const BindingFlags F = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
                _create = t.GetMethods(F).FirstOrDefault(m =>
                    m.Name == "CreateNotification"
                    && m.GetParameters().Length == 1
                    && m.GetParameters()[0].ParameterType == typeof(string));
                if (_create == null || _create.IsStatic) return;
                // `CreateNotification` is a BUILDER: it instantiates the notification INACTIVE and hands back a
                // `NotificationBuilder` whose `Show()` puts it on screen. Calling only the first half creates a
                // hidden object and reports success — which is why no plugin notification was ever visible
                //. Resolved from the RETURN TYPE, so a renamed builder still binds.
                _show = _create.ReturnType == typeof(void)
                    ? null
                    : _create.ReturnType.GetMethod("Show", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null);
                _withColor = _create.ReturnType == typeof(void)
                    ? null
                    : _create.ReturnType.GetMethod("WithColor", BindingFlags.Public | BindingFlags.Instance, null,
                                                   new[] { typeof(UnityEngine.Color) }, null);
                // Instance method: find the singleton the game keeps.
                foreach (var name in new[] { "instance", "Instance", "current", "Current" })
                {
                    var pi = t.GetProperty(name, F);
                    if (pi != null) { _target = pi.GetValue(null); if (_target != null) return; }
                    var fi = t.GetField(name, F);
                    if (fi != null) { _target = fi.GetValue(null); if (_target != null) return; }
                }
                if (_target == null)
                    // Last resort: the live component. "Any" rather than "First" — there is only ever one
                    // notification manager, so instance-ID ordering buys nothing and the ordered variants are both
                    // deprecated for depending on it.
                    _target = UnityEngine.Object.FindAnyObjectByType(t);
            }
            catch (Exception ex) { Warn?.Invoke($"notification lookup failed: {ex.Message}"); }
        }

        /// <summary>Show an on-screen notification. `warn` picks the game's red over its green. Never throws.</summary>
        public static void Show(string text, bool warn = false)
        {
            try
            {
                Resolve();
                if (_create == null) return;
                object built;
                if (_create.IsStatic) built = _create.Invoke(null, new object[] { text });
                else if (_target != null) built = _create.Invoke(_target, new object[] { text });
                else return;
                if (built == null) return;
                // Colour first, then show: the builder returns itself, so the order is the game's own chain.
                if (_withColor != null) built = _withColor.Invoke(built, new object[] { warn ? Bad : Ok }) ?? built;
                // The builder's own `Show()` is what makes it visible; without it the notification exists,
                // inactive, and every caller believes it announced something.
                if (_show != null) _show.Invoke(built, null);
            }
            catch (Exception ex) { Warn?.Invoke($"notification failed: {ex.Message}"); }
        }
    }
}
