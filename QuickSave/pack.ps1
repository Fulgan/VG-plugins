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

[xml]$proj = Get-Content "$root/QuickSave.csproj"
$ver = ($proj.Project.PropertyGroup.Version | Where-Object { $_ }) | Select-Object -First 1
if (-not $ver) { throw "Could not read <Version> from the csproj." }

dotnet build "$root/QuickSave.csproj" -c $Configuration

$dist  = "$root/dist"
$stage = "$dist/BepInEx/plugins/QuickSave"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$root/bin/$Configuration/QuickSave.dll" $stage

$zip = "$dist/QuickSave-v$ver.zip"
Compress-Archive -Path "$dist/BepInEx" -DestinationPath $zip -Force
Write-Host "Packaged $zip" -ForegroundColor Green
