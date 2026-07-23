using System;
using System.Collections.Generic;

namespace Hypercom
{
    // Ring buffer of captured in-game log lines (notifications + event-log). Written from Harmony
    // hooks on the Unity main thread, read from socket threads — guarded by a lock. Also pushes each
    // new line to SSE clients as a "log" event. No backfill: only captures while the bridge runs.
    internal static class LogBuffer
    {
        private const int Max = 200;
        private static readonly object Gate = new object();
        private static readonly LinkedList<Dictionary<string, object>> Entries = new LinkedList<Dictionary<string, object>>();

        internal static void Add(string source, string text)
        {
            if (string.IsNullOrEmpty(text))
                return;
            var entry = new Dictionary<string, object>
            {
                ["t"] = DateTime.Now.ToString("HH:mm:ss"),
                ["source"] = source,
                ["text"] = text,
            };
            lock (Gate)
            {
                Entries.AddLast(entry);
                while (Entries.Count > Max)
                    Entries.RemoveFirst();
            }
            EventBus.Emit("log", new Dictionary<string, object>(entry));
        }

        internal static List<object> Recent()
        {
            lock (Gate)
                return new List<object>(Entries);
        }
    }
}
