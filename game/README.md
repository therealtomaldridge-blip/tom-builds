# GREED 💰 — 3D multiplayer party game

Climb a vault tower, grab loot, **shove your friends off ledges to steal their haul**, and reach the
gold **EXIT** at the top before the rising lava catches you. Bank what you carry; greedy players who
linger too long lose everything. Highest banked across 3 rounds wins.

Built to ride the 2026 viral formula: co-op chaos with friends, daring risk/reward, instant
zero-install browser join, and clippable betrayal moments.

## Stack
- **Server:** Node.js + `ws` — authoritative for game logic (loot, banking, shove, lava, scoring),
  also serves the static client. No database.
- **Client:** vanilla JS + **Three.js** (loaded from CDN via import map — no build step). Local
  player uses client-side prediction; remote players are interpolated from 20 Hz server snapshots.

## Run it locally
```bash
cd game
npm install
npm start
# open http://localhost:3000
```
Open the URL in 2–3 browser tabs (or share your LAN IP). One player clicks **Create a room**, the
others **Join** with the 4-letter code (or open the copied `?r=CODE` link). Host hits **START**.

### Controls
- **Move:** WASD / arrows (or the on-screen stick on mobile)
- **Look:** mouse (click to capture pointer) / drag on the right side on mobile
- **Jump:** Space · **Grab loot:** E · **Shove:** F or click

## Test (no browser needed)
```bash
npm test
```
Runs a headless multi-client WebSocket smoke test covering room create/join, match start,
position sync, loot grab, banking, and shove-to-steal.

## Deploy (free tiers)
It's a single Node process serving everything on one port, so it drops onto most hosts:
- **Render / Railway / Fly.io:** new Web Service from this repo, build `npm install`, start
  `npm start`. Bind to `process.env.PORT` (already handled).
- WebSockets work out of the box on these (they proxy `wss://`).
- Three.js loads from a public CDN, so no asset pipeline is required.

## What's in v1 vs. later
**In:** lobby + room links, 3D tower with platforms/loot, gravity/jump physics, rising lava,
grab/carry-weight, exit banking, shove-to-steal, 3 rounds + scoreboard, desktop + mobile controls.

**Not yet (documented next steps):**
- **Monetization hooks:** the natural spots are (a) cosmetic player skins/trails — extend the player
  color into a skin picker in the lobby and gate premium ones, and (b) an interstitial ad between
  rounds (drop an ad-network snippet into the results screen in `public/index.html`). Neither is
  wired to a real provider in v1 — it needs your account/keys.
- Persistence/accounts, anti-cheat (movement is client-trusted for feel), matchmaking, more maps,
  sound. Real profitability depends on getting players — the design is built so funny clips
  (shoving friends into lava) are the marketing engine for TikTok/Shorts.

## Roblox path (bigger revenue, needs you)
The same design maps cleanly onto a Roblox experience (built-in multiplayer, audience, Robux). That
route needs hands-on publishing + DevEx setup on your account; the deliverable there would be Luau
scripts + a Studio assembly/publish guide.
