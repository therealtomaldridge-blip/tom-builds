/*
 * Headless multi-client smoke test for the GREED server.
 * Verifies: room create/join, match start, position updates, loot grab,
 * banking at the exit, shove-to-steal, and live snapshots — no browser needed.
 */
process.env.PORT = process.env.PORT || "3717";
require("../server.js"); // starts http + ws on PORT
const WebSocket = require("ws");

const URL = `ws://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, label) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL:"} ${label}`);
  if (!cond) failures++;
}

class Client {
  constructor(name) { this.name = name; this.msgs = []; this.id = null; }
  connect(joinMsg) {
    return new Promise((res) => {
      this.ws = new WebSocket(URL);
      this.ws.on("message", (b) => {
        const m = JSON.parse(b); this.msgs.push(m);
        if (m.t === "joined") this.id = m.id;
        if (m.t === "joined" || m.t === "start") this.last = m;
      });
      this.ws.on("open", () => { this.ws.send(JSON.stringify(joinMsg)); res(); });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  state(x, y, z, r = 0) { this.send({ t: "state", p: [x, y, z], r }); }
  async waitFor(pred, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    return null;
  }
  drain() { this.msgs = []; }
}

(async () => {
  console.log("GREED smoke test\n----------------");
  await sleep(300);

  // 1. create + join
  const host = new Client("Host");
  await host.connect({ t: "join", name: "Host" });
  const joined = await host.waitFor((m) => m.t === "joined");
  assert(joined && joined.code && joined.code.length === 4, "host creates room with 4-letter code");
  const code = joined.code;

  const p2 = new Client("Greedo");
  await p2.connect({ t: "join", name: "Greedo", room: code });
  assert((await p2.waitFor((m) => m.t === "joined")) !== null, "second player joins by code");
  assert((await host.waitFor((m) => m.t === "lobby" && m.players.length === 2)) !== null, "lobby shows 2 players");

  // 2. start match
  host.drain(); p2.drain();
  host.send({ t: "start" });
  const start = await host.waitFor((m) => m.t === "start");
  assert(start && start.map && start.map.loot.length > 0, "match starts and map has loot");
  const map = start.map;
  assert((await p2.waitFor((m) => m.t === "start")) !== null, "both clients receive start");

  // 3. snapshots flowing
  assert((await host.waitFor((m) => m.t === "snap" && m.players.length === 2)) !== null, "snapshots broadcast with both players");

  // 4. grab loot
  const loot = map.loot[0];
  host.drain();
  host.state(loot.x, loot.y, loot.z);
  await sleep(60);
  host.send({ t: "grab" });
  const grabbed = await host.waitFor((m) => m.t === "loot" && m.id === loot.id && m.holder === host.id);
  assert(grabbed !== null, "player grabs nearby loot (server assigns holder)");
  assert((await host.waitFor((m) => m.t === "snap" && m.players.find((x) => x.id === host.id && x.c === 1)) !== null), "carry count reflects grabbed loot");

  // 5. bank at exit
  host.drain();
  host.state(0, map.exitY, 0);
  const banked = await host.waitFor((m) => m.t === "banked" && m.id === host.id && m.amount > 0, 2500);
  assert(banked !== null, "loot banked at the exit for points");

  // 6. shove-to-steal: p2 grabs, host shoves and p2 drops loot
  const loot2 = map.loot[1];
  p2.drain();
  p2.state(loot2.x, loot2.y, loot2.z);
  await sleep(60);
  p2.send({ t: "grab" });
  const p2grab = await p2.waitFor((m) => m.t === "loot" && m.id === loot2.id && m.holder === p2.id);
  assert(p2grab !== null, "victim grabs loot before being shoved");
  // host stands just behind p2 (at -z) facing +z toward p2
  host.drain(); p2.drain();
  host.state(loot2.x, loot2.y, loot2.z - 1.2, 0); // yaw 0 => faces +z
  p2.state(loot2.x, loot2.y, loot2.z, 0);
  await sleep(80);
  host.send({ t: "shove" });
  const shoved = await p2.waitFor((m) => m.t === "shoved" && m.id === p2.id, 2500);
  assert(shoved !== null, "shove staggers the victim");
  const dropped = await host.waitFor((m) => m.t === "loot" && m.id === loot2.id && m.holder === null, 2500);
  assert(dropped !== null, "shoved victim drops their loot (now stealable)");

  // 7. cleanup
  host.ws.close(); p2.ws.close();
  await sleep(200);

  console.log("----------------");
  if (failures === 0) { console.log("ALL CHECKS PASSED ✅"); process.exit(0); }
  else { console.log(`${failures} CHECK(S) FAILED ❌`); process.exit(1); }
})();
