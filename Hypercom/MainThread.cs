using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Hypercom
{
    // Marshals work from the socket background thread onto the Unity main thread.
    // Game API is NOT thread-safe — every read/write must run inside Run(...). Plugin.Update()
    // calls Drain() once per frame; each queued job runs to completion there, so a whole mutation
    // executed inside one Run(...) lambda is atomic vs. other jobs (single-flight, no interleave).
    internal static class MainThread
    {
        private static readonly ConcurrentQueue<Action> Queue = new ConcurrentQueue<Action>();

        // How long a socket thread will wait for the main thread to service its job before failing.
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

        // A job that runs longer than this is a VISIBLE stall, not a slow request: it happens inside the frame,
        // so the game is frozen for exactly as long. Logged with the route so the cost has an owner — a payload
        // that grows with the playthrough (8k armory rows) is invisible on a fresh save and seconds long on an
        // old one.
        private const double StallMs = 100;

        // Call once per frame from the Unity main thread.
        internal static void Drain()
        {
            while (Queue.TryDequeue(out var job))
            {
                var t0 = Stopwatch.GetTimestamp();
                try { job(); }
                catch (Exception ex) { Plugin.Log.LogError($"main-thread job threw: {ex}"); }
                var ms = (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency;
                if (ms >= StallMs) Plugin.Log.LogWarning($"main-thread job held the frame for {ms:F0}ms ({Label})");
            }
        }

        // What the job in flight is, for the stall line. Set by Run, read only on the main thread.
        private static string Label = "?";

        // The route this connection is serving, set once per request by the server. `[ThreadStatic]` because a
        // connection has its own thread, and the alternative is threading a label through 30-odd call sites.
        [ThreadStatic] internal static string Route;

        // Enqueue f to run on the main thread; block the calling (socket) thread until it returns. `label` names
        // the caller in the stall warning — without it the log says a frame was held and not by what.
        internal static T Run<T>(Func<T> f, string label = null)
        {
            var tcs = new TaskCompletionSource<T>();
            // Captured HERE, on the calling thread: `Route` is [ThreadStatic] and the job runs on the MAIN
            // thread, where it is always null — reading it inside the lambda reported every stall as unlabelled.
            var lbl = label ?? Route ?? "unlabelled";
            Queue.Enqueue(() =>
            {
                Label = lbl;
                try { tcs.TrySetResult(f()); }
                catch (Exception ex) { tcs.TrySetException(ex); }
            });

            if (!tcs.Task.Wait(Timeout))
                throw new TimeoutException("main-thread job did not run within timeout (game paused or stopped?)");
            return tcs.Task.GetAwaiter().GetResult();
        }
    }
}
