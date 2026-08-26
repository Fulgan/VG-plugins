using System;
using System.Collections.Generic;
using HarmonyLib;
using Source.Data;
using Source.SpaceShip;
using Behaviour.Unit;
using Behaviour.Weapons;   // TargetableUnit, which the neighbour scan returns
using UnityEngine;
using VG.Game;

namespace CicWatch
{
    // One hull worth reporting: what to print, plus the live unit so vitals are read at draw time rather than
    // remembered. Unity's own null check answers true once a unit is destroyed, so a stale entry reads as gone.
    internal sealed class Contact
    {
        internal string Guid;
        internal string Rarity;      // rarity NAME, as VG.Core.Rarity keys them
        internal string Size;        // SpaceShipType member name: Drone, Size1 .. Size8
        internal string Rank;
        internal int Level;      // the game's own level for this hull, shown beside the rank
        internal string Class;   // the HULL CLASS, always, never a custom name
        internal int Points;
        internal bool Hostile;
        internal bool Boardable;     // the one state with a clock on it
        internal float Distance;

        internal AbstractUnit Unit;

        internal string Label => VG.Core.Rarity.RefitLabel(Rarity, Points);

        /// <summary>
        /// RANK AND LEVEL TOGETHER, which is how they are read: `Veteran` says which band this hull rolled its rarity
        /// in and the number says how hard it actually hits. One owner, because the panel and the settings tab both
        /// print it and two spellings of one fact is the drift this repo pays for most.
        /// </summary>
        internal string RankLabel => Level > 0 ? $"{Rank} ({Level})" : Rank;

        /// <summary>`S6`, or `Drone`. One owner in <see cref="Fmt"/>, since the rule editor names sizes too.</summary>
        internal string SizeLabel => Fmt.SizeLabel(Size);
    }

    // WHAT IS IN THE AREA, read from the world.
    //
    // There is no arrival hook any more, and that is two lessons rather than a simplification for its own sake:
    // judging a hull once at arrival meant a changed rule re-judged nothing already present, and the hook ran while
    // the game was still deciding what the thing even was. The scan is the readout. The only patch left is the one
    // event a scan cannot catch — the instant a hull becomes boardable, whose rolled chance is gone by the next tick
    // — which also keeps this mod off the unit-creation path a boarding operation walks 223 times.
    //
    // NOTHING HERE TOASTS. The panel is the mod's only voice: a standing readout plus a notification for the same
    // fact is the noise V6 forbids, and every call now raises the panel and borrows its header instead (`Say`).
    internal static class Watch
    {
        internal sealed class Tally
        {
            internal int Seen, Own, Hired, Wreck, Listed;

            // WHAT WOULD HAVE TO CHANGE, per rule, for the contacts nobody called. A count per GATE is meaningless
            // under a disjunction — no single criterion dropped anything — so the plot records, for each rule, how
            // many contacts fell to which of its criteria and by how much.
            internal readonly List<Near> Misses = new List<Near>();

            internal sealed class Near
            {
                internal int Rule;          // index into the rule list, so the panel can print the rule itself
                internal string Failed;     // the criterion most contacts fell to
                internal string Detail;     // what it would take
                internal int Count;         // how many fell to it
                internal int Held;          // criteria those contacts DID satisfy, so "closest" is orderable
            }

            /// <summary>Record which rule came closest for a contact nobody called.</summary>
            internal void Note(IList<WatchCriteria> rules, ContactFacts f)
            {
                if (rules == null || rules.Count == 0) return;

                // The CLOSEST rule only. Recording every rule's miss for every contact turns a five-rule list into
                // five lines of noise per contact, and the one worth acting on is the one that nearly matched.
                var bestAt = -1;
                var best = new WatchMiss();
                for (var i = 0; i < rules.Count; i++)
                {
                    var m = WatchMatch.Judge(rules[i], f);
                    if (m.Failed == null) return;                  // matched: not a miss at all
                    if (bestAt < 0 || m.Held > best.Held) { best = m; bestAt = i; }
                }
                if (bestAt < 0) return;

                for (var i = 0; i < Misses.Count; i++)
                    if (Misses[i].Rule == bestAt && Misses[i].Failed == best.Failed)
                    {
                        Misses[i].Count++;
                        return;
                    }
                Misses.Add(new Near { Rule = bestAt, Failed = best.Failed, Detail = best.Detail, Count = 1, Held = best.Held });
            }

            // WHAT IS OUT THERE, counted before any quality rule runs. A watch officer calls every hostile
            // hull whether or not it is worth designating, so the header is built from these and the ROWS
            // from what the rules kept. Live hulls only: wrecks, our own and hired guns are already gone.
            //
            // BOARDABLE AND BOARDING ARE DISJOINT: a hull with a boarding running against it is no longer an
            // opportunity to take, it is an action in progress, and either can be plural at the same time.
            internal int Hostiles, Friendlies, Boardables, Boardings;
        }

        /// <summary>What the last scan dropped and why. Per SCAN, never a running total.</summary>
        internal static Tally Area = new Tally();

        /// <summary>What the last scan cost, so this mod can be ruled out of a freeze by measurement.</summary>
        internal static double ScanMs;

        private static Type _mercenary;
        private static bool _lookedForMercenary;
        private static int _rejectsLogged;
        private static int _scansLogged;
        private static int _lossesLogged;

        // WHO WAS HERE LAST SCAN, over the whole AREA and not the row set: an arrival is called whether or not the
        // quality rules would give the hull a line. ONE SET ANSWERS BOTH DIRECTIONS: a guid this sweep holds that
        // the last did not is an arrival, and one the last held that this does not is a loss. ∴ it is rotated AFTER
        // the loss loop has read it, and only where the sweep ran to the end.
        private static readonly HashSet<string> Present = new HashSet<string>();
        private static bool _haveBaseline;

        // WHAT THE PANEL HAD TO SAY LAST SWEEP, keyed by hull and by whether it was takeable. A dismissal is
        // cleared by NEW information, and this is what "new" means: a contact the rules did not call a moment ago,
        // or one that has just become boardable. Keying on the takeable flag as well is what makes that second
        // case read as news rather than as the same row it already was.
        private static readonly HashSet<string> Called = new HashSet<string>();

        // FOUR BUCKETS, because a loss is TWO questions: which way the hull went, and whose it was. A count with no
        // side to it names one side and is wrong about the other. Which way it went comes from `Fate`; nothing here
        // claims the KILL, since the plot cannot tell whose shot it was.
        private static Voice.Losses _lost;

        // WHOSE SIDE EACH HULL WAS ON LAST SWEEP. A contact that turns on us neither arrives nor leaves ∴ no set
        // membership changes and nothing else here can see it: the only evidence is the hostility this hull READ as
        // a moment ago, which the game answers for NOW and never for THEN. Kept per guid, and only for hulls held
        // across both sweeps — an arrival that is hostile from the first sighting is a new bogey, not a turncoat.
        private static readonly Dictionary<string, bool> WasHostile = new Dictionary<string, bool>();
        private static int _turned;
        /// <summary>Did this sweep turn up something the panel was not already showing?</summary>
        internal static bool SomethingNew;

        // A WAVE, not a hull. Arrivals trickle in over several scans, so new sightings accumulate and are called once
        // the flow stops (or once the batch has run long enough that waiting reads as silence).
        private static int _newHostile, _newFriendly, _newPrize;
        private static float _newestAt, _batchFrom;
        private static object _presentAt;

        internal static void Install(Harmony harmony)
        {
            // Private, which Harmony does not mind, and resolved by NAME so no member reference is compiled in.
            var became = AccessTools.Method(typeof(SpaceShip), "BecameBoardable");
            if (became != null)
                harmony.Patch(became, postfix: new HarmonyMethod(typeof(Watch), nameof(AfterBecameBoardable)));
            else
                Plugin.Log.LogWarning("SpaceShip.BecameBoardable not found: a hull becoming boardable will only be "
                                      + "noticed when the panel next scans.");

            Fate.Install(harmony);
        }

        // Parameters by NAME and only the ones wanted: taking the DamageData would bind a type this mod has no other
        // use for. Every patch body swallows its own failure, since a readout is never worth taking a game path down.
        private static void AfterBecameBoardable(SpaceShip __instance, float boardableChance, float hpFraction)
        {
            try
            {
                if (Plugin.Cfg == null || !Plugin.Cfg.Enabled.Value || __instance == null) return;
                var ship = __instance.unitData as SpaceShipData;
                if (ship == null || ship.isPlayer) return;

                var name = ShipNames.ClassName(ship);
                Plugin.Log.LogInfo($"boardable {name}: hull={Fmt.Pct(hpFraction)} "
                                   + $"chance={Fmt.Pct(boardableChance, 2)}");
                // NO ODDS ON SCREEN. The rolled chance and the hull fraction go to the LOG, where a number is
                // evidence rather than clutter, but the player asked for the readout to stop quoting them.
                Say($"{name} is boardable, captain");
            }
            catch (Exception e) { Plugin.Log.LogWarning($"boardable not reported: {e.Message}"); }
        }

        /// <summary>
        /// One pass at 4 Hz: the list the panel draws, plus the state changes worth a word. A toast cannot depend on
        /// a window being open, which is the whole point of a toast.
        /// </summary>
        internal static List<Contact> Tick()
        {
            // NOTHING TO WATCH WITHOUT A SHIP TO WATCH FROM. `GameState.Loaded` is false at the main menu and through
            // a load, and a quiet plot is only quiet where there IS a plot: the readout otherwise stood on the title
            // screen reporting clear boards. The panel goes with the save, and the arrival history with it, so
            // returning to a system does not read as a wave.
            if (!Ready())
            {
                if (_wasReady)
                {
                    _wasReady = false;
                    Forget();
                    _wasWorth = false;
                    // CLOSED OUTRIGHT, ⊥ auto-hidden: a panel the player opened by hand still has nothing to say on
                    // the title screen, and a dismissal made in the last save must not follow them into the next one.
                    Panel.Close();
                    Panel.DismissedByHand = false;
                }
                Area = new Tally();
                return new List<Contact>();
            }
            _wasReady = true;

            var all = Scan();
            try
            {
                if (_scansLogged < 3 && Area.Seen > 0)
                {
                    _scansLogged++;
                    Plugin.Log.LogInfo($"sweep: {Area.Seen} on the scope, {Area.Listed} called, "
                                       + $"{Area.Misses.Count} near-miss group(s), {Area.Wreck} wrecks, "
                                       + $"{Area.Own} mine, {Area.Hired} hired ({ScanMs:n1} ms)");
                }

                CallTheWave(all.Count);
                Follow(all);
            }
            catch (Exception e) { Plugin.Log.LogWarning($"state changes not read: {e.Message}"); }
            return all;
        }

        // ONE CALL PER WAVE. A hull per line is the per-arrival toast the player had removed; a footprint of four
        // hulls is one report. The batch closes once nothing new has appeared for `Settle`, or once it has been open
        // for `Longest` — a system that keeps spawning must not hold the call for ever.
        private const float Settle = 1.25f;
        private const float Longest = 5f;

        /// <summary>
        /// The counts the standing report speaks from, in one place: the header and the wave call both need them, and
        /// the friendly count is a SETTING (`CallsFriendlies`) rather than a tally, so reading it twice is how the two
        /// surfaces would come to disagree. <paramref name="designated"/> is the row count.
        /// </summary>
        internal static Voice.Standing Standing(int designated)
        {
            return new Voice.Standing
            {
                Hostiles = Area.Hostiles,
                Friendlies = Plugin.Cfg != null && Plugin.Cfg.CallsFriendlies() ? Area.Friendlies : 0,
                Boardable = Area.Boardables,
                Boarding = Area.Boardings,
                Designated = designated,
            };
        }

        /// <summary>
        /// THE PANEL IS THE ONLY VOICE THIS MOD HAS. Every notification is gone at the player's word — `remove the CIC
        /// toasters altogether, keep only the panel notification` — so a call raises the readout and takes its header
        /// for a few seconds rather than putting a second sentence in front of the game. RAISED HERE, ⊥ left to the
        /// next sweep: a line flashed onto a panel nobody can see is the silence the toast used to cover, and the
        /// callers already treat a call as new information that clears a dismissal.
        /// </summary>
        private static void Say(string line)
        {
            Panel.Raise(auto: true);
            Panel.Flash(line);
        }

        private static void CallTheWave(int designated)
        {
            if (_newHostile + _newFriendly + _lost.Any + _turned <= 0) return;

            var now = Time.unscaledTime;
            if (now - _newestAt < Settle && now - _batchFrom < Longest) return;

            var lost = _lost;
            var hostiles = _newHostile;
            var friendlies = _newFriendly;
            var prizes = _newPrize;
            var turned = _turned;
            _newHostile = _newFriendly = _newPrize = 0;
            _lost = new Voice.Losses();
            _turned = 0;
            _batchFrom = _newestAt = 0f;

            // NO SECOND POLICY HERE. Everything counted above was already called by a rule, so a hostility
            // test at this point would be the rule list overruled by something it cannot reach — the defect that
            // kept a called S6 off the plot and out of the toast at the same time. Traffic is quiet because no
            // rule names it, not because this line drops it.

            // ONE SENTENCE FOR BOTH DIRECTIONS. The settle window already gathers a burst, so a fight that kills
            // three and draws four more is one call rather than seven — which is the whole reason the window is
            // there and the reason this needed no new mechanism.
            // THE CALL CARRIES THE STANDING REPORT WITH IT. It takes the header line for 6 s, and a call that named
            // only what changed hid the state of the plot for exactly as long as it was up.
            var line = Voice.Change(hostiles, friendlies, prizes, lost, turned, Standing(designated));
            Plugin.Log.LogInfo($"wave: {hostiles} hostile, {friendlies} friendly, {prizes} boardable, "
                               + $"down {lost.DownHostile}h/{lost.DownFriendly}f, "
                               + $"gone {lost.GoneHostile}h/{lost.GoneFriendly}f, {turned} turned hostile");

            // A wave is new information as well ∴ it too clears a dismissal, and then raises the panel it just
            // un-dismissed rather than waiting for the next tick.
            Panel.DismissedByHand = false;

            Say(line);
        }

        /// <summary>Drop the arrival state. A new area starts with no history rather than a false wave.</summary>
        private static void Forget()
        {
            Present.Clear();
            // A new area starts with nothing already shown ∴ whatever is there reads as new, which is what makes a
            // dismissal from the last system stop following the player into this one.
            Called.Clear();
            Fate.Forget();
            WasHostile.Clear();
            SomethingNew = false;
            _newHostile = _newFriendly = _newPrize = 0;
            _lost = new Voice.Losses();
            _turned = 0;
            _batchFrom = _newestAt = 0f;
        }

        /// <summary>WHAT IS THERE, through the game's own neighbour scan, judged against the CURRENT rules.</summary>
        internal static List<Contact> Scan()
        {
            var found = new List<Contact>();
            var tally = new Tally();
            var calledNow = new HashSet<string>();
            var hostileNow = new Dictionary<string, bool>();
            // WHO IS HERE NOW, by guid. Declared out here with the other per-sweep sets because the loss loop below
            // runs outside the try, and `swept` says whether it holds the whole area or only as much of it as the
            // sweep managed before throwing: a partial set read as complete reports every remaining contact as lost.
            var here = new HashSet<string>();
            var swept = false;
            var somethingNew = false;
            var clock = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                if (Plugin.Cfg == null || !Plugin.Cfg.Enabled.Value) { Area = tally; SomethingNew = false; return found; }

                var me = Source.Player.GamePlayer.current?.currentSpaceShip?.unit;
                var centre = me != null ? (Vector2)me.transform.position : Vector2.zero;

                // A radius that covers the area rather than a sensor range: units only exist in the scene you are
                // in, so this is "everything here" without inventing a detection distance the game does not have.
                var near = PhysicsInteraction.GetUnitsWithinRange(centre, 100000f, me as TargetableUnit);
                if (near == null) { Area = tally; SomethingNew = false; return found; }

                var seen = new HashSet<string>();

                // A NEW AREA IS NOT AN ARRIVAL. Every hull in a system we just entered is unknown to us, and calling
                // the lot of them a footprint would be a lie in the player's own terms.
                object poi = null;
                try { poi = Source.Galaxy.MapPointOfInterest.current; } catch { }
                if (!ReferenceEquals(poi, _presentAt))
                {
                    _presentAt = poi;
                    _haveBaseline = false;
                    Forget();
                }
                foreach (var t in near)
                {
                    var unit = t as AbstractUnit;
                    if (unit == null) continue;
                    var ship = unit.unitData as SpaceShipData;
                    if (ship == null) continue;

                    tally.Seen++;
                    // A WRECK IS NOT A CONTACT AND CARRIES NO CONTACT'S IDENTITY: the game builds it as a new unit
                    // with a guid of its own, so there is nothing here to match against a hull the plot was holding.
                    if (unit.isSalvage) { tally.Wreck++; continue; }
                    if (ship.isPlayer || Mine(ship)) { tally.Own++; continue; }
                    if (IsMercenary(ship)) { tally.Hired++; continue; }

                    var guid = ship.guid;
                    if (!string.IsNullOrEmpty(guid) && !seen.Add(guid)) continue;

                    var hostile = false;
                    try { hostile = ship.IsPlayerEnemy(); } catch { }

                    // Opportunity is never filtered by the danger rule: a hull that can be taken right now is the
                    // rarest thing here and it has a clock on it.
                    var boardable = false;
                    try { boardable = (unit as SpaceShip)?.isBoardable ?? false; } catch { }

                    // Only asked of a hull that IS boardable, which keeps the reflected walk off every scan of every
                    // ship in the area.
                    var boarding = boardable && Boarding.Live(unit as SpaceShip) >= 0f;

                    // Counted HERE, above every filter below, because the report and the rows answer different
                    // questions: what is in the area, and what earns a line of its own.
                    if (hostile) tally.Hostiles++; else tally.Friendlies++;
                    if (boarding) tally.Boardings++; else if (boardable) tally.Boardables++;

                    // A HULL WITH NO GUID STILL HAS AN IDENTITY for as long as it exists: its Unity instance id.
                    // Tracking it by that is what stops it reading as NEW on every sweep — this runs at 4 Hz, so
                    // "cannot be tracked ∴ treat as new" announced the same contact about twenty times per wave and
                    // re-raised a panel the player had dismissed, four times a second. The old comment called that
                    // the safe direction for a dismissal; it is the opposite, because a readout that cannot be shut
                    // is one that gets ignored.
                    var trackKey = !string.IsNullOrEmpty(guid) ? guid : "#" + unit.GetInstanceID();
                    here.Add(trackKey);

                    // A hull we did not hold a moment ago — or, on the FIRST sweep of a new area, everything there,
                    // once. Arriving somewhere is not the same as something arriving, but the interesting hull is
                    // often the one that was already here, and the plot alone does not speak.
                    var fresh = !_haveBaseline || !Present.Contains(trackKey);

                    // A HULL THAT TURNS ON US IS A CHANGE WITH NO MOVEMENT IN IT: it is in both sweeps, so no
                    // arrival and no departure marks it, and the plot would otherwise show one more bogey without a
                    // word said. Only for a hull held across both sweeps and only ONE WAY — a contact that stops
                    // being hostile is not a threat, and calling it would put the readout in the business of
                    // reporting diplomacy.
                    if (!fresh && hostile)
                    {
                        bool before;
                        if (WasHostile.TryGetValue(guid, out before) && !before)
                        {
                            _turned++;
                            // NEW INFORMATION, ∴ it clears a dismissal like an arrival does: a plot the player shut
                            // during quiet traffic is exactly the plot they want back when that traffic turns.
                            somethingNew = true;
                            if (_batchFrom <= 0f) _batchFrom = Time.unscaledTime;
                            _newestAt = Time.unscaledTime;
                        }
                    }
                    if (!string.IsNullOrEmpty(guid)) hostileNow[guid] = hostile;

                    // THE WAVE IS A HEADER-LEVEL STATEMENT, so it counts the AREA rather than the rows (
                    // split). What earns a LINE is the rules' business and stays so; what is happening out there is
                    // the watch officer's, and a fight where most hulls matched no rule is still a fight.
                    if (fresh)
                    {
                        if (hostile) _newHostile++; else _newFriendly++;
                        if (boardable) _newPrize++;
                        if (_batchFrom <= 0f) _batchFrom = Time.unscaledTime;
                        _newestAt = Time.unscaledTime;
                    }

                    // ONE QUESTION, ⊥ a chain of gates. A contact is called when ANY rule matches ALL of its
                    // own criteria, so nothing can veto anything else in silence — which is what the old chain of
                    // three `continue`s cost ( a hull that passed its size rule, dropped for being one level
                    // short of a floor that applied to every size at once).
                    var size = SizeOf(ship);
                    var rarity = GameMembers.Get(ship, "shipRarity")?.ToString();
                    var facts = FactsOf(ship, size, rarity, hostile, boardable);
                    if (!WatchMatch.Any(Plugin.Cfg.RuleList, facts))
                    {
                        // NEAREST MISS, ⊥ a reason: under a disjunction no single criterion dropped this contact, so
                        // what the panel can honestly report is which rule came closest and on what.
                        tally.Note(Plugin.Cfg.RuleList, facts);
                        if (_rejectsLogged < 3)
                        {
                            _rejectsLogged++;
                            Plugin.Log.LogWarning($"not called {ShipNames.Label(ship)}: rarity="
                                + $"'{rarity ?? "<null>"}' size='{size ?? "<null>"}' level={facts.Level} "
                                + $"hostile={hostile} boardable={boardable}");
                        }
                        continue;
                    }

                    // Keyed for the "is this new to the panel" test below, off the same `trackKey` the freshness
                    // test uses ∴ a guid-less hull is answered once rather than every quarter second. The `!`
                    // suffix makes a hull becoming boardable its own call: that state has a clock on it.
                    var callKey = boardable ? trackKey + "!" : trackKey;
                    if (!Called.Contains(callKey)) somethingNew = true;
                    calledNow.Add(callKey);

                    var c = new Contact { Guid = guid, Unit = unit };
                    Describe(c, ship);
                    c.Hostile = hostile;
                    c.Boardable = boardable;
                    c.Distance = me != null ? Vector2.Distance(centre, unit.transform.position) : 0f;
                    found.Add(c);
                    tally.Listed++;
                }

                // A capture first, then whatever is closest: the panel answers "what do I do next".
                found.Sort((a, b) =>
                {
                    if (a.Boardable != b.Boardable) return a.Boardable ? -1 : 1;
                    return a.Distance.CompareTo(b.Distance);
                });
                swept = true;
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"area not scanned: {e.Message}");
            }
            clock.Stop();
            ScanMs = clock.Elapsed.TotalMilliseconds;
            Area = tally;
            // NOTHING IS ROTATED OFF A SWEEP THAT DID NOT FINISH. `here` would then be a partial area, and every
            // contact the sweep never reached would read as a loss.
            if (!swept)
            {
                if (somethingNew) SomethingNew = true;
                return found;
            }

            // WHO LEFT, AND WHICH WAY. A hull absent from this sweep is either DOWN or simply out of range, and only
            // a death witnessed as it happened can tell the two apart: the game removes the hull the same way for
            // both, so an absence with no death against it is a contact that left. Only counted once a baseline
            // exists: on the first sweep of a new area everything is "missing" and none of it is news.
            if (_haveBaseline)
            {
                foreach (var guid in Present)
                {
                    if (here.Contains(guid)) continue;

                    // CONSUMED, so one death is reported once even where the hull lingers a sweep after dying.
                    var down = Fate.Down(guid);
                    if (_lossesLogged < 20)
                    {
                        _lossesLogged++;
                        Plugin.Log.LogInfo($"fate: lost guid='{guid}' -> {(down ? "DOWN" : "gone")}");
                    }

                    // AND WHOSE IT WAS. The side is already held per guid for the turncoat test; a loss with no side
                    // to it names one side and is wrong about the other.
                    bool wasHostile;
                    WasHostile.TryGetValue(guid, out wasHostile);

                    if (down) { if (wasHostile) _lost.DownHostile++; else _lost.DownFriendly++; }
                    else { if (wasHostile) _lost.GoneHostile++; else _lost.GoneFriendly++; }

                    if (_batchFrom <= 0f) _batchFrom = Time.unscaledTime;
                    _newestAt = Time.unscaledTime;
                }
            }
            Fate.Prune();

            Present.Clear();
            foreach (var g in here) Present.Add(g);
            _haveBaseline = true;
            // REPLACED, ⊥ merged: a guid that left the area takes its side with it, so returning later reads as an
            // arrival rather than as a hull that changed allegiance while out of sight.
            WasHostile.Clear();
            foreach (var kv in hostileNow) WasHostile[kv.Key] = kv.Value;

            Called.Clear();
            foreach (var k in calledNow) Called.Add(k);
            // STICKY UNTIL `Follow` USES IT. The settings tab scans for itself on every frame it draws, so a scan
            // that merely re-read the same area would otherwise clear the flag before the tick that acts on it —
            // and having the panel stay dismissed BECAUSE the player had the settings open is the kind of coupling
            // nobody would ever guess at.
            if (somethingNew) SomethingNew = true;
            return found;
        }

        /// <summary>
        /// Say the loudest contact again, through the one surface that speaks. For answering "does the call path work
        /// at all" without waiting for a hull to become boardable or a wave to break.
        /// </summary>
        internal static string AnnounceAgain()
        {
            var all = Scan();
            if (all.Count == 0) return "CIC has nothing to report, captain";
            var c = all[0];
            Say($"{c.Class} on our scopes, captain ({c.Label}, {c.SizeLabel}, {c.Rank})");
            return $"announced {c.Class}";
        }

        // The auto-open policy. It RAISES the panel and never focuses it, green never triggers it while docked, and
        // it fires once per POI: a wave that reopens a panel the player just closed is worse than silence.
        // THE PANEL FOLLOWS THE SITUATION. The old policy fired ONCE per system on a first sighting, which meant the
        // readout was a thing you opened rather than a thing that was up when it mattered: nothing raised it for hulls
        // already present when you arrived, and nothing raised it again after you closed it. So the policy is now
        // evaluated every tick against what is actually out there — up while it matters, down when the plot clears.
        //
        // Dismissing still works, and that is the point of `DismissedByHand`: a panel the player shut stays shut until
        // the area empties, which is the natural end of the engagement they dismissed it for.
        private static bool _wasWorth;
        private static bool _wasReady;

        // OURS IS MORE THAN THE HULL WE ARE FLYING. `isPlayer` is set on the ship under us; a fleet hull parked at the
        // station, and a PRIZE sitting in the dry dock waiting to be recommissioned, are not flagged by it and were
        // therefore reported as neighbours — the dry dock's `Voron` was listed as a contact at 341 m while its
        // recommission panel was open. The game keeps three lists and a hull in any of them is ours to leave alone.
        private static readonly string[] MyFleets = { "spaceShips", "capturedShips", "activeFleet" };

        private static bool Mine(SpaceShipData ship)
        {
            if (ship == null) return false;
            try
            {
                var me = Source.Player.GamePlayer.current;
                if (me == null) return false;
                if (ReferenceEquals(me.currentSpaceShip, ship)) return true;

                foreach (var field in MyFleets)
                {
                    // By NAME: `capturedShips` only exists where capture does, and a missing list must cost this check
                    // rather than the scan it sits in.
                    var list = GameMembers.Get(me, field) as System.Collections.IEnumerable;
                    if (list == null) continue;
                    foreach (var entry in list) if (ReferenceEquals(entry, ship)) return true;
                }
            }
            catch { }
            return false;
        }

        /// <summary>A loaded playthrough with a hull under us, which is the only state this readout means anything in.</summary>
        private static bool Ready()
        {
            try { return GameState.Loaded && Source.Player.GamePlayer.current?.currentSpaceShip?.unit != null; }
            catch { return false; }
        }

        private static void Follow(List<Contact> all)
        {
            try
            {
                // IT DOES ⊥ TAKE ITSELF DOWN. Lowering the panel on a quiet plot meant the quiet lines were never
                // read: the readout vanished exactly when it had something calm to say, and a standing readout that
                // disappears is not standing. Once up it stays up until the player closes it.
                var worth = Worth(all);

                // A DISMISSAL IS CLEARED BY NEW INFORMATION, ⊥ only by the plot going from quiet to busy. Reading
                // the transition alone meant that closing the panel during a fight kept it shut for the whole of it:
                // `worth` never dipped while the enemy was still there, so nothing ever cleared the flag, and the
                // readout stayed away exactly as long as it was wanted. What counts as new is a contact the rules
                // were not already calling, or one that has just become takeable.
                if (worth && (!_wasWorth || SomethingNew)) Panel.DismissedByHand = false;
                SomethingNew = false;
                _wasWorth = worth;

                // QUIET LINES ON means the panel is WANTED ON A QUIET PLOT: raising it only when something was worth
                // reporting left the quiet lines unreachable a second way, since a plot that is empty from the start
                // never transitions into being worth anything. OFF is the opposite request — show up when there is
                // something to name, go away when there is not.
                var wantUp = worth || Plugin.Cfg.QuietLines.Value;

                if (wantUp)
                {
                    if (!Panel.IsOpen && !Panel.DismissedByHand) Panel.Raise(auto: true);
                }
                else
                {
                    Panel.AutoHide();
                }
            }
            catch (Exception e) { Plugin.Log.LogWarning($"panel could not follow the area: {e.Message}"); }
        }

        /// <summary>
        /// Is there anything worth having the panel up for? THE RULES ANSWER THAT, and nothing else does.
        ///
        /// This used to be a second policy counting hostiles and boardables, which is a gate the rule list cannot
        /// reach: a rule calling an S6 freighter left the panel shut because the hull was neither shooting nor
        /// takeable, and the player was told a contact was held by a panel that would not open to show them. The
        /// rule list is the one owner of "worth naming" and the panel follows it.
        ///
        /// The docked exception goes with it. Station traffic no longer needs suppressing here, because traffic
        /// only reaches this point if a rule the player wrote asked for it.
        /// </summary>
        private static bool Worth(List<Contact> all)
        {
            if (Plugin.Cfg.AutoOpenOn.Value == AutoOpen.Never) return false;

            // THE ROWS ARE THE RULES' BUSINESS, THE HEADER IS THE AREA'S, and the panel is worth having up when
            // EITHER has something to say. Reading only the rows was the mistake: a hostile hull nobody wrote a
            // rule for still belongs in the count the header carries, and a plot that stays down through a fight
            // because the enemy was one quality letter short of a rule is a readout that is absent exactly when it
            // is wanted. This is ⊥ V35's forbidden second gate — it does not decide what is CALLED, only whether
            // the thing that reports the area is on screen.
            return all.Count > 0 || Area.Hostiles > 0 || Area.Boardables + Area.Boardings > 0;
        }

        /// <summary>
        /// The hull as the rules read it. The one adapter between the game and the matcher: everything past this
        /// point is a POCO, which is what lets the matching be tested without the game (the KeepMatch pattern).
        /// </summary>
        private static ContactFacts FactsOf(SpaceShipData ship, string size, string rarity, bool hostile, bool boardable)
        {
            return new ContactFacts
            {
                SizeRank = size == null ? -1 : Array.IndexOf(Config.SizeNames, size),
                RarityRank = rarity == null ? -1 : VG.Core.Rarity.Rank(rarity),
                Level = LevelOf(ship),
                PlayerLevel = Config.MyLevel(),
                Hostile = hostile,
                Boardable = boardable,
            };
        }

        /// <summary>A hull's level, or 0 where the game has not set one.</summary>
        private static int LevelOf(SpaceShipData ship)
        {
            try { return ship?.level ?? 0; }
            catch { return 0; }
        }

        // Everything descriptive in one place, so two paths cannot describe the same hull differently.
        private static void Describe(Contact c, SpaceShipData ship)
        {
            c.Rarity = GameMembers.Get(ship, "shipRarity")?.ToString() ?? "Standard";
            c.Size = SizeOf(ship);
            c.Rank = RankOf(ship);
            c.Level = LevelOf(ship);
            // THE CLASS, ⊥ the name. A custom name is what its owner calls it; the class is what it IS, and on the
            // other side of a fight that is the only half worth a column.
            c.Class = ShipNames.ClassName(ship);
            c.Points = PointsOf(ship);
        }

        // Hull size as the game's own enum member name. shipClass is the ship COMPONENT, which is where the role
        // type lives; both it and GetShipType exist on every branch.
        private static string SizeOf(SpaceShipData ship)
        {
            try
            {
                var role = ship.shipClass?.shipRoleType;
                return role != null ? role.GetShipType().ToString() : null;
            }
            catch { return null; }
        }

        private static string RankOf(AbstractUnitData data)
        {
            try { return data.unitRank.ToString(); }
            catch { return null; }
        }

        // The points half of Type-A25, display only: it scales with level rather than with danger.
        private static int PointsOf(SpaceShipData ship)
        {
            try
            {
                var state = GameMembers.Get(ship, "upgradeState");
                var spent = state == null ? null : GameMembers.Get(state, "TotalPointsSpent");
                return spent == null ? 0 : Convert.ToInt32(spent);
            }
            catch { return 0; }
        }

        // The game's own test for a hired wingman, reached by name: CaptainData's base type is one of the crew types
        // that differ per branch, so naming it here would bind something the release build spells differently.
        private static bool IsMercenary(SpaceShipData ship)
        {
            if (!_lookedForMercenary)
            {
                _lookedForMercenary = true;
                _mercenary = GameMembers.FindType("Source.Personnel.Mercenary");
            }
            if (_mercenary == null) return false;

            var commander = GameMembers.Get(ship, "commanderData");
            return commander != null && _mercenary.IsInstanceOfType(commander);
        }
    }
}
