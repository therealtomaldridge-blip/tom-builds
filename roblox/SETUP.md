# GREED on Roblox — setup & test (paste two scripts)

Roblox gives you online multiplayer, movement, jumping, camera and mobile
controls for free. You just paste in two scripts and the game builds itself.

## 1. Install & create
1. Install **Roblox Studio** (free) from create.roblox.com → log in.
2. **New** → **Baseplate** template.
3. In the **Explorer** panel, click the default **Baseplate** part and delete it
   (and its SpawnLocation if separate). GREED builds its own arena + spawn.
   *(Explorer/Properties not visible? View tab → tick **Explorer** and **Properties**.)*

## 2. Paste the SERVER script
1. In Explorer, hover **ServerScriptService** → **＋** → **Script**.
2. Select everything in it (Ctrl+A) and paste the contents of
   **`GreedServer.server.lua`**.

## 3. Paste the CLIENT script
1. In Explorer, expand **StarterPlayer** → hover **StarterPlayerScripts** → **＋**
   → **LocalScript**.
2. Select all and paste the contents of **`GreedClient.client.lua`**.

## 4. Test play
- **Solo:** press the big **▶ Play** button (top). You'll spawn in the arena —
  climb, grab loot, bank on the gold EXIT up top before the lava rises.
- **With fake friends (multiplayer test):** **Test** tab → **Clients and Servers**
  → set 2 players → **Start**. Studio opens multiple windows so you can test the
  shoving/stealing.

### Controls (all built in by Roblox)
Move = WASD / left stick · jump = Space / button · look = mouse / drag ·
**Shove = F** (or the on-screen **SHOVE** button on mobile) · grab loot by
walking into it. Your **Bag** and **Banked** totals show in the player list
(top-right) automatically.

## 5. Publish so real friends can join (online!)
1. **File → Publish to Roblox As…** → give it a name → **Create**.
2. **Home tab → Game Settings → Permissions → Public** (and set the audience age).
3. On the Roblox website open your game's page and **share the link** — friends
   click Play and join your live server. Roblox hosts it; no servers to run.

## What this version includes
Procedural vault tower (new layout each round), coins/gems/treasure, carry-weight
slowdown (the greed tradeoff), rising lava that speeds up each round, exit
banking, **shove-to-steal** between players, 3-round loop, and an auto Bag/Banked
leaderboard.

## Tuning & next steps
- All knobs are in the `CFG` table at the top of the server script (arena size,
  round time, lava speed, levels). Tweak and re-Play.
- Want **monetization**? Roblox has it built in — add a Developer Product or
  Game Pass (e.g., a cosmetic trail or a "double bag" perk) via Studio's
  Monetization page, then handle the purchase in the server script. I can wire
  a specific one up if you tell me what to sell.
- Want nicer visuals (real models instead of neon blocks), sound, or a proper
  round-winner screen? Say the word.
