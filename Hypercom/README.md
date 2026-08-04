# Hypercom

A mod for **Vanguard Galaxy** that powers the **[Ship Optimizer](../ShipOptimizer/)** web app. It
runs a small server inside the game so the optimizer can read your inventory, loadouts, shops and the
galaxy around you, and change things for you - no need to fight the in-game menus or restart.

**Version 0.2.0** - [what changed](../RELEASE-NOTES.md).

In a normal install Hypercom is all you need: start the game and the Ship Optimizer opens in your
browser. The app itself is where the gear ranking, sell lists, map and faction standing live - see its
[own page](../ShipOptimizer/) for what it can do.

> /!\ **This is a power tool.** Anything that can reach the server and has the access token can move and
> sell your items, so treat the token like a password. Out of the box it listens on `127.0.0.1` only -
> nothing outside your PC can connect. Turn on **Allow other devices** and it listens on *every* network
> adapter this machine has, which is how a phone reaches it; the token is then forced on and cannot be
> switched off.

## Installing

1. Install **[BepInEx 5](https://github.com/BepInEx/BepInEx/releases)** into your game folder (the
   mod loader Hypercom runs on).
2. Get the zip from the **[Releases](https://github.com/Fulgan/VG-plugins/releases)** page, then install
   it with a mod manager (like Vortex) or extract it into your game folder.
3. Start the game. The Ship Optimizer opens in your browser automatically.

One file is all of it - the web app is built into the plugin, so there is no folder of loose UI files to
keep in sync, and the page you load always matches the version you installed. If you are upgrading from
0.1.0, the old `ui` folder beside the plugin is removed for you, but only the files a release actually
put there: anything you changed yourself is left alone.

## Settings

Press **F7** in-game for the settings window; Hypercom's controls are on the **Hypercom** tab. From
there you can open the web app, view or regenerate the access token, and turn access controls on or
off. Changes apply right away. The **F7** key can be changed in the **Hotkeys** tab.

### Turning the token on - you never have to copy it

**Require token** is off by default, which is fine for a PC only you use. When you switch it on, the
**Open web UI** button relabels itself to **Open web UI (enrols this browser)** - press it and the browser
that opens is signed in already. Behind the scenes it carries a short-lived enrolment code, and the page
trades that code for its own token and remembers it.

So the sequence is just:

1. Tick **Require token**.
2. Press **Open web UI (enrols this browser)**.

There is nothing to read out of a file and nothing to paste. The same happens automatically at game start if
**Open browser on start** is on.

Worth knowing:

- **The code, not the token, is what travels.** It lasts two minutes, works once, and the browser gets its own
  token - your main token never leaves the game.
- **Pressing the button twice is harmless.** An enrolment code that is still valid gets reused rather than
  replaced, so you don't spend a device slot per click (there are 16) or invalidate a pairing QR you have open.
- **Already-enrolled browsers keep working.** Enrolling again just replaces that browser's stored token.
- **A different browser, or a private window, needs its own enrolment** - press the button again from there.
- **Regenerating the main token** in the settings tab does not sign out enrolled browsers or paired phones;
  those are separate tokens, each revocable on its own.

You can also change these in `BepInEx\config\fulgan.vanguardgalaxy.hypercom.cfg`:

| Setting | Default | What it does |
|---|---|---|
| `Enabled` | on | Turns the server on or off. |
| `Port` | 8777 | The port it uses. |
| `RequireAuth` | off | Require the access token on every request. The **Open web UI** button then enrols the browser for you - see above. |
| `AllowRemote` | off | Listen on every adapter instead of loopback only, so other devices can reach it. Forces the token on. Only use on a network you trust. |
| `OpenBrowserOnStart` | on | Open the Ship Optimizer in your browser when the game starts. |
| `PairHost` | empty | The address put in the pairing QR. Empty means "detect it" - see [picking the right adapter](#picking-the-right-adapter). |

## Using your phone or tablet

The Ship Optimizer runs in any browser, so you can keep it on a phone beside you instead of alt-tabbing. Note that there is almost no work done to actually make it touch or small screen friendly yet, but it's reachable and usable on a tablet.

1. Open the **Hypercom** tab and click **Pair a phone**. If the server is still loopback-only you'll get
   **Enable LAN access & pair** instead, which switches it over first.
2. Scan the QR code with your phone's camera. Can't scan it? Open the address shown above the code and type
   the 8-character code by hand - it avoids the letters I, L, O and U so nothing is ambiguous.
3. That's it. The phone gets its own access token and remembers it.

**What LAN access means.** Anyone on your network can then load the Ship Optimizer *page*. They cannot read
your inventory or spend your credits without a token, and the only way to get one is a code you are currently
displaying. Turn it off when you're done if you're on a network you don't trust.

**If the phone just spins**, it is almost always the Windows firewall dropping the first outside connection
rather than anything to do with pairing. Allow the port once, in an admin terminal:

```
netsh advfirewall firewall add rule name="Hypercom" dir=in action=allow protocol=TCP localport=8777
```

## Picking the right adapter

With **Allow other devices** on, the server listens on all of them - but the QR code can only contain
*one* address, and only one of your adapters is the one your phone can actually reach. A gaming PC often
has several: the real network card, a Wi-Fi card, a VPN tunnel, and the virtual adapters that WSL, Hyper-V,
Docker or Bluetooth add. They all look equally valid from inside the game.

**What it picks on its own.** Best guess first:

1. **The address this PC would route from** - the one your own traffic leaves by. On a normal single-network
   machine this is the right answer and there is nothing to do.
2. **A mesh-VPN address** (Tailscale and friends, in the `100.64-100.127` range). This is the one that also
   works when your phone is *not* on your home network.
3. **Any other real adapter.**
4. **Virtual adapters last** - WSL, Hyper-V, vEthernet, Bluetooth. These reach nothing outside this PC, so
   they are only ever a fallback.

Adapters that are switched off, loopback, or sitting on a `169.254.*` address (which is what Windows hands
out when DHCP failed) are skipped entirely.

**Choosing it yourself.** When more than one candidate exists, the pairing panel shows a button like
`Address: 192.168.1.20 (Ethernet) - try another`. Each press moves to the next candidate, naming the adapter
it belongs to, and rebuilds the QR. Your choice is written to `PairHost` in the config, so it sticks for
next time. To set it by hand, put the address in `PairHost` directly.

**Which one do I want?**

- **Phone on the same Wi-Fi as the PC** -> the address on the same subnet as your phone. If your phone is
  `192.168.1.34`, you want the `192.168.1.x` one, not `172.x` (usually Docker or WSL) and not `10.x` unless
  that really is your network.
- **Nothing works and there are several `172.x` entries** -> those are almost always the virtual adapters.
  Cycle past them.

- **Phone not on your network at all** (mobile data, another building) -> no LAN address will do, and the
  answer is a mesh VPN. See the next section.

Both IPv4 and IPv6 are accepted on the LAN listener, which matters on iPhones: they prefer the IPv6 address
when a mesh VPN offers both, and an IPv4-only server is unreachable there for no visible reason.

## Reaching it from outside your network, without opening a hole

Skip this section if your phone and your PC are on the same Wi-Fi. It matters when they are not: playing on
a desk at work, the phone on mobile data, or a PC you leave running at home.

**The obvious answer is the wrong one.** Forwarding port 8777 on your router puts a server that can sell
your items on the public internet. The only thing between a stranger and your inventory would be the token,
on a port that automated scanners find within hours. Don't do it.

**What a mesh VPN is.** A small program you install on both machines. It gives each of your own devices a
private address (in the `100.64-100.127` range) that only your other devices can use, and encrypts
everything between them. The important part for us: both ends make an *outbound* connection to the
coordination service and meet in the middle, so

- there is nothing to forward on your router and no port exposed to the internet,
- it works from behind mobile networks, hotel Wi-Fi and shared connections that have no public address at all,
- and the address only resolves for devices signed into *your* network, so there is nothing for a scanner to
  find in the first place.

**[Tailscale](https://tailscale.com/)** is the usual choice, free for personal use and about a two-minute
setup; [NetBird](https://netbird.io/), [ZeroTier](https://www.zerotier.com/) and plain
[WireGuard](https://www.wireguard.com/) do the same job if you prefer. Tailscale calls your private network
a *tailnet*, which is the word the settings panel uses.

**Setting it up:**

1. Install it on the PC that runs the game, and on your phone. Sign both into the same account.
2. Both devices now show a `100.x.y.z` address. Nothing else to configure.
3. In Hypercom, pair as usual. That address is *preferred automatically* over your LAN addresses, and the
   panel confirms it with "This is a mesh-VPN address - works from anywhere your phone is on the same
   tailnet." If it picked a LAN address instead, press **try another** until you see that message.
4. Keep the VPN app running on the phone while you use the app. If the page stops loading when you leave the
   house, that is the first thing to check.

**Why this is the safe way in:** your inventory is reachable by exactly the devices you signed in yourself,
and nothing about your PC becomes visible to the internet. Removing a device from your tailnet cuts its
access immediately, whatever tokens it holds - which is a second, independent switch on top of revoking the
paired device in Hypercom. And you still get the same protections as on a LAN: the token is forced on, each
device holds only its own token, and a pairing code lasts two minutes and works once.

One caveat: this is not a substitute for the local firewall rule above. That rule lets the game accept
connections *on your own PC*; it is not a hole in your router, and you may need it before the phone can
reach you over the tailnet too.

## Safety

- Selling never touches items the game marks unsellable (mission, favourite, or no sale value).
- Nothing sells, buys, or moves while **ECHO** (autopilot) is flying your ship.
- Items only move between your cargo, your armory, and station storage - never between ships and
  never your equipped gear.
- A sell list shows you the exact items it proposes, and you confirm before anything is sold.
- A sale that can't take your credits is refused outright rather than handing the goods over unpaid.
- Every buy and sell is logged in the app's ledger and announced in-game, so nothing happens quietly.
- A paired phone gets its own token, never your main one, and revoking it doesn't affect anything else.

## Help

Questions or bugs? Join the **[Discord](https://discord.gg/mFZ34Rzzqs)**.

## Credits

**Vanguard Galaxy** is made by **Bat Roost Games**
([Steam](https://store.steampowered.com/app/3471800/Vanguard_Galaxy/)). This is an unofficial,
fan-made mod, not affiliated with or endorsed by Bat Roost Games.
