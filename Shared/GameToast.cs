using System;
using System.Linq;
using System.Reflection;

namespace VG.Game
{
    // The game's own on-screen notification, shared by every plugin.
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
        private static object _target;
        private static bool _looked;

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

        /// <summary>Show an on-screen notification. Never throws.</summary>
        public static void Show(string text)
        {
            try
            {
                Resolve();
                if (_create == null) return;
                if (_create.IsStatic) _create.Invoke(null, new object[] { text });
                else if (_target != null) _create.Invoke(_target, new object[] { text });
            }
            catch (Exception ex) { Warn?.Invoke($"notification failed: {ex.Message}"); }
        }
    }
}
