/*
 * GREED — authoritative game server
 * -----------------------------------
 * - Serves the static client (public/) over plain HTTP.
 * - Runs WebSocket rooms keyed by a 4-letter code.
 * - Authoritative for game LOGIC: loot ownership, banking, shove/steal,
 *   rising lava, deaths, round timer and scoring.
 * - Movement is client-simulated (client-side prediction) for snappy feel;
 *   the server stores each client's reported position for proximity checks
 *   and clamps it to the arena bounds. (No anti-cheat in v1 — documented.)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

/* ----------------------------- static server ----------------------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

/* --------------------------------- config --------------------------------- */
const CFG = {
  TICK_MS: 50,            // 20 Hz snapshots
  ROUND_SEC: 75,
  MAX_ROUNDS: 3,
  MIN_PLAYERS: 1,         // allow solo testing
  MAX_PLAYERS: 6,
  GRAB_RADIUS: 2.0,
  SHOVE_RADIUS: 2.4,
  SHOVE_ARC: 0.55,        // dot-product threshold for "in front"
  SHOVE_FORCE: 9,
  ARENA_R: 8,             // half-extent of square tower footprint
  LOOT_VALUE: { coin: 1, gem: 3, treasure: 10 },
};
const COLORS = ["#ff5a5f", "#ffd166", "#06d6a0", "#4cc9f0", "#c77dff", "#ff8fab"];

/* --------------------------------- helpers -------------------------------- */
function code4() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0];
  return s;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ------------------------------- map builder ------------------------------ */
function makeMap() {
  const R = CFG.ARENA_R;
  const platforms = [];
  const loot = [];
  let lid = 0;

  // ground floor
  platforms.push({ x: 0, y: 0, z: 0, sx: R * 2, sy: 1, sz: R * 2, ground: true });

  const levels = 12;
  const gapY = 4.2;
  const types = ["coin", "coin", "coin", "gem", "gem", "treasure"];

  for (let i = 1; i <= levels; i++) {
    const y = i * gapY;
    const n = 1 + ((Math.random() * 2) | 0); // 1–2 platforms
    for (let k = 0; k < n; k++) {
      const sx = 3 + Math.random() * 2, sz = 3 + Math.random() * 2;
      const x = (Math.random() * 2 - 1) * (R - sx / 2 - 0.5);
      const z = (Math.random() * 2 - 1) * (R - sz / 2 - 0.5);
      platforms.push({ x, y, z, sx, sy: 0.6, sz });
      const lc = 1 + ((Math.random() * 2) | 0);
      for (let j = 0; j < lc; j++) {
        const kind = types[(Math.random() * types.length) | 0];
        loot.push({
          id: lid++, kind, value: CFG.LOOT_VALUE[kind],
          x: x + (Math.random() * 2 - 1) * (sx / 2 - 0.6),
          y: y + 0.7,
          z: z + (Math.random() * 2 - 1) * (sz / 2 - 0.6),
          holder: null, banked: false,
        });
      }
    }
  }
  const exitY = (levels + 1) * gapY;
  platforms.push({ x: 0, y: exitY, z: 0, sx: 4.5, sy: 0.6, sz: 4.5, exit: true });
  return { platforms, loot, exitY, towerHeight: exitY + 2, R };
}

/* ---------------------------------- rooms --------------------------------- */
const rooms = new Map();

function makeRoom() {
  const code = (() => { let c; do { c = code4(); } while (rooms.has(c)); return c; })();
  const room = {
    code, players: new Map(), hostId: null,
    state: "lobby",          // lobby | playing | intermission | over
    map: null, lava: -2, round: 0, timeLeft: 0, loopTimer: null, interTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}
function send(p, msg) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, color: p.color, host: p.id === room.hostId,
    total: p.total,
  }));
}

function lobbyUpdate(room) {
  broadcast(room, { t: "lobby", code: room.code, state: room.state, players: publicPlayers(room) });
}

/* -------------------------------- match flow ------------------------------ */
function startMatch(room) {
  if (room.state === "playing") return;
  room.round = 0;
  for (const p of room.players.values()) p.total = 0;
  nextRound(room);
}

function nextRound(room) {
  clearTimeout(room.interTimer);
  room.round++;
  room.map = makeMap();
  room.lava = -2;
  room.timeLeft = CFG.ROUND_SEC;
  room.state = "playing";
  room.roundStart = Date.now();

  let i = 0;
  for (const p of room.players.values()) {
    p.alive = true;
    p.carry = [];        // loot ids being carried
    p.roundBanked = 0;
    const ang = (i / Math.max(1, room.players.size)) * Math.PI * 2;
    p.pos = { x: Math.cos(ang) * 3, y: 1.2, z: Math.sin(ang) * 3 };
    p.yaw = 0;
    i++;
  }

  broadcast(room, {
    t: "start",
    round: room.round, maxRounds: CFG.MAX_ROUNDS,
    map: room.map, roundSec: CFG.ROUND_SEC,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, pos: p.pos })),
  });

  clearInterval(room.loopTimer);
  room.loopTimer = setInterval(() => tick(room), CFG.TICK_MS);
}

function endRound(room) {
  clearInterval(room.loopTimer);
  room.loopTimer = null;
  for (const p of room.players.values()) p.total += p.roundBanked;

  const scores = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, color: p.color, round: p.roundBanked, total: p.total }))
    .sort((a, b) => b.total - a.total);

  const done = room.round >= CFG.MAX_ROUNDS;
  room.state = done ? "over" : "intermission";
  broadcast(room, { t: done ? "gameover" : "roundover", round: room.round, scores });

  if (done) {
    room.round = 0;
    room.state = "lobby";
    setTimeout(() => { if (rooms.has(room.code)) lobbyUpdate(room); }, 50);
  } else {
    room.interTimer = setTimeout(() => { if (rooms.has(room.code)) nextRound(room); }, 6000);
  }
}

function lootAt(room, l) { return { t: "loot", id: l.id, holder: l.holder, banked: l.banked, x: l.x, y: l.y, z: l.z }; }

function tick(room) {
  const elapsed = (Date.now() - room.roundStart) / 1000;
  room.timeLeft = Math.max(0, CFG.ROUND_SEC - elapsed);

  // lava rises from -2 up to just above the exit by the end of the round
  const top = room.map.exitY + 1.5;
  room.lava = -2 + (elapsed / CFG.ROUND_SEC) * (top + 2);

  // deaths + auto-bank
  let aliveCount = 0;
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    // clamp reported position into arena
    const R = CFG.ARENA_R;
    p.pos.x = clamp(p.pos.x, -R, R);
    p.pos.z = clamp(p.pos.z, -R, R);
    p.pos.y = clamp(p.pos.y, -5, room.map.towerHeight + 3);

    // caught by lava
    if (p.pos.y < room.lava + 0.4) {
      p.alive = false;
      // carried loot is consumed by the lava (lost)
      for (const id of p.carry) {
        const l = room.map.loot[id];
        if (l) { l.holder = null; l.banked = false; l.y = -50; broadcast(room, lootAt(room, l)); }
      }
      p.carry = [];
      broadcast(room, { t: "died", id: p.id });
      continue;
    }
    aliveCount++;

    // banking at the exit platform
    if (p.carry.length > 0) {
      const ex = room.map; // exit at 0,exitY,0
      const onExit = Math.abs(p.pos.x) < 2.4 && Math.abs(p.pos.z) < 2.4 &&
                     p.pos.y > ex.exitY - 0.5 && p.pos.y < ex.exitY + 4;
      if (onExit) {
        let amount = 0;
        for (const id of p.carry) {
          const l = room.map.loot[id];
          if (l) { l.banked = true; l.holder = null; amount += l.value; broadcast(room, lootAt(room, l)); }
        }
        p.roundBanked += amount;
        p.carry = [];
        broadcast(room, { t: "banked", id: p.id, amount, round: p.roundBanked });
      }
    }
  }

  // snapshot
  broadcast(room, {
    t: "snap",
    lava: +room.lava.toFixed(2),
    time: +room.timeLeft.toFixed(1),
    players: [...room.players.values()].map((p) => ({
      id: p.id, x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2),
      r: +p.yaw.toFixed(2), c: p.carry.length, a: p.alive ? 1 : 0, b: p.roundBanked,
    })),
  });

  if (room.timeLeft <= 0 || (room.players.size > 0 && aliveCount === 0)) endRound(room);
}

/* ------------------------------- player actions --------------------------- */
function tryGrab(room, p) {
  if (!p.alive) return;
  let best = null, bestD = CFG.GRAB_RADIUS * CFG.GRAB_RADIUS;
  for (const l of room.map.loot) {
    if (l.holder !== null || l.banked) continue;
    const dx = l.x - p.pos.x, dy = l.y - p.pos.y, dz = l.z - p.pos.z;
    const d = dx * dx + dy * dy * 0.5 + dz * dz;
    if (d < bestD) { bestD = d; best = l; }
  }
  if (best) {
    best.holder = p.id;
    p.carry.push(best.id);
    broadcast(room, lootAt(room, best));
  }
}

function tryShove(room, p) {
  if (!p.alive) return;
  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw); // facing direction
  let target = null, bestD = CFG.SHOVE_RADIUS * CFG.SHOVE_RADIUS;
  for (const o of room.players.values()) {
    if (o.id === p.id || !o.alive) continue;
    const dx = o.pos.x - p.pos.x, dy = o.pos.y - p.pos.y, dz = o.pos.z - p.pos.z;
    const d = dx * dx + dz * dz;
    if (d > bestD || Math.abs(dy) > 2.5) continue;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const dot = (dx / len) * fx + (dz / len) * fz; // in front?
    if (dot < CFG.SHOVE_ARC) continue;
    if (d < bestD) { bestD = d; target = o; }
  }
  if (!target) return;

  // knockback direction (away from shover)
  const len = Math.sqrt((target.pos.x - p.pos.x) ** 2 + (target.pos.z - p.pos.z) ** 2) || 1;
  const vx = ((target.pos.x - p.pos.x) / len) * CFG.SHOVE_FORCE;
  const vz = ((target.pos.z - p.pos.z) / len) * CFG.SHOVE_FORCE;

  // drop all of target's carried loot at their position (now grabbable = the steal)
  for (const id of target.carry) {
    const l = room.map.loot[id];
    if (l) {
      l.holder = null;
      l.x = target.pos.x + (Math.random() - 0.5);
      l.y = target.pos.y + 0.3;
      l.z = target.pos.z + (Math.random() - 0.5);
      broadcast(room, lootAt(room, l));
    }
  }
  target.carry = [];
  broadcast(room, { t: "shoved", id: target.id, by: p.id, vx: +vx.toFixed(2), vz: +vz.toFixed(2) });
}

/* ------------------------------- ws handling ------------------------------ */
const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on("connection", (ws) => {
  let room = null;
  let player = null;

  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }

    if (msg.t === "join") {
      const name = (("" + (msg.name || "Player")).trim().slice(0, 14)) || "Player";
      if (msg.room) {
        room = rooms.get(("" + msg.room).toUpperCase());
        if (!room) return send({ ws }, { t: "error", msg: "Room not found" });
        if (room.players.size >= CFG.MAX_PLAYERS) return send({ ws }, { t: "error", msg: "Room is full" });
      } else {
        room = makeRoom();
      }
      const id = nextId++;
      player = {
        id, ws, name, color: COLORS[room.players.size % COLORS.length],
        pos: { x: 0, y: 1.2, z: 0 }, yaw: 0,
        carry: [], roundBanked: 0, total: 0, alive: true,
      };
      room.players.set(id, player);
      if (!room.hostId) room.hostId = id;
      send(player, { t: "joined", id, code: room.code, host: id === room.hostId, color: player.color });
      lobbyUpdate(room);
      // if joining mid-match, send them into the current round as a spectator-ish late join
      if (room.state === "playing") {
        player.pos = { x: Math.random() * 4 - 2, y: 1.2, z: Math.random() * 4 - 2 };
        send(player, {
          t: "start", round: room.round, maxRounds: CFG.MAX_ROUNDS,
          map: room.map, roundSec: CFG.ROUND_SEC,
          players: [...room.players.values()].map((q) => ({ id: q.id, name: q.name, color: q.color, pos: q.pos })),
        });
      }
      return;
    }

    if (!room || !player) return;

    switch (msg.t) {
      case "start":
        if (player.id === room.hostId && room.state === "lobby" && room.players.size >= CFG.MIN_PLAYERS) startMatch(room);
        break;
      case "state": // client-predicted position update
        if (Array.isArray(msg.p) && room.state === "playing") {
          player.pos.x = +msg.p[0]; player.pos.y = +msg.p[1]; player.pos.z = +msg.p[2];
          if (typeof msg.r === "number") player.yaw = msg.r;
        }
        break;
      case "grab": tryGrab(room, player); break;
      case "shove": tryShove(room, player); break;
      case "again":
        if (player.id === room.hostId && room.state === "lobby") startMatch(room);
        break;
    }
  });

  ws.on("close", () => {
    if (!room || !player) return;
    room.players.delete(player.id);
    if (room.players.size === 0) {
      clearInterval(room.loopTimer);
      clearTimeout(room.interTimer);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === player.id) room.hostId = room.players.keys().next().value;
    broadcast(room, { t: "left", id: player.id });
    lobbyUpdate(room);
  });
});

server.listen(PORT, () => {
  console.log(`GREED server listening on http://localhost:${PORT}`);
});

// exported config for tests
module.exports = { CFG, makeMap };
