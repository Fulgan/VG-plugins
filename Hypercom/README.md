# Hypercom

A mod for **Vanguard Galaxy** that powers the **[Ship Optimizer](../ShipOptimizer/)** web app. It
runs a small server inside the game so the optimizer can read your inventory and loadouts and change
them for you — no need to fight the in-game menus or restart.

In a normal install Hypercom is all you need: start the game and the Ship Optimizer opens in your
browser.

> ⚠️ **This is a power tool.** Anything on your PC that has the access token can move and sell your
> items. It only listens on your own machine, but treat the token like a password.

## Installing

1. Install this mod from **Nexus Mods** with a mod manager (like Vortex), or extract the zip into
   your game folder.
2. Start the game. The Ship Optimizer opens in your browser automatically.

## Settings

Press **F7** in-game for the settings window; Hypercom's controls are on the **Hypercom** tab. From
there you can open the web app, view or regenerate the access token, and turn access controls on or
off. Changes apply right away. The **F7** key can be changed in the **Hotkeys** tab.

You can also change these in `BepInEx\config\fulgan.vanguardgalaxy.hypercom.cfg`:

| Setting | Default | What it does |
|---|---|---|
| Enabled | on | Turns the server on or off. |
| Port | 8777 | The port it uses. |
| Require token | off | Require the access token on every request. |
| Allow other devices | off | Let other devices on your network reach it. Turns the token on. Only use on a network you trust. |
| Open browser on start | on | Open the Ship Optimizer in your browser when the game starts. |

## Safety

- Selling never touches items the game marks unsellable (mission, favourite, or no sale value).
- Nothing sells, buys, or moves while **ECHO** (autopilot) is flying your ship.
- Items only move between your cargo, your armory, and station storage — never between ships and
  never your equipped gear.

## Help

Questions or bugs? Join the **[Discord](https://discord.gg/mFZ34Rzzqs)**.

## Credits

**Vanguard Galaxy** is made by **Bat Roost Games**
([Steam](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/)). This is an unofficial,
fan-made mod, not affiliated with or endorsed by Bat Roost Games.
