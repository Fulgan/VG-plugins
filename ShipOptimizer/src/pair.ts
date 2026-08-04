import { api, loadConn, saveConn } from "./api";

// Claiming a pairing code, so a phone can reach the bridge without anyone typing a token on a touchscreen.
//
// The flow: the settings tab shows a QR for `http://<lan-ip>:<port>/#/pair?c=<CODE>`. The phone opens it,
// which loads the app shell from the bridge itself, and this runs BEFORE the first render — it trades the code
// for a device token and stores a conn pointing at the origin it was loaded from.
//
// Two details that matter:
//
//   The code rides in the FRAGMENT (`#/pair?c=`), which browsers never send to a server and which therefore
//   cannot show up in a log or a proxy. It is stripped from the URL as soon as it is claimed, so a reload
//   doesn't retry a spent code and the address bar stops carrying it.
//
//   The conn is derived from `location`, not from the code: the page was served BY the bridge, so its own
//   origin is the one address known to work from this device.

const CODE_PARAM = "c";

export interface PairOutcome {
  attempted: boolean;   // was there a code in the URL at all
  ok: boolean;
  label?: string;
  error?: string;
}

// Read the code out of the hash. The hash is `#/pair?c=CODE`, i.e. a path and query INSIDE the fragment, so
// it needs its own parse — `location.search` is empty here.
function codeFromHash(hash: string): string | null {
  const m = /^#\/?pair\?(.*)$/.exec(hash);
  if (!m) return null;
  const code = new URLSearchParams(m[1]).get(CODE_PARAM);
  return code && code.trim() ? code.trim() : null;
}

// A short, recognisable name for this device, for the revoke list on the PC. The full user-agent string is
// long and mostly noise, and it lands in an IMGUI label — the bridge sanitises it either way, but there
// is no reason to send 200 characters of it.
function deviceLabel(ua: string): string {
  const known = ["iPhone", "iPad", "Android", "Macintosh", "Windows", "Linux"];
  const platform = known.find((k) => ua.includes(k));
  const browser = /Firefox\/[\d.]+/.exec(ua)?.[0].split("/")[0]
    ?? (ua.includes("Edg/") ? "Edge" : ua.includes("Chrome/") ? "Chrome" : ua.includes("Safari/") ? "Safari" : null);
  return [platform, browser].filter(Boolean).join(" ") || "phone";
}

// Claim the code in the current URL, if there is one. Resolves either way — a failed pairing must still let
// the app start, showing whatever the stored conn was.
export async function claimPairingCode(): Promise<PairOutcome> {
  const code = codeFromHash(location.hash);
  if (!code) return { attempted: false, ok: false };

  // Drop the code from the URL first: it is single-use, so a retry on reload can only fail confusingly, and
  // `replaceState` keeps it out of history as well as out of the address bar.
  const clean = location.pathname + location.search;
  try { history.replaceState(null, "", clean); } catch { /* a stale hash is survivable */ }

  // Talk to the origin that served this page — that is the bridge, by construction.
  const conn = { host: location.hostname, port: location.port || "80", token: "" };
  try {
    const r = await api.pairClaim(conn, code, deviceLabel(navigator.userAgent));
    saveConn({ ...loadConn(), ...conn, token: r.token });
    return { attempted: true, ok: true, label: r.label };
  } catch (e) {
    return { attempted: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
