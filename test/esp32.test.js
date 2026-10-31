import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Esp32Client,
  DEFAULT_PROFILE,
  formatCommand,
  parseResult,
  parseMessage,
  MeasurementNotReady,
} from "../public/esp32.js";
const point = { id: 1, code: "SP-1024", target: 2.5 },
  runId = 7;
function fake({
  timeout = 15,
  dropGet = false,
  dropAck = false,
  dropCancel = false,
  readyOnCancel = false,
} = {}) {
  const map = new Map();
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
  const state = {
    frame: null,
    status: null,
    commands: [],
    serverSaved: false,
    led: false,
  };
  const view = (text) => new DataView(new TextEncoder().encode(text).buffer);
  const tx = new EventTarget();
  tx.properties = { read: true, notify: true };
  tx.startNotifications = async () => tx;
  tx.readValue = async () => view(state.frame ?? "NONE");
  const notify = (text) => {
    tx.value = view(text);
    tx.dispatchEvent(new Event("characteristicvaluechanged"));
  };
  const rx = {
    properties: { write: true, writeWithoutResponse: true },
    writeValueWithResponse: async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      state.commands.push(text);
      if (text === "STATUS") {
        notify(state.status ?? "NONE");
        return;
      }
      if (text === "GET") {
        if (!dropGet) notify(state.frame ?? "NONE");
        return;
      }
      if (text.startsWith("ACK;")) {
        assert.equal(
          state.serverSaved,
          true,
          "ACK must follow confirmed server save",
        );
        state.frame = null;
        state.status = null;
        state.led = false;
        if (!dropAck) notify("STATUS;ACK_OK");
        return;
      }
      if (text.endsWith(";0")) {
        if (readyOnCancel) {
          state.frame = "SP-1024;2.500;12.45;9.82";
          state.status = "STATUS;READY;SP-1024";
          state.led = true;
        }
        if (state.frame) {
          notify(state.status);
          return;
        }
        state.status = null;
        state.led = false;
        if (!dropCancel) notify("STATUS;ACK_OK");
        return;
      }
      assert.match(text, /^SP-(1024|2000);(2.5|3)$/);
      state.status = "STATUS;WAIT_FLOW;" + text.split(";")[0];
      state.frame = null;
      notify(state.status);
    },
  };
  const device = new EventTarget();
  device.name = "SpuelPilot-ESP32";
  device.gatt = {
    connected: false,
    connect: async () => {
      device.gatt.connected = true;
      return {
        getPrimaryService: async (uuid) => {
          assert.equal(uuid, DEFAULT_PROFILE.service);
          return {
            getCharacteristic: async (id) =>
              id === DEFAULT_PROFILE.command ? rx : tx,
          };
        },
      };
    },
    disconnect: () => {
      if (device.gatt.connected) {
        device.gatt.connected = false;
        device.dispatchEvent(new Event("gattserverdisconnected"));
      }
    },
  };
  const bluetooth = {
    requestDevice: async (options) => {
      assert.deepEqual(options, {
        filters: [{ services: [DEFAULT_PROFILE.service] }],
      });
      return device;
    },
  };
  const client = new Esp32Client({ bluetooth, storage, timeout });
  client.bindUser(42);
  const complete = (frame = "SP-1024;2.500;12.45;9.82") => {
    state.frame = frame;
    state.status = "STATUS;READY;SP-1024";
    state.led = true;
    notify(state.status);
  };
  const receipt = () => ({
    saved: true,
    source: "esp32",
    id: 9,
    user_id: 42,
    point_id: 1,
    code: "SP-1024",
    run_id: runId,
    request_id: client.job.requestId,
    volume: 2.5,
    temperature_before: 12.45,
    temperature_after: 9.82,
  });
  return { client, state, storage, map, complete, receipt, bluetooth, tx, rx };
}
test("ESP32-Protokoll kodiert Aufträge und prüft ID, Zahlen und vollständige Resultate", () => {
  assert.equal(formatCommand(point), "SP-1024;2.5");
  assert.equal(
    formatCommand({ ...point, target: 0.0000001 }),
    "SP-1024;0.0000001",
  );
  for (const code of ["SP;1", "SP\n1", "ACK", "GET"])
    assert.throws(() => formatCommand({ ...point, code }));
  assert.deepEqual(parseResult("SP-1024;2.500;12.45;9.82", point), {
    volume: 2.5,
    temperature_before: 12.45,
    temperature_after: 9.82,
  });
  assert.deepEqual(parseResult("SP-1024;2,500;12,45;9,82\r\n", point), {
    volume: 2.5,
    temperature_before: 12.45,
    temperature_after: 9.82,
  });
  for (const frame of [
    "SP-1025;2.5;12;9",
    "SP-1024;NaN;12;9",
    "SP-1024;3;101;9",
    "SP-1024;3;12;9;EXTRA",
    "SP-1024;3;12C;9",
  ])
    assert.throws(() => parseResult(frame, point));
  assert.throws(
    () => parseResult("SP-1024;2.4;12;9", point),
    MeasurementNotReady,
  );
  assert.deepEqual(parseMessage("STATUS;ACK_OK"), { type: "ack" });
  assert.deepEqual(parseMessage("NONE"), { type: "none" });
  for (const state of ["WAIT_FLOW", "COUNTDOWN", "MEASURING", "READY"])
    assert.equal(parseMessage(`STATUS;${state};SP-1024`).state, state);
  assert.throws(() => parseMessage("STATUS;UNKNOWN;SP-1024"));
});
test("BLE-Client sendet GET, übernimmt Notify-Werte und sendet ACK erst nach Serverbestätigung", async () => {
  const f = fake();
  await f.client.connect();
  assert.equal(f.client.connected, true);
  assert.equal(await f.client.exchange(point, runId), null);
  assert.deepEqual(f.state.commands, [
    "STATUS",
    "STATUS",
    "GET",
    "SP-1024;2.5",
  ]);
  await assert.rejects(f.client.exchange(point, runId), MeasurementNotReady);
  f.complete();
  const values = await f.client.exchange(point, runId);
  assert.equal(values.temperature_after, 9.82);
  assert.equal(f.client.deviceStatus.state, "READY");
  assert.equal(
    f.state.commands.some((c) => c.startsWith("ACK;")),
    false,
  );
  assert.equal(f.state.led, true);
  assert.throws(() => f.client.markSaved({ ...f.receipt(), saved: false }));
  f.state.serverSaved = true;
  await f.client.acknowledge(f.receipt());
  assert.equal(f.state.commands.at(-1), "ACK;SP-1024");
  assert.equal(f.state.led, false);
  assert.equal(f.client.job, null);
  assert.equal(f.map.size, 0);
});
test("Falsche IDs und fremde Serverbestätigungen löschen keine ESP32-Daten", async () => {
  const f = fake();
  await f.client.connect();
  await f.client.exchange(point, runId);
  f.complete("SP-OTHER;2.5;12.45;9.82");
  await assert.rejects(f.client.exchange(point, runId), /Spülpunkt-ID/);
  assert.equal(
    f.state.commands.some((c) => c.startsWith("ACK;")),
    false,
  );
  assert.throws(() => f.client.markSaved({ ...f.receipt(), user_id: 99 }));
  await assert.rejects(
    f.client.exchange({ ...point, id: 2, code: "SP-OTHER" }, runId),
    /offen|Ergebnis/,
  );
  assert.equal(f.state.led, true);
});
test("Eine verlorene GET-Notification wird über TX Read nachgeholt", async () => {
  const f = fake({ dropGet: true, timeout: 5 });
  await f.client.connect();
  await f.client.exchange(point, runId);
  f.complete();
  assert.equal((await f.client.exchange(point, runId)).volume, 2.5);
  assert.equal(f.state.led, true);
});
test("Verlorenes ACK_OK bleibt wiederaufnehmbar; Browserneustart sendet keine doppelte Messung", async () => {
  const f = fake({ dropAck: true, timeout: 5 });
  await f.client.connect();
  await f.client.exchange(point, runId);
  f.complete();
  await f.client.exchange(point, runId);
  const receipt = f.receipt();
  f.state.serverSaved = true;
  await assert.rejects(f.client.acknowledge(receipt), /Antwort/);
  assert.equal(f.client.job.savedId, 9);
  assert.equal(f.state.led, false);
  f.client.disconnect();
  const resumed = new Esp32Client({
    bluetooth: f.bluetooth,
    storage: f.storage,
    timeout: 5,
  });
  resumed.bindUser(42);
  assert.equal(resumed.job.savedId, 9);
  await resumed.connect();
  await resumed.acknowledge(receipt);
  assert.equal(resumed.job, null);
  assert.equal(f.state.commands.filter((c) => c === "SP-1024;2.5").length, 1);
  assert.equal(f.state.commands.filter((c) => c === "ACK;SP-1024").length, 1);
});
test("Gerätedaten werden weder durch einen neuen Auftrag noch durch Logout verworfen", async () => {
  const f = fake();
  await f.client.connect();
  f.complete();
  await assert.rejects(f.client.exchange(point, runId), /Ergebnis/);
  assert.equal(f.state.led, true);
  assert.equal(f.state.commands.includes("SP-1024;2.5"), false);
  const g = fake();
  await g.client.connect();
  await g.client.exchange(point, runId);
  const request = g.client.job.requestId;
  g.client.bindUser(null);
  assert.equal(g.client.connected, false);
  assert.equal(g.client.job, null);
  g.client.bindUser(42);
  assert.equal(g.client.job.requestId, request);
});

test("Eine verspätete HTTP-Speicherbestätigung bleibt nach Abmeldung für den ursprünglichen Benutzer erhalten", async () => {
  const f = fake();
  await f.client.connect();
  await f.client.exchange(point, runId);
  f.complete();
  await f.client.exchange(point, runId);
  const receipt = f.receipt();
  f.client.bindUser(null);
  assert.equal(f.client.markSaved(receipt), false);
  assert.equal(f.client.job, null);
  assert.equal(
    f.state.commands.some((c) => c.startsWith("ACK;")),
    false,
  );
  f.client.bindUser(42);
  assert.equal(f.client.job.savedId, receipt.id);
  await f.client.connect();
  f.state.serverSaved = true;
  await f.client.acknowledge(receipt);
  assert.equal(f.client.job, null);
});

test("Messabbruch verwendet ID;0 ohne Firmware-Schalter", async () => {
  for (const phase of ["WAIT_FLOW", "COUNTDOWN", "MEASURING"]) {
    const f = fake();
    await f.client.connect();
    await f.client.exchange(point, runId);
    f.state.status = `STATUS;${phase};SP-1024`;
    await f.client.cancelMeasurement();
    assert.equal(f.client.job, null);
    assert.equal(f.state.commands.at(-1), "SP-1024;0");
    assert.equal(
      f.state.commands.some((c) => c.startsWith("ACK;")),
      false,
    );
    assert.equal(f.map.size, 0);
  }
});
test("Abbruch schützt fertige Messungen, falsche IDs und den gleichzeitigen Abschluss", async () => {
  const f = fake();
  await f.client.connect();
  await f.client.exchange(point, runId);
  f.complete();
  await assert.rejects(f.client.cancelMeasurement(), /abgeschlossen/);
  assert.equal(f.state.commands.includes("SP-1024;0"), false);
  assert.equal(f.state.led, true);
  const g = fake();
  await g.client.connect();
  await g.client.exchange(point, runId);
  g.state.status = "STATUS;MEASURING;SP-FREMD";
  await assert.rejects(g.client.cancelMeasurement(), /anderer/);
  assert.equal(g.state.commands.includes("SP-1024;0"), false);
  const h = fake({ readyOnCancel: true });
  await h.client.connect();
  await h.client.exchange(point, runId);
  await assert.rejects(h.client.cancelMeasurement(), /nicht bestätigt/);
  assert.equal(h.state.led, true);
  assert.equal(h.client.job.cancelPending, false);
  assert.equal((await h.client.exchange(point, runId)).volume, 2.5);
});
test("Unbestätigter Abbruch bleibt offen und kann nach Verbindungsabbruch geprüft werden", async () => {
  const f = fake({ dropCancel: true, timeout: 5 });
  await f.client.connect();
  await f.client.exchange(point, runId);
  await assert.rejects(f.client.cancelMeasurement(), /nicht bestätigt/);
  assert.equal(f.client.job.cancelPending, true);
  await assert.rejects(f.client.exchange(point, runId), /Abbruch/);
  f.client.disconnect();
  await f.client.connect();
  await f.client.cancelMeasurement();
  assert.equal(f.client.job, null);
  assert.equal(f.state.commands.filter((c) => c === "SP-1024;0").length, 1);
});

test("Neue Messung fragt nach laufendem Auftrag und startet nur nach bestätigtem Abbruch", async () => {
  const f = fake();
  await f.client.connect();
  await f.client.exchange(point, runId);
  let prompts = 0;
  const next = { id: 2, code: "SP-2000", target: 3 };
  const declined = await f.client.exchange(next, runId, async (code) => {
    prompts++;
    assert.equal(code, point.code);
    return false;
  });
  assert.equal(declined, false);
  assert.equal(f.client.job.code, point.code);
  assert.equal(f.state.commands.includes("SP-1024;0"), false);
  await f.client.exchange(next, runId, async (code) => {
    prompts++;
    assert.equal(code, point.code);
    return true;
  });
  assert.equal(prompts, 2);
  assert.equal(f.client.job.code, next.code);
  const zero = f.state.commands.indexOf("SP-1024;0"),
    start = f.state.commands.indexOf("SP-2000;3");
  assert.ok(zero >= 0 && start > zero);
});
test("Bestätigter Neustart desselben Punktes wartet auf echten Abbruch und bewahrt fertige Ergebnisse", async () => {
  const f = fake({ dropCancel: true, timeout: 5 });
  await f.client.connect();
  await f.client.exchange(point, runId);
  await assert.rejects(
    f.client.startMeasurement(point, runId, async () => true),
    /nicht bestätigt/,
  );
  assert.equal(f.state.commands.filter((c) => c === "SP-1024;2.5").length, 1);
  const g = fake({ readyOnCancel: true });
  await g.client.connect();
  await g.client.exchange(point, runId);
  await assert.rejects(
    g.client.startMeasurement(point, runId, async () => true),
    /nicht bestätigt/,
  );
  assert.equal(g.state.led, true);
  assert.equal(g.state.commands.filter((c) => c === "SP-1024;2.5").length, 1);
});

test("LIVE validiert alle neun Felder, Leerlauf, Fehler und Restzeit ohne Ergebniswerte zu erfinden", () => {
  const live = parseMessage(
    "LIVE;MEASURING;SP-1024;4.5;12.45;1.25;2.5;50;1000",
  );
  assert.deepEqual(live, {
    type: "live",
    state: "MEASURING",
    code: "SP-1024",
    flow: 4.5,
    temperature: 12.45,
    volume: 1.25,
    target: 2.5,
    percent: 50,
    remaining: 1000,
  });
  assert.equal(parseMessage("LIVE;IDLE;;0;13.2;0;0;0;-1").code, null);
  assert.equal(parseMessage("LIVE;IDLE;-;0;13.2;0;0;0;-1").remaining, -1);
  assert.equal(
    parseMessage("LIVE;ERROR;SP-1024;0;13;1;2.5;40;-1").state,
    "ERROR",
  );
  assert.equal(parseMessage("STATUS;ERROR;SP-1024").state, "ERROR");
  for (const frame of [
    "LIVE;MEASURING;SP-1024;4.5;12;1;2.5;40",
    "LIVE;MEASURING;SP-1024;4.5;12;1;2.5;40;1;EXTRA",
    "LIVE;UNKNOWN;SP-1024;4.5;12;1;2.5;40;1",
    "LIVE;MEASURING;;4.5;12;1;2.5;40;1",
    "LIVE;MEASURING;SP-1024;NaN;12;1;2.5;40;1",
    "LIVE;MEASURING;SP-1024;-1;12;1;2.5;40;1",
    "LIVE;MEASURING;SP-1024;1;-127;1;2.5;40;1",
    "LIVE;MEASURING;SP-1024;1;12;1;0;40;1",
    "LIVE;MEASURING;SP-1024;1;12;1;2.5;101;1",
    "LIVE;MEASURING;SP-1024;1;12;1;2.5;40;-2",
    "LIVE;MEASURING;SP-1024;1;12;1;2.5;40;1\nNONE",
    "LIVE;MEASURING;" + "x".repeat(513),
  ])
    assert.throws(() => parseMessage(frame), frame);
});

test("Live-Daten laufen ohne Auftrag, veralten und verschwinden bei echter Trennung", async (t) => {
  const f = fake();
  await f.client.connect();
  const notify = (text) => {
    f.tx.value = new DataView(new TextEncoder().encode(text).buffer);
    f.tx.dispatchEvent(new Event("characteristicvaluechanged"));
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  notify("LIVE;IDLE;;1.2;14.2;0;0;0;-1");
  assert.equal(f.client.live.flow, 1.2);
  assert.equal(f.client.job, null);
  assert.equal(
    f.client.transport.mtu,
    null,
    "Web Bluetooth does not expose negotiated MTU",
  );
  assert.ok(f.client.transport.maxNotificationBytes > 20);
  t.mock.timers.tick(5001);
  assert.equal(f.client.live, null);
  notify("LIVE;MEASURING;SP-1024;4;14;1;2.5;40;1350");
  f.client.device.gatt.disconnect();
  assert.equal(f.client.live, null);
  assert.equal(f.client.deviceStatus, null);
  notify("LIVE;MEASURING;SP-1024;4;14;1.5;2.5;60;900");
  assert.equal(
    f.client.live,
    null,
    "late notifications must not revive disconnected values",
  );
});

test("LIVE stört weder GET noch ACK; abgeschnittene Telemetrie verwirft keine Messung", async () => {
  const f = fake({ dropGet: true });
  await f.client.connect();
  await f.client.startMeasurement(point, runId);
  f.complete();
  const notify = (text) => {
    f.tx.value = new DataView(new TextEncoder().encode(text).buffer);
    f.tx.dispatchEvent(new Event("characteristicvaluechanged"));
  };
  const getting = f.client.exchange(point, runId);
  notify("LIVE;READY;SP-1024;4;12.4;2.5;2.5;100;0");
  assert.ok(f.client.waiting);
  notify("LIVE;READY;SP-1024;4;12.4;2.5");
  assert.ok(
    f.client.waiting,
    "malformed telemetry cannot reject a result request",
  );
  assert.equal(f.client.live, null);
  const values = await getting;
  assert.equal(values.temperature_before, 12.45);
  assert.equal(
    f.state.commands.some((c) => c.startsWith("ACK;")),
    false,
  );
  f.state.serverSaved = true;
  await f.client.acknowledge(f.receipt());
  assert.equal(f.client.job, null);
});

test("Abgeschnittenes GET-Telegramm verwendet vollständiges TX Read; unvollständiges Read erzeugt kein Ergebnis", async () => {
  const f = fake();
  await f.client.connect();
  await f.client.startMeasurement(point, runId);
  f.state.frame = "SP-1024;2.500;12.45;9.82";
  const write = f.rx.writeValueWithResponse;
  f.rx.writeValueWithResponse = async (bytes) => {
    if (new TextDecoder().decode(bytes) === "GET") {
      f.tx.value = new DataView(
        new TextEncoder().encode("SP-1024;2.500;12.").buffer,
      );
      f.tx.dispatchEvent(new Event("characteristicvaluechanged"));
    } else await write(bytes);
  };
  assert.equal((await f.client.exchange(point, runId)).temperature_after, 9.82);
  f.tx.readValue = async () =>
    new DataView(new TextEncoder().encode("SP-1024;2.500;12.").buffer);
  await assert.rejects(() => f.client.exchange(point, runId));
  assert.equal(
    f.state.commands.some((c) => c.startsWith("ACK;")),
    false,
  );
  f.client.disconnect();
});

test("Auch ein numerisch plausibel abgeschnittenes Ergebnis wird vor Speicherung mit TX Read verglichen", async () => {
  const f = fake();
  await f.client.connect();
  await f.client.startMeasurement(point, runId);
  f.state.frame = "SP-1024;2.500;12.45;9.82";
  const write = f.rx.writeValueWithResponse;
  f.rx.writeValueWithResponse = async (bytes) => {
    if (new TextDecoder().decode(bytes) === "GET") {
      f.tx.value = new DataView(
        new TextEncoder().encode("SP-1024;2.500;12.45;9").buffer,
      );
      f.tx.dispatchEvent(new Event("characteristicvaluechanged"));
    } else await write(bytes);
  };
  await assert.rejects(() => f.client.exchange(point, runId), /TX Read/);
  assert.equal(f.client.job.received, false);
  assert.equal(
    f.state.commands.some((c) => c.startsWith("ACK;")),
    false,
  );
  f.client.disconnect();
});
