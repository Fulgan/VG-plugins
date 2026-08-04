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
    //   * The crew API is the most volatile part of this game — it was renamed wholesale between the
    //     0.8.0.15 release and the 0.8.1.19 beta, which is why Api.CrewSupported() exists at all. A typed
    //     reference to OfficerData would risk a TypeLoad on a version that doesn't have it.
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
            if (!Api.CrewSupported()) return Api.Result.Err(400, "crew not supported by this game version");
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

            var cost = (long)Compat.Get<int>(officer, "purchaseCost", 0);
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
                var before = Compat.Enumerate(Compat.Get(GamePlayer.current, "allOfficers")).Count();
                found.Invoke(foundTarget, new[] { officer });
                var after = Compat.Enumerate(Compat.Get(GamePlayer.current, "allOfficers")).Count();
                report["hired"] = after > before;                  // did the roster actually grow?
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
