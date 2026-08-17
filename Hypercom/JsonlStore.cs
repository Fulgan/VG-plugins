using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Hypercom
{
    /// <summary>
    /// An append-only history on disk, as JSON lines, trimmed to a ceiling.
    ///
    /// ONE owner for the mechanics two histories need — the purchase ledger and the mission log — because they are
    /// the same problem twice: rows the app cannot reconstruct, written while the game runs, read back per
    /// playthrough. What differs between them is the SHAPE of a row and nothing else.
    ///
    /// Three properties the callers depend on, each learned the hard way in `Ledger`:
    ///
    ///  * a write NEVER throws into the caller. Both callers are recording something that already happened — the
    ///    money has moved, the mission is gone — so a failed write loses a row and must not lose the event.
    ///  * one unparseable LINE loses one row, not the file: a partial last append (killed mid-write) must not take
    ///    the history with it.
    ///  * persistence can be DEFERRED and is ref-counted. A write is the whole file, so a bulk operation that
    ///    records thousands of rows would otherwise rewrite it thousands of times — measured at ~12ms per sale and
    ///    the reason the game stood still through a 7,891-item one. Nested scopes cannot flush an outer one early,
    ///    and `Flush` must run even when the operation throws.
    /// </summary>
    internal sealed class JsonlStore
    {
        private readonly string _fileName;
        private readonly int _maxEntries;
        private readonly object _gate = new object();
        private List<Dictionary<string, object>> _cache;
        private int _deferred;
        private bool _dirty;

        internal JsonlStore(string fileName, int maxEntries)
        {
            _fileName = fileName;
            _maxEntries = maxEntries;
        }

        private string Path => System.IO.Path.Combine(BepInEx.Paths.ConfigPath, _fileName);

        /// <summary>Append one row. Best-effort by contract — see the class note.</summary>
        internal void Append(Dictionary<string, object> entry)
        {
            try
            {
                lock (_gate)
                {
                    Load();
                    _cache.Add(entry);
                    if (_cache.Count > _maxEntries) _cache.RemoveRange(0, _cache.Count - _maxEntries);
                    if (_deferred > 0) _dirty = true; else Persist();
                }
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"{_fileName} write failed: {ex.Message}"); }
        }

        /// <summary>Every row, oldest first. The caller filters and orders — it knows what its rows mean.</summary>
        internal List<Dictionary<string, object>> Rows()
        {
            lock (_gate)
            {
                Load();
                return new List<Dictionary<string, object>>(_cache);
            }
        }

        internal void Defer()
        {
            lock (_gate) _deferred++;
        }

        internal void Flush()
        {
            lock (_gate)
            {
                if (_deferred > 0) _deferred--;
                if (_deferred > 0 || !_dirty) return;
                _dirty = false;
                Persist();
            }
        }

        /// <summary>
        /// Keep only the rows a predicate accepts, and report how many went. For "forget this playthrough" — the one
        /// operation that is ⊥ an append, and the reason the cache is owned here rather than rebuilt per read.
        /// </summary>
        internal int Keep(Func<Dictionary<string, object>, bool> keep)
        {
            lock (_gate)
            {
                Load();
                var before = _cache.Count;
                _cache = _cache.Where(keep).ToList();
                Persist();
                return before - _cache.Count;
            }
        }

        private void Load()
        {
            if (_cache != null) return;
            _cache = new List<Dictionary<string, object>>();
            try
            {
                if (!File.Exists(Path)) return;
                foreach (var line in File.ReadAllLines(Path))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try { var o = Json.ParseObject(line); if (o != null) _cache.Add(o); } catch { }
                }
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"{_fileName} load failed: {ex.Message}"); }
        }

        private void Persist()
        {
            try { File.WriteAllLines(Path, _cache.Select(Json.Write)); }
            catch (Exception ex) { Plugin.Log.LogWarning($"{_fileName} save failed: {ex.Message}"); }
        }
    }
}
