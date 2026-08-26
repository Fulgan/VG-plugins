# Make the Vite dev server reachable from somewhere else, and print the link to open.
#
# What it configures, and why each piece is needed:
#
#   THE BIND. Vite listens on loopback by default, so the dev server is invisible from any other device. This
#   writes `VG_DEV_HOST` as the machine's TAILNET address rather than `0.0.0.0`: the dev server has no auth of
#   its own, so the set of people who can reach it should be the set of people on the owner's tailnet, not
#   everyone sharing a network with this PC.
#
#   THE TOKEN. The bridge requires `X-Auth-Token`, and a browser that has never paired does not have one. The
#   token goes into `.env.local`, which is read by `vite.config.ts` in NODE and attached to proxied requests
#   there, so it stays on this machine. Putting it in the link instead would hand a permanent credential to
#   anything that reads a URL, which is exactly what pairing codes exist to avoid.
#
# `.env.local` is gitignored by Vite convention; the token must never be committed.

[CmdletBinding()]
param(
    # Where the game is installed, for the token file. Overridable for a non-default Steam library.
    [string] $GameDir = 'C:\Program Files (x86)\Steam\steamapps\common\Vanguard Galaxy',
    [int]    $Port = 5173,
    [int]    $BridgePort = 8777,
    # Bind to this instead of the detected tailnet address. `0.0.0.0` is deliberately awkward to reach for.
    [string] $BindHost
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# --- the address to bind to -----------------------------------------------------------------------------
$dnsName = $null
if (-not $BindHost) {
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if (-not $ts) { throw "tailscale not found and no -BindHost given. Pass -BindHost <address> to bind explicitly." }
    $BindHost = (& tailscale ip -4 | Select-Object -First 1).Trim()
    if (-not $BindHost) { throw "tailscale is installed but reported no IPv4 address. Is it connected?" }
    # The MagicDNS name is what a human should type; the IP is what Vite binds to. Both reach the same socket.
    $status = & tailscale status --json | ConvertFrom-Json
    $dnsName = $status.Self.DNSName.TrimEnd('.')
}

# --- the bridge token -----------------------------------------------------------------------------------
$tokenPath = Join-Path $GameDir 'BepInEx\config\hypercom-token.txt'
if (-not (Test-Path $tokenPath)) {
    throw "No bridge token at $tokenPath. Start the game once with Hypercom loaded: it writes the file on first run."
}
$token = (Get-Content -Raw $tokenPath).Trim()
if (-not $token) { throw "The token file at $tokenPath is empty." }

# --- write it where vite.config.ts reads it ---------------------------------------------------------------
$envPath = Join-Path $root '.env.local'
@(
    "VG_DEV_HOST=$BindHost"
    "VG_BRIDGE_PORT=$BridgePort"
    "VG_BRIDGE_TOKEN=$token"
) | Set-Content -Path $envPath -Encoding utf8
Write-Host "wrote $envPath (token redacted, do not commit)" -ForegroundColor DarkGray

# --- report ------------------------------------------------------------------------------------------------
$url = if ($dnsName) { "http://${dnsName}:$Port/" } else { "http://${BindHost}:$Port/" }

Write-Host ''
Write-Host '  Open this from any device on the tailnet:' -ForegroundColor Green
Write-Host "    $url" -ForegroundColor White
Write-Host ''
Write-Host "  bind      ${BindHost}:$Port" -ForegroundColor DarkGray
Write-Host "  bridge    127.0.0.1:$BridgePort (proxied; the token never leaves this machine)" -ForegroundColor DarkGray
Write-Host ''
# Vite reads .env.local at STARTUP, so a server already running is still on the old config and still bound to
# loopback. Saying so beats the link silently not answering.
Write-Host '  Restart the dev server for this to take effect (npm run dev).' -ForegroundColor Yellow
Write-Host ''
