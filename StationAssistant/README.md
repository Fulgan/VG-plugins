# Station Assistant

Quality-of-life mod for **Vanguard Galaxy** that handles chores at the station for you.

**Version 1.1.0** - [what changed](../RELEASE-NOTES.md).

## What it does

- **Quartermaster** - keeps your consumables stocked: decoy transponders, ion and plasma fuel cells,
  locator beacons and tracking tag bots. You set how many you want on the ship and how many in
  reserve, per ship, and it buys the shortfall from the station shops. It can also release a decoy
  when you undock. You can copy what you configured in another save or copy the setting for all the
  ships you own.
- **Auto-sell** - sells surplus gear (turrets, modules, boosters) by rarity and level, and keeps
  anything you favorite or write a keep-rule for.
- **Gunner** - refills your ship's ammo and stows what your guns don't use. It can work out how much
  you need the same way ECHO does, from the minutes of fire in your autopilot setting.
- **Loadouts** - saves a ship's current gear setup and re-applies it later from the Personal Hangar
  (shows you a preview first, and leaves slots you didn't save alone). Shared with Hypercom if you have
  both installed.

## Installing

Needs **[BepInEx 5](https://github.com/BepInEx/BepInEx/releases)** in your game folder first (the mod
loader). Then get the zip from the **[Releases](https://github.com/Fulgan/VG-plugins/releases)** page and
either install it with a mod manager (like Vortex) or extract it into your game folder. Restart the game.

## Using it

Press **F7** for the settings window, with tabs for **Quartermaster**, **Auto-sell**, **Gunner** and
**Loadouts**. Quick keys: **F8** sells, **F9** runs the gunner, **F11** is your decoy key. All keys can
be changed in the **Hotkeys** tab, and hotkeys do nothing at the main menu - settings belong to a save,
so there is nothing for them to act on until one is loaded.

Everything is per pilot, so two commanders can play differently.

### Quartermaster

Stock targets are per ship and per item: how many to carry in **cargo**, how many to keep in the
**armory** as reserve. `0` means "leave that container alone". A restock moves your surplus into the
armory, buys the shortfall (all or nothing - it won't half-fill an order), then tops the ship up from
the armory.

You choose **when** it runs: on dock, on undock (the default), or only when you press the key. There is
also a **Restock now** button, and **Copy targets to all ships** if you'd rather not set up each hull
by hand.

**F11** means "I want a decoy out". In space with no decoy running it releases one; press it while one
is already running (or while docked) and it switches the automation off instead.

### Gunner

Two ways to decide how much ammo to carry:

- **Auto** - enough for ECHO's minutes of fire, per equipped gun.
- **Manual** - your own per-ammo targets, which you can seed from what's currently in your cargo.

Either way it can stow ammo your equipped guns don't use, and buy what's missing from the shop.

### Auto-sell

Rules match by category, minimum rarity, size, minimum level and aspect. **Size is exact** - a Medium
rule spares Medium and nothing else. Use **List matches** to see exactly what a rule set would sell
before you press the sell key.

Nothing sells while **ECHO** is flying, and items the game marks unsellable - mission
items, favourites, anything with no sale value - are never touched.

## Help

Questions or bugs? Join the **[Discord](https://discord.gg/mFZ34Rzzqs)**.

## Credits

**Vanguard Galaxy** is made by **Bat Roost Games**
([Steam](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/)). This is an unofficial,
fan-made mod, not affiliated with or endorsed by Bat Roost Games.

