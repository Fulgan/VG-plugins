using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Behaviour.Crew;
using Source.SpaceShip;
using Behaviour.Item;
using Behaviour.UI.Spacestation;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;
using Source.Util;
using UnityEngine;
using VG.Loadout;

namespace Hypercom
{
    // Request handlers. Every method runs its game access inside MainThread.Run so it executes on
    // the Unity main thread; a whole mutation lives in one lambda, making it atomic (V3, V5).
    internal static class Api
    {
        internal readonly struct Result
        {
            internal readonly int Status;
            internal readonly object Body;
            internal Result(int status, object body) { Status = status; Body = body; }
            internal static Result Ok(object body) => new Result(200, body);
            internal static Result Err(int status, string msg)
                => new Result(status, new Dictionary<string, object> { ["error"] = msg });
        }

        // "docked" = inside the station interior. SpaceStation.current stays set in-sector after undock,
        // so it can't represent docked-ness; the interior instance flips on dock/undock (matches the
        // event watcher).
        private static bool Docked => SpaceStationInterior.instance != null;
        private static bool Echo => GamePlayer.current?.currentAutopilotSessionStats != null;

        private static AppliedTransient _lastApplied; // last apply, for one-level undo (§V26)

        // Crew (officer) management changed in the 0.8.1.19 beta and will likely change again, so crew
        // features gate on this. Call on the Unity main thread (reads Application.version).
        // Stable id for the current playthrough — the web uses it to drop cached inventory/loadout when you
        // switch save/playthrough. The game has no persisted "universe seed": the galaxy is generated once at
        // new-game (SeededRandom.Global, itself seeded from DateTime.Now.Ticks) and then serialized whole into
        // Player.map. But every sector gets a Guid.NewGuid() at generation that persists unchanged for the life
        // of the playthrough — so the ordered set of sector guids IS a stable, unique per-playthrough fingerprint
        // (equivalent to a seed). Hashed deterministically (FNV-1a) so it's compact and process-independent.
        // Reflection (Compat) keeps this typeref-free so one binary runs on both game versions. Falls back to
        // commander identity when there's no galaxy yet (main menu / brand-new game).
        // Delegates to the shared store's fingerprint so Hypercom and Station Assistant compute the SAME
        // per-playthrough key (galaxy sector-guid hash; commander fallback). See VG.Loadout.LoadoutStore.
        private static string PlaythroughId(GamePlayer p) => LoadoutStore.PlaythroughKey(p);

        // Crew (officer) features gate on the game version. This binary is built against the beta's
        // Source.Personnel crew API (>= 0.8.1.19); the 0.8.0.15 release renamed it to Source.Crew, whose
        // members this binary doesn't reference — so crew is OFF there. Crucially, every method that
        // touches OfficerData is only *invoked* behind this gate, so it never JIT-compiles (and can't
        // TypeLoad) on a version that lacks the type. See doc/game-version-api-diff.md.
        internal static bool CrewSupported() => GameVersion.IsAtLeast(Application.version, 0, 8, 1, 19);

        // ---- reads ----

        internal static Result Status() => MainThread.Run(() =>
        {
            var p = GamePlayer.current;
            var roleType = p?.currentSpaceShip?.shipClass?.shipRoleType;
            return Result.Ok(new Dictionary<string, object>
            {
                ["docked"] = Docked,
                ["station"] = SpaceStation.current?.name,
                ["lastStation"] = p?.lastStation?.name,
                ["shipGuid"] = p?.currentSpaceShip?.guid,
                ["shipType"] = p?.currentSpaceShip?.shipClass?.displayName, // ship class, e.g. "Chisel Mk I"
                ["role"] = roleType != null ? roleType.GetRole().ToString() : null,
                ["credits"] = p?.credits ?? 0L,
                ["crewSupported"] = CrewSupported(),
                ["hasDroneBay"] = Compat.Call(p?.currentSpaceShip, "HasDroneBay") ?? false,
                ["playthrough"] = PlaythroughId(p), // stable per save — lets the web drop stale cross-playthrough cache
                ["playthroughName"] = Playthroughs.Name(PlaythroughId(p)), // user-chosen pretty name (null = unnamed)
                ["gameVersion"] = Application.version,
                ["pluginVersion"] = Plugin.Version,
            });
        });

        // Owned officer roster + per-ship officer-slot counts. Crew-only (V28); older builds → error.
        internal static Result Officers() => MainThread.Run(() =>
        {
            if (!CrewSupported())
                return Result.Err(400, "crew not supported by this game version");
            return Result.Ok(Stores.OfficersDto());
        });

        // Recruitable officers at the docked station's Personnel Center (+ hire cost). Docked-only.
        internal static Result Recruits() => MainThread.Run(() =>
        {
            if (!CrewSupported())
                return Result.Err(400, "crew not supported by this game version");
            if (!Docked)
                return Result.Err(403, "not docked");
            return Result.Ok(Stores.RecruitsDto());
        });

        // Equipment TEMPLATE catalog — the EquipmentBuilder recipes (stat bands + level/rarity scaling)
        // that instances are rolled from, stamped with the game version. Not rolled instances.
        internal static Result EquipmentCatalog() => MainThread.Run(() =>
        {
            try { return Result.Ok(Catalog.EquipmentDto()); }
            catch (Exception ex) { return Result.Err(500, "catalog failed: " + ex.Message); }
        });

        // Distinct turret types + damage types + module slots that exist in the game (for gear filters).
        internal static Result CatalogTypes() => MainThread.Run(() =>
        {
            try { return Result.Ok(Catalog.TypesDto()); }
            catch (Exception ex) { return Result.Err(500, "catalog types failed: " + ex.Message); }
        });

        // Render a ship's sprite to PNG bytes (null → 404), from the game itself so it always matches the
        // actual (incl. new/beta) ship. The body sprite is `surfaceSprite` on the live unit — often null
        // while docked — so fall back to the class prefab's first SpriteRenderer. Experimental.
        internal static byte[] ShipImage(string guid) => MainThread.Run(() =>
        {
            var ship = string.IsNullOrEmpty(guid) ? GamePlayer.current?.currentSpaceShip : LoadoutCore.FindShip(guid);
            var cls = ship?.shipClass;
            if (cls == null) return null;
            Sprite sp = null;
            try { sp = cls.surfaceSprite?.sprite; } catch { }
            if (sp == null) { try { sp = cls.GetComponentInChildren<SpriteRenderer>(true)?.sprite; } catch { } }
            return RenderSprite(sp);
        });

        // Render an officer portrait to PNG bytes (null → 404). The icon sprite lives in an atlas, so
        // blit it to a temp RenderTexture and read back the sprite's region — works whether or not the
        // source texture is CPU-readable. Unity-graphics calls → must run on the main thread.
        internal static byte[] OfficerPortrait(string guid, string icon) => MainThread.Run(()
            => CrewSupported() ? PortraitImpl(guid, icon) : null); // gate before PortraitImpl so OfficerData never JITs off-version

        // Isolated so its OfficerData typeref only resolves on crew-capable versions (see CrewSupported).
        private static byte[] PortraitImpl(string guid, string icon)
        {
            Sprite sprite = null;
            if (!string.IsNullOrEmpty(guid))
                sprite = GamePlayer.current?.GetOfficer(guid)?.icon?.sprite;
            if (sprite == null && !string.IsNullOrEmpty(icon))
                sprite = OfficerIcons.Get(icon)?.sprite;
            return RenderSprite(sprite);
        }

        // Owned-crew guids per ship slot. Isolated (touches SpaceShipData.officers/OfficerData) — only
        // called behind CrewSupported so it never JITs on a version without the Personnel crew API.
        private static List<string> CollectOfficers(SpaceShipData ship)
        {
            var list = new List<string>();
            if (ship?.officers != null) foreach (var o in ship.officers) list.Add(o?.guid);
            return list;
        }

        // Ship hardpoint layout: each gun mount's normalized position (u,v) on the rendered ship image
        // (/ships/image), + size/index/equipped. For a positional loadout editor overlay. Modules are
        // NOT positional (internal) — returned as a flat list. Current ship only (the live instance).
        // (u,v) are in image space: origin top-left, (0,0)=top-left corner, (1,1)=bottom-right.
        internal static Result ShipLayout() => MainThread.Run(() =>
        {
            var ship = GamePlayer.current?.currentSpaceShip;
            var cls = ship?.shipClass;
            if (cls == null) return Result.Err(404, "no current ship");

            // Use the SAME renderer /ships/image draws from, so overlay coords match the PNG exactly.
            SpriteRenderer sr = null; Sprite sp = null;
            try { sr = cls.surfaceSprite; sp = sr?.sprite; } catch { }
            if (sp == null) { sr = cls.GetComponentInChildren<SpriteRenderer>(true); sp = sr?.sprite; }
            if (sr == null || sp == null) return Result.Err(404, "no ship sprite");
            var b = sp.bounds; // local-space AABB matching the rendered textureRect

            var hardpoints = new List<object>();
            var slots = cls.hardpointSlots;
            if (slots != null)
                for (int i = 0; i < slots.Length; i++)
                {
                    var hp = slots[i];
                    if (hp == null) continue;
                    var local = sr.transform.InverseTransformPoint(hp.transform.position);
                    var u = b.size.x > 0 ? (local.x - b.min.x) / b.size.x : 0.5f;
                    var v = b.size.y > 0 ? (local.y - b.min.y) / b.size.y : 0.5f;
                    var idx = hp.index >= 0 ? hp.index : i;
                    InventoryItemType item = (ship.hardpoints != null && idx < ship.hardpoints.Length) ? ship.hardpoints[idx] : null;
                    hardpoints.Add(new Dictionary<string, object>
                    {
                        ["index"] = idx,
                        ["size"] = hp.size.ToString(),
                        ["rotate"] = hp.rotate,
                        ["u"] = u,
                        ["v"] = 1f - v, // flip: image origin is top-left, sprite bounds bottom-left
                        ["equipped"] = item == null ? null : Stores.ItemDto(item), // full DTO → mainStat/power + tooltip
                    });
                }

            var modules = new List<object>();
            var mslots = cls.moduleSlots;
            if (mslots != null)
                foreach (var m in mslots)
                    if (m != null)
                    {
                        InventoryItemType mi = null;
                        try { mi = ship.GetEquippedItem(m.slot); } catch { }
                        modules.Add(new Dictionary<string, object>
                        {
                            ["slot"] = m.slot.ToString(),
                            ["size"] = m.size.ToString(),
                            ["equipped"] = mi == null ? null : Stores.ItemDto(mi),
                        });
                    }

            return Result.Ok(new Dictionary<string, object>
            {
                ["shipGuid"] = ship.guid,
                ["name"] = cls.displayName,
                ["image"] = new Dictionary<string, object> { ["w"] = Mathf.RoundToInt(sp.textureRect.width), ["h"] = Mathf.RoundToInt(sp.textureRect.height) },
                ["hardpoints"] = hardpoints,
                ["modules"] = modules,
                ["diag"] = new Dictionary<string, object> { ["slotCount"] = slots?.Length ?? 0, ["fromSurfaceSprite"] = cls.surfaceSprite != null },
            });
        });

        // Render an inventory item's icon to PNG (null → 404), by store + item handle. For the gear
        // editor's in-game-style tooltips.
        internal static byte[] ItemImage(string store, int key, string slot) => MainThread.Run(() =>
        {
            InventoryItemType item = null;
            if (!string.IsNullOrEmpty(slot))
            {
                // Equipped item by ship slot ("t:<i>" hardpoint / "m:<EquipmentSlot>" module) — these have no store handle.
                var ship = GamePlayer.current?.currentSpaceShip;
                if (ship != null)
                {
                    if (slot.StartsWith("t:") && int.TryParse(slot.Substring(2), out var i) && ship.hardpoints != null && i >= 0 && i < ship.hardpoints.Length)
                        item = ship.hardpoints[i];
                    else if (slot.StartsWith("m:"))
                        try { item = ship.GetEquippedItem((EquipmentSlot)Enum.Parse(typeof(EquipmentSlot), slot.Substring(2))); } catch { }
                }
            }
            else
            {
                var inv = Stores.Resolve(store);
                item = (inv != null ? Stores.FindEntry(inv, key) : null)?.item;
            }
            Sprite sp = null;
            try { sp = item?.icon; } catch { }
            return RenderSprite(sp);
        });

        private static byte[] RenderSprite(Sprite sprite)
        {
            if (sprite == null || sprite.texture == null) return null;
            var tex = sprite.texture;
            var rect = sprite.textureRect; // sprite's pixel region within the atlas (bottom-left origin)
            var w = Mathf.RoundToInt(rect.width);
            var h = Mathf.RoundToInt(rect.height);
            if (w <= 0 || h <= 0) return null;

            var prevActive = RenderTexture.active;
            var rt = RenderTexture.GetTemporary(tex.width, tex.height, 0,
                RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            Texture2D readable = null;
            try
            {
                Graphics.Blit(tex, rt);
                RenderTexture.active = rt;
                readable = new Texture2D(w, h, TextureFormat.RGBA32, false);
                // RenderTexture and texture space share the bottom-left origin, so the region maps directly.
                readable.ReadPixels(new Rect(rect.x, rect.y, w, h), 0, 0);
                readable.Apply();
                return readable.EncodeToPNG();
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"portrait render failed: {ex.Message}");
                return null;
            }
            finally
            {
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
                if (readable != null) UnityEngine.Object.Destroy(readable);
            }
        }

        internal static Result Inventories() => MainThread.Run(() =>
        {
            var stores = new List<object>();
            // undocked → cargo only (V4); docked → all three.
            var ids = Docked ? Stores.All : new[] { Stores.Cargo };
            foreach (var id in ids)
            {
                var inv = Stores.Resolve(id);
                if (inv != null)
                    stores.Add(Stores.StoreDto(id, inv));
            }
            return Result.Ok(new Dictionary<string, object> { ["stores"] = stores });
        });

        internal static Result Shops() => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            var shops = new List<object>();
            foreach (var (id, shop) in EnumerateShops())
            {
                var items = new List<object>();
                if (shop.items != null)
                    foreach (var e in shop.items)
                        if (e?.item != null)
                        {
                            var dto = Stores.ItemDto(e.item);
                            dto["cost"] = e.cost;
                            dto["costItem"] = e.costItem?.identifier;
                            dto["costItemCount"] = e.costItemCount;
                            // Barter items: how many of the cost currency the player owns (armory+cargo+
                            // material) — so the UI can tell if a barter purchase is actually affordable.
                            if (e.costItem != null)
                                dto["costItemOwned"] = GamePlayer.current?.CountAvailableItems(e.costItem) ?? 0;
                            dto["stock"] = e.item.HasInfiniteShopSupply() ? -1 : e.count;
                            items.Add(dto);
                        }
                shops.Add(new Dictionary<string, object>
                {
                    ["id"] = id,
                    ["facility"] = id,
                    ["items"] = items,
                });
            }
            return Result.Ok(new Dictionary<string, object> { ["shops"] = shops });
        });

        internal static Result Loadout() => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            return Result.Ok(Stores.LoadoutDto(GamePlayer.current?.currentSpaceShip));
        });

        // All owned ships + their loadouts (read-only; available anywhere, not just docked).
        internal static Result Ships() => MainThread.Run(() =>
            Result.Ok(new Dictionary<string, object> { ["ships"] = Stores.ShipsDto() }));

        // Consolidated in-game log captured since the bridge started (thread-safe buffer, no game call).
        internal static Result Log() => Result.Ok(new Dictionary<string, object> { ["entries"] = LogBuffer.Recent() });

        // ---- mutations ----

        internal static Result Move(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");

            var from = Str(body, "from");
            var to = Str(body, "to");
            if (!Stores.IsValidStore(from) || !Stores.IsValidStore(to))
                return Result.Err(400, "from/to must be cargo|armory|material");
            if (from == to)
                return Result.Err(400, "from and to are the same store");
            if (!TryInt(body, "key", out var slot))
                return Result.Err(400, "missing item key (slot)");

            var src = Stores.Resolve(from);
            var dst = Stores.Resolve(to);
            if (src == null || dst == null)
                return Result.Err(400, "store unavailable");

            var entry = Stores.FindEntry(src, slot);
            if (entry == null)
                return Result.Err(404, $"item not found in {from}");

            var want = Int(body, "count");
            var n = want <= 0 ? entry.count : Math.Min(want, entry.count);
            n = ClampToSpace(dst, entry.item, n);
            if (n <= 0)
                return Result.Err(400, "no space in destination");

            dst.Add(entry.item, n);
            src.Remove(entry, n);
            return Result.Ok(new Dictionary<string, object> { ["moved"] = n });
        });

        internal static Result Sell(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");

            var store = Str(body, "store");
            if (!Stores.IsValidStore(store))
                return Result.Err(400, "store must be cargo|armory|material");
            if (!TryInt(body, "key", out var slot))
                return Result.Err(400, "missing item key (slot)");

            var inv = Stores.Resolve(store);
            if (inv == null)
                return Result.Err(400, "store unavailable");

            var entry = Stores.FindEntry(inv, slot);
            if (entry == null)
                return Result.Err(404, $"item not found in {store}");

            var item = entry.item;
            if (!item.canSell || item.missionItem || item.criticalItem || item.favouriteItem || item.sellValue <= 0)
                return Result.Err(403, "item is not sellable"); // V6

            var want = Int(body, "count");
            var n = want <= 0 ? entry.count : Math.Min(want, entry.count);
            var value = (long)item.sellValue * n;

            var player = GamePlayer.current;
            player.credits = AddClamped(player.credits, value);

            var shop = SpaceStation.current?.shopInventory;
            if (shop != null && item.buyBack)
                try { shop.Add(item, n, buyback: true); } catch { }

            inv.Remove(entry, n);
            return Result.Ok(new Dictionary<string, object> { ["sold"] = n, ["credits"] = value });
        });

        internal static Result Buy(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");

            if (!TryInt(body, "key", out var slot))
                return Result.Err(400, "missing item key (slot)");
            var want = Int(body, "count");
            if (want <= 0)
                return Result.Err(400, "count must be >= 1");

            var wantShop = Str(body, "shop"); // optional; recommended when slots overlap across shops

            // Find the offer at `slot` in the requested shop (or the first shop that has that slot).
            ShopInventory shop = null;
            Inventory.InventoryItem offer = null;
            foreach (var (id, s) in EnumerateShops())
            {
                if (!string.IsNullOrEmpty(wantShop) && id != wantShop)
                    continue;
                offer = s.items?.FirstOrDefault(i => i?.item != null && i.slot == slot
                                                     && (i.count > 0 || i.item.HasInfiniteShopSupply()));
                if (offer != null) { shop = s; break; }
            }
            if (offer == null)
                return Result.Err(404, "no matching offer in shop(s)");

            var player = GamePlayer.current;
            var cargo = player.currentSpaceShip?.cargo;
            if (cargo == null)
                return Result.Err(400, "no ship cargo");

            var infinite = offer.item.HasInfiniteShopSupply();
            var available = infinite ? int.MaxValue : offer.count;
            var amount = Math.Min(want, available);

            var barter = offer.costItem != null;
            long spent = 0;
            if (barter)
            {
                var per = offer.costItemCount;
                var canPay = per > 0 ? player.CountAvailableItems(offer.costItem) / per : amount;
                amount = Math.Min(amount, canPay);
            }
            else
            {
                if (offer.cost <= 0)
                    return Result.Err(400, "item has no purchasable price");
                amount = Math.Min(amount, (int)Math.Min(int.MaxValue, player.credits / offer.cost));
            }

            amount = ClampToSpace(cargo, offer.item, amount);
            if (amount <= 0)
                return Result.Err(409, "cannot afford or no cargo space");

            if (barter)
                player.ConsumeAvailableItems(offer.costItem, offer.costItemCount * amount);
            else
            {
                spent = (long)offer.cost * amount;
                player.RemoveCredits(offer.cost * amount); // release RemoveCredits takes no spend-category
            }

            var bought = offer.item;
            cargo.Add(bought, amount);
            if (!infinite)
                shop.Remove(offer, amount);
            foreach (var part in bought.GetComponents<InventoryItemPart>())
                part.OnPurchase(amount);

            return Result.Ok(new Dictionary<string, object>
            {
                ["bought"] = amount,
                ["spent"] = spent,
                ["barter"] = barter,
            });
        });

        // ---- loadout apply / undo / pending (§V23-V28) ----

        // Apply a partial additive transient: gear best-match + officers by guid. Docked → apply now
        // (tracked for undo); undocked → queue exactly one pending, applied on next dock. ECHO-refused.
        internal static Result LoadoutApply(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (Echo) return Result.Err(409, "ECHO active");
            var gear = ParseGear(body);          // fingerprint slots (finder)
            var officers = ParseOfficers(body);
            var hasDirect = HasDirectSlots(body); // exact-handle gear slots (store+key)
            if (gear.slots.Count == 0 && officers.Count == 0 && !hasDirect)
                return Result.Err(400, "nothing to apply (no slots or officers)");
            var crew = CrewSupported();

            // Apply only while docked (armory readable + a sane place to refit). No queueing.
            if (!Docked) return Result.Err(403, "dock to apply");

            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship");

            var t = LoadoutCore.ApplyTransient(ship, gear, officers, crew, out var changed);
            // Direct gear: resolve + validate each handle against what the client saw (skip moved items).
            var (direct, stale) = ParseDirect(body);
            if (direct.Count > 0)
            {
                var td = LoadoutCore.ApplyDirect(ship, direct, out var dc);
                changed += dc;
                if (t == null) t = td; else if (td != null) t.gear.AddRange(td.gear);
            }
            _lastApplied = t;
            return Result.Ok(new Dictionary<string, object>
            {
                ["applied"] = true,
                ["changed"] = changed,
                ["stale"] = stale, // handles that no longer matched (moved/sold) — client should refresh
                ["prior"] = t != null && (t.gear.Count > 0 || t.officers.Count > 0),
            });
        });

        // Restore the last applied transient's touched slots to their prior occupants (§V26).
        internal static Result LoadoutUndo() => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");
            var n = LoadoutCore.Undo(_lastApplied);
            _lastApplied = null; // one level of undo
            return Result.Ok(new Dictionary<string, object> { ["restored"] = n });
        });

        // ---- named loadout presets (gear snapshot + officer guids, persisted) ----

        internal static Result PresetsList() => MainThread.Run(()
            => Result.Ok(new Dictionary<string, object> { ["presets"] = Presets.List(PlaythroughId(GamePlayer.current), GamePlayer.current?.currentSpaceShip?.guid) }));

        // Snapshot the current ship's gear (fingerprints) + officer assignment under a name.
        internal static Result PresetSave(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var name = Str(body, "name")?.Trim();
            if (string.IsNullOrEmpty(name)) return Result.Err(400, "missing preset name");
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship");

            var gear = LoadoutCore.Snapshot(ship, name);
            var officers = CrewSupported() ? CollectOfficers(ship) : new List<string>(); // gated: CollectOfficers touches OfficerData
            Presets.Put(PlaythroughId(GamePlayer.current), ship.guid, name, new Presets.Preset { Ship = ship.shipClass?.displayName ?? name, ShipGuid = ship.guid, Gear = gear, Officers = officers });
            return Result.Ok(new Dictionary<string, object>
            {
                ["saved"] = name,
                ["gearSlots"] = gear.slots.Count,
                ["officers"] = officers.Count(g => !string.IsNullOrEmpty(g)),
            });
        });

        // Restore a preset onto the current ship: gear via the finder, officers by guid. Undoable.
        internal static Result PresetRestore(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (Echo) return Result.Err(409, "ECHO active");
            if (!Docked) return Result.Err(403, "not docked");
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship");
            var p = Presets.Get(PlaythroughId(GamePlayer.current), ship.guid, Str(body, "name") ?? "");
            if (p == null) return Result.Err(404, "no such preset");

            var officers = new List<OfficerAssign>();
            if (CrewSupported() && p.Officers != null)
                for (var i = 0; i < p.Officers.Count; i++)
                    if (!string.IsNullOrEmpty(p.Officers[i])) officers.Add(new OfficerAssign { slot = i, guid = p.Officers[i] });

            var t = LoadoutCore.ApplyTransient(ship, p.Gear, officers, CrewSupported(), out var changed);
            _lastApplied = t;
            return Result.Ok(new Dictionary<string, object>
            {
                ["restored"] = Str(body, "name"),
                ["changed"] = changed,
                ["prior"] = t != null && (t.gear.Count > 0 || t.officers.Count > 0),
            });
        });

        internal static Result PresetDelete(Dictionary<string, object> body) => MainThread.Run(()
            => Result.Ok(new Dictionary<string, object> { ["deleted"] = Presets.Remove(PlaythroughId(GamePlayer.current), GamePlayer.current?.currentSpaceShip?.guid, Str(body, "name") ?? "") }));

        // Export/import all presets for the current playthrough (portable JSON, moves between machines).
        internal static Result PresetsExport() => MainThread.Run(() =>
        {
            var pt = PlaythroughId(GamePlayer.current);
            return Result.Ok(new Dictionary<string, object>
            {
                ["playthrough"] = pt,
                ["playthroughName"] = Playthroughs.Name(pt),
                ["presets"] = Presets.Export(pt),
            });
        });

        internal static Result PresetsImport(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var pt = PlaythroughId(GamePlayer.current);
            if (string.IsNullOrEmpty(pt)) return Result.Err(409, "no active playthrough");
            var entries = body != null && body.TryGetValue("presets", out var pv) ? pv as List<object> : null;
            var n = Presets.Import(pt, entries);
            return Result.Ok(new Dictionary<string, object> { ["imported"] = n });
        });

        // Set (or clear, when empty) the pretty name for the current playthrough.
        internal static Result PlaythroughName(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var pt = PlaythroughId(GamePlayer.current);
            if (string.IsNullOrEmpty(pt)) return Result.Err(409, "no active playthrough");
            Playthroughs.SetName(pt, Str(body, "name") ?? "");
            return Result.Ok(new Dictionary<string, object> { ["playthrough"] = pt, ["name"] = Playthroughs.Name(pt) });
        });

        // Orphaned presets (untagged legacy entries) + claiming one into the current playthrough.
        internal static Result PresetsOrphans()
            => Result.Ok(new Dictionary<string, object> { ["presets"] = Presets.ListOrphans() });

        internal static Result PresetClaim(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var rawKey = Str(body, "rawKey")?.Trim() ?? Str(body, "name")?.Trim(); // rawKey identifies the orphan
            if (string.IsNullOrEmpty(rawKey)) return Result.Err(400, "missing preset key");
            var pt = PlaythroughId(GamePlayer.current);
            if (string.IsNullOrEmpty(pt)) return Result.Err(409, "no active playthrough");
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship to claim onto");
            switch (Presets.Claim(pt, ship.guid, rawKey))
            {
                case "missing": return Result.Err(404, "no such orphaned preset");
                case "conflict": return Result.Err(409, "a loadout with that name already exists on this ship");
                default: return Result.Ok(new Dictionary<string, object> { ["claimed"] = rawKey });
            }
        });

        // ---- request parsing ----

        private static LoadoutPreset ParseGear(Dictionary<string, object> body)
        {
            var p = new LoadoutPreset { name = "transient" };
            if (body != null && body.TryGetValue("slots", out var sv) && sv is List<object> arr)
                foreach (var o in arr)
                    if (o is Dictionary<string, object> d && !d.ContainsKey("store")) p.slots.Add(ParseSlot(d)); // fingerprint slots
            return p;
        }

        private static bool HasDirectSlots(Dictionary<string, object> body)
            => body != null && body.TryGetValue("slots", out var sv) && sv is List<object> arr
               && arr.Any(o => o is Dictionary<string, object> d && d.ContainsKey("store"));

        // Exact-handle gear slots {kind, slot, store, key, name, level}. The handle is re-resolved live
        // and validated against the identity the client saw; a mismatch (item moved/sold) is counted as
        // stale and skipped — never equips the wrong item.
        private static (List<DirectSlot> slots, int stale) ParseDirect(Dictionary<string, object> body)
        {
            var list = new List<DirectSlot>();
            var stale = 0;
            if (body != null && body.TryGetValue("slots", out var sv) && sv is List<object> arr)
                foreach (var o in arr)
                {
                    if (!(o is Dictionary<string, object> d) || !d.ContainsKey("store")) continue;
                    var kind = Str(d, "kind");
                    var isModule = kind == "Module";
                    // Modules are keyed by EquipmentSlot NAME (a string); turrets/boosters by array index (int).
                    string slotName = null; int slot = 0;
                    if (isModule) { slotName = Str(d, "slot"); if (string.IsNullOrEmpty(slotName)) { stale++; continue; } }
                    else if (!TryInt(d, "slot", out slot)) { stale++; continue; }
                    if (!TryInt(d, "key", out var key)) { stale++; continue; }
                    var inv = Stores.Resolve(Str(d, "store"));
                    var entry = inv != null ? Stores.FindEntry(inv, key) : null;
                    var name = Str(d, "name");
                    var lvl = Int(d, "level");
                    if (entry?.item == null
                        || (name != null && entry.item.displayName != name)
                        || (lvl > 0 && entry.item.itemLevel != lvl))
                    { stale++; continue; } // handle moved / no longer the same item
                    list.Add(new DirectSlot { kind = kind, slot = slot, slotName = slotName, item = entry.item, source = inv });
                }
            return (list, stale);
        }

        private static LoadoutSlot ParseSlot(Dictionary<string, object> d)
        {
            var s = new LoadoutSlot
            {
                kind = Str(d, "kind") ?? "",
                slot = Str(d, "slot") ?? "",
                identifier = Str(d, "identifier") ?? "",
                type = Str(d, "type") ?? "",
                name = Str(d, "name") ?? "",
                rarity = Str(d, "rarity") ?? "",
                level = Int(d, "level"),
                size = Str(d, "size") ?? "",
                mainStat = Str(d, "mainStat") ?? "",
                aspectSlotCount = Int(d, "aspectSlotCount"),
            };
            if (d.TryGetValue("aspects", out var av) && av is List<object> al)
                foreach (var a in al) if (a != null) s.aspects.Add(a.ToString());
            // stats accepted as ready fingerprint strings ("Stat=amount:cr") or as the /loadout DTO's
            // {stat, amount, canReroll} objects — normalized to the finder's string form either way.
            if (d.TryGetValue("stats", out var stv) && stv is List<object> sl)
                foreach (var x in sl)
                {
                    if (x is string str) s.stats.Add(str);
                    else if (x is Dictionary<string, object> sd)
                        s.stats.Add($"{Str(sd, "stat")}={LoadoutCore.Fmt((float)ToDbl(sd, "amount"))}:{(Bool(sd, "canReroll") ? 1 : 0)}");
                }
            return s;
        }

        private static List<OfficerAssign> ParseOfficers(Dictionary<string, object> body)
        {
            var list = new List<OfficerAssign>();
            if (body != null && body.TryGetValue("officers", out var ov) && ov is List<object> arr)
                foreach (var o in arr)
                    if (o is Dictionary<string, object> d)
                        list.Add(new OfficerAssign { slot = Int(d, "slot"), guid = Str(d, "guid") });
            return list;
        }

        // ---- helpers ----

        private static IEnumerable<(string id, ShopInventory shop)> EnumerateShops()
        {
            var st = SpaceStation.current;
            if (st == null)
                yield break;
            var all = new[]
            {
                st.generalShopInventory, st.miningShopInventory, st.salvageShopInventory,
                st.bountyShopInventory, st.patrolShopInventory, st.industryShopInventory,
                st.conquestShopInventory, st.umbralShopInventory,
            };
            foreach (var s in all)
                if (s != null)
                    yield return (s.facility.ToString(), s);
        }

        // Largest n (0..amount) whose volume still fits the inventory (no-cap stores never clamp).
        private static int ClampToSpace(Inventory inv, InventoryItemType item, int amount)
        {
            while (amount > 0 && inv.IsFull(item.m3 * amount))
                amount--;
            return amount;
        }

        private static long AddClamped(long a, long b)
            => (b > 0 && a > long.MaxValue - b) ? long.MaxValue : a + b;

        private static string Str(Dictionary<string, object> body, string key)
            => body != null && body.TryGetValue(key, out var v) && v != null ? v.ToString() : null;

        private static int Int(Dictionary<string, object> body, string key)
            => TryInt(body, key, out var n) ? n : 0;

        // True + parsed int when `key` is present and numeric; false when missing/non-numeric.
        // (Distinguishes an absent key from a legitimate slot 0.)
        private static bool TryInt(Dictionary<string, object> body, string key, out int val)
        {
            val = 0;
            if (body == null || !body.TryGetValue(key, out var v) || v == null)
                return false;
            try { val = (int)Math.Round(Convert.ToDouble(v, CultureInfo.InvariantCulture)); return true; }
            catch { return false; }
        }

        private static bool Bool(Dictionary<string, object> d, string key)
            => d != null && d.TryGetValue(key, out var v) && v is bool b && b;

        private static double ToDbl(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v) || v == null) return 0;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return 0; }
        }
    }
}
