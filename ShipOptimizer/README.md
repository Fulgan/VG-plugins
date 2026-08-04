# Ship Optimizer

A web app for **Vanguard Galaxy** that looks at your ship, your inventory, the station shops and the
galaxy around you, suggests a better loadout, and applies it for you. It runs through the
**[Hypercom](../Hypercom/)** mod, and ships inside it - there is nothing separate to install.

**Ships with Hypercom 0.2.0** - [what changed](../RELEASE-NOTES.md).

## What it does

Six tabs. Above them you get your credits, any other currency you hold, and the restock and mission
timers. Each tab shows how many changes it is suggesting, so you can see what's waiting without opening
it.

### Inventory & opportunities

Your own gear next to the station's shop, filtered by category or rarity, and you can buy straight from the
shop list. Two short lists show what would be an upgrade: one from what you already own, one from what the
station sells. Underneath, your current loadout, a list of everything the app has bought and sold, and the
game's own messages.

The **Sell list...** button is for clearing out junk. You describe what you want gone as rules, it shows
you exactly which items those rules picked, you untick anything you want to keep, then you sell. Lists can
be named, saved, exported and imported, so a set of rules can move to your next playthrough.

### Officers

Ranks your crew by the skills you care about and fills the ship you pick, and it points out recruits at the
station worth hiring over what you have. Officers are shared between ships, so crewing one doesn't take
anyone off another.

Beta branch only. Crew moved there, and the release branch is going away in a few weeks, so making it work
there as well is more effort than it is worth.

### Boosters

Picks the strongest boosters for your slots, looking at your ship, your inventory and the armory. You can
tie a slot to one type, and it shows how close each resonance is to unlocking. (resonance is beta-only)

### Ship gear

Each slot with what's in it next to what it suggests, ranked on a DPS index rather than the main stat alone
([how that works](#how-gear-is-judged)). Filt er by activity (combat, mining, salvage), by type, by damage
or by aspect, and lock a slot to keep what's already fitted. Below that: what the ship's power adds up to,
what your reactor is using now and what it would use after the change, and how your ship is holding up.

### Summary

Everything the other tabs are proposing in one place, so you can read it over and apply the lot in one go,
with an undo. Named loadout presets live here too, and saving one keeps your optimizer settings as well as
the gear, so loading it puts your filters and priorities back.

### Map

Work in progress, and a different take on the in-game one: only one thing is coloured in at a time, so you
ask one question instead of reading five at once. You pick what that is - who owns what, your materials,
level, how recently you were there, or stations - and zoom from quadrant to subsector. There's a heat map
of where your materials are sitting and a "find my stuff" search for any of them. Distances are in jumps
from where you are now.

Faction standing sits at the foot of it, as two panels: reputation and conquest, rows in the same order the
game puts them in, each with its own change log. The log is built by polling your standing, so reloading a
save can post the difference it finds as a correction entry.

## How gear is judged

Two modes, switched with the button in the Gear tab header.

**simple** uses the main stat, like the game shows it.

**expanded** (the default) starts from that number and adds what the item's own bonuses do: fire rate,
crit, damage bonuses and aspects. Fire rate is the real one, with reload counted in.

The rest is what makes a gun better or worse than its number looks:

- **A gun's main power is its own (beta).** A harder hitting gun hits harder itself. It used to be
  averaged over all your guns, the last beta stopped that.
- **Release and beta don't count it the same way.** Release still averages, beta doesn't. The app uses the
  beta rule for both, so on release the order can be off (the more guns you have, the bigger the
  difference). Worth checking the game's own numbers before you buy.
- **Substats are shared.** Precision (crit chance), crit damage, damage bonuses and fire rate are read
  from all your guns at once, so a bonus on one gun helps the others. That's why a small gun with good
  substats can still win a slot, and why the app looks at all your guns together instead of one slot at a
  time.
- **Fire rate bonuses.** The app counts a full firing cycle, reload included. So attack speed gives less
  and less on its own, and a bigger magazine or a faster reload is often the better buy. Burst guns gain
  the least from it.
- **The rest of your power is split between your guns.** Skills, your hull, modules and boosters all raise
  the same stat, and a bigger hardpoint takes a bigger share of it.
- **Power use matters.** How much of your reactor you are using lands in a band, and the band changes your
  Combat, Mining and Salvage Power:

  | reactor in use | your power |
  |---|---|
  | up to 50% | +20% |
  | up to 75% | +10% |
  | up to 100% | unchanged |
  | up to 125% | -25% |
  | up to 150% | -50% |
  | over 150% | -75% |

  So a gun that draws nothing can beat a bigger one just by keeping you in a better band. Swaps are
  counted together, because two guns that each fit on their own can still push you over a line. The tab
  shows what your usage would become.
- **Combat, mining and salvage aren't compared.** Different jobs, so no percentage between them. That
  choice is yours.
- **Mining and salvage have two layers.** Surface and Core. The score is the worse of the two, so
  ignoring Core doesn't win. If you don't own the gear for both, it says so.
- **Small gains are ignored.** Under 1% isn't worth the trip to the workshop. Changing job (a weapon where
  a mining laser was) always counts, and so does filling an empty slot.
- **How it picks.** Best item for each slot first, then it keeps swapping one slot at a time until nothing
  gets better. Each item is only used once.
- **The numbers come from the game.** It reads the game's own stats instead of redoing the maths. Splash
  damage isn't counted (it depends on the fight).

## Using it

You don't run this yourself. Install **Hypercom**, start the game, press **F7** and use **Open web UI** on
the Hypercom tab. For a phone or tablet, scan the QR code there instead (see Hypercom's pairing section) -
the phone gets its own token and you can revoke that one on its own.

- **Docked for anything that changes your ship.** Undocked you still get the app, but gear is read-only
  and you only see what's in your cargo. The shop list shows the last station you were in.
- **It keeps up on its own.** Dock, undock, fit something or switch ships and it refreshes. An **ECHO**
  badge shows when autopilot is flying, and changes are refused while it is.
- **Settings follow the save.** A new character starts clean instead of inheriting the last one's sell
  rules and filters. Gear settings are kept per ship.
- **Loadout presets are shared with Station Assistant**, if you have that installed too.
- **The Tools menu (...)** exports and imports loadouts and sell lists, so a set of rules can outlive the
  playthrough you wrote it in.
- Refresh clocks sit above the tabs, so "is it worth docking yet" is answerable from any of them.

## Help

Questions or bugs? Join the **[Discord](https://discord.gg/mFZ34Rzzqs)**.

## Credits

**Vanguard Galaxy** is made by **Bat Roost Games**
([Steam](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/)). Game info and images come
from the community wiki (<https://wiki.vanguardgalaxy.com>) - thanks to its maintainers. This is an
unofficial, fan-made mod, not affiliated with or endorsed by Bat Roost Games.
