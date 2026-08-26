#!/usr/bin/env pwsh
# Build CIC Watch and package a Nexus-ready zip under dist/.
# Usage:  ./pack.ps1            (Release)
#         ./pack.ps1 -Configuration Debug
# The zip has BepInEx\ at its root (BepInEx\plugins\CicWatch\) so it installs via a mod manager
# (Vortex) or by extracting into the game folder.
#
# One DLL and nothing else: the shared settings host, the reflection helper, the rarity table, the ship
# namer and the inflector are compiled in from Shared/, so there is no separate dependency to publish.
#
# THIS FILE IS ALSO THE REGISTRATION. The mod list is derived rather than written down: both
# tools/mod-versions.ps1 and tools/publish-oss.ps1 treat a folder with a pack.ps1 as a mod, and the
# publisher then REFUSES to run while such a folder is missing from its mirror list. So a mod without this
# script is invisible to the release machinery, and a mod with it cannot be released without its source.

param([string]$Configuration = "Release")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# One owner for the version: tools/mod-versions.ps1, which refuses to answer while <Version> and the
# [BepInPlugin] literal disagree. A zip named for a number the running plugin does not report is a release
# nobody can reason about, and it is what an update check would compare against.
$ver = (& (Join-Path $root '../tools/mod-versions.ps1') -Mod CicWatch -Quiet).Version

dotnet build "$root/CicWatch.csproj" -c $Configuration

$dist  = "$root/dist"
$stage = "$dist/BepInEx/plugins/CicWatch"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$root/bin/$Configuration/CicWatch.dll" $stage

$zip = "$dist/CicWatch-v$ver.zip"
Compress-Archive -Path "$dist/BepInEx" -DestinationPath $zip -Force
Write-Host "Packaged $zip" -ForegroundColor Green
