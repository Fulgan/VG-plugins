# Release notes

What changed in each release, written for players. Newest first.

Each mod versions on its own, so a date can carry one mod or all of them. Every release also lives on the
[Releases](https://github.com/Fulgan/VG-plugins/releases) page, where the zips are.

---

## 2026-08-17 - Hypercom 0.3.0 | Station Assistant 1.1.2

A shopping list to go with the sell list, resonance counted on boosters, and a lot of fixes to the gear
suggestions. Both mods also work on game beta 0.8.1.26.

### Hypercom 0.3.0

**Shopping list.** Allow you to specify what you are shopping for - quality, type, aspect, substat count, a
price ceiling, or how many you already own. Matching offers in a station's shop are flagged for you.

**Filters improvements.** More natural display for filters.

**Booster resonance is taken into account.** Boosters are now ranked with their resonance bonus counted, either as current or fully unlocked.

**Booster preferences.** Specify which resonance bonuses you prefer and which to ignore, per ship.

**Sell list.** Now shows what the default rule is about to take, not just how many. Sort it, group it, choose the columns. You can also sell straight from the inventory grid.

**Gear suggestions.** New **Suggest whole ship**: guns and modules picked in one pass. Modules are judged as a set rather than one at a time, and every suggested row explains the reason for the pick.

**Map.** New Umbral daily layer, display improvement (still WIP).

**Filters, grouping and column selection in inventory** for easier management.

**Works on game beta 0.8.1.26.** Moving items, selling and applying a loadout would all have stopped working on that build.

#### Fixes

- The gear tab no longer offers you two builds in turn.
- Combat Power, Precision and power draw are valued properly, so a worse module is no longer offered as an
  upgrade.
- Core-mining guns are suggested again, and the gear tab no longer goes quiet on a mining or salvage ship.
- Fixed stats calculation so the result after applying a change matches what was predicted.
- A pinned slot is left alone.
- Extra tractor beams no longer count as an upgrade.
- Item tooltips are no longer cut off, and the hardpoint dots sit on the ship.
- What you sold shows in the shop list, tinted, with no extra click.
- Choosing columns works as expected, and a column that reads the same on every row is not offered.
- Conquest contribution, the mission log and the reputation log all read correctly.

### Station Assistant 1.1.2

**Works on game beta 0.8.1.26.** Auto-sell, the ammo valet and the decoy charge would all have stopped working
on that build. Nothing else has changed, and the mod still works on the earlier betas and on the release
version.

---

## 2026-08-05 - Hypercom 0.2.1 | Station Assistant 1.1.1

A fix release, almost all of it from playing a long save: an 8,000-item armory found a lot of things that
work fine on a fresh one.

### Hypercom 0.2.1

**Selling a lot of things at once**

- **Selling a long list took minutes and looked frozen.** Every row was its own request, and each one waited
  for a frame — 7,891 items was over two minutes of that. The whole list now goes out as one request and
  takes a couple of seconds, and the game shows how far it has got while it works.
- **Sold items now reach the station's shop.** They were only being put on the shelf when the game allowed
  them to be bought back; everything else was sold into nowhere.
- **The station's shop panel updates when a sale fills it.** The goods were there, but the open panel kept
  drawing the list it had when it opened — typing in its search box was the only way to see them.
- **Boosters are no longer skipped** with "slot 25 now holds Combat Power I, not Combat Power I". The check
  was comparing an item's internal name against the one you were shown, and for a booster those differ. The
  same check guards buying, where it was refusing ammo and materials for the same reason.
- **A big sale no longer makes the app reload your inventory dozens of times**, and the shop list no longer
  drags the game down afterwards — what you sold is held back until you ask for it, with "show N you sold"
  in the shop header.

**In-game messages**

- **Every notification the mod has ever sent was invisible.** It was created hidden and never shown, so
  buys, sales and hires happened in silence. They appear now — and are readable, having first appeared in
  black on a black banner.

**The sell list**

- **Common gear and most boosters were invisible to it.** Anything that rolled no substats was treated as
  though it were not equipment, so a rule that said to sell it did nothing and it survived every sale.
- **Editing a rule no longer switches it off.** It left the rule set for as long as the editor was open, so
  a sale run while editing ignored it.
- **A rule that names activities no longer sweeps up your modules and boosters** without saying so — "no
  activity (modules, boosters)" is a value you can tick, and so is "none" for a field an item simply has
  none of.
- **"level vs mine" compares against your level**, not against the highest-level item you own.
- A relative-level rule now reads as a sentence — "level is at least 10 levels below mine" — and every word
  of it can be changed where it stands. "at or below mine" and "exactly mine" need no number at all.
- The rule editor takes the room it needs, the field picker is no longer cut off, comparisons can be flipped
  in place, and the split's groups are nested and sorted the way the rule groups them.

**Gear suggestions**

- **A "+25% Precision" roll was being valued as +0.25 Precision.** Percentage rolls are now read against the
  pool they scale, and a "+% Combat Power" substat counts at all.
- **Modules are judged by what they do to your battery**, not by their headline stat. A scanner with more
  Precision that gives up pooled Combat Power, a crit aspect and a reactor bracket is no longer an upgrade
  on a combat ship — while armour, aspect slots and draw still decide between two modules the damage model
  rates equally.
- **A reactor swap counts the power budget it changes.** A smaller reactor is not an upgrade when the load
  it leaves you with costs the reactor bonus on every pool.
- An empty aspect slot is valued by what you could put in it, and rolls your ship cannot use — Drone Power
  with no drone bay, Salvage Power on a ship that neither salvages nor carries a salvage gun — are ignored.

### Station Assistant 1.1.1

- **The hotkeys answer even when there is nothing to do.** Auto-sell with no categories ticked, the gunner
  with nothing to move, a restock while undocked — each said so only inside the mod's own settings window,
  so the key looked broken.
- **Items sold by auto-sell reach the station's shop**, not only the ones the game lets you buy back.

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
