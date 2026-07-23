using System;
using System.Collections.Generic;
using System.Collections.Concurrent;

namespace Hypercom
{
    // Fan-out of game events to connected SSE clients. Emit() runs on the Unity main thread (from the
    // Update watcher) and must never block on socket I/O — it only enqueues to per-client bounded
    // queues (V9). Each SSE connection drains its own queue on its own thread.
    internal static class EventBus
    {
        internal sealed class Client
        {
            // Bounded so a stalled reader can't grow memory without limit; TryAdd drops when full.
            internal readonly BlockingCollection<string> Queue =
                new BlockingCollection<string>(new ConcurrentQueue<string>(), 256);
        }

        private static readonly object Gate = new object();
        private static readonly List<Client> Clients = new List<Client>();

        internal static Client Register()
        {
            var c = new Client();
            lock (Gate) Clients.Add(c);
            return c;
        }

        internal static void Unregister(Client c)
        {
            lock (Gate) Clients.Remove(c);
            try { c.Queue.Dispose(); } catch { }
        }

        // Format one SSE frame and push to every client queue. Non-blocking; drops for full queues.
        internal static void Emit(string type, Dictionary<string, object> payload = null)
        {
            var map = payload ?? new Dictionary<string, object>();
            map["type"] = type;
            var frame = "data: " + Json.Write(map) + "\n\n";
            lock (Gate)
                foreach (var c in Clients)
                    try { c.Queue.TryAdd(frame); } catch { }
        }
    }
}
