using System;
using System.Collections.Concurrent;
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

        // Call once per frame from the Unity main thread.
        internal static void Drain()
        {
            while (Queue.TryDequeue(out var job))
            {
                try { job(); }
                catch (Exception ex) { Plugin.Log.LogError($"main-thread job threw: {ex}"); }
            }
        }

        // Enqueue f to run on the main thread; block the calling (socket) thread until it returns.
        internal static T Run<T>(Func<T> f)
        {
            var tcs = new TaskCompletionSource<T>();
            Queue.Enqueue(() =>
            {
                try { tcs.TrySetResult(f()); }
                catch (Exception ex) { tcs.TrySetException(ex); }
            });

            if (!tcs.Task.Wait(Timeout))
                throw new TimeoutException("main-thread job did not run within timeout (game paused or stopped?)");
            return tcs.Task.GetAwaiter().GetResult();
        }
    }
}
