#!/usr/bin/env pwsh
# Build Station Assistant and package a Nexus-ready zip under dist/.
# Usage:  ./pack.ps1            (Release)
#         ./pack.ps1 -Configuration Debug
# The zip has BepInEx\ at its root (BepInEx\plugins\StationAssistant\ + lang) so it installs via a mod
# manager (Vortex) or by extracting into the game folder.

param([string]$Configuration = "Release")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

[xml]$proj = Get-Content "$root/StationAssistant.csproj"
$ver = ($proj.Project.PropertyGroup.Version | Where-Object { $_ }) | Select-Object -First 1
if (-not $ver) { throw "Could not read <Version> from the csproj." }

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
