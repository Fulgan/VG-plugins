# CIC Watch

A mod for **Vanguard Galaxy** that is a standing readout of what is in the area. A combat information centre
panel that notifies you of important sensor changes and lists the notable contacts. Includes an editor to let
you specify precisely what is worth listing.

It also has announcements from the CIC to the bridge to add some flavour.

**Beta branch only.** Hull refits and improvements, as well as boarding, only exist in the beta branch. Since this mod makes heavy use of those, it cannot be used on the release branch and will do nothing there.

[What changed in the latest release](../RELEASE-NOTES.md).

## Installing

Needs **[BepInEx 5](https://github.com/BepInEx/BepInEx/releases)** in your game folder first (the mod
loader). Then extract the zip into your game folder: it has `BepInEx\` at its root, so a mod manager
(like Vortex) handles it too. Restart the game.

## Settings

Press **F7** for the shared mod settings window, or edit
`BepInEx\config\fulgan.vanguardgalaxy.cicwatch.cfg`:

| Setting | Default | What it does |
|---|---|---|
| Watch/Enabled | true | Whether the mod watches at all. |
| Watch/Rules | one per size | What is worth naming, one rule per ship size. Edit these in the settings tab. |
| Watch/LevelFilter | false | Also call a ship out for its level, whatever it is refitted to. |
| Watch/MinLevelDelta | 0 | How far above your own level that level rule starts counting. |
| Watch/HostileOnly | true | Only name ships that are hostile to you. |
| Watch/AutoOpenOn | WhenCalled | When the panel lifts itself: `WhenCalled` or `Never`. It never steals your keyboard. |
| UI/ShowVitals | true | Show each ship's hull, armour and shield. Off keeps one line per ship. |
| UI/ShowCapture | true | Show whether a ship can be taken, why not, or the chance per attempt. |
| UI/QuietLines | true | Say so in words when the area is quiet and stay up. Off hides the panel until there is something to report. |

## What to expect

- **Configurable rules for what constitutes a notable contact.** A Size8 is worth a line whatever it is; a
  Size2 rarely is unless it is an `X`. Each size takes its own quality, or `off`. Rules can also be set for the
  level compared to your own, and for friend or foe status.
- **A note if a ship cannot be boarded.** A ship carrying loot can never be boarded, and neither can anything
  above level 80.
- **Calls out important sensor changes.** Arrivals, kills, ships that broke off, and friendlies that
  turn on you, gathered into one call instead of several a second apart. A kill and a ship simply leaving
  are named as the different things they are.

## Help

Questions or bugs? Join the **[Discord](https://discord.gg/mFZ34Rzzqs)**.

## Credits

**Vanguard Galaxy** is made by **Bat Roost Games**
([Steam](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/)). This is an unofficial,
fan-made mod, not affiliated with or endorsed by Bat Roost Games.
