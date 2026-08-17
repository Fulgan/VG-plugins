using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using BepInEx;

namespace Hypercom
{
    // Minimal HTTP/1.1 server over a loopback-only TcpListener. No HttpListener → no Windows
    // urlacl/admin requirement. Requests need a matching X-Auth-Token header, except CORS
    // preflight (OPTIONS) and SSE (/events, token via query). Socket threads never touch game state
    // directly — handlers marshal via MainThread.Run.
    internal sealed class HttpServer
    {
        private const int MaxBodyBytes = 1 << 20; // 1 MiB request-body cap

        private int _port;
        private string _token;
        private bool _requireAuth;
        private bool _allowRemote;
        private TcpListener _listener;
        private Thread _acceptThread;
        private volatile bool _running;

        internal HttpServer(int port, bool requireAuth, bool allowRemote)
        {
            _port = port;
            _allowRemote = allowRemote;
            // A remote bind forces auth ON, unconditionally and HERE. `Restart` already did this internally while
            // the constructor trusted its caller to have done it — the same safety rule in two places, one of
            // which a future second caller could simply forget, and the cost of forgetting is inventory control
            // exposed to the LAN with no token.
            _requireAuth = requireAuth || allowRemote;
            _token = LoadOrCreateToken(); // always written, so it's ready if RequireAuth is turned on
        }

        internal bool Running => _running;
        internal string Token => _token;
        // The local browser always reaches the server on loopback, even when also bound wider.
        internal string LocalUrl => $"http://127.0.0.1:{_port}/";

        // The address a PHONE has to use. Loopback is the one answer that certainly does not work there, so the
        // pairing panel needs the machine's LAN address — computed, never hardcoded, and overridable because no
        // amount of probing beats a player who knows their own network.
        internal string LanUrl => $"http://{LanAddress()}:{_port}/";

        // The pairing URL, code included. `#/pair?c=` keeps the code in the FRAGMENT, which browsers do not send
        // to any server and which does not land in an access log.
        internal string PairUrl(string code) => $"{LanUrl}#/pair?c={code}";

        // The same enrolment link aimed at THIS machine's browser. A pairing code in the URL is what saves the
        // player from copying a token by hand: the page claims it before its first render and stores the device
        // token it gets back (see `src/pair.ts`).
        internal string LocalPairUrl(string code) => $"{LocalUrl}#/pair?c={code}";

        // Whether a caller needs a token. Drives the enrolment link: without auth there is nothing to enrol.
        internal bool RequiresAuth => _requireAuth;

        // Override, then the routed address, then anything else plausible.
        internal string LanAddress()
        {
            if (!string.IsNullOrEmpty(PairHostOverride)) return PairHostOverride;
            var candidates = LanCandidates();
            return candidates.Count > 0 ? candidates[0].Address : "127.0.0.1";
        }

        internal static string PairHostOverride;

        // Ask the OS which local address it WOULD route from, by "connecting" a UDP socket to an address nobody
        // answers. UDP connect sends no packet — it only fixes the local endpoint — so this needs no network and
        // no permission, and unlike enumerating adapters it cannot pick the Hyper-V, WSL or VPN interface on a
        // machine that has several.
        private static string RoutedAddress()
        {
            try
            {
                using (var socket = new System.Net.Sockets.Socket(
                    System.Net.Sockets.AddressFamily.InterNetwork,
                    System.Net.Sockets.SocketType.Dgram,
                    System.Net.Sockets.ProtocolType.Udp))
                {
                    // Reserved documentation address (RFC 5737): guaranteed to be someone else's problem.
                    socket.Connect("203.0.113.1", 65530);
                    var local = socket.LocalEndPoint as System.Net.IPEndPoint;
                    var ip = local?.Address?.ToString();
                    return string.IsNullOrEmpty(ip) || ip == "0.0.0.0" ? null : ip;
                }
            }
            catch { return null; }
        }

        // One address the UI can offer, with the adapter it belongs to. The label is the point: a machine with
        // Tailscale, a VPN, WSL and two NICs has half a dozen candidates and only the player knows which one
        // their phone can reach — "100.76.91.86 (Tailscale)" is answerable, a bare IP is a guess.
        internal sealed class NetAddress
        {
            internal string Address;
            internal string Label;
            internal bool OffLan;   // reachable from outside this network (a tailnet address)
            public override string ToString() => Address;
        }

        // A CGNAT address (100.64.0.0/10) on this machine means a mesh VPN — Tailscale and friends live there.
        // Worth knowing because it is the one candidate that keeps working when the phone is NOT on this
        // network, which is exactly when a LAN address silently fails.
        private static bool IsCgnat(byte[] b) => b[0] == 100 && b[1] >= 64 && b[1] <= 127;

        // Every address a phone could plausibly use, best first.
        //
        // Enumerated per ADAPTER rather than through `Dns.GetHostAddresses`, which reports a bare list with no
        // clue which entry is a tunnel, a hypervisor bridge or a dead NIC. Ordering: the address this box would
        // route from (the usual answer on one LAN), then any tailnet address, then the rest — with virtual
        // adapters last, since a WSL or Hyper-V address reaches nothing outside this PC.
        internal static List<NetAddress> LanCandidates()
        {
            var routed = RoutedAddress();
            var found = new List<NetAddress>();
            try
            {
                foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;
                    foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        var bytes = ua.Address.GetAddressBytes();
                        // 169.254.* is what an adapter gets when DHCP failed: it reaches nothing.
                        if (bytes[0] == 127 || (bytes[0] == 169 && bytes[1] == 254)) continue;
                        var text = ua.Address.ToString();
                        if (found.Exists(a => a.Address == text)) continue;
                        found.Add(new NetAddress { Address = text, Label = ni.Name, OffLan = IsCgnat(bytes) });
                    }
                }
            }
            catch { /* an adapter that cannot be read just means fewer candidates */ }

            var virt = new Func<NetAddress, bool>(a =>
                a.Label.IndexOf("WSL", StringComparison.OrdinalIgnoreCase) >= 0
                || a.Label.IndexOf("Hyper-V", StringComparison.OrdinalIgnoreCase) >= 0
                || a.Label.IndexOf("vEthernet", StringComparison.OrdinalIgnoreCase) >= 0
                || a.Label.IndexOf("Bluetooth", StringComparison.OrdinalIgnoreCase) >= 0);

            var ordered = new List<NetAddress>();
            var pick = new Action<Func<NetAddress, bool>>(match =>
            {
                foreach (var a in found)
                    if (match(a) && !ordered.Contains(a)) ordered.Add(a);
            });
            pick(a => a.Address == routed && !virt(a));
            pick(a => a.OffLan);
            pick(a => !virt(a));
            pick(_ => true);
            return ordered;
        }

        // Addresses only — kept for callers that just want the strings.
        internal static List<string> LanAddresses()
        {
            var result = new List<string>();
            foreach (var a in LanCandidates()) result.Add(a.Address);
            return result;
        }

        // A string field out of a parsed request body, or null. Local to this file so the pre-auth claim route
        // does not have to reach into Api's helpers.
        private static string BodyString(Dictionary<string, object> body, string key) =>
            body != null && body.TryGetValue(key, out var v) ? v as string : null;

        // One place that decides whether a token is good: the master token OR any paired device's. Two
        // comparison sites is how one of them ends up not accepting device tokens, or not being fixed-time.
        private bool IsValidToken(string token) =>
            Pairing.FixedTimeEquals(token, _token) || Pairing.IsDeviceToken(token);

        internal void Start()
        {
            _listener = CreateListener();
            _listener.Start();
            _running = true;
            _acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "Hypercom-accept" };
            _acceptThread.Start();
            var scope = _allowRemote ? "0.0.0.0 (LAN — token required)" : "127.0.0.1";
            Plugin.Log.LogInfo($"Hypercom listening on {scope}:{_port} (token in BepInEx/config/{TokenFileName})");
        }

        // The listener. Dual-stack ONLY for a LAN bind, and that distinction is load-bearing:
        //
        //   remote   `IPv6Any` + `DualMode` accepts both families on one socket, which is what a phone needs —
        //            a mesh VPN hands out an IPv4 and an IPv6 address for this PC and iOS prefers the IPv6 one,
        //            so an IPv4-only listener is silently unreachable there.
        //   loopback IPv4 `127.0.0.1`, because `DualMode` does NOT make a socket bound to a SPECIFIC address
        //            answer the other family: bound to `::1`, an IPv4 loopback connection arrives as
        //            `::ffff:127.0.0.1` and is refused. Binding `IPv6Any` instead would open every interface,
        //            which is exactly what the loopback default exists to prevent. `LocalUrl` is
        //            127.0.0.1, so this is the address every local client actually uses.
        private TcpListener CreateListener()
        {
            if (!_allowRemote) return new TcpListener(IPAddress.Loopback, _port);
            if (Socket.OSSupportsIPv6)
            {
                try
                {
                    var listener = new TcpListener(IPAddress.IPv6Any, _port);
                    listener.Server.DualMode = true;   // must be set before Start()
                    return listener;
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogWarning($"IPv6 listener unavailable ({ex.Message}); IPv4 only");
                }
            }
            return new TcpListener(IPAddress.Any, _port);
        }

        internal void Stop()
        {
            _running = false;
            try { _listener?.Stop(); } catch { }   // unblocks AcceptTcpClient so the accept thread exits
            try { _acceptThread?.Join(200); } catch { } // brief, bounded — thread is background anyway
            _listener = null;
            _acceptThread = null;
        }

        // Apply changed bind/port/auth live by rebinding. Remote bind forces auth on (never expose
        // the server to the LAN without a token). Token is preserved.
        internal void Restart(int port, bool requireAuth, bool allowRemote)
        {
            Stop();
            _port = port;
            _allowRemote = allowRemote;
            _requireAuth = requireAuth || allowRemote;
            try { Start(); }
            catch (Exception ex) { Plugin.Log.LogError($"Hypercom restart failed: {ex.Message}"); }
        }

        // Roll a fresh token (written to the token file). Takes effect immediately for new requests.
        internal void RegenerateToken()
        {
            _token = Guid.NewGuid().ToString("N");
            try { System.IO.File.WriteAllText(TokenPath, _token); }
            catch (Exception ex) { Plugin.Log.LogWarning($"could not persist regenerated token: {ex.Message}"); }
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client = null;
                try { client = _listener.AcceptTcpClient(); }
                catch { if (!_running) break; continue; }
                if (client != null)
                {
                    var c = client;
                    ThreadPool.QueueUserWorkItem(_ => Handle(c));
                }
            }
        }

        private void Handle(TcpClient client)
        {
            try
            {
                using (client)
                using (var stream = client.GetStream())
                {
                    stream.ReadTimeout = 15000;
                    stream.WriteTimeout = 15000;

                    if (!TryReadRequest(stream, out var method, out var path, out var query,
                            out var headers, out var body))
                    {
                        WriteResponse(stream, 400, new Dictionary<string, object> { ["error"] = "malformed request" }, null);
                        return;
                    }

                    var allowOrigin = headers.TryGetValue("Origin", out var origin) && IsLoopbackOrigin(origin)
                        ? origin : null;

                    // CORS preflight — no auth (browsers send it without custom headers).
                    if (method == "OPTIONS")
                    {
                        WritePreflight(stream, allowOrigin);
                        return;
                    }

                    // Pairing claim — the ONE unauthenticated mutation, and it has to be: a phone that has
                    // never paired holds no token. It trades a live, single-use code for a device token, so
                    // what it grants is bounded by what the player put on screen. It sits HERE rather than in
                    // `Route`, which runs behind the 401 and so could never answer an unpaired phone.
                    if (method == "POST" && path == "/pair/claim")
                    {
                        var claim = Json.ParseObject(body);
                        var claimed = Pairing.Claim(BodyString(claim, "code"), BodyString(claim, "label"));
                        if (claimed.Ok)
                            WriteResponse(stream, 200, new Dictionary<string, object>
                            {
                                ["token"] = claimed.Token,
                                ["label"] = claimed.Label,
                            }, allowOrigin);
                        else
                            WriteResponse(stream, 403, new Dictionary<string, object> { ["error"] = claimed.Error }, allowOrigin);
                        return;
                    }

                    // SSE feed — token via query, because EventSource can't set request headers.
                    if (method == "GET" && path == "/events")
                    {
                        if (RejectQueryToken(stream, query, allowOrigin)) return;
                        StreamEvents(stream, allowOrigin); // blocks until client disconnects or server stops
                        return;
                    }

                    // Ship image — binary PNG rendered from the game's ship sprite (experimental).
                    // `v` (build + ship class) makes the sprite cacheable; without it, assume the caller can't
                    // tell builds apart and keep the copy short-lived.
                    var shipV = QueryParam(query, "v");
                    if (ServePng(stream, method, path, "/ships/image", query, allowOrigin,
                                 () => Api.ShipImage(QueryParam(query, "guid"), shipV), "no ship image",
                                 string.IsNullOrEmpty(shipV) ? ShortImageCache : LongImageCache)) return;

                    // Item icon — binary PNG rendered from the item's sprite, by store + key handle.
                    // `v` is an opaque cache key from the client (the item name): it makes the URL change
                    // whenever the icon would, so both this server and the browser can hold onto the PNG.
                    int.TryParse(QueryParam(query, "key"), out var ikey);
                    var v = QueryParam(query, "v");
                    if (ServePng(stream, method, path, "/item/image", query, allowOrigin,
                                 () => Api.ItemImage(QueryParam(query, "store"), ikey, QueryParam(query, "slot"), v),
                                 "no item image", string.IsNullOrEmpty(v) ? ShortImageCache : LongImageCache)) return;

#if DEBUG
                    // Live object browser — DEBUG BUILDS ONLY (the whole implementation is compiled out of
                    // Release), and additionally behind the EnableDebugEndpoints flag. Read-only; see Reflect.cs.
                    if (method == "GET" && path == "/debug/reflect")
                    {
                        if (RejectQueryToken(stream, query, allowOrigin)) return;
                        if (!DebugEnabled)
                        {
                            WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "no such endpoint" }, allowOrigin);
                            return;
                        }
                        int.TryParse(QueryParam(query, "depth"), out var rdepth);
                        var rres = Reflect.Browse(QueryParam(query, "path"), rdepth);
                        WriteResponse(stream, rres.Status, rres.Body, allowOrigin);
                        return;
                    }
#endif

                    // Officer portrait — binary PNG. Token via query, because <img> can't set headers
                    // (like SSE). Low-sensitivity image; the roster names stay header-gated below.
                    // Faction badge PNG — same art the in-game map uses. Token via query, like other <img> sources.
                    if (ServePng(stream, method, path, "/factions/icon", query, allowOrigin,
                                 () => Api.FactionIcon(QueryParam(query, "id")), "no icon", LongImageCache)) return;
                    // Aspect badge PNG, keyed by the `id` each item's aspect entry carries.
                    if (ServePng(stream, method, path, "/item/icon", query, allowOrigin,
                                 () => Api.ItemIconById(QueryParam(query, "id")), "no item icon", LongImageCache)) return;

                    if (ServePng(stream, method, path, "/aspects/icon", query, allowOrigin,
                                 () => Api.AspectIcon(QueryParam(query, "id")), "no icon", LongImageCache)) return;
                    // A portrait is fixed per guid/icon, so it caches long.
                    if (ServePng(stream, method, path, "/officers/portrait", query, allowOrigin,
                                 () => Api.OfficerPortrait(QueryParam(query, "guid"), QueryParam(query, "icon")),
                                 "no portrait", LongImageCache)) return;

                    // Static web UI (bundled next to the DLL in Release builds). Served without auth —
                    // it's only the app shell; the token still gates every data/API call below. Absent
                    // in Debug builds: run the UI via Vite (`npm run dev`) pointed at this server.
                    if (method == "GET" && !IsApiGet(path))
                    {
                        ServeStatic(stream, path, allowOrigin);
                        return;
                    }

                    // Everything else: header auth, when enabled.
                    headers.TryGetValue("x-auth-token", out var token);
                    if (_requireAuth && !IsValidToken(token))
                    {
                        WriteResponse(stream, 401, new Dictionary<string, object> { ["error"] = "bad or missing X-Auth-Token" }, allowOrigin);
                        return;
                    }

                    // Names this request in the main-thread stall warning, and in the oversized-payload one.
                    MainThread.Route = method + " " + path;
                    var result = Route(method, path, query, body);
                    WriteResponse(stream, result.Status, result.Body, allowOrigin);
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"request handling failed: {ex.Message}");
            }
        }

        // GET paths handled by the API/SSE (everything else GET is treated as a static UI request).
        private static readonly HashSet<string> ApiGetPaths = new HashSet<string>
        {
            "/status", "/inventories", "/shops", "/loadout", "/ships", "/officers", "/recruits", "/log", "/events",
            "/loadout/presets", "/loadout/presets/orphans", "/loadout/presets/export",
            "/catalog/equipment", "/catalog/types", "/catalog/prefabs", "/catalog/ships", "/catalog/aspects", "/ship/layout", "/ship/vitals", "/stat/sources", "/skills", "/reputation", "/reputation/log", "/client/state", "/galaxy", "/cycles", "/materials", "/ledger",
            "/missions/log", "/arena/probe", "/arena/vectors", "/ship/turrets/attack", "/combat/log",
        };
        /// <summary>
        /// Whether a GET is an API call at all — and therefore the SECOND place every GET endpoint is registered.
        ///
        /// ⚠ A path missing here never reaches `Route`: it is treated as a UI path, and the SPA fallback answers an
        /// extension-less unknown route with `index.html` and a 200. So the failure of forgetting this list is an
        /// endpoint that returns the app shell instead of JSON — no error anywhere, and a client that "works" until
        /// it parses the body. Add a GET route in BOTH places.
        /// </summary>
        private static bool IsApiGet(string path) => ApiGetPaths.Contains(path);

        // Set from the hidden Debug/EnableDebugEndpoints config flag. When false, debug endpoints 404
        // exactly like unknown paths — invisible in the public plugin.
        internal static bool DebugEnabled;
        private static readonly HashSet<string> DebugPaths = new HashSet<string> { "/catalog/equipment", "/catalog/prefabs", "/catalog/ships", "/catalog/aspects", "/arena/probe", "/arena/vectors", "/ship/turrets/attack", "/combat/log" };

        private static Api.Result Route(string method, string path, string query, string body)
        {
            try
            {
                if (DebugPaths.Contains(path) && !DebugEnabled)
                    return Api.Result.Err(404, "no such endpoint");
                switch (method + " " + path)
                {
                    case "GET /status": return Api.Status();
                    case "GET /inventories": return Api.Inventories(QueryParam(query, "fresh") != null);
                    case "GET /shops": return Api.Shops(QueryParam(query, "buyback") != null, QueryParam(query, "fresh") != null);
                    // The mission history. `since` is an ISO timestamp ∴ a client polls for what it has not
                    // seen rather than re-reading a playthrough's whole log (the `/ledger` scoping, one param over).
                    case "GET /missions/log":
                    {
                        var mpt = QueryParam(query, "playthrough");
                        var mscope = mpt == "all" ? null : (string.IsNullOrEmpty(mpt) ? Api.CurrentPlaythrough() : mpt);
                        return Api.Result.Ok(MissionLog.Dto(QueryParam(query, "since"), mscope,
                            int.TryParse(QueryParam(query, "limit"), out var ml) ? ml : 500));
                    }
                    case "GET /loadout": return Api.Loadout();
                    case "GET /ships": return Api.Ships();
                    case "GET /officers": return Api.Officers();
                    case "GET /recruits": return Api.Recruits();
                    case "GET /catalog/equipment": return Api.EquipmentCatalog();
                    case "GET /catalog/types": return Api.CatalogTypes();
                    case "GET /catalog/prefabs": return Api.CatalogPrefabs();
                    case "GET /catalog/aspects": return Catalog.AspectsDto();
                    case "GET /catalog/ships": return Api.CatalogShips();
                    case "GET /arena/probe":
                        return Arena.Probe(QueryParam(query, "hull"), QueryParam(query, "type"), QueryParam(query, "amount"), QueryParam(query, "rank"), QueryParam(query, "level"));
                    case "GET /ship/layout": return Api.ShipLayout(QueryParam(query, "guid"));
                    case "GET /ship/vitals": return Api.Vitals();
                    case "GET /arena/vectors":
                        return Arena.Vectors(QueryParam(query, "hull"), QueryParam(query, "amount"));
                    case "GET /ship/turrets/attack": return TurretAttack.Dto();
                    case "GET /combat/log": return CombatLog.Dto(QueryParam(query, "clear") != null);
                    case "GET /stat/sources": return Api.StatSources(QueryParam(query, "stat"));
                    case "GET /skills": return Api.Skills();
                    case "GET /reputation": return Reputation.Dto();
                    case "GET /reputation/log":
                        return RepLog.Dto(long.TryParse(QueryParam(query, "since"), out var repSince) ? repSince : 0L);
                    case "GET /log": return Api.Log();
                    // Persisted purchase/sale history. Scoped to one playthrough by default so a reloaded save
                    // shows its own spending; `?playthrough=all` reads the whole file.
                    case "GET /ledger":
                    {
                        var pt = QueryParam(query, "playthrough");
                        var scope = pt == "all" ? null : (string.IsNullOrEmpty(pt) ? Api.CurrentPlaythrough() : pt);
                        return Api.Result.Ok(Ledger.Dto(
                            int.TryParse(QueryParam(query, "limit"), out var lim) ? lim : 200, scope));
                    }
                    case "POST /ledger/clear":
                    {
                        var pt = QueryParam(query, "playthrough");
                        var scope = pt == "all" ? null : (string.IsNullOrEmpty(pt) ? Api.CurrentPlaythrough() : pt);
                        return Api.Result.Ok(new Dictionary<string, object> { ["cleared"] = Ledger.Clear(scope) });
                    }
                    case "POST /move": return Api.Move(Json.ParseObject(body));
                    case "POST /sell": return Api.Sell(Json.ParseObject(body));
                    case "POST /buy": return Api.Buy(Json.ParseObject(body));
                    case "POST /loadout/apply": return Api.LoadoutApply(Json.ParseObject(body));
                    case "POST /loadout/undo": return Api.LoadoutUndo();
                    case "GET /loadout/presets": return Api.PresetsList();
                    case "GET /loadout/presets/orphans": return Api.PresetsOrphans();
                    case "POST /loadout/presets/save": return Api.PresetSave(Json.ParseObject(body));
                    case "POST /loadout/presets/restore": return Api.PresetRestore(Json.ParseObject(body));
                    case "POST /loadout/presets/delete": return Api.PresetDelete(Json.ParseObject(body));
                    case "POST /loadout/presets/claim": return Api.PresetClaim(Json.ParseObject(body));
                    case "GET /loadout/presets/export": return Api.PresetsExport();
                    case "POST /loadout/presets/import": return Api.PresetsImport(Json.ParseObject(body));
                    case "POST /playthrough/name": return Api.PlaythroughName(Json.ParseObject(body));
                    // ?pois=<systemGuid> fetches one system's POIs on demand — they're ~95% of the
                    // walk, and the map itself only needs systems + gates. ?fresh=1 bypasses the short TTL.
                    case "GET /galaxy": return Galaxy.Dto(QueryParam(query, "pois"), QueryParam(query, "fresh") != null);
                    // The three refresh cycles ALONE. `/galaxy` carries the same figures, but it is a whole
                    // galaxy — every system, station and faction — and a header strip that polls it to show
                    // three countdowns would fetch ~100x what it renders.
                    case "GET /cycles": return Api.Cycles();
                    // Where every material is stored, across every station in a visited subsector.
                    case "GET /materials": return Materials.Dto(QueryParam(query, "fresh") != null);
                    case "GET /client/state": return Api.ClientStateGet();
                    case "POST /client/state": return Api.ClientStatePut(Json.ParseObject(body));
                    case "POST /client/state/clear": return Api.ClientStateClear(Json.ParseObject(body));
                    case "POST /images/purge": return Api.PurgeImages();
                    // Hire a recruit from the docked station's Personnel Center. `dryRun: true` reports
                    // what it would call and what it would cost without touching anything.
                    case "POST /officers/hire": return Hiring.Hire(Json.ParseObject(body));
                    default: return Api.Result.Err(404, "no such endpoint");
                }
            }
            catch (FormatException fe)
            {
                return Api.Result.Err(400, "bad JSON: " + fe.Message);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"handler {method} {path} threw: {ex}");
                return Api.Result.Err(500, "internal error");
            }
        }

        // ---- SSE ----

        private void StreamEvents(NetworkStream stream, string allowOrigin)
        {
            var client = EventBus.Register();
            try
            {
                var sb = new StringBuilder();
                sb.Append("HTTP/1.1 200 OK\r\n");
                sb.Append("Content-Type: text/event-stream; charset=utf-8\r\n");
                sb.Append("Cache-Control: no-cache\r\n");
                AppendCors(sb, allowOrigin);
                sb.Append("Connection: keep-alive\r\n\r\n");
                if (!WriteRaw(stream, sb.ToString()))
                    return;
                if (!WriteRaw(stream, ": connected\n\n"))
                    return;

                while (_running)
                {
                    // Wake at least every 15s to send a keep-alive comment (and re-check _running).
                    if (client.Queue.TryTake(out var frame, 15000))
                    {
                        if (!WriteRaw(stream, frame)) break;
                    }
                    else if (!WriteRaw(stream, ": ping\n\n"))
                    {
                        break;
                    }
                }
            }
            catch { /* client vanished */ }
            finally { EventBus.Unregister(client); }
        }

        private static bool WriteRaw(NetworkStream stream, string text)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(text);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
                return true;
            }
            catch { return false; }
        }

        // ---- raw HTTP parsing ----

        private static bool TryReadRequest(NetworkStream stream, out string method, out string path,
            out string query, out Dictionary<string, string> headers, out string body)
        {
            method = path = query = body = null;
            headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            var head = ReadHead(stream);
            if (string.IsNullOrEmpty(head))
                return false;

            var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
            var requestLine = lines[0].Split(' ');
            if (requestLine.Length < 2)
                return false;
            method = requestLine[0].ToUpperInvariant();
            var target = requestLine[1];
            var q = target.IndexOf('?');
            if (q >= 0) { path = target.Substring(0, q); query = target.Substring(q + 1); }
            else { path = target; query = ""; }

            for (var i = 1; i < lines.Length; i++)
            {
                var line = lines[i];
                if (line.Length == 0) continue;
                var colon = line.IndexOf(':');
                if (colon <= 0) continue;
                headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim();
            }

            // Chunked bodies (e.g. some HTTP clients) or Content-Length bodies.
            if (headers.TryGetValue("Transfer-Encoding", out var te)
                && te.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                body = ReadChunkedBody(stream);
                return body != null;
            }

            var length = 0;
            if (headers.TryGetValue("Content-Length", out var cl))
                int.TryParse(cl, out length);
            if (length > MaxBodyBytes)
                return false;

            body = length > 0 ? ReadBody(stream, length) : "";
            return true;
        }

        // Read bytes until the CRLFCRLF header terminator; return the header block as text.
        private static string ReadHead(NetworkStream stream)
        {
            var buf = new List<byte>(1024);
            var window = 0; // trailing \r\n\r\n state machine
            while (buf.Count < 64 * 1024)
            {
                int b;
                try { b = stream.ReadByte(); }
                catch { break; }
                if (b < 0) break;
                buf.Add((byte)b);
                switch (window)
                {
                    case 0: window = b == '\r' ? 1 : 0; break;
                    case 1: window = b == '\n' ? 2 : (b == '\r' ? 1 : 0); break;
                    case 2: window = b == '\r' ? 3 : 0; break;
                    case 3:
                        if (b == '\n') return Encoding.UTF8.GetString(buf.ToArray());
                        window = 0;
                        break;
                }
            }
            return buf.Count > 0 ? Encoding.UTF8.GetString(buf.ToArray()) : null;
        }

        private static string ReadBody(NetworkStream stream, int length)
        {
            var buf = new byte[length];
            var read = 0;
            while (read < length)
            {
                int n;
                try { n = stream.Read(buf, read, length - read); }
                catch { break; }
                if (n <= 0) break;
                read += n;
            }
            return Encoding.UTF8.GetString(buf, 0, read);
        }

        // Transfer-Encoding: chunked — [hex-size CRLF][data CRLF]... terminated by a 0-size chunk.
        private static string ReadChunkedBody(NetworkStream stream)
        {
            var body = new List<byte>();
            while (body.Count <= MaxBodyBytes)
            {
                var sizeLine = ReadLine(stream);
                if (sizeLine == null) return null;
                var semi = sizeLine.IndexOf(';'); // chunk extensions, ignored
                if (semi >= 0) sizeLine = sizeLine.Substring(0, semi);
                if (!int.TryParse(sizeLine.Trim(), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var size))
                    return null;
                if (size == 0)
                {
                    ReadLine(stream); // trailing CRLF after the final chunk
                    return Encoding.UTF8.GetString(body.ToArray());
                }
                var chunk = new byte[size];
                var read = 0;
                while (read < size)
                {
                    int n;
                    try { n = stream.Read(chunk, read, size - read); }
                    catch { return null; }
                    if (n <= 0) return null;
                    read += n;
                }
                body.AddRange(chunk);
                ReadLine(stream); // CRLF after chunk data
            }
            return null;
        }

        private static string ReadLine(NetworkStream stream)
        {
            var buf = new List<byte>(16);
            while (true)
            {
                int b;
                try { b = stream.ReadByte(); }
                catch { return null; }
                if (b < 0) return buf.Count > 0 ? Encoding.UTF8.GetString(buf.ToArray()) : null;
                if (b == '\n') return Encoding.UTF8.GetString(buf.ToArray()).TrimEnd('\r');
                buf.Add((byte)b);
            }
        }

        // ---- responses ----

        // Cache policies for the binary image endpoints. Icons/portraits are immutable for a given cache
        // key, so the browser may keep them for a day — before this, every tooltip hover refetched the
        // PNG and made the game re-render the sprite, which is what made tooltips feel slow to draw.
        // Anything re-rendered from live state (the ship image) gets the short policy instead.
        // ONE owner for every rendered-PNG route. Six of these existed as near-identical eight-line blocks
        // (ship, item-by-slot, item-by-id, faction, aspect, portrait), each repeating the query-token gate, the
        // 404 body shape, the content type and the cache header — so a change to any of those had to be made six
        // times, and in practice would be made once.
        //
        // Token via QUERY, not a header: every one of these is an `<img src>`, and an <img> cannot set headers.
        // Returns true when it handled the route, so a caller reads `if (ServePng(...)) return;`.
        private bool ServePng(NetworkStream stream, string method, string path, string route,
                                     string query, string allowOrigin,
                                     Func<byte[]> render, string notFound, string cacheControl)
        {
            if (method != "GET" || path != route) return false;
            if (RejectQueryToken(stream, query, allowOrigin)) return true;
            var png = render();
            if (png == null)
                WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = notFound }, allowOrigin);
            else
                WriteBytes(stream, 200, "image/png", png, allowOrigin, cacheControl);
            return true;
        }

        private const string LongImageCache = "public, max-age=86400, immutable";
        private const string ShortImageCache = "public, max-age=60";

        private static readonly Dictionary<int, string> Reasons = new Dictionary<int, string>
        {
            [200] = "OK", [204] = "No Content", [400] = "Bad Request", [401] = "Unauthorized",
            [403] = "Forbidden", [404] = "Not Found", [409] = "Conflict", [500] = "Internal Server Error",
        };

        // Untranslated localization keys emitted to a client, reported ONCE per field+key. Ammo names shipped as
        // `@RailcannonAmmo` through four endpoints before a player noticed; a leak that announces
        // itself in the log costs one line here and saves the next one being found by eye in the UI.
        private static readonly HashSet<string> _keyLeaks = new HashSet<string>();
        private static readonly System.Text.RegularExpressions.Regex KeyLeak =
            new System.Text.RegularExpressions.Regex("\"([A-Za-z]+)\":\"(@[^\"]+)\"",
                System.Text.RegularExpressions.RegexOptions.Compiled);

        private static void WarnOnKeyLeaks(string json)
        {
            try
            {
                foreach (System.Text.RegularExpressions.Match m in KeyLeak.Matches(json))
                {
                    var seen = m.Groups[1].Value + "=" + m.Groups[2].Value;
                    lock (_keyLeaks)
                    {
                        if (_keyLeaks.Count > 200 || !_keyLeaks.Add(seen)) continue;
                    }
                    Plugin.Log.LogWarning($"untranslated key sent to a client: \"{m.Groups[1].Value}\": \"{m.Groups[2].Value}\" — route it through ItemNames/Translate (V56)");
                }
            }
            catch { }
        }

        // A response big enough to be worth reporting: serialising it costs real time, and the size grows with
        // the playthrough rather than with anything a fresh save would show.
        private const int BigBodyBytes = 1 << 20; // 1 MiB

        private static void WriteResponse(NetworkStream stream, int status, object body, string allowOrigin)
        {
            // Timed because this half runs on the CONNECTION's thread while the main-thread half runs inside a
            // frame: separating them is what says whether a slow route is stalling the game or only the client.
            var t0 = Stopwatch.GetTimestamp();
            var text = Json.Write(body);
            var serMs = (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency;
            WarnOnKeyLeaks(text);
            var json = Encoding.UTF8.GetBytes(text);
            if (json.Length >= BigBodyBytes)
                Plugin.Log.LogWarning($"{MainThread.Route ?? "?"} served {json.Length / 1024 / 1024.0:F1} MB, " +
                                      $"serialised off-thread in {serMs:F0}ms");
            var reason = Reasons.TryGetValue(status, out var r) ? r : "Status";
            var sb = new StringBuilder();
            sb.Append($"HTTP/1.1 {status} {reason}\r\n");
            sb.Append("Content-Type: application/json; charset=utf-8\r\n");
            sb.Append($"Content-Length: {json.Length}\r\n");
            AppendCors(sb, allowOrigin);
            sb.Append("Connection: close\r\n\r\n");
            try
            {
                var header = Encoding.UTF8.GetBytes(sb.ToString());
                stream.Write(header, 0, header.Length);
                stream.Write(json, 0, json.Length);
                stream.Flush();
            }
            catch { }
        }

        private static void WritePreflight(NetworkStream stream, string allowOrigin)
        {
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 204 No Content\r\n");
            AppendCors(sb, allowOrigin);
            sb.Append("Content-Length: 0\r\n");
            sb.Append("Connection: close\r\n\r\n");
            WriteRaw(stream, sb.ToString());
        }

        // CORS only for loopback origins; no Allow-Origin header for anything else.
        private static void AppendCors(StringBuilder sb, string allowOrigin)
        {
            if (allowOrigin == null) return;
            sb.Append($"Access-Control-Allow-Origin: {allowOrigin}\r\n");
            sb.Append("Access-Control-Allow-Headers: X-Auth-Token, Content-Type\r\n");
            sb.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        }

        // Whether an `Origin` may be echoed back in `Access-Control-Allow-Origin`. Matched on the PARSED HOST
        // against an exact set — a prefix test on the origin string accepts `http://localhost.evil.com`, and
        // echoing that back lets such a page READ every reply cross-origin (inventory, credits, shop), which
        // with the default `RequireAuth` off needs no token at all.
        private static readonly HashSet<string> LoopbackHosts =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "::1", "[::1]" };

        private static bool IsLoopbackOrigin(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return false;
            // A relative or malformed value is not an origin; `Uri` decides that, not string inspection.
            if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
            return LoopbackHosts.Contains(uri.Host);
        }

        // Query-string token auth for the paths that can't send headers (<img>, EventSource). Writes a
        // 401 and returns true when the request must be rejected; false to proceed. One place instead of
        // the same guard copy-pasted at each such route.
        private bool RejectQueryToken(System.Net.Sockets.NetworkStream stream, string query, string allowOrigin)
        {
            if (!_requireAuth || IsValidToken(QueryParam(query, "token"))) return false;
            WriteResponse(stream, 401, new Dictionary<string, object> { ["error"] = "bad or missing token" }, allowOrigin);
            return true;
        }

        private static string QueryParam(string query, string name)
        {
            if (string.IsNullOrEmpty(query)) return null;
            foreach (var pair in query.Split('&'))
            {
                var eq = pair.IndexOf('=');
                if (eq <= 0) continue;
                if (Uri.UnescapeDataString(pair.Substring(0, eq)) == name)
                    return Uri.UnescapeDataString(pair.Substring(eq + 1));
            }
            return null;
        }

        // ---- static web UI ----

        // A UI is embedded on Release builds. The plugin checks this to decide whether to auto-open a
        // browser — Debug builds embed nothing and use Vite instead.
        internal static bool UiBundled => WebUi.Bundled;

        private void ServeStatic(NetworkStream stream, string path, string allowOrigin)
        {
            try
            {
                if (!WebUi.Bundled)
                {
                    WriteResponse(stream, 404,
                        new Dictionary<string, object> { ["error"] = "web UI not bundled; run it via Vite in dev" }, allowOrigin);
                    return;
                }

                var rel = Uri.UnescapeDataString(path.TrimStart('/'));
                if (rel.Length == 0) rel = "index.html";

                // No traversal guard is needed and none would help: the path is a lookup key into the embedded
                // set, so a name outside it simply does not resolve.
                var bytes = WebUi.Read(rel);
                if (bytes == null)
                {
                    // SPA fallback: an extension-less unknown route serves index.html (client routing);
                    // a missing asset (has an extension) is a real 404.
                    if (System.IO.Path.HasExtension(rel))
                    {
                        WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "not found" }, allowOrigin);
                        return;
                    }
                    rel = "index.html";
                    bytes = WebUi.Read(rel);
                    if (bytes == null)
                    {
                        WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "not found" }, allowOrigin);
                        return;
                    }
                }

                WriteBytes(stream, 200, ContentType(rel), bytes, allowOrigin);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"static serve failed for {path}: {ex.Message}");
                try { WriteResponse(stream, 500, new Dictionary<string, object> { ["error"] = "internal error" }, allowOrigin); }
                catch { }
            }
        }

        private static void WriteBytes(NetworkStream stream, int status, string contentType, byte[] bytes, string allowOrigin, string cacheControl = null)
        {
            var reason = Reasons.TryGetValue(status, out var r) ? r : "Status";
            var sb = new StringBuilder();
            sb.Append($"HTTP/1.1 {status} {reason}\r\n");
            sb.Append($"Content-Type: {contentType}\r\n");
            sb.Append($"Content-Length: {bytes.Length}\r\n");
            sb.Append($"Cache-Control: {cacheControl ?? "no-cache"}\r\n"); // default: avoid stale UI after a rebuild
            AppendCors(sb, allowOrigin);
            sb.Append("Connection: close\r\n\r\n");
            try
            {
                var header = Encoding.UTF8.GetBytes(sb.ToString());
                stream.Write(header, 0, header.Length);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
            catch { }
        }

        private static string ContentType(string file)
        {
            switch (System.IO.Path.GetExtension(file).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": case ".map": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".ico": return "image/x-icon";
                case ".webp": return "image/webp";
                case ".woff": return "font/woff";
                case ".woff2": return "font/woff2";
                case ".ttf": return "font/ttf";
                case ".txt": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";
            }
        }

        // ---- token ----

        private const string TokenFileName = "hypercom-token.txt";
        private static string TokenPath => System.IO.Path.Combine(Paths.ConfigPath, TokenFileName);

        private static string LoadOrCreateToken()
        {
            var path = TokenPath;
            try
            {
                if (System.IO.File.Exists(path))
                {
                    var existing = System.IO.File.ReadAllText(path).Trim();
                    if (!string.IsNullOrEmpty(existing))
                        return existing;
                }
                var token = Guid.NewGuid().ToString("N");
                System.IO.File.WriteAllText(path, token);
                return token;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"could not persist token file ({ex.Message}); using a session-only token");
                return Guid.NewGuid().ToString("N");
            }
        }
    }
}


