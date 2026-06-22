# GREED in Unity — setup (60 seconds)

A single-player, paste-and-play port of GREED. One C# file, no scene building,
no prefabs.

## Steps
1. **Create a project:** Unity Hub → New Project → **3D** template (Built-in or
   URP both work). Unity 2021 LTS or newer recommended.
2. **Enable old input:** `Edit → Project Settings → Player → Other Settings →
   Active Input Handling` → set to **Both** (or *Input Manager (Old)*).
   *(New projects sometimes default to the new Input System, which disables the
   `Input.GetAxis` calls this script uses.)*
3. **Add the script:** drag `GreedGame.cs` into the `Assets/` folder (anywhere).
4. **Press Play.** The game bootstraps itself — it creates the camera, lights,
   the vault tower, loot, lava and your player automatically. Nothing to wire.

## Controls
- **Move:** WASD / Arrow keys
- **Look:** mouse (the cursor locks on Play; press **Esc** to free it)
- **Jump:** Space
- **Grab loot:** just walk into it (auto-pickup)
- **Bank:** stand on the gold **EXIT** platform at the top with loot in your bag

## The game
Climb the tower grabbing coins (1), gems (3) and treasure (10). The more you
carry the **slower you move and the lower you jump** — that's the greed. The lava
rises from below and gets faster each round. Reach the EXIT and bank before it
catches you; if it catches you, you lose everything you're carrying. 3 rounds,
cumulative score, high score saved locally.

## Notes / next steps
- This is the **single-player core loop**. The **shove-to-steal** mechanic and
  **online multiplayer with friends** belong to the networked build — in Unity
  that means adding a netcode package (Mirror is the easiest free option) plus
  player/loot prefabs. Say the word and I'll provide that version + a guide.
- Everything is built from Unity primitives in code (clean low-poly look). Swap
  in real models/materials later by replacing the `MakePlatform` / `MakeLoot` /
  `SpawnPlayer` mesh creation.
- If colours look flat in URP, that's just the default lit material — it still
  runs correctly.
