using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using BepInEx;

namespace Hypercom
{
    // Minimal HTTP/1.1 server over a loopback-only TcpListener (V1). No HttpListener → no Windows
    // urlacl/admin requirement. Requests need a matching X-Auth-Token header (V2), except CORS
    // preflight (OPTIONS) and SSE (/events, token via query). Socket threads never touch game state
    // directly — handlers marshal via MainThread.Run (V3).
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
            _requireAuth = requireAuth;
            _allowRemote = allowRemote;
            _token = LoadOrCreateToken(); // always written, so it's ready if RequireAuth is turned on
        }

        internal bool Running => _running;
        internal string Token => _token;
        // The local browser always reaches the server on loopback, even when also bound wider.
        internal string LocalUrl => $"http://127.0.0.1:{_port}/";

        internal void Start()
        {
            _listener = new TcpListener(_allowRemote ? IPAddress.Any : IPAddress.Loopback, _port);
            _listener.Start();
            _running = true;
            _acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "Hypercom-accept" };
            _acceptThread.Start();
            var scope = _allowRemote ? "0.0.0.0 (LAN — token required)" : "127.0.0.1";
            Plugin.Log.LogInfo($"Hypercom listening on {scope}:{_port} (token in BepInEx/config/{TokenFileName})");
        }

        internal void Stop()
        {
            _running = false;
            try { _listener?.Stop(); } catch { }
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

                    // SSE feed — token via query, because EventSource can't set request headers.
                    if (method == "GET" && path == "/events")
                    {
                        if (_requireAuth && QueryParam(query, "token") != _token)
                        {
                            WriteResponse(stream, 401, new Dictionary<string, object> { ["error"] = "bad or missing token" }, allowOrigin);
                            return;
                        }
                        StreamEvents(stream, allowOrigin); // blocks until client disconnects or server stops
                        return;
                    }

                    // Ship image — binary PNG rendered from the game's ship sprite (experimental).
                    if (method == "GET" && path == "/ships/image")
                    {
                        if (_requireAuth && QueryParam(query, "token") != _token)
                        {
                            WriteResponse(stream, 401, new Dictionary<string, object> { ["error"] = "bad or missing token" }, allowOrigin);
                            return;
                        }
                        var png = Api.ShipImage(QueryParam(query, "guid"));
                        if (png == null)
                            WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "no ship image" }, allowOrigin);
                        else
                            WriteBytes(stream, 200, "image/png", png, allowOrigin);
                        return;
                    }

                    // Item icon — binary PNG rendered from the item's sprite, by store + key handle.
                    if (method == "GET" && path == "/item/image")
                    {
                        if (_requireAuth && QueryParam(query, "token") != _token)
                        {
                            WriteResponse(stream, 401, new Dictionary<string, object> { ["error"] = "bad or missing token" }, allowOrigin);
                            return;
                        }
                        int.TryParse(QueryParam(query, "key"), out var ikey);
                        var png = Api.ItemImage(QueryParam(query, "store"), ikey, QueryParam(query, "slot"));
                        if (png == null)
                            WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "no item image" }, allowOrigin);
                        else
                            WriteBytes(stream, 200, "image/png", png, allowOrigin);
                        return;
                    }

                    // Officer portrait — binary PNG. Token via query, because <img> can't set headers
                    // (like SSE). Low-sensitivity image; the roster names stay header-gated below.
                    if (method == "GET" && path == "/officers/portrait")
                    {
                        if (_requireAuth && QueryParam(query, "token") != _token)
                        {
                            WriteResponse(stream, 401, new Dictionary<string, object> { ["error"] = "bad or missing token" }, allowOrigin);
                            return;
                        }
                        var png = Api.OfficerPortrait(QueryParam(query, "guid"), QueryParam(query, "icon"));
                        if (png == null)
                            WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "no portrait" }, allowOrigin);
                        else
                            WriteBytes(stream, 200, "image/png", png, allowOrigin);
                        return;
                    }

                    // Static web UI (bundled next to the DLL in Release builds). Served without auth —
                    // it's only the app shell; the token still gates every data/API call below. Absent
                    // in Debug builds: run the UI via Vite (`npm run dev`) pointed at this server.
                    if (method == "GET" && !IsApiGet(path))
                    {
                        ServeStatic(stream, path, allowOrigin);
                        return;
                    }

                    // Everything else: header auth (V2), when enabled.
                    headers.TryGetValue("x-auth-token", out var token);
                    if (_requireAuth && token != _token)
                    {
                        WriteResponse(stream, 401, new Dictionary<string, object> { ["error"] = "bad or missing X-Auth-Token" }, allowOrigin);
                        return;
                    }

                    var result = Route(method, path, body);
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
            "/catalog/equipment", "/catalog/types", "/ship/layout",
        };
        private static bool IsApiGet(string path) => ApiGetPaths.Contains(path);

        // Set from the hidden Debug/EnableDebugEndpoints config flag. When false, debug endpoints 404
        // exactly like unknown paths — invisible in the public plugin.
        internal static bool DebugEnabled;
        private static readonly HashSet<string> DebugPaths = new HashSet<string> { "/catalog/equipment" };

        private static Api.Result Route(string method, string path, string body)
        {
            try
            {
                if (DebugPaths.Contains(path) && !DebugEnabled)
                    return Api.Result.Err(404, "no such endpoint");
                switch (method + " " + path)
                {
                    case "GET /status": return Api.Status();
                    case "GET /inventories": return Api.Inventories();
                    case "GET /shops": return Api.Shops();
                    case "GET /loadout": return Api.Loadout();
                    case "GET /ships": return Api.Ships();
                    case "GET /officers": return Api.Officers();
                    case "GET /recruits": return Api.Recruits();
                    case "GET /catalog/equipment": return Api.EquipmentCatalog();
                    case "GET /catalog/types": return Api.CatalogTypes();
                    case "GET /ship/layout": return Api.ShipLayout();
                    case "GET /log": return Api.Log();
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

        private static readonly Dictionary<int, string> Reasons = new Dictionary<int, string>
        {
            [200] = "OK", [204] = "No Content", [400] = "Bad Request", [401] = "Unauthorized",
            [403] = "Forbidden", [404] = "Not Found", [409] = "Conflict", [500] = "Internal Server Error",
        };

        private static void WriteResponse(NetworkStream stream, int status, object body, string allowOrigin)
        {
            var json = Encoding.UTF8.GetBytes(Json.Write(body));
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

        // CORS only for loopback origins (V3); no Allow-Origin header for anything else.
        private static void AppendCors(StringBuilder sb, string allowOrigin)
        {
            if (allowOrigin == null) return;
            sb.Append($"Access-Control-Allow-Origin: {allowOrigin}\r\n");
            sb.Append("Access-Control-Allow-Headers: X-Auth-Token, Content-Type\r\n");
            sb.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        }

        private static bool IsLoopbackOrigin(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return false;
            return origin.StartsWith("http://localhost", StringComparison.OrdinalIgnoreCase)
                || origin.StartsWith("http://127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || origin.StartsWith("https://localhost", StringComparison.OrdinalIgnoreCase)
                || origin.StartsWith("https://127.0.0.1", StringComparison.OrdinalIgnoreCase);
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

        private static string _uiRoot;
        private static string UiRoot => _uiRoot ??= System.IO.Path.Combine(
            System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location) ?? ".", "ui");

        // A UI is bundled (Release deploy) when its index.html is present. The plugin checks this to
        // decide whether to auto-open a browser — Debug builds have no ui/ and use Vite instead.
        internal static bool UiBundled => System.IO.File.Exists(System.IO.Path.Combine(UiRoot, "index.html"));

        private void ServeStatic(NetworkStream stream, string path, string allowOrigin)
        {
            try
            {
                if (!System.IO.Directory.Exists(UiRoot))
                {
                    WriteResponse(stream, 404,
                        new Dictionary<string, object> { ["error"] = "web UI not bundled; run it via Vite in dev" }, allowOrigin);
                    return;
                }

                var rootFull = System.IO.Path.GetFullPath(UiRoot).TrimEnd('\\', '/');
                var rel = Uri.UnescapeDataString(path.TrimStart('/'));
                if (rel.Length == 0) rel = "index.html";

                var full = System.IO.Path.GetFullPath(System.IO.Path.Combine(rootFull, rel));
                // Path-traversal guard: the resolved file must stay under the UI root.
                if (full != rootFull && !full.StartsWith(rootFull + System.IO.Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    WriteResponse(stream, 403, new Dictionary<string, object> { ["error"] = "forbidden" }, allowOrigin);
                    return;
                }

                if (!System.IO.File.Exists(full))
                {
                    // SPA fallback: an extension-less unknown route serves index.html (client routing);
                    // a missing asset (has an extension) is a real 404.
                    if (System.IO.Path.HasExtension(full))
                    {
                        WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "not found" }, allowOrigin);
                        return;
                    }
                    full = System.IO.Path.Combine(rootFull, "index.html");
                    if (!System.IO.File.Exists(full))
                    {
                        WriteResponse(stream, 404, new Dictionary<string, object> { ["error"] = "not found" }, allowOrigin);
                        return;
                    }
                }

                WriteBytes(stream, 200, ContentType(full), System.IO.File.ReadAllBytes(full), allowOrigin);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"static serve failed for {path}: {ex.Message}");
                try { WriteResponse(stream, 500, new Dictionary<string, object> { ["error"] = "internal error" }, allowOrigin); }
                catch { }
            }
        }

        private static void WriteBytes(NetworkStream stream, int status, string contentType, byte[] bytes, string allowOrigin)
        {
            var reason = Reasons.TryGetValue(status, out var r) ? r : "Status";
            var sb = new StringBuilder();
            sb.Append($"HTTP/1.1 {status} {reason}\r\n");
            sb.Append($"Content-Type: {contentType}\r\n");
            sb.Append($"Content-Length: {bytes.Length}\r\n");
            sb.Append("Cache-Control: no-cache\r\n"); // avoid stale UI after a rebuild
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
