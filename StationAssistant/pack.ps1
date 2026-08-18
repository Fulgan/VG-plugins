#!/usr/bin/env pwsh
# Build Station Assistant and package a Nexus-ready zip under dist/.
# Usage:  ./pack.ps1            (Release)
#         ./pack.ps1 -Configuration Debug
# The zip has BepInEx\ at its root (BepInEx\plugins\StationAssistant\ + lang) so it installs via a mod
# manager (Vortex) or by extracting into the game folder.

param([string]$Configuration = "Release")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# One owner for the version: tools/mod-versions.ps1, which refuses to answer while <Version> and the
# [BepInPlugin] literal disagree. A zip named for a number the running plugin does not report is a release
# nobody can reason about — and it is what an update check would compare against.
$ver = (& (Join-Path $root '../tools/mod-versions.ps1') -Mod StationAssistant -Quiet).Version

dotnet build "$root/StationAssistant.csproj" -c $Configuration

$dist  = "$root/dist"
$stage = "$dist/BepInEx/plugins/StationAssistant"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$stage/lang" | Out-Null
Copy-Item "$root/bin/$Configuration/StationAssistant.dll" $stage
Copy-Item "$root/lang/*.lang" "$stage/lang"

$zip = "$dist/StationAssistant-v$ver.zip"
Compress-Archive -Path "$dist/BepInEx" -DestinationPath $zip -Force
Write-Host "Packaged $zip"
