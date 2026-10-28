using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Source.Player;

namespace Hypercom
{
    // Hiring an officer from the docked station's Personnel Center.
    //
    // Everything here is reflection-only and DISCOVERED AT RUNTIME rather than typed. Two reasons:
    //   * The crew API is the most volatile part of this game — it was renamed wholesale once already, so a
    //     typed reference to OfficerData risks a TypeLoad on a build that moves it again.
    //   * `HireOfficer` takes a parameter, so it can't be found by enumerating zero-arg members; the host
    //     object isn't documented anywhere. So the hosts are searched in order and the first plausible
    //     one-parameter method wins.
    //
    // `dryRun` reports what WOULD be called (and what it would cost) without invoking anything, so the
    // discovery can be verified before any credits move.
    internal static class Hiring
    {
        // Where a hire method might live, most specific first.
        private static IEnumerable<KeyValuePair<string, object>> Hosts(object station, object centre)
        {
            yield return new KeyValuePair<string, object>("personnelCenter", centre);
            yield return new KeyValuePair<string, object>("station", station);
            yield return new KeyValuePair<string, object>("player", GamePlayer.current);
        }

        private static readonly string[] MethodNames = { "HireOfficer", "Hire", "RecruitOfficer", "Recruit", "BuyOfficer" };

        private const BindingFlags F = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

        internal static Api.Result Hire(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (!Api.Docked) return Api.Result.Err(403, "not docked");
            if (GamePlayer.current?.currentAutopilotSessionStats != null) return Api.Result.Err(409, "ECHO active");

            var guid = Body.Str(body, "guid");
            if (string.IsNullOrEmpty(guid)) return Api.Result.Err(400, "missing officer guid");
            var dryRun = body != null && body.TryGetValue("dryRun", out var dv) && dv is bool b && b;

            var station = Compat.Get(GamePlayer.current, "lastStation") ?? Source.Galaxy.POI.SpaceStation.current;
            var centre = Compat.Get(station, "personnelCenter");
            if (centre == null) return Api.Result.Err(404, "this station has no Personnel Center");

            // The recruit, by guid, from the centre's own list — never trust a client-supplied identity.
            object officer = null;
            foreach (var o in Compat.Enumerate(Compat.Get(centre, "officers")))
                if (Compat.Get<string>(o, "guid", null) == guid) { officer = o; break; }
            if (officer == null) return Api.Result.Err(404, "no such recruit at this station");

            // `int` up to game 0.8.2, `long` from 0.8.3: converted from the boxed value, since `Get<T>` matches the
            // exact type and answers its fallback for any other.
            var cost = Convert.ToInt64(Compat.Get(officer, "purchaseCost") ?? 0);
            var credits = Compat.Get<long>(GamePlayer.current, "credits", 0L);

            // Find a callable hire method whose single parameter accepts this officer.
            string foundOn = null, foundName = null;
            MethodInfo found = null;
            object foundTarget = null;
            foreach (var host in Hosts(station, centre))
            {
                if (host.Value == null) continue;
                for (var t = host.Value.GetType(); t != null && found == null; t = t.BaseType)
                    foreach (var name in MethodNames)
                    {
                        var m = t.GetMethods(F).FirstOrDefault(x =>
                            x.Name == name
                            && x.GetParameters().Length == 1
                            && x.GetParameters()[0].ParameterType.IsInstanceOfType(officer));
                        if (m == null) continue;
                        found = m; foundOn = host.Key; foundName = name; foundTarget = host.Value;
                        break;
                    }
                if (found != null) break;
            }

            var report = new Dictionary<string, object>
            {
                ["officer"] = Compat.Get<string>(officer, "name", null),
                ["guid"] = guid,
                ["cost"] = cost,
                ["credits"] = credits,
                ["affordable"] = cost <= credits,
                ["method"] = found == null ? null : $"{foundOn}.{foundName}({found.GetParameters()[0].ParameterType.Name})",
                ["station"] = Compat.Get<string>(station, "name", null),
            };

            if (found == null)
            {
                report["error"] = "no hire method found — the crew API likely changed again";
                return new Api.Result(501, report);
            }
            if (dryRun) { report["dryRun"] = true; return Api.Result.Ok(report); }
            // Checked here as well as by the game: a wrong spend is worse than a refused click.
            if (cost > credits)
                return Api.Result.Err(409, $"cannot afford {Compat.Get<string>(officer, "name", "officer")}: need {cost:N0} cr, have {credits:N0}");

            try
            {
                // COUNTED ON THE LIST WE ADD TO, by the name the game actually uses. This read `allOfficers`, which
                // exists nowhere in the game: reflection answered null, `Enumerate` turned that into an empty
                // sequence, and 0-before/0-after made every successful hire look like a failure — so the rollback
                // undid a hire that had worked, refunding the cost and putting the recruit back while the officer
                // stayed on the roster. A count that cannot be read is a verification we do not have, so a missing
                // list REFUSES the mutation instead of proceeding blind.
                var roster = Compat.Get(GamePlayer.current, "officers");
                if (roster == null)
                {
                    report["error"] = "GamePlayer.officers not found — refusing to hire without a way to verify it";
                    return new Api.Result(501, report);
                }
                var before = Compat.Enumerate(roster).Count();

                // THE GAME'S OWN SEQUENCE, MIRRORED. `PersonnelCenter.HireOfficer` does not hire: its whole body is
                // `officers.Remove(officer)`. The hire is four more steps, and calling only the first took the
                // recruit off the station's list while nothing joined the crew and nothing was charged — the recruit
                // simply vanished until the station refreshed. `PersonnelCenterOfficersPanel.HireSelected` is the
                // order followed here: afford, remove, pay, add, notify.
                var removed = found.Invoke(foundTarget, new[] { officer });
                if (removed is bool tookIt && !tookIt)
                {
                    report["error"] = "the recruit was no longer on this station's list";
                    return new Api.Result(409, report);
                }

                var paid = VG.Game.Wallet.Spend(GamePlayer.current, cost, "Officers");
                report["paid"] = paid;

                // ⚠ A FAILED PAYMENT MUST STOP THE HIRE. It did not: only a roster that failed to GROW triggered
                // the rollback below, so `paid == false` with a successful add answered 200 with
                // `hired: true, paid: false` and toasted "for N cr" — a free officer with a receipt. `Wallet.Spend`
                // returns false whenever `RemoveCredits` is absent or throws, so this is a live branch.
                //
                // Refused HERE rather than after the add, because at this point the only thing to undo is the
                // station's own list: the roster has not been touched yet.
                if (!paid)
                {
                    var unpaidList = Compat.Get(centre, "officers");
                    var putBack = unpaidList?.GetType().GetMethod("Add");
                    try { putBack?.Invoke(unpaidList, new[] { officer }); report["restored"] = putBack != null; }
                    catch { report["restored"] = false; }
                    report["hired"] = false;
                    report["error"] = "the credits could not be taken, so nobody was hired; "
                                      + "the recruit was put back on the station's list";
                    return new Api.Result(402, report);
                }

                // The actual hire: the roster is a list, and joining it is what makes someone crew.
                var added = false;
                var add = roster?.GetType().GetMethod("Add");
                if (add != null)
                {
                    try { add.Invoke(roster, new[] { officer }); added = true; }
                    catch (Exception ex) { report["addError"] = (ex.InnerException ?? ex).Message; }
                }
                report["added"] = added;

                // The game's own UI listens for this; without it the crew screens keep the old roster on screen.
                var crewData = VG.Game.GameMembers.FindType("Source.Personnel.CrewData");
                var notify = crewData?.GetMethod("NotifyOfficerChanged",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                try { notify?.Invoke(null, null); } catch { /* cosmetic: the hire already happened */ }

                var after = Compat.Enumerate(roster).Count();
                report["hired"] = after > before;                  // did the roster actually grow?

                // A HALF-DONE HIRE IS PUT BACK. If the roster did not grow we have taken a recruit off the station
                // and possibly charged for them, which is worse than refusing the click: return both.
                if (after <= before)
                {
                    var centreList = Compat.Get(centre, "officers");
                    var back = centreList?.GetType().GetMethod("Add");
                    try { back?.Invoke(centreList, new[] { officer }); report["restored"] = back != null; }
                    catch { report["restored"] = false; }
                    if (paid)
                    {
                        var refunded = VG.Game.Wallet.SetBalance(GamePlayer.current,
                            Compat.Get<long>(GamePlayer.current, "credits", 0L) + cost);
                        report["refunded"] = refunded;
                    }
                    report["error"] = "the game accepted the calls but the roster did not change; "
                                      + "the recruit and any credits were put back";
                    return new Api.Result(500, report);
                }
                report["rosterBefore"] = before;
                report["rosterAfter"] = after;
                report["creditsAfter"] = Compat.Get<long>(GamePlayer.current, "credits", 0L);
                if (after > before)
                    Notify.Transaction("hire",
                        $"signed on {Compat.Get<string>(officer, "name", "a new officer")} for {cost:N0} cr.",
                        "Your personnel officer");
                return Api.Result.Ok(report);
            }
            catch (Exception ex)
            {
                report["error"] = (ex.InnerException ?? ex).Message;
                return new Api.Result(500, report);
            }
        });
    }
}
