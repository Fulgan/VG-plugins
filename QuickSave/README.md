# Quick Save

A mod for **Vanguard Galaxy** that saves and loads on a keypress. One key writes your game to a
`quicksave` slot; another loads it back.

Its own mod on purpose: it shares nothing with the other Vanguard Galaxy mods, so you don't have to
install a station automation mod or a web server to get two hotkeys. It will be retired if the feature 
is implemented in the game.

**Version 1.0.0** - [what changed](../RELEASE-NOTES.md).

## Installing

Needs **[BepInEx 5](https://github.com/BepInEx/BepInEx/releases)** in your game folder first (the mod
loader). Then extract the zip into your game folder - it has `BepInEx\` at its root, so a mod manager
(like Vortex) handles it too. Restart the game.

## Settings

**Both keys start unbound**, so the mod does nothing until you pick them. That's deliberate: the game
already uses a lot of keys, and claiming one uninvited could shadow something you rely on.

Press **F7** for the shared mod settings window and set them on the **Hotkeys** tab, or edit
`BepInEx\config\fulgan.vanguardgalaxy.quicksave.cfg`:

| Setting | Default | What it does |
|---|---|---|
| QuickSave | None | Key that saves your game to the `quicksave` slot. `None` = disabled. |
| QuickLoad | None | Key that loads the `quicksave` slot. `None` = disabled. |

## What to expect

- **Saving** tells you it worked - and tells you if it didn't. A save that fails quietly is worse than
  no save, because you find out only when you need it.
- **Loading** goes through the game's own load, the same one the menu button uses, so you get the
  normal loading screen.
- **A quick load discards everything since your last quick save** - that's what loading is. Treat the
  load key as the one to bind carefully.
- **An accidental load is recoverable.** Just before loading, your current game is written to a
  separate `quicksave-undo` slot. If you press load by mistake, that slot is in the game's own load
  menu, holding everything you were about to lose. It covers **one** press: the next quick load
  overwrites it, so recover before you load again.
- **A second press is ignored** while a save or load is still going, rather than running twice. The key
  comes back as soon as the game reports you back in control - it's the load that holds it, not a timer.

## Help

Questions or bugs? Join the **[Discord](https://discord.gg/mFZ34Rzzqs)**.

## Credits

**Vanguard Galaxy** is made by **Bat Roost Games**
([Steam](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/)). This is an unofficial,
fan-made mod, not affiliated with or endorsed by Bat Roost Games.
