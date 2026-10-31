import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowRecorder, thinPoints } from "../public/flow-recorder.js";
import { flowChart } from "../public/flow-chart.js";
function fixture() {
  const states = new Map(),
    samples = new Map(),
    server = new Map(),
    held = new Set();
  let time = 0,
    lost = false,
    offline = false,
    lostFinish = false,
    status = "active";
  const store = {
    state: async (owner) => structuredClone(states.get(owner) || null),
    save: async (state) => {
      states.set(state.ownerId, structuredClone(state));
    },
    append: async (state, sample) => {
      assert.equal(states.get(state.ownerId).nextSeq, sample.seq);
      samples.set(sample.seq, structuredClone(sample));
      states.set(state.ownerId, {
        ...state,
        nextSeq: sample.seq + 1,
        lastElapsed: sample.elapsed_ms,
      });
    },
    peek: async () => [...samples.values()].slice(0, 200),
    count: async () => samples.size,
    accepted: async (owner, id, seq) => {
      for (const key of samples.keys()) if (key <= seq) samples.delete(key);
    },
    clear: async (owner) => states.delete(owner),
  };
  const detail = () => ({
    id: 14,
    user_id: 2,
    status,
    last_seq: server.size - 1,
    last_ms: [...server.values()].at(-1)?.elapsed_ms || 0,
    elapsed_ms: time,
  });
  const request = async (path, body, method) => {
    if (offline) throw Error("Netz offline");
    if (path.endsWith("/samples")) {
      for (const s of body.samples) {
        if (server.has(s.seq)) assert.deepEqual(server.get(s.seq), s);
        else server.set(s.seq, structuredClone(s));
      }
      if (lost) {
        lost = false;
        throw Error("Antwort verloren");
      }
      return { ok: true, ...detail() };
    }
    if (path.endsWith("/finish")) {
      assert.equal(body.last_seq, server.size - 1);
      status = "completed";
      if (lostFinish) {
        lostFinish = false;
        throw Error("Abschlussantwort verloren");
      }
      return detail();
    }
    if (path.endsWith("/series")) return [...server.values()];
    return detail();
  };
  const locks = {
    request: async (name, options, callback) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({});
      } finally {
        held.delete(name);
      }
    },
  };
  const create = () =>
    new FlowRecorder({ request, store, locks, clock: () => time });
  return {
    create,
    store,
    samples,
    server,
    held,
    advance: (ms) => (time += ms),
    setLost: (v) => (lost = v),
    setOffline: (v) => (offline = v),
    setLostFinish: (v) => (lostFinish = v),
  };
}
const live = (flow) => ({
  type: "live",
  state: "IDLE",
  flow,
  temperature: 22,
  volume: 0,
});
test("Durchflussaufzeichnung läuft ohne Sollmenge weiter, speichert Nullwerte und schreibt keine Temperatur oder BLE-Befehle", async () => {
  const f = fixture(),
    r = f.create();
  await r.bindUser(2);
  await r.start({});
  r.capture(live(0));
  await r.serial;
  f.advance(1000);
  r.capture(live(4.5));
  await r.serial;
  f.setLost(true);
  await assert.rejects(() => r.flush(), /Antwort verloren/);
  assert.equal(f.server.size, 2);
  assert.equal(r.pending, 2);
  await r.flush();
  assert.equal(f.server.size, 2);
  assert.equal(r.pending, 0);
  f.advance(48 * 3600000);
  r.capture(live(8));
  await r.serial;
  assert.equal(r.running, true);
  assert.equal("temperature" in f.samples.get(2), false);
  assert.equal("volume" in f.samples.get(2), false);
  await r.finish();
  assert.equal(f.server.size, 3);
  assert.equal(r.active, null);
  await r.bindUser(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.held.size, 0);
});
test("Netzausfall beim Beenden bewahrt lokale Werte; nach Neuladen und verlorener Abschlussantwort wird ohne Dublette abgeschlossen", async () => {
  const f = fixture(),
    r = f.create();
  await r.bindUser(2);
  await r.start({});
  r.capture(live(5));
  await r.serial;
  f.setOffline(true);
  await assert.rejects(() => r.finish());
  assert.equal(r.running, false);
  assert.equal(r.active.stopping, true);
  assert.equal(f.samples.size, 1);
  await r.bindUser(null);
  const resumed = f.create();
  await resumed.bindUser(2);
  assert.equal(resumed.pending, 1);
  f.setOffline(false);
  f.setLostFinish(true);
  await assert.rejects(() => resumed.finish(), /Abschlussantwort/);
  assert.equal(f.server.size, 1);
  assert.equal(f.samples.size, 0);
  await resumed.bindUser(null);
  const final = f.create();
  await final.bindUser(2);
  await final.resume(14);
  assert.equal(final.active, null);
  assert.equal(f.server.size, 1);
  await final.bindUser(null);
});
test("Zweiter Tab erhält keinen Schreib-Lock; ein Kontowechsel beendet die lokale Erfassung und sendet keine fremden Werte", async () => {
  const f = fixture(),
    first = f.create(),
    second = f.create();
  await first.bindUser(2);
  await first.start({});
  await second.bindUser(2);
  await assert.rejects(() => second.resume(14), /anderen Tab/);
  first.capture(live(3));
  await first.serial;
  await first.bindUser(9);
  first.capture(live(8));
  await first.serial;
  await first.flush();
  assert.equal(f.server.size, 0);
  assert.equal(f.samples.size, 1);
  await first.bindUser(null);
  await second.bindUser(null);
});
test("Kurve bleibt begrenzt, bewahrt Spitzen und zeichnet keine Verbindung über eine Unterbrechung", () => {
  const points = Array.from({ length: 4000 }, (_, seq) => ({
    seq,
    elapsed_ms: seq * 1000,
    flow: seq === 2001 ? 999 : 2,
    segment: seq < 2100 ? 0 : 1,
  }));
  const thin = thinPoints(points);
  assert.ok(thin.length <= 1202);
  assert.ok(thin.some((p) => p.flow === 999));
  assert.equal(thin[0].seq, 0);
  assert.equal(thin.at(-1).seq, 3999);
  const svg = flowChart(thin);
  assert.equal((svg.match(/class="flow-chart-line"/g) || []).length, 2);
});

test("Kontowechsel während des Aktivierens kann keine fremde Messung in den neuen Benutzerkontext übernehmen", async () => {
  const f = fixture(),
    r = f.create();
  await r.bindUser(2);
  let release;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    original = f.store.state;
  f.store.state = async (owner) => {
    if (owner === 2) await gate;
    return original(owner);
  };
  const starting = r.start({});
  await new Promise((resolve) => setImmediate(resolve));
  await r.bindUser(9);
  release();
  await assert.rejects(() => starting, /Benutzerkonto gewechselt/);
  assert.equal(r.active, null);
  assert.equal(r.ownerId, 9);
  assert.deepEqual(r.points, []);
  await r.bindUser(null);
});

test("Verspätete Abschlussantwort räumt nur den ursprünglichen lokalen Auftrag auf", async () => {
  const f = fixture(),
    r = f.create();
  await r.bindUser(2);
  await r.start({});
  r.capture(live(2));
  await r.serial;
  let release;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    original = r.request;
  r.request = async (...args) => {
    const result = await original(...args);
    if (args[0].endsWith("/finish")) await gate;
    return result;
  };
  const finishing = r.finish();
  await new Promise((resolve) => setImmediate(resolve));
  await f.store.save({
    ownerId: 9,
    id: 99,
    nextSeq: 0,
    lastElapsed: 0,
    stopping: false,
  });
  await r.bindUser(9);
  release();
  await finishing;
  assert.equal(r.ownerId, 9);
  assert.equal(r.active.id, 99);
  assert.equal(await f.store.state(2), null);
  await r.bindUser(null);
});
