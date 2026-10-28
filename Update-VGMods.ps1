<#
.SYNOPSIS
  Install or update the VG-plugins mods for Vanguard Galaxy, matching the game branch you play.

.DESCRIPTION
  Finds your Vanguard Galaxy install through Steam, reads which game branch it is on (the normal release or the
  open-beta) and which game version is installed, then installs the matching build of each mod from the
  VG-plugins GitHub releases.

  It warns before installing when your game is newer than the version these mods were built for: they still
  load, but some features may not work until a build for your game version is released.

  Nothing is changed until you confirm. Needs BepInEx 5 already installed in the game folder.

  Run it from PowerShell:

      powershell -ExecutionPolicy Bypass -File .\Update-VGMods.ps1

.PARAMETER GameDir
  The game folder, if it is not found through Steam.

.PARAMETER Channel
  'release' or 'beta'. Normally chosen from the game branch Steam has installed.

.PARAMETER Mods
  Which mods to install, by folder name: Hypercom, StationAssistant, CicWatch, QuickSave. Default: the ones
  already installed, or all of them on a first install.

.PARAMETER Yes
  Do not ask for confirmation.

.PARAMETER ManifestUrl
  Read the mod list from here instead of the published one. For testing.
#>
[CmdletBinding()]
param(
  [string]$GameDir,
  [ValidateSet('', 'release', 'beta')] [string]$Channel = '',
  [string[]]$Mods,
  [switch]$Yes,
  [string]$ManifestUrl
)

$ErrorActionPreference = 'Stop'
$AppId = '3471800'
$Repo = 'Fulgan/VG-plugins'
$DownloadPrefix = "https://github.com/$Repo/releases/download/"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Stop-With([string]$text) { Say $text 'Red'; exit 1 }

function Confirm-Step([string]$question) {
  if ($Yes) { return $true }
  $answer = Read-Host "$question [y/N]"
  return $answer -match '^(y|yes)$'
}

# Every Steam library folder, from the Steam install in the registry.
function Get-SteamLibraries {
  $steam = $null
  foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
    try {
      $item = Get-ItemProperty -Path $key -ErrorAction Stop
      if ($item.SteamPath) { $steam = $item.SteamPath; break }
      if ($item.InstallPath) { $steam = $item.InstallPath; break }
    } catch { }
  }
  if (-not $steam) { return @() }
  $steam = $steam -replace '/', '\'
  $libs = @($steam)
  $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
  if (Test-Path -LiteralPath $vdf) {
    foreach ($m in [regex]::Matches((Get-Content -LiteralPath $vdf -Raw), '"path"\s+"([^"]+)"')) {
      $libs += ($m.Groups[1].Value -replace '\\\\', '\')
    }
  }
  return $libs | Select-Object -Unique
}

# Version parts as integers; missing parts count as 0.
function Compare-Version([string]$a, [string]$b, [int]$parts) {
  $x = $a.Split('.'); $y = $b.Split('.')
  for ($i = 0; $i -lt $parts; $i++) {
    $p = 0; $q = 0
    if ($i -lt $x.Count) { $p = [int]$x[$i] }
    if ($i -lt $y.Count) { $q = [int]$y[$i] }
    if ($p -ne $q) { if ($p -lt $q) { return -1 } else { return 1 } }
  }
  return 0
}

# --- the game --------------------------------------------------------------------------------------------

$manifestFile = $null
if (-not $GameDir) {
  foreach ($lib in Get-SteamLibraries) {
    $acf = Join-Path $lib "steamapps\appmanifest_$AppId.acf"
    if (Test-Path -LiteralPath $acf) {
      $manifestFile = $acf
      $dir = [regex]::Match((Get-Content -LiteralPath $acf -Raw), '"installdir"\s+"([^"]+)"').Groups[1].Value
      $GameDir = Join-Path $lib "steamapps\common\$dir"
      break
    }
  }
}
if (-not $GameDir -or -not (Test-Path -LiteralPath $GameDir)) {
  Stop-With 'Vanguard Galaxy was not found through Steam. Pass the game folder: -GameDir "D:\...\Vanguard Galaxy"'
}
Say "Game folder: $GameDir"

if (Get-Process -Name 'VanguardGalaxy' -ErrorAction SilentlyContinue) {
  Stop-With 'Vanguard Galaxy is running. Close the game first: mods are only loaded when it starts.'
}
if (-not (Test-Path -LiteralPath (Join-Path $GameDir 'BepInEx\core\BepInEx.dll'))) {
  Stop-With 'BepInEx 5 is not installed in the game folder. Install it first: https://github.com/BepInEx/BepInEx/releases (BepInEx 5, x64).'
}

# The installed game version is Unity's Application.version, stored as a length-prefixed string in
# globalgamemanagers. The Unity version (6000.x) has the same shape, so the game version is the first one
# starting with 0.
$ggm = Join-Path $GameDir 'VanguardGalaxy_Data\globalgamemanagers'
$text = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($ggm))
$vm = [regex]::Match($text, '[\x03-\x20]\x00\x00\x00(0\.\d+(?:\.\d+){0,2})\x00')
if (-not $vm.Success) { Stop-With "Could not read the game version from $ggm." }
$game = $vm.Groups[1].Value

# The branch Steam has installed: MountedConfig is what is on disk, UserConfig what was asked for.
$branch = 'public'
if ($manifestFile) {
  $acfText = Get-Content -LiteralPath $manifestFile -Raw
  foreach ($block in 'MountedConfig', 'UserConfig') {
    $m = [regex]::Match($acfText, '"' + $block + '"\s*\{[^}]*?"BetaKey"\s+"([^"]*)"')
    if ($m.Success) { if ($m.Groups[1].Value) { $branch = $m.Groups[1].Value }; break }
  }
}
if (-not $Channel) { $Channel = if ($branch -eq 'public') { 'release' } else { 'beta' } }
Say "Game version: $game (Steam branch '$branch') -> '$Channel' mods"

# --- what is published for that channel -----------------------------------------------------------------

$mirrorBranch = if ($Channel -eq 'release') { 'main' } else { 'beta' }
$url = if ($ManifestUrl) { $ManifestUrl } else { "https://raw.githubusercontent.com/$Repo/$mirrorBranch/install.txt" }
try {
  if (Test-Path -LiteralPath $url) { $raw = Get-Content -LiteralPath $url -Raw }
  else { $raw = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content }
}
catch { Stop-With "Could not download the '$Channel' mod list from $url ($($_.Exception.Message))." }
if ($raw -is [byte[]]) { $raw = [Text.Encoding]::ASCII.GetString($raw) }

$supported = $null
$published = @()
foreach ($line in ($raw -split "`n")) {
  $line = $line.Trim()
  if (-not $line -or $line.StartsWith('#')) { continue }
  $f = $line.Split('|')
  if ($f[0] -eq 'game' -and $f.Count -eq 2) { $supported = $f[1] }
  elseif ($f[0] -eq 'mod' -and $f.Count -eq 6 -and $f[5].StartsWith($DownloadPrefix)) {
    $published += [pscustomobject]@{ Guid = $f[1]; Folder = $f[2]; Name = $f[3]; Version = $f[4]; Zip = $f[5] }
  }
}
if (-not $supported -or -not $published) { Stop-With "The '$Channel' mod list at $url is empty or unreadable." }

# --- is the game one these builds run on ----------------------------------------------------------------

$line = Compare-Version $game $supported 3
if ($line -gt 0) {
  Say ''
  Say "WARNING: your game ($game) is newer than these mods support ($supported)." 'Yellow'
  Say 'They will install and load, but some features may not work until a build for your game version is' 'Yellow'
  Say 'released. Run this script again then.' 'Yellow'
  if (-not (Confirm-Step 'Install anyway?')) { exit 0 }
} elseif ($line -lt 0) {
  Say ''
  Say "WARNING: your game ($game) is older than these mods are built for ($supported)." 'Yellow'
  Say 'Some features may not work. Update the game through Steam, then run this again.' 'Yellow'
  if (-not (Confirm-Step 'Install anyway?')) { exit 0 }
} elseif ((Compare-Version $game $supported 4) -gt 0) {
  Say "Note: these mods were built for game $supported; $game is a newer patch of the same version and should work." 'Yellow'
}

# --- which mods ------------------------------------------------------------------------------------------

$pluginsDir = Join-Path $GameDir 'BepInEx\plugins'
if ($Mods) {
  $chosen = @($published | Where-Object { $Mods -contains $_.Folder })
  $unknown = @($Mods | Where-Object { $published.Folder -notcontains $_ })
  if ($unknown) { Stop-With "Unknown mod(s): $($unknown -join ', '). Available: $($published.Folder -join ', ')" }
} else {
  $chosen = @($published | Where-Object { Test-Path -LiteralPath (Join-Path $pluginsDir $_.Folder) })
  if (-not $chosen) { $chosen = $published; Say 'No mods installed yet: installing all of them.' }
}

Say ''
Say 'Plan:' 'Cyan'
$plan = @()
foreach ($m in $chosen) {
  $dll = Join-Path $pluginsDir "$($m.Folder)\$($m.Folder).dll"
  $have = $null
  if (Test-Path -LiteralPath $dll) {
    $v = (Get-Item -LiteralPath $dll).VersionInfo.FileVersion
    if ($v) { $have = ($v.Split('.')[0..2] -join '.') }
  }
  if ($have -eq $m.Version) { Say "  $($m.Name) $have - up to date"; continue }
  $from = if ($have) { $have } else { 'not installed' }
  Say "  $($m.Name): $from -> $($m.Version)"
  $plan += $m
}
if (-not $plan) { Say ''; Say 'Everything is up to date.' 'Green'; exit 0 }
Say ''
if (-not (Confirm-Step "Install into $GameDir ?")) { exit 0 }

# --- install ---------------------------------------------------------------------------------------------

$work = Join-Path ([IO.Path]::GetTempPath()) ('vg-plugins-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  foreach ($m in $plan) {
    $zip = Join-Path $work "$($m.Folder).zip"
    $out = Join-Path $work $m.Folder
    Say "Downloading $($m.Name) $($m.Version)..."
    Invoke-WebRequest -Uri $m.Zip -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $out -Force
    # Every release zip has BepInEx\ at its root, so it lands in the game folder as it would by hand.
    if (-not (Test-Path -LiteralPath (Join-Path $out "BepInEx\plugins\$($m.Folder)"))) {
      throw "$($m.Name): the downloaded zip does not have the expected BepInEx\plugins\$($m.Folder) folder; nothing was installed for it."
    }
    Copy-Item -Path (Join-Path $out 'BepInEx') -Destination $GameDir -Recurse -Force
    Say "  installed $($m.Name) $($m.Version)" 'Green'
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Say ''
Say 'Done. Start the game to load the new versions.' 'Green'
