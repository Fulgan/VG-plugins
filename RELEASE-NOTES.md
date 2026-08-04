# Release notes

What changed in each release, written for players. Newest first.

Each mod versions on its own, so a date can carry one mod or all of them. Every release also lives on the
[Releases](https://github.com/Fulgan/VG-plugins/releases) page, where the zips are.

---

## 2026-08-03 - Hypercom 0.2.0 | Station Assistant 1.1.0 | Quick Save 1.0.0

### Hypercom 0.2.0

**A lot of work here:**

- **A completely new optimisation system** was built into the plugin. Instead of relying on main stat alone, 
it tries to factor in substats, fire rate and aspects to calculates a "DPS index".
It also takes the overall ship's power consumption into accounts and will consider it when suggesting a 
switch (so swapping weapon don't make you lose that 20% power bonus).

- **A new "sell list"** function has been introduced to help you manage your armory.

- **A map** has been added. This is very much a work in progress but it already let you see where you have stored materials through a heat map and a "find my stuff" function that let you search for material. The ship's current location is also much easier to read than in the game.

- **Faction reputations** (under the map) for both "reputation" and "conquest" categories. There is also a ledger for both but it works by polling your reps so it will do some weird stuff if you reload a save (rep. changes between the saves will be worked as new correction entries)

**Note:** The "Officers" tab is only present in the beta version of the game. It would be too much work to make it functional in the release version when it's going away in a few weeks.

**And some less drastic changes:**


- **Phone or tablet pairing** from a QR code in the settings tab.

- **The web UI now ships inside the plugin** instead of as a `ui` folder of loose files. Upgrading removes the old folder for you if the content matches what was distributed (leavs any changes behind)

- **A plan that would make your ship worse now says so.** Turrets and modules share one stepped reactor
  budget, so changes that each look like a gain can add up to a loss.

- **Settings now belong to a playtrough.** Starting a new game (or swapping between different saves) no longer inherits the last character's sell rules and filters. Also, optimization settings are now saved per ship.
 
- **Fixed: the reputation view lists the factions actually in the war**, including the Umbral rank, and no longer shows non-combatants sitting at zero.

- **Better ranking.** Fire rate, reactor scaling and weapon power are read the way the game computes them,
  so the numbers the app shows match what you see in-game.

### Station Assistant 1.1.0

- **`Decoy` ranamed `Quartermaster`** as it now let you manage inventory (and reserve) of ion/plasma fuel cells, locator beacons, tracking tag bots in addition of the decoys.

- **Decoy toggle hotkey** (def. F11) for toggling on/off the automatic decoy deployment on undock.

- **Restock trigger selectable** You can now chose when the restock happens: on dock, undock or manual (with a hotkey).

- **`Ammo valet` renamed `gunner`.** and it now refill your ship's inventory based on a rule similar to ECHO's: it will calculate the amount of ammo necessary to fire for the given amount of minutes (per ECHO's setting) and load that. You can still use the old mode if you like.

- **Saved loadout are now properly shared** between Sattion Assistant and Hypercom if both are installed. A bug previously prevented changes made in Hypercom to appear in SA until the game was reloaded.
 
- **Keep-rule Size is exact** not ">=" - a Medium rule no longer spares Large. Label "Min size" -> "Size".

### Quick Save 1.0.0 - first release

The age-old "quick save/load hotkeys" feature. Quick load has an "undo" feature that creates an extra save right before reloading (you need to reload it manually though).

Note that both keys are **unbound** by default (Press F7 to bind them)

---

## 2026-07-23 - Hypercom 0.1.0 | Station Assistant 1.0.0

First public release of both mods.

- **Hypercom 0.1.0** - runs a small local server inside the game so the Ship Optimizer web app can read
  and change your inventory and loadouts.
- **Station Assistant 1.0.0** - station chore automation: decoy transponders, auto-sell, ammo valet, and
  loadout presets.
