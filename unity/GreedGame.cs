// =============================================================================
//  GREED — single-player Unity prototype  (paste-and-play, no scene setup)
// -----------------------------------------------------------------------------
//  HOW TO USE
//    1. New Unity project (3D). Edit > Project Settings > Player >
//       "Active Input Handling" = Both (or Input Manager (Old)).
//    2. Drop this file anywhere in Assets/.  (Filename can stay GreedGame.cs.)
//    3. Press Play. That's it — the game bootstraps itself, no GameObjects to
//       wire, no prefabs. Works in Built-in or URP render pipelines.
//
//  GAME
//    Climb the vault tower and grab loot (coins/gems/treasure). The more you
//    carry the slower and lower you jump — that's the greed. Lava rises from
//    below; reach the gold EXIT at the top and BANK your haul before it catches
//    you. Get caught and you lose everything you're carrying. 3 rounds, the
//    lava gets faster each round. Beat your high score (saved locally).
//
//  CONTROLS
//    Move WASD/Arrows · Look = mouse · Jump = Space · loot is auto-grabbed by
//    walking into it · Esc frees the cursor.
//
//  NOTE: Shove-to-steal and online play are part of the multiplayer build; this
//  single-player version focuses on the climb/greed/escape core loop.
// =============================================================================

using System.Collections.Generic;
using UnityEngine;

// -----------------------------------------------------------------------------
//  Bootstrap: spawns the manager automatically, so nothing needs to be in the
//  scene. Runs once when Play is pressed.
// -----------------------------------------------------------------------------
public static class GreedBootstrap
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Boot()
    {
        if (Object.FindObjectOfType<GreedManager>() != null) return;
        var go = new GameObject("GreedManager");
        go.AddComponent<GreedManager>();
    }
}

// -----------------------------------------------------------------------------
//  Small data + utility
// -----------------------------------------------------------------------------
public class LootItem : MonoBehaviour
{
    public int value;
    public string kind;
    public bool taken;
    public float spin;
    void Update() { if (!taken) transform.Rotate(0f, spin * Time.deltaTime * 90f, 0f); }
}

public static class GreedUtil
{
    // Robustly tints a primitive across Built-in (_Color) and URP (_BaseColor).
    public static void Tint(GameObject go, Color c, float emissive = 0f)
    {
        var r = go.GetComponent<Renderer>();
        if (r == null) return;
        var m = r.material;
        if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
        if (m.HasProperty("_Color")) m.SetColor("_Color", c);
        if (emissive > 0f && m.HasProperty("_EmissionColor"))
        {
            m.EnableKeyword("_EMISSION");
            m.SetColor("_EmissionColor", c * emissive);
        }
    }
    public static void StripCollider(GameObject go)
    {
        var col = go.GetComponent<Collider>();
        if (col != null) Object.Destroy(col);
    }
}

// -----------------------------------------------------------------------------
//  Main game manager: builds the world, owns round/score state, draws the HUD.
// -----------------------------------------------------------------------------
public class GreedManager : MonoBehaviour
{
    // --- tuning ---
    const int MAX_ROUNDS = 3;
    const float ARENA_R = 9f;
    const int LEVELS = 12;
    const float GAP_Y = 4.2f;

    enum State { Ready, Playing, RoundEnd, GameOver }
    State state = State.Ready;

    int round = 0;
    int totalBanked = 0;
    int lastRoundBanked = 0;
    bool lastRoundWon = false;
    int highScore = 0;

    // world
    Transform world;
    readonly List<LootItem> loot = new List<LootItem>();
    GameObject lava;
    float lavaY, lavaSpeed, exitY;
    Vector3 exitPos;

    PlayerController player;
    Camera cam;
    GUIStyle big, mid, pill;

    void Start()
    {
        highScore = PlayerPrefs.GetInt("greed_high", 0);
        SetupCameraAndLight();
        Application.targetFrameRate = 60;
    }

    void SetupCameraAndLight()
    {
        var camGo = new GameObject("GreedCamera");
        cam = camGo.AddComponent<Camera>();
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.08f, 0.06f, 0.16f);
        cam.fieldOfView = 70f;
        cam.tag = "MainCamera";
        camGo.AddComponent<AudioListener>();
        RenderSettings.fog = true;
        RenderSettings.fogColor = new Color(0.08f, 0.06f, 0.16f);
        RenderSettings.fogMode = FogMode.Linear;
        RenderSettings.fogStartDistance = 24f;
        RenderSettings.fogEndDistance = 70f;

        var sunGo = new GameObject("Sun");
        var sun = sunGo.AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.color = new Color(1f, 0.95f, 0.85f);
        sun.intensity = 1.1f;
        sunGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
        RenderSettings.ambientLight = new Color(0.45f, 0.42f, 0.55f);
    }

    // ------------------------------------------------------------------ rounds
    void StartGame()
    {
        round = 0; totalBanked = 0;
        NextRound();
    }

    void NextRound()
    {
        round++;
        BuildWorld(round);
        lavaY = -3f;
        lavaSpeed = 0.85f + round * 0.45f;   // faster each round
        lastRoundBanked = 0;
        SpawnPlayer();
        Cursor.lockState = CursorLockMode.Locked;
        Cursor.visible = false;
        state = State.Playing;
    }

    void EndRound(bool won)
    {
        lastRoundWon = won;
        lastRoundBanked = won ? player.carriedValue : 0;
        if (won) totalBanked += player.carriedValue;
        player.Freeze();
        Cursor.lockState = CursorLockMode.None;
        Cursor.visible = true;

        if (round >= MAX_ROUNDS)
        {
            state = State.GameOver;
            if (totalBanked > highScore) { highScore = totalBanked; PlayerPrefs.SetInt("greed_high", highScore); PlayerPrefs.Save(); }
        }
        else state = State.RoundEnd;
    }

    // ------------------------------------------------------------------- world
    void BuildWorld(int diff)
    {
        if (world != null) Destroy(world.gameObject);
        loot.Clear();
        world = new GameObject("World").transform;

        // ground
        MakePlatform(new Vector3(0, -0.5f, 0), new Vector3(ARENA_R * 2, 1, ARENA_R * 2), new Color(0.16f, 0.14f, 0.25f), false);

        string[] kinds = { "coin", "coin", "coin", "gem", "gem", "treasure" };
        int levels = LEVELS + diff;            // a little taller each round
        for (int i = 1; i <= levels; i++)
        {
            float y = i * GAP_Y;
            int n = 1 + Random.Range(0, 2);
            for (int k = 0; k < n; k++)
            {
                float sx = 3f + Random.value * 2f, sz = 3f + Random.value * 2f;
                float x = (Random.value * 2 - 1) * (ARENA_R - sx / 2 - 0.5f);
                float z = (Random.value * 2 - 1) * (ARENA_R - sz / 2 - 0.5f);
                MakePlatform(new Vector3(x, y, z), new Vector3(sx, 0.6f, sz), new Color(0.29f, 0.25f, 0.42f), false);
                int lc = 1 + Random.Range(0, 2);
                for (int j = 0; j < lc; j++)
                {
                    string kind = kinds[Random.Range(0, kinds.Length)];
                    Vector3 lp = new Vector3(
                        x + (Random.value * 2 - 1) * (sx / 2 - 0.6f),
                        y + 0.9f,
                        z + (Random.value * 2 - 1) * (sz / 2 - 0.6f));
                    MakeLoot(kind, lp);
                }
            }
        }

        exitY = (levels + 1) * GAP_Y;
        exitPos = new Vector3(0, exitY, 0);
        var exit = MakePlatform(exitPos + Vector3.down * 0.3f, new Vector3(5f, 0.6f, 5f), new Color(1f, 0.82f, 0.4f), true);
        GreedUtil.Tint(exit, new Color(1f, 0.82f, 0.4f), 0.5f);

        // lava
        lava = GameObject.CreatePrimitive(PrimitiveType.Cube);
        lava.name = "Lava";
        lava.transform.SetParent(world);
        lava.transform.localScale = new Vector3(ARENA_R * 6, 1f, ARENA_R * 6);
        GreedUtil.StripCollider(lava);
        GreedUtil.Tint(lava, new Color(1f, 0.28f, 0.12f), 0.8f);
    }

    GameObject MakePlatform(Vector3 pos, Vector3 scale, Color c, bool exit)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.transform.SetParent(world);
        go.transform.position = pos;
        go.transform.localScale = scale;
        GreedUtil.Tint(go, c);
        return go;
    }

    void MakeLoot(string kind, Vector3 pos)
    {
        GameObject go;
        Color c; int val; float scale;
        if (kind == "coin") { go = GameObject.CreatePrimitive(PrimitiveType.Cylinder); c = new Color(1f, 0.82f, 0.4f); val = 1; scale = 0.5f; go.transform.localScale = new Vector3(0.55f, 0.06f, 0.55f); }
        else if (kind == "gem") { go = GameObject.CreatePrimitive(PrimitiveType.Sphere); c = new Color(0.3f, 0.79f, 0.94f); val = 3; scale = 0.55f; go.transform.localScale = Vector3.one * 0.6f; }
        else { go = GameObject.CreatePrimitive(PrimitiveType.Cube); c = new Color(1f, 0.67f, 0f); val = 10; scale = 0.7f; go.transform.localScale = new Vector3(0.8f, 0.6f, 0.6f); }

        go.transform.SetParent(world);
        go.transform.position = pos;
        GreedUtil.StripCollider(go);
        GreedUtil.Tint(go, c, 0.35f);
        var li = go.AddComponent<LootItem>();
        li.kind = kind; li.value = val; li.spin = (kind == "coin") ? 1f : 0.4f;
        loot.Add(li);
    }

    void SpawnPlayer()
    {
        if (player != null) Destroy(player.gameObject);
        var root = new GameObject("Player");
        root.transform.position = new Vector3(0, 1.5f, 0);
        var cc = root.AddComponent<CharacterController>();
        cc.height = 1.8f; cc.radius = 0.4f; cc.center = new Vector3(0, 0.9f, 0); cc.stepOffset = 0.4f;

        var vis = GameObject.CreatePrimitive(PrimitiveType.Capsule);
        vis.transform.SetParent(root.transform);
        vis.transform.localPosition = new Vector3(0, 0.9f, 0);
        vis.transform.localScale = new Vector3(0.8f, 0.9f, 0.8f);
        GreedUtil.StripCollider(vis);
        GreedUtil.Tint(vis, new Color(1f, 0.35f, 0.37f), 0.15f);

        player = root.AddComponent<PlayerController>();
        player.Init(this, cam);
    }

    // -------------------------------------------------------- queries for player
    public float ArenaR => ARENA_R;
    public bool IsPlaying => state == State.Playing;

    public void TryPickup(Vector3 p, PlayerController pc)
    {
        for (int i = 0; i < loot.Count; i++)
        {
            var l = loot[i];
            if (l == null || l.taken) continue;
            if ((l.transform.position - p).sqrMagnitude < 1.6f * 1.6f)
            {
                l.taken = true;
                l.gameObject.SetActive(false);
                pc.carry++; pc.carriedValue += l.value;
            }
        }
    }

    public bool AtExit(Vector3 p)
    {
        return Mathf.Abs(p.x - exitPos.x) < 2.6f && Mathf.Abs(p.z - exitPos.z) < 2.6f
            && p.y > exitY - 1.0f && p.y < exitY + 4f;
    }

    public float LavaY => lavaY;

    // --------------------------------------------------------------------- loop
    void Update()
    {
        if (state == State.Playing)
        {
            lavaY += lavaSpeed * Time.deltaTime;
            if (lava != null) lava.transform.position = new Vector3(0, lavaY, 0);

            if (player != null && player.alive)
            {
                Vector3 pp = player.transform.position;
                // bank
                if (player.carry > 0 && AtExit(pp)) { EndRound(true); return; }
                // caught by lava
                if (pp.y < lavaY + 0.4f) { player.Die(); EndRound(false); return; }
            }
        }
        if (Input.GetKeyDown(KeyCode.Escape)) { Cursor.lockState = CursorLockMode.None; Cursor.visible = true; }
    }

    // ---------------------------------------------------------------------- HUD
    void EnsureStyles()
    {
        if (big != null) return;
        big = new GUIStyle(GUI.skin.label) { fontSize = 34, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter, normal = { textColor = Color.white } };
        mid = new GUIStyle(GUI.skin.label) { fontSize = 18, alignment = TextAnchor.MiddleCenter, normal = { textColor = new Color(0.85f, 0.82f, 0.95f) } };
        pill = new GUIStyle(GUI.skin.box) { fontSize = 18, fontStyle = FontStyle.Bold, normal = { textColor = Color.white } };
    }

    void OnGUI()
    {
        EnsureStyles();
        float w = Screen.width, h = Screen.height;

        if (state == State.Playing)
        {
            string bag = player != null ? $"Bag: {player.carry}  (${player.carriedValue})" : "";
            string danger = (player != null) ? Mathf.Max(0, player.transform.position.y - lavaY).ToString("0.0") : "";
            GUI.Box(new Rect(w / 2 - 220, 12, 130, 36), $"Round {round}/{MAX_ROUNDS}", pill);
            GUI.Box(new Rect(w / 2 - 80, 12, 200, 36), bag, pill);
            GUI.Box(new Rect(w / 2 + 130, 12, 130, 36), $"Banked: ${totalBanked}", pill);
            // danger gauge
            float gap = player != null ? player.transform.position.y - lavaY : 99;
            string warn = gap < 4 ? "LAVA CLOSE — GET TO THE EXIT!" : "Climb - grab loot - bank at the top EXIT";
            var s = new GUIStyle(mid); if (gap < 4) s.normal.textColor = new Color(1f, 0.4f, 0.3f);
            GUI.Label(new Rect(0, h - 60, w, 30), warn, s);
            return;
        }

        // panels for menu/results
        float pw = 460, ph = 320;
        Rect r = new Rect(w / 2 - pw / 2, h / 2 - ph / 2, pw, ph);
        GUI.Box(r, "");
        GUILayout.BeginArea(new Rect(r.x + 24, r.y + 22, pw - 48, ph - 44));

        if (state == State.Ready)
        {
            GUILayout.Label("GREED", big);
            GUILayout.Space(6);
            GUILayout.Label("Climb the vault. Grab loot — but the more you carry,\nthe slower you move. Bank it at the top EXIT before\nthe rising lava catches you. 3 rounds. Be greedy.", mid);
            GUILayout.Space(14);
            GUILayout.Label($"High score: ${highScore}", mid);
            GUILayout.Space(10);
            if (GUILayout.Button("START", GUILayout.Height(48))) StartGame();
        }
        else if (state == State.RoundEnd)
        {
            GUILayout.Label(lastRoundWon ? "BANKED!" : "CAUGHT!", big);
            GUILayout.Space(6);
            GUILayout.Label(lastRoundWon ? $"You banked ${lastRoundBanked} this round." : "The lava took your haul. $0 this round.", mid);
            GUILayout.Space(8);
            GUILayout.Label($"Total banked: ${totalBanked}", mid);
            GUILayout.Space(16);
            if (GUILayout.Button($"Next round ({round + 1}/{MAX_ROUNDS})", GUILayout.Height(48))) NextRound();
        }
        else if (state == State.GameOver)
        {
            GUILayout.Label("GAME OVER", big);
            GUILayout.Space(6);
            GUILayout.Label($"You banked ${totalBanked} across {MAX_ROUNDS} rounds.", mid);
            GUILayout.Label(totalBanked >= highScore ? "NEW HIGH SCORE!" : $"High score: ${highScore}", mid);
            GUILayout.Space(16);
            if (GUILayout.Button("PLAY AGAIN", GUILayout.Height(48))) StartGame();
        }
        GUILayout.EndArea();
    }
}

// -----------------------------------------------------------------------------
//  Player: movement (CharacterController), camera, auto-pickup. Carry weight
//  slows movement & jump — the "greed" tradeoff.
// -----------------------------------------------------------------------------
public class PlayerController : MonoBehaviour
{
    GreedManager mgr;
    Camera cam;
    CharacterController cc;

    public int carry = 0;
    public int carriedValue = 0;
    public bool alive = true;
    bool frozen = false;

    float vSpeed = 0f;
    float yaw = 0f, pitch = 18f;
    const float GRAV = 25f, JUMP = 9.5f, MOVE = 7f, SENS = 2.4f, CAM_DIST = 8.5f;

    public void Init(GreedManager m, Camera c) { mgr = m; cam = c; cc = GetComponent<CharacterController>(); alive = true; frozen = false; }
    public void Freeze() { frozen = true; }
    public void Die() { alive = false; frozen = true; foreach (var r in GetComponentsInChildren<Renderer>()) r.enabled = false; }

    float Speed() => Mathf.Max(3.5f, MOVE * (1f - 0.05f * carry));
    float JumpV() => Mathf.Max(7f, JUMP * (1f - 0.03f * carry));

    void Update()
    {
        if (cc == null || mgr == null) return;

        // camera look
        if (!frozen && Cursor.lockState == CursorLockMode.Locked)
        {
            yaw += Input.GetAxis("Mouse X") * SENS;
            pitch = Mathf.Clamp(pitch - Input.GetAxis("Mouse Y") * SENS, -10f, 70f);
        }

        if (!frozen && mgr.IsPlaying)
        {
            // input relative to camera yaw
            float ix = Input.GetAxisRaw("Horizontal");
            float iz = Input.GetAxisRaw("Vertical");
            Vector3 fwd = new Vector3(Mathf.Sin(yaw * Mathf.Deg2Rad), 0, Mathf.Cos(yaw * Mathf.Deg2Rad));
            Vector3 right = new Vector3(fwd.z, 0, -fwd.x);
            Vector3 dir = (fwd * iz + right * ix);
            if (dir.sqrMagnitude > 1f) dir.Normalize();

            if (cc.isGrounded)
            {
                if (vSpeed < 0) vSpeed = -2f;
                if (Input.GetButtonDown("Jump") || Input.GetKeyDown(KeyCode.Space)) vSpeed = JumpV();
            }
            vSpeed -= GRAV * Time.deltaTime;

            Vector3 move = dir * Speed();
            move.y = vSpeed;
            cc.Move(move * Time.deltaTime);

            // face movement direction
            if (dir.sqrMagnitude > 0.01f)
                transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(dir), 12f * Time.deltaTime);

            // clamp to arena
            float R = mgr.ArenaR - 0.4f;
            Vector3 p = transform.position;
            p.x = Mathf.Clamp(p.x, -R, R); p.z = Mathf.Clamp(p.z, -R, R);
            if (p.y < -10f) p.y = -10f;
            transform.position = p;

            mgr.TryPickup(transform.position, this);
        }
    }

    void LateUpdate()
    {
        if (cam == null) return;
        Vector3 target = transform.position + Vector3.up * 1.4f;
        float pr = pitch * Mathf.Deg2Rad, yr = yaw * Mathf.Deg2Rad;
        Vector3 offset = new Vector3(
            -Mathf.Sin(yr) * Mathf.Cos(pr),
            Mathf.Sin(pr) + 0.25f,
            -Mathf.Cos(yr) * Mathf.Cos(pr)) * CAM_DIST;
        cam.transform.position = Vector3.Lerp(cam.transform.position, target + offset, 10f * Time.deltaTime);
        cam.transform.LookAt(target);
    }
}
