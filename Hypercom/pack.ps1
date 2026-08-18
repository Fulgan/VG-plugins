#!/usr/bin/env pwsh
# Build Hypercom and package an installable zip under dist/.
# Usage:  ./pack.ps1            (Release — embeds the ShipOptimizer web UI in the DLL)
#         ./pack.ps1 -Configuration Debug   (no web UI)
# The zip has BepInEx\ at its root (BepInEx\plugins\Hypercom\) so it installs via a mod
# manager (Vortex) or by extracting into the game folder. One DLL: the web UI is compiled in.

param([string]$Configuration = "Release")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# One owner for the version: tools/mod-versions.ps1, which refuses to answer while <Version> and the
# [BepInPlugin] literal disagree. A zip named for a number the running plugin does not report is a release
# nobody can reason about — and it is what an update check would compare against.
$ver = (& (Join-Path $root '../tools/mod-versions.ps1') -Mod Hypercom -Quiet).Version

# Release builds run the csproj EmbedWebUi target (npm build), embedding ShipOptimizer/dist in the DLL.
dotnet build "$root/Hypercom.csproj" -c $Configuration

$dist  = "$root/dist"
$stage = "$dist/BepInEx/plugins/Hypercom"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$root/bin/$Configuration/Hypercom.dll" $stage

$zip = "$dist/Hypercom-v$ver.zip"
Compress-Archive -Path "$dist/BepInEx" -DestinationPath $zip -Force
Write-Host "Packaged $zip"
