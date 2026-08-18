#!/usr/bin/env pwsh
# Build QuickSave and package a Nexus-ready zip under dist/.
# Usage:  ./pack.ps1            (Release)
#         ./pack.ps1 -Configuration Debug
# The zip has BepInEx\ at its root (BepInEx\plugins\QuickSave\) so it installs via a mod manager
# (Vortex) or by extracting into the game folder.
#
# One DLL and nothing else: the shared settings host, the reflection helper and the toast are compiled
# in from Shared/, so there is no separate dependency to publish.

param([string]$Configuration = "Release")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# One owner for the version: tools/mod-versions.ps1, which refuses to answer while <Version> and the
# [BepInPlugin] literal disagree. A zip named for a number the running plugin does not report is a release
# nobody can reason about — and it is what an update check would compare against.
$ver = (& (Join-Path $root '../tools/mod-versions.ps1') -Mod QuickSave -Quiet).Version

dotnet build "$root/QuickSave.csproj" -c $Configuration

$dist  = "$root/dist"
$stage = "$dist/BepInEx/plugins/QuickSave"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$root/bin/$Configuration/QuickSave.dll" $stage

$zip = "$dist/QuickSave-v$ver.zip"
Compress-Archive -Path "$dist/BepInEx" -DestinationPath $zip -Force
Write-Host "Packaged $zip" -ForegroundColor Green
