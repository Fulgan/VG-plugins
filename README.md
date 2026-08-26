# Vanguard Galaxy Mods

Community mods for [**Vanguard Galaxy**](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/).

| Mod | What it does |
|---|---|
| **[Station Assistant](StationAssistant/)** | Automates decoy transponders, keeps various consumables stocked, sells surplus gear, and manages ammo for you. |
| **[Hypercom](Hypercom/)** | HTTP server that runs inside the game and provides both a location to serve the ship optimizer from and a bridge so it can reach into the game. |
| **[Ship Optimizer](ShipOptimizer/)** | All-round tool for ship management displayed as a web UI. |
| **[Quick Save](QuickSave/)** | Quick save and quick load on a keypress, with an undo slot. |
| **[CIC Watch](CicWatch/)** | A combat information centre with a display of notable sensor contacts (Beta branch only). |

Each mod's own page has the details on what it does and how to use it, but you can access everything from the settings panel, invoked by pressing `F7` (by default).

## Installing

These mods need **[BepInEx 5](https://github.com/BepInEx/BepInEx/releases)** installed in your game
folder first (the mod loader they run on).

Then grab the mod's zip from the **[Releases](https://github.com/Fulgan/VG-plugins/releases)** page and
either install it with a mod manager (like Vortex) or extract it into your game folder: each zip has
`BepInEx\` at its root. Restart the game to load it.

Each mod is a single self-contained file: there is no shared dependency to install, and you can take one
mod without the others.

**[What changed in the latest release](RELEASE-NOTES.md)**

## Downloads

<!-- DOWNLOADS:BEGIN. Rewritten by tools/publish-oss.ps1 from each mod's <Version>; edit the prose, not the
     links, or the next mirror run will overwrite what you wrote. -->

### Hypercom

Ship Optimizer ships inside it: one download for both.

**[Download Hypercom 0.4.0](https://github.com/Fulgan/VG-plugins/releases/download/Hypercom-v0.4.0/Hypercom-v0.4.0.zip)**
([all Hypercom releases](https://github.com/Fulgan/VG-plugins/releases?q=Hypercom))

### Station Assistant

**[Download Station Assistant 1.1.6](https://github.com/Fulgan/VG-plugins/releases/download/StationAssistant-v1.1.6/StationAssistant-v1.1.6.zip)**
([all Station Assistant releases](https://github.com/Fulgan/VG-plugins/releases?q=Station+Assistant))

### Quick Save

**[Download Quick Save 1.0.1](https://github.com/Fulgan/VG-plugins/releases/download/QuickSave-v1.0.1/QuickSave-v1.0.1.zip)**
([all Quick Save releases](https://github.com/Fulgan/VG-plugins/releases?q=Quick+Save))

### CIC Watch

Beta branch only: on the public release branch it switches itself off.

**[Download CIC Watch 0.1.0](https://github.com/Fulgan/VG-plugins/releases/download/CicWatch-v0.1.0/CicWatch-v0.1.0.zip)**
([all CIC Watch releases](https://github.com/Fulgan/VG-plugins/releases?q=CIC+Watch))

<!-- DOWNLOADS:END -->


## Help & community

Questions, bug reports, or just want to chat? Join the **[Discord](https://discord.gg/mFZ34Rzzqs)**.

## Credits

- **Vanguard Galaxy** is made by **Bat Roost Games**:
  [buy it on Steam](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/).
- Some game info and images come from the community wiki
  (<https://wiki.vanguardgalaxy.com>), thanks to its maintainers.

These are unofficial, fan-made mods, not affiliated with or endorsed by Bat Roost Games. Use at your
own risk.

## License

[MIT](LICENSE) (c) Fulgan.
