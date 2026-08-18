using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
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

        // A frame gap this long is a FREEZE the player sees, not a slow frame.
        private const double FreezeMs = 1000;

        // Rows are kept from a LOWER bar than the log line. "It freezes sometimes" is a claim about a
        // distribution, and a 400 ms hitch every few seconds and one 37 s stall are different problems that a
        // single 1 s threshold reports identically: as silence in one case and one line in the other.
        private const double RecordMs = 400;

        // Gaps before this much runtime are IGNORED: a scene load holds the frame for a second or more and does it
        // on every launch, so reporting it would put a FREEZE line in every log — which teaches a reader to skip
        // the line, and this line exists to be read exactly once.
        private const float SettleSeconds = 30f;

        /// <summary>
        /// OFF unless a developer turns it on (`Debug/LogFrameGaps`, hidden and false by default). A player's log is
        /// for what went wrong, ⊥ for measurements — and a FREEZE line in a log nobody asked for measurements from
        /// is noise that teaches its reader to skip lines. Removal is tracked as.
        ///
        /// A runtime flag rather than `#if DEBUG`, because the build a developer RUNS is Release: compiling this out
        /// would remove it from the only build where it could ever fire.
        /// </summary>
        internal static bool WatchFrames;

        private static long _lastFrame;

        // WHAT MAKES A GAP ATTRIBUTABLE. A duration alone cannot separate "the game computed something enormous"
        // from "something waited on a lock or on disk", and those have different owners. So each frame stamps the
        // process CPU time and the GC counters, and a gap reports what changed across it:
        //
        //   cpu spent ~= the gap        -> a synchronous BUILD ran (the boarding simulation measured 37 s this way)
        //   cpu spent ~= 0              -> the main thread WAITED: a lock, a disk write, a network call
        //   gen0 collections in bursts  -> allocation pressure rather than one long computation
        //
        // Every read here is cheap and every one is behind WatchFrames, which is off for players.
        private static System.Diagnostics.Process _self;
        private static double _lastCpuMs;
        private static int _lastGen0, _lastGen1;
        private static long _lastHeap;

        // Freezes outlive the log: BepInEx truncates LogOutput.log on every launch, so a player who reports "it
        // hangs sometimes" has already lost the evidence of every session but the last.
        private static readonly JsonlStore Freezes = new JsonlStore("hypercom-freezes.jsonl", 200);

        /// <summary>
        /// Report a frame that never came, and say whether any of it was ours.
        ///
        /// Called at the TOP of Update, before anything else runs, so the gap it measures is the time the game
        /// spent NOT running frames — whatever held it. A stall inside one of our jobs already names itself
        /// (see the warning in Drain); this catches the other cases, and those are the ones a freeze report
        /// cannot otherwise be attributed to: a Harmony patch body, another plugin, or the game itself (an
        /// autosave on a large save is the usual suspect).
        ///
        /// The line deliberately says what was IN FLIGHT rather than guessing a cause: a socket thread waiting
        /// on a job means a request was pending through the freeze — which is not the same as that request
        /// having caused it, and reading it as a cause is how the wrong owner gets blamed.
        /// </summary>
        internal static void Watch()
        {
            var now = Stopwatch.GetTimestamp();

            var cpuMs = 0.0;
            var gen0 = 0;
            var gen1 = 0;
            var heap = 0L;
            if (WatchFrames)
            {
                try
                {
                    if (_self == null) _self = System.Diagnostics.Process.GetCurrentProcess();
                    cpuMs = _self.TotalProcessorTime.TotalMilliseconds;
                    gen0 = GC.CollectionCount(0);
                    gen1 = GC.CollectionCount(1);
                    heap = GC.GetTotalMemory(false);
                }
                catch { /* a counter this runtime does not keep is reported as 0, never as a throw */ }
            }

            // `_lastFrame` is stamped either way (below), so switching this on mid-session cannot report the whole
            // time it was off as one enormous gap.
            if (WatchFrames && _lastFrame != 0 && UnityEngine.Time.realtimeSinceStartup > SettleSeconds)
            {
                var ms = (now - _lastFrame) * 1000.0 / Stopwatch.Frequency;
                if (ms >= RecordMs)
                {
                    var queued = Queue.Count;
                    var cpu = cpuMs - _lastCpuMs;
                    var share = ms > 0 ? cpu / ms : 0;                      // >1 means several cores were busy
                    var g0 = gen0 - _lastGen0;
                    var g1 = gen1 - _lastGen1;
                    var heapMb = (heap - _lastHeap) / (1024.0 * 1024.0);
                    // Docked or in space, because the two have different suspects: an autosave and the station
                    // panels on one side, spawning and combat on the other. Read straight from the game's own
                    // static rather than through a helper that does not exist.
                    var docked = false;
                    try { docked = Source.Galaxy.POI.SpaceStation.current != null; } catch { }

                    // The READING is stated, because a duration on its own has been read as "the last thing in the
                    // log did it" more than once, and that is how the wrong owner gets blamed.
                    var reading = share >= 0.6 ? "COMPUTE: something ran to completion on the main thread"
                                : share <= 0.15 ? "WAIT: the main thread was blocked, not busy"
                                : "MIXED: partly busy, partly waiting";

                    // Only the real freezes reach the log; every hitch reaches the file.
                    if (ms >= FreezeMs)
                    Plugin.Log.LogWarning(
                        $"FRAME GAP {ms:F0}ms — no frame ran for that long. {reading} " +
                        $"(cpu {cpu:F0}ms, {share:P0} of the gap; gc gen0 +{g0}, gen1 +{g1}, heap {heapMb:+0.0;-0.0;0} MB; " +
                        $"{(docked ? "docked" : "in space")}). " +
                        $"Ours in flight: {(queued > 0 ? queued + " job(s) queued, last label '" + Label + "'" : "none")}. " +
                        "A gap with nothing queued was NOT a Hypercom request; check plugin patches (dock/undock " +
                        "automation) and the game's own autosave.");

                    Freezes.Append(new Dictionary<string, object>
                    {
                        ["at"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                        ["gapMs"] = Math.Round(ms),
                        ["cpuMs"] = Math.Round(cpu),
                        ["cpuShare"] = Math.Round(share, 3),
                        ["reading"] = share >= 0.6 ? "compute" : share <= 0.15 ? "wait" : "mixed",
                        ["gen0"] = g0,
                        ["gen1"] = g1,
                        ["heapDeltaMb"] = Math.Round(heapMb, 1),
                        ["docked"] = docked,
                        ["queued"] = queued,
                        ["label"] = queued > 0 ? Label : null,
                        ["playSeconds"] = Math.Round(UnityEngine.Time.realtimeSinceStartup),
                    });
                }
            }
            _lastFrame = now;
            _lastCpuMs = cpuMs;
            _lastGen0 = gen0;
            _lastGen1 = gen1;
            _lastHeap = heap;
        }

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
