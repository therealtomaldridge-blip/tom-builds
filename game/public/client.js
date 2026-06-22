import * as THREE from "three";

/* =========================================================================
   GREED — client
   - Three.js render + local player physics (client-side prediction).
   - WebSocket to the authoritative server for game logic.
   ========================================================================= */

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia("(pointer:coarse)").matches;

/* ----------------------------- shared tuning ----------------------------- */
const PHYS = { GRAV: 30, MOVE: 7, JUMP: 12, RAD: 0.45, EYE: 1.0 };
function carrySpeed(c) { return Math.max(3.5, PHYS.MOVE * (1 - 0.05 * c)); }
function carryJump(c) { return Math.max(8, PHYS.JUMP * (1 - 0.03 * c)); }

/* --------------------------------- state --------------------------------- */
let ws, myId = null, myColor = "#ffd166", isHost = false, roomCode = "";
let map = null, lavaY = -2, lavaTargetY = -2, timeLeft = 0, roundInfo = { round: 1, max: 3 };
let phase = "lobby"; // lobby | playing | results

const players = new Map(); // id -> { name,color, mesh, label, target:{x,y,z,r}, carry, alive, isMe }
const lootMeshes = new Map(); // id -> mesh
const me = { pos: { x: 0, y: 1.2, z: 0 }, vy: 0, yaw: 0, grounded: false, groundedPrev: false, carry: 0, alive: true };

/* --------------------------------- THREE --------------------------------- */
const canvas = $("game");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14102a);
scene.fog = new THREE.Fog(0x14102a, 22, 60);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 300);
let camYaw = 0, camPitch = 0.35, camDist = 9;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xfff0d0, 1.1);
sun.position.set(10, 30, 12);
scene.add(sun);
const fill = new THREE.PointLight(0xff7733, 0.6, 80);
fill.position.set(0, 2, 0);
scene.add(fill);

// lava plane
const lava = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshBasicMaterial({ color: 0xff4422, transparent: true, opacity: 0.92 })
);
lava.rotation.x = -Math.PI / 2;
lava.position.y = -2;
scene.add(lava);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener("resize", resize); resize();

/* --------------------------- mesh factories ------------------------------ */
function textSprite(text, color = "#fff") {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "bold 34px Segoe UI, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.7)"; g.strokeText(text, 128, 32);
  g.fillStyle = color; g.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(2.4, 0.6, 1);
  return spr;
}

function makePlayer(p) {
  const grp = new THREE.Group();
  const col = new THREE.Color(p.color || "#fff");
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PHYS.RAD, 0.9, 4, 10),
    new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, emissive: col, emissiveIntensity: 0.15 })
  );
  body.position.y = 0.85;
  grp.add(body);
  // eyes (so we can read facing)
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  for (const sx of [-0.16, 0.16]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), eyeMat);
    eye.position.set(sx, 1.2, 0.4);
    grp.add(eye);
  }
  const label = textSprite(p.name, p.color);
  label.position.y = 1.9;
  grp.add(label);
  // bag indicator
  const bag = textSprite("", "#ffd166");
  bag.position.y = 2.35; bag.scale.set(1.6, 0.45, 1);
  grp.add(bag);
  grp.userData.bag = bag;
  worldGroup.add(grp);
  return grp;
}

function makeLoot(l) {
  let geo, color, scale = 1;
  if (l.kind === "coin") { geo = new THREE.CylinderGeometry(0.28, 0.28, 0.09, 16); color = 0xffd166; }
  else if (l.kind === "gem") { geo = new THREE.OctahedronGeometry(0.32); color = 0x4cc9f0; }
  else { geo = new THREE.BoxGeometry(0.6, 0.45, 0.45); color = 0xffaa00; scale = 1; }
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.25, emissive: color, emissiveIntensity: 0.25 }));
  m.position.set(l.x, l.y, l.z);
  m.userData = { kind: l.kind, spin: l.kind === "coin" ? 1 : 0.4 };
  m.scale.setScalar(scale);
  worldGroup.add(m);
  return m;
}

function buildWorld() {
  // clear
  while (worldGroup.children.length) worldGroup.remove(worldGroup.children[0]);
  players.forEach((p) => { if (p.mesh) p.mesh = makePlayer(p); });
  lootMeshes.clear();

  for (const pl of map.platforms) {
    const isExit = pl.exit, isGround = pl.ground;
    const mat = new THREE.MeshStandardMaterial({
      color: isExit ? 0xffd166 : isGround ? 0x2a2440 : 0x4a3f6b,
      roughness: 0.85, emissive: isExit ? 0xffaa00 : 0x000000, emissiveIntensity: isExit ? 0.4 : 0,
    });
    const m = new THREE.Mesh(new THREE.BoxGeometry(pl.sx, pl.sy, pl.sz), mat);
    m.position.set(pl.x, pl.y, pl.z);
    worldGroup.add(m);
    if (isExit) {
      const beam = textSprite("EXIT ⬆", "#fff7d6");
      beam.position.set(pl.x, pl.y + 2.5, pl.z); beam.scale.set(3, 0.8, 1);
      worldGroup.add(beam);
    }
  }
  for (const l of map.loot) {
    const m = makeLoot(l);
    lootMeshes.set(l.id, m);
  }
  // rebuild player meshes fresh
  players.forEach((p, id) => { p.mesh = makePlayer(p); });
}

/* ------------------------------- networking ------------------------------ */
function connect(joinMsg) {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify(joinMsg));
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => { if (phase === "playing") showErr("Disconnected from server."); };
  ws.onerror = () => showErr("Connection error.");
}
function sendJSON(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function handle(m) {
  switch (m.t) {
    case "joined":
      myId = m.id; roomCode = m.code; isHost = m.host; myColor = m.color;
      showRoom();
      history.replaceState(null, "", `?r=${m.code}`);
      break;
    case "error": showErr(m.msg); break;
    case "lobby":
      roomCode = m.code; renderLobby(m.players); phase = m.state === "playing" ? "playing" : "lobby";
      break;
    case "start": onStart(m); break;
    case "snap": onSnap(m); break;
    case "loot": onLoot(m); break;
    case "shoved": onShoved(m); break;
    case "died": onDied(m); break;
    case "banked": onBanked(m); break;
    case "roundover": onResults(m, false); break;
    case "gameover": onResults(m, true); break;
    case "left": removePlayer(m.id); break;
  }
}

function onStart(m) {
  map = m.map; roundInfo = { round: m.round, max: m.maxRounds };
  lavaY = lavaTargetY = -2; timeLeft = m.roundSec;
  phase = "playing";
  players.clear();
  for (const p of m.players) {
    players.set(p.id, { name: p.name, color: p.color, target: { x: p.pos.x, y: p.pos.y, z: p.pos.z, r: 0 }, carry: 0, alive: true, isMe: p.id === myId });
    if (p.id === myId) { me.pos = { ...p.pos }; me.vy = 0; me.alive = true; me.carry = 0; }
  }
  buildWorld();
  $("lobby").classList.add("hidden");
  $("results").classList.add("hidden");
  $("hud").classList.remove("hidden");
  if (isTouch) $("touch").classList.remove("hidden");
  flashHint("Grab loot (E), reach the EXIT on top, escape the lava!");
}

let lastSnap = 0;
function onSnap(m) {
  lastSnap = performance.now();
  lavaTargetY = m.lava; timeLeft = m.time;
  for (const sp of m.players) {
    const p = players.get(sp.id);
    if (!p) continue;
    p.alive = sp.a === 1;
    p.carry = sp.c;
    if (sp.id === myId) {
      me.carry = sp.c; me.alive = sp.a === 1;
    } else {
      p.target = { x: sp.x, y: sp.y, z: sp.z, r: sp.r };
    }
  }
  // HUD
  $("hudTime").textContent = timeLeft.toFixed(1);
  $("hudTime").classList.toggle("low", timeLeft <= 10);
  $("hudRound").textContent = `Round ${roundInfo.round}/${roundInfo.max}`;
  $("hudBag").textContent = `💰 ${me.carry}`;
  const mine = m.players.find((x) => x.id === myId);
  $("hudBank").textContent = `🏦 ${mine ? mine.b : 0}`;
  renderHudScores(m.players);
}

function onLoot(m) {
  const mesh = lootMeshes.get(m.id);
  if (!mesh) return;
  const hidden = m.holder !== null || m.banked || m.y < -10;
  mesh.visible = !hidden;
  if (!hidden) mesh.position.set(m.x, m.y, m.z);
}

function onShoved(m) {
  if (m.id === myId) {
    me.vy = 6; // pop up
    me.pos.x += m.vx * 0.12; me.pos.z += m.vz * 0.12;
    flashHint("💥 You got shoved! Your loot scattered!");
  }
}
function onDied(m) {
  if (m.id === myId) { me.alive = false; flashHint("🌋 You fell in the lava! Spectating…"); }
  const p = players.get(m.id);
  if (p && p.mesh) p.mesh.visible = false;
}
function onBanked(m) {
  if (m.id === myId) flashHint(`🏦 Banked +${m.amount}!`);
}

function removePlayer(id) {
  const p = players.get(id);
  if (p && p.mesh) worldGroup.remove(p.mesh);
  players.delete(id);
}

/* --------------------------------- input --------------------------------- */
const keys = {};
addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (e.code === "KeyE") sendJSON({ t: "grab" });
  if (e.code === "KeyF") sendJSON({ t: "shove" });
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
});
addEventListener("keyup", (e) => { keys[e.code] = false; });

// mouse look (pointer lock) + click = shove
canvas.addEventListener("click", () => {
  if (phase !== "playing") return;
  if (!isTouch && document.pointerLockElement !== canvas) { canvas.requestPointerLock(); return; }
  sendJSON({ t: "shove" });
});
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement === canvas) {
    camYaw -= e.movementX * 0.0025;
    camPitch = THREE.MathUtils.clamp(camPitch - e.movementY * 0.0025, -0.2, 1.2);
  }
});

// touch: stick + camera drag + buttons
const stickState = { active: false, dx: 0, dy: 0, cx: 0, cy: 0 };
if (isTouch) {
  const stick = $("stick"), nub = $("nub");
  const setNub = (dx, dy) => { nub.style.transform = `translate(${dx}px,${dy}px)`; };
  stick.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; const r = stick.getBoundingClientRect();
    stickState.active = true; stickState.cx = r.left + r.width / 2; stickState.cy = r.top + r.height / 2;
  }, { passive: true });
  stick.addEventListener("touchmove", (e) => {
    const t = e.touches[0]; let dx = t.clientX - stickState.cx, dy = t.clientY - stickState.cy;
    const len = Math.hypot(dx, dy), max = 40; if (len > max) { dx = dx / len * max; dy = dy / len * max; }
    stickState.dx = dx / max; stickState.dy = dy / max; setNub(dx, dy);
  }, { passive: true });
  const end = () => { stickState.active = false; stickState.dx = stickState.dy = 0; setNub(0, 0); };
  stick.addEventListener("touchend", end); stick.addEventListener("touchcancel", end);

  $("tJump").addEventListener("touchstart", (e) => { e.preventDefault(); keys.Space = true; }, { passive: false });
  $("tJump").addEventListener("touchend", () => { keys.Space = false; });
  $("tGrab").addEventListener("touchstart", (e) => { e.preventDefault(); sendJSON({ t: "grab" }); }, { passive: false });
  $("tShove").addEventListener("touchstart", (e) => { e.preventDefault(); sendJSON({ t: "shove" }); }, { passive: false });

  // camera drag on right half
  let camTouch = null;
  addEventListener("touchstart", (e) => {
    const t = e.touches[e.touches.length - 1];
    if (t.clientX > innerWidth / 2 && t.target === canvas) camTouch = { x: t.clientX, y: t.clientY, id: t.identifier };
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (!camTouch) return;
    for (const t of e.touches) if (t.identifier === camTouch.id) {
      camYaw -= (t.clientX - camTouch.x) * 0.005;
      camPitch = THREE.MathUtils.clamp(camPitch - (t.clientY - camTouch.y) * 0.005, -0.2, 1.2);
      camTouch.x = t.clientX; camTouch.y = t.clientY;
    }
  }, { passive: true });
  addEventListener("touchend", () => { camTouch = null; });
}

/* ------------------------- local physics + camera ------------------------ */
function platformLanding(oldY, newY, x, z) {
  // returns the highest platform top we land on this frame, or null
  let top = null;
  for (const pl of map.platforms) {
    const t = pl.y + pl.sy / 2;
    if (Math.abs(x - pl.x) < pl.sx / 2 + PHYS.RAD && Math.abs(z - pl.z) < pl.sz / 2 + PHYS.RAD) {
      if (oldY >= t - 0.15 && newY <= t + 0.001) {
        if (top === null || t > top) top = t;
      }
    }
  }
  return top;
}

function stepLocal(dt) {
  if (!map) return;
  const sp = carrySpeed(me.carry);

  // movement input relative to camera yaw
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) iz += 1;
  if (keys.KeyS || keys.ArrowDown) iz -= 1;
  if (keys.KeyA || keys.ArrowLeft) ix -= 1;
  if (keys.KeyD || keys.ArrowRight) ix += 1;
  if (stickState.active) { ix += stickState.dx; iz += -stickState.dy; }
  const il = Math.hypot(ix, iz);

  const fwdX = Math.sin(camYaw), fwdZ = Math.cos(camYaw);
  const rightX = Math.cos(camYaw), rightZ = -Math.sin(camYaw);
  let mvx = 0, mvz = 0;
  if (il > 0.05 && me.alive) {
    const nx = ix / il, nz = iz / il;
    mvx = (fwdX * nz + rightX * nx);
    mvz = (fwdZ * nz + rightZ * nx);
    me.yaw = Math.atan2(mvx, mvz);
  }

  // jump
  if ((keys.Space) && me.groundedPrev && me.alive) { me.vy = carryJump(me.carry); me.groundedPrev = false; }

  // gravity
  me.vy -= PHYS.GRAV * dt;

  // horizontal
  me.pos.x += mvx * sp * dt;
  me.pos.z += mvz * sp * dt;
  const R = map.R - PHYS.RAD;
  me.pos.x = THREE.MathUtils.clamp(me.pos.x, -R, R);
  me.pos.z = THREE.MathUtils.clamp(me.pos.z, -R, R);

  // vertical w/ platform landing
  const newY = me.pos.y + me.vy * dt;
  const top = platformLanding(me.pos.y, newY, me.pos.x, me.pos.z);
  me.grounded = false;
  if (top !== null && me.vy <= 0) { me.pos.y = top; me.vy = 0; me.grounded = true; }
  else me.pos.y = newY;
  me.groundedPrev = me.grounded;

  if (me.pos.y < -8) me.pos.y = -8; // floor safety; server handles lava death
}

let lastStateSend = 0;
function maybeSendState(now) {
  if (now - lastStateSend < 50) return;
  lastStateSend = now;
  sendJSON({ t: "state", p: [me.pos.x, me.pos.y, me.pos.z], r: me.yaw });
}

/* ------------------------------- main loop ------------------------------- */
let prev = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;

  if (phase === "playing" && map) {
    stepLocal(dt);
    maybeSendState(now);

    // lava
    lavaY += (lavaTargetY - lavaY) * Math.min(1, dt * 6);
    lava.position.y = lavaY;

    // place + interpolate players
    players.forEach((p, id) => {
      if (!p.mesh) return;
      if (id === myId) {
        p.mesh.visible = me.alive;
        p.mesh.position.set(me.pos.x, me.pos.y, me.pos.z);
        p.mesh.rotation.y = me.yaw;
      } else {
        p.mesh.visible = p.alive;
        p.mesh.position.x += (p.target.x - p.mesh.position.x) * Math.min(1, dt * 12);
        p.mesh.position.y += (p.target.y - p.mesh.position.y) * Math.min(1, dt * 12);
        p.mesh.position.z += (p.target.z - p.mesh.position.z) * Math.min(1, dt * 12);
        p.mesh.rotation.y = p.target.r;
      }
      const bag = p.mesh.userData.bag;
      if (bag) updateBag(bag, p.carry);
    });

    // spin loot
    worldGroup.children.forEach((c) => { if (c.userData && c.userData.spin) c.rotation.y += dt * c.userData.spin * 3; });

    // camera follow (third person)
    const tx = me.pos.x, ty = me.pos.y + 1.4, tz = me.pos.z;
    const cx = tx - Math.sin(camYaw) * Math.cos(camPitch) * camDist;
    const cy = ty + Math.sin(camPitch) * camDist;
    const cz = tz - Math.cos(camYaw) * Math.cos(camPitch) * camDist;
    camera.position.lerp(new THREE.Vector3(cx, cy, cz), Math.min(1, dt * 8));
    camera.lookAt(tx, ty, tz);
    fill.position.set(me.pos.x, me.pos.y + 1, me.pos.z);
  }

  renderer.render(scene, camera);
}

const bagCache = new WeakMap();
function updateBag(spr, carry) {
  if (bagCache.get(spr) === carry) return;
  bagCache.set(spr, carry);
  const txt = carry > 0 ? `💰${carry}` : "";
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "bold 40px Segoe UI"; g.textAlign = "center"; g.textBaseline = "middle";
  g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.7)"; g.strokeText(txt, 128, 32);
  g.fillStyle = "#ffd166"; g.fillText(txt, 128, 32);
  spr.material.map.dispose(); spr.material.map = new THREE.CanvasTexture(c);
  spr.visible = carry > 0;
}
loop();

/* --------------------------------- HUD UI -------------------------------- */
function renderHudScores(list) {
  const el = $("hudScores");
  el.innerHTML = list.slice().sort((a, b) => b.b - a.b).map((p) => {
    const pl = players.get(p.id); const name = pl ? pl.name : "?"; const col = pl ? pl.color : "#fff";
    return `<div class="srow"><span class="dot" style="background:${col};color:${col}"></span>${name} ${p.b}</div>`;
  }).join("");
}
let hintTimer = null;
function flashHint(msg) {
  const h = $("hudHint"); h.textContent = msg; h.classList.add("show");
  clearTimeout(hintTimer); hintTimer = setTimeout(() => h.classList.remove("show"), 2600);
}

/* ------------------------------- lobby UI -------------------------------- */
function showErr(msg) { $("err").textContent = msg; }
function showRoom() {
  $("entry").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("roomCode").textContent = roomCode;
}
function renderLobby(list) {
  if (phase === "playing") return;
  $("lobby").classList.remove("hidden");
  $("hud").classList.add("hidden");
  $("results").classList.add("hidden");
  $("touch").classList.add("hidden");
  if (roomCode) showRoom();
  const el = $("playerList");
  el.innerHTML = list.map((p) =>
    `<div class="prow"><span class="dot" style="background:${p.color};color:${p.color}"></span>${p.name}${p.host ? '<span class="tag">HOST</span>' : ""}</div>`
  ).join("");
  const meHost = list.find((p) => p.id === myId)?.host;
  isHost = !!meHost;
  $("startBtn").classList.toggle("hidden", !isHost);
  $("waitMsg").classList.toggle("hidden", isHost);
}

$("createBtn").onclick = () => {
  const name = $("nameInput").value.trim() || "Player";
  connect({ t: "join", name });
};
$("joinBtn").onclick = () => {
  const name = $("nameInput").value.trim() || "Player";
  const code = $("codeInput").value.trim().toUpperCase();
  if (!code) return showErr("Enter a room code.");
  connect({ t: "join", name, room: code });
};
$("startBtn").onclick = () => sendJSON({ t: "start" });
$("copyBtn").onclick = async () => {
  const link = `${location.origin}?r=${roomCode}`;
  try { await navigator.clipboard.writeText(link); $("copyBtn").textContent = "✓ Copied!"; }
  catch { prompt("Copy this link:", link); }
};

/* ------------------------------ results UI ------------------------------- */
function onResults(m, over) {
  phase = over ? "lobby" : "results";
  $("hud").classList.add("hidden");
  $("touch").classList.add("hidden");
  $("results").classList.remove("hidden");
  $("resTitle").textContent = over ? "🏆 GAME OVER" : `Round ${m.round} done`;
  $("resBoard").innerHTML = m.scores.map((s, i) =>
    `<div class="brow ${over && i === 0 ? "win" : ""}"><span class="rank">${["🥇", "🥈", "🥉"][i] || (i + 1)}</span>
     <span class="dot" style="background:${s.color};color:${s.color}"></span>${s.name}
     <span class="rd">+${s.round}</span><span class="total">${s.total}</span></div>`
  ).join("");
  $("resNext").classList.toggle("hidden", over);
  $("resAgain").classList.toggle("hidden", !(over && isHost));
  $("resMenu").classList.toggle("hidden", !over);
}
$("resAgain").onclick = () => { sendJSON({ t: "again" }); $("results").classList.add("hidden"); };
$("resMenu").onclick = () => location.reload();

/* --------------------------- prefill from link --------------------------- */
const urlCode = new URLSearchParams(location.search).get("r");
if (urlCode) $("codeInput").value = urlCode.toUpperCase();
