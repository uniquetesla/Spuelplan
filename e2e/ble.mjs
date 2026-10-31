import {
  chromium,
  expect,
  request as playwrightRequest,
} from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "spuelpilot-ble-ui-")),
  password = "BLE-Test-Passwort-2026!";
let browser, server, admin;
try {
  server = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      DEMO_MODE: "true",
      DEMO_PASSWORD: password,
      DB_PATH: join(directory, "db.sqlite"),
      PORT: "0",
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Serverstart fehlgeschlagen")),
      10000,
    );
    server.stdout.on("data", (d) => {
      const m = d.toString().match(/Port (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:" + m[1]);
      }
    });
    server.once("exit", (c) => {
      clearTimeout(timer);
      reject(Error("Server exit " + c));
    });
  });
  admin = await playwrightRequest.newContext({
    baseURL: base,
    extraHTTPHeaders: { Origin: base },
  });
  const auth = await (
    await admin.post("/api/login", {
      data: { email: "admin@spuelplan.local", password },
    })
  ).json();
  const headers = { "X-CSRF-Token": auth.csrf };
  const list = await (
    await admin.post("/api/lists", { headers, data: { name: "BLE-Testliste" } })
  ).json();
  const point = await (
    await admin.post("/api/points", {
      headers,
      data: {
        list_id: list.id,
        code: "SP-BLE",
        address: "64646 Heppenheim",
        target: 2.5,
      },
    })
  ).json();
  assert.equal(
    (
      await admin.put(`/api/lists/${list.id}/assignments`, {
        headers,
        data: { user_ids: [2] },
      })
    ).status(),
    200,
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const state = {
      frame: null,
      code: null,
      status: null,
      led: false,
      dropAck: true,
    };
    const commands = JSON.parse(
      sessionStorage.getItem("__ble_commands") || "[]",
    );
    const tx = new EventTarget();
    tx.properties = { read: true, notify: true };
    const view = (text) => new DataView(new TextEncoder().encode(text).buffer);
    const notify = (text) => {
      tx.value = view(text);
      tx.dispatchEvent(new Event("characteristicvaluechanged"));
    };
    tx.startNotifications = async () => tx;
    tx.readValue = async () => view(state.frame ?? "NONE");
    const rx = {
      properties: { write: true, writeWithoutResponse: true },
      writeValueWithResponse: async (bytes) => {
        const text = new TextDecoder().decode(bytes);
        commands.push(text);
        sessionStorage.setItem("__ble_commands", JSON.stringify(commands));
        if (text === "STATUS") {
          notify(state.status ?? "NONE");
          return;
        }
        if (text === "GET") {
          notify(state.frame ?? "NONE");
          return;
        }
        if (text.startsWith("ACK;")) {
          if (!sessionStorage.getItem("__server_confirmed"))
            throw Error("ACK before server success");
          state.frame = null;
          state.led = false;
          state.status = null;
          if (!state.dropAck) notify("STATUS;ACK_OK");
          return;
        }
        if (text === `${state.code};0`) {
          if (state.frame) {
            notify(state.status);
            return;
          }
          state.status = null;
          state.led = false;
          notify("STATUS;ACK_OK");
          return;
        }
        const [code] = text.split(";");
        state.code = code;
        state.status = "STATUS;WAIT_FLOW;" + code;
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
            if (uuid !== "5f6d0001-7ad8-4cb4-8cf5-909d54aa0001")
              throw Error("Wrong UUID");
            return {
              getCharacteristic: async (id) => {
                if (id === "5f6d0002-7ad8-4cb4-8cf5-909d54aa0001") return rx;
                if (id === "5f6d0003-7ad8-4cb4-8cf5-909d54aa0001") return tx;
                throw Error("Wrong characteristic");
              },
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
    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: { requestDevice: async () => device },
    });
    window.__ble = {
      state,
      commands,
      notify,
      disconnect: () => device.gatt.disconnect(),
      complete: (frame = "SP-BLE;2.500;12.45;9.82") => {
        state.frame = frame;
        state.status = "STATUS;READY;" + frame.split(";")[0];
        state.led = true;
        notify(state.status);
      },
    };
  });
  let attempts = 0,
    requestId;
  await page.route(`**/api/points/${point.id}/flushes`, async (route) => {
    attempts++;
    const body = route.request().postDataJSON();
    assert.equal(body.source, "esp32");
    if (requestId) assert.equal(body.request_id, requestId);
    requestId = body.request_id;
    if (attempts === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Test-Speicherfehler" }),
      });
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), attempts === 2 ? 201 : 200);
    if (attempts === 2) {
      await route.abort("failed");
      return;
    }
    await page.evaluate(() =>
      sessionStorage.setItem("__server_confirmed", "true"),
    );
    await route.fulfill({ response });
  });
  await page.goto(base);
  await page
    .getByLabel("E-Mail-Adresse", { exact: true })
    .fill("lena@spuelplan.local");
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByRole("link", { name: /BLE-Testliste/ }).click();
  await page
    .locator('tr[data-action="select-point"]')
    .getByText("64646 Heppenheim", { exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Spülpunkt an ESP32 senden",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Bluetooth verbinden", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Spülpunkt an ESP32 senden",
      exact: true,
    }),
  ).toBeEnabled();
  await page.evaluate(() =>
    window.__ble.notify("LIVE;IDLE;;1.25;14.2;0;0;0;-1"),
  );
  await expect(page.locator('[data-live="flow"]')).toContainText("1,25");
  await expect(page.locator('[data-live="temperature"]')).toContainText("14,2");
  await page.evaluate(() => window.__ble.disconnect());
  await expect(page.locator('[data-live="flow"]')).toContainText("—");
  await expect(page.locator('[data-live="temperature"]')).toContainText("—");
  await page
    .getByRole("button", { name: "Bluetooth verbinden", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Spülpunkt an ESP32 senden", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Messdaten abrufen", exact: true }),
  ).toBeEnabled();
  assert.ok(
    (await page.evaluate(() => window.__ble.commands)).includes("SP-BLE;2.5"),
  );
  await expect(page.locator("[data-ble-cancel-support]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Messung abbrechen", exact: true }),
  ).toBeEnabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Neue Messung starten", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Messdaten abrufen", exact: true }),
  ).toBeEnabled();
  assert.equal(
    await page.evaluate(() => window.__ble.commands.includes("SP-BLE;0")),
    false,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Neue Messung starten", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Messdaten abrufen", exact: true }),
  ).toBeEnabled();
  assert.equal(
    await page.evaluate(
      () => window.__ble.commands.filter((c) => c === "SP-BLE;0").length,
    ),
    1,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Messung abbrechen", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Spülpunkt an ESP32 senden",
      exact: true,
    }),
  ).toBeEnabled();
  assert.equal(attempts, 0);
  assert.equal(
    await page.evaluate(() => window.__ble.commands.includes("SP-BLE;0")),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      window.__ble.commands.some((c) => c.startsWith("ACK;")),
    ),
    false,
  );
  await page
    .getByRole("button", { name: "Spülpunkt an ESP32 senden", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Messdaten abrufen", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    window.__ble.notify("LIVE;MEASURING;SP-BLE;4.5;12.4;1.25;2.5;50;1000"),
  );
  await expect(
    page.getByRole("progressbar", { name: "Spülfortschritt" }),
  ).toHaveAttribute("aria-valuenow", "50");
  await expect(page.locator('[data-live="volume"]')).toHaveText(
    "1,25 / 2,5 m³",
  );
  await expect(page.locator('[data-live="remaining"]')).toHaveText(
    "16 Min. 40 Sek.",
  );
  const priorStarts = await page.evaluate(
    () => window.__ble.commands.filter((c) => c === "SP-BLE;2.5").length,
  );
  await page.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.goto(base + "/#/account");
  await expect(
    page.getByRole("heading", { name: "Mein Passwort", exact: true, level: 1 }),
  ).toBeVisible();
  const dock = page.locator('[data-measurement="ble"]');
  await expect(dock).toBeVisible();
  await expect(dock).toContainText("50 %");
  await dock.focus();
  await page.evaluate(() =>
    window.__ble.notify("LIVE;MEASURING;SP-BLE;4.5;12.4;1.5;2.5;60;800"),
  );
  await expect(dock).toBeFocused();
  await expect(dock).toContainText("60 %");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#measurement-dock")).not.toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await dock.click();
  await expect(
    page.getByRole("heading", { name: "Spülung dokumentieren", exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => window.__ble.commands.filter((c) => c === "SP-BLE;2.5").length,
    ),
    priorStarts,
    "opening the running job must never start another hardware measurement",
  );
  await page.evaluate(() =>
    window.__ble.notify("LIVE;WAIT_FLOW;SP-BLE;0;12.4;1.25;2.5;50;-1"),
  );
  await expect(page.locator('[data-live="remaining"]')).toHaveText(
    "Nicht berechenbar",
  );
  await page.evaluate(() =>
    window.__ble.notify("LIVE;ERROR;SP-BLE;0;12.4;1.25;2.5;50;-1"),
  );
  await expect(page.locator(".ble-status")).toContainText("Messfehler");
  await page.evaluate(() => window.__ble.notify("LIVE;MEASURING;SP-BLE;4"));
  await expect(page.locator('[data-live="flow"]')).toContainText("—");
  assert.equal(attempts, 0);
  await page.evaluate(() => window.__ble.complete("FREMD;2.500;12.45;9.82"));
  await page
    .getByRole("button", { name: "Messdaten abrufen", exact: true })
    .click();
  await expect(page.locator(".ble-error")).toContainText("Spülpunkt-ID");
  await expect(
    page.getByLabel("Temperatur vorher · °C", { exact: true }),
  ).toHaveValue("");
  await page.evaluate(() => {
    window.__ble.state.frame = "SP-BLE;2.500;12.45;9.82";
    window.__ble.state.status = "STATUS;READY;SP-BLE";
    window.__ble.state.led = true;
    for (let i = 0; i < 5; i++)
      window.__ble.notify("LIVE;READY;SP-BLE;4.5;9.82;2.5;2.5;100;0");
  });
  await expect(
    page.getByLabel("Temperatur vorher · °C", { exact: true }),
  ).toHaveValue("12.45");
  await expect(
    page.getByLabel("Temperatur nachher · °C", { exact: true }),
  ).toHaveValue("9.82");
  await expect(
    page.getByLabel("Tatsächlich gespülte Menge · m³", { exact: true }),
  ).toHaveValue("2.5");
  await page
    .getByLabel("Trübung festgestellt?", { exact: true })
    .selectOption("false");
  await expect(page.locator(".ble-error")).toContainText("Test-Speicherfehler");
  assert.equal(
    attempts,
    1,
    "READY triggers one automatic save, repeated telemetry must not duplicate it",
  );
  await page.screenshot({ path: "/tmp/spuelpilot-ble.png", fullPage: true });
  assert.equal(
    await page.evaluate(() =>
      window.__ble.commands.some((c) => c.startsWith("ACK;")),
    ),
    false,
  );
  assert.equal(await page.evaluate(() => window.__ble.state.led), true);
  await page
    .getByRole("button", { name: "Spülung speichern", exact: true })
    .click();
  await expect(page.locator("#modal-error")).not.toContainText(
    "Test-Speicherfehler",
  );
  await expect(
    page.getByRole("button", { name: "Spülung speichern", exact: true }),
  ).toBeEnabled();
  assert.equal(
    await page.evaluate(() =>
      window.__ble.commands.some((c) => c.startsWith("ACK;")),
    ),
    false,
  );
  await page
    .getByRole("button", { name: "Spülung speichern", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("heading", { name: "Spüllisten", exact: true, level: 1 }),
  ).toBeVisible();
  assert.equal(attempts, 3);
  assert.equal(await page.evaluate(() => window.__ble.state.led), false);
  const records = await (await admin.get("/api/flushes")).json();
  const saved = records.filter((r) => r.request_id === requestId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, "esp32");
  assert.equal(saved[0].temperature_before, 12.45);
  // Simulate a lost local receipt marker while keeping the durable transfer ID.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("spuelpilot.ble-job."),
    );
    const job = JSON.parse(localStorage.getItem(key));
    delete job.savedId;
    localStorage.setItem(key, JSON.stringify(job));
  });
  await page.goto(base + "/#/devices");
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Geräte & Sensoren",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Server-Speicherstatus prüfen", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Empfang am ESP32 bestätigen",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Bluetooth verbinden", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Empfang am ESP32 bestätigen",
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Empfang am ESP32 bestätigen", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Empfang am ESP32 bestätigen",
      exact: true,
    }),
  ).toHaveCount(0);
  const commands = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("__ble_commands")),
  );
  assert.equal(commands.filter((c) => c === "SP-BLE;2.5").length, 3);
  assert.equal(commands.filter((c) => c === "ACK;SP-BLE").length, 1);
  await page.goto(base + "/#/flow");
  await page
    .getByRole("button", { name: "Neue Durchflussmessung", exact: true })
    .click();
  await page
    .getByLabel("Adresse", { exact: true })
    .fill("Parallele Durchflussmessung");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Aufzeichnung starten", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(page.locator('[data-measurement="flow"]')).toBeVisible();
  // A second run completes autonomously while disconnected. The existing job
  // metadata supplies the explicitly chosen turbidity, never a guessed default.
  assert.equal(
    (
      await admin.post(`/api/lists/${list.id}/publish`, { headers, data: {} })
    ).status(),
    200,
  );
  assert.equal(
    (
      await admin.post(`/api/lists/${list.id}/restart`, {
        headers,
        data: { user_ids: [2] },
      })
    ).status(),
    201,
  );
  await page.unroute(`**/api/points/${point.id}/flushes`);
  let automaticPosts = 0;
  await page.route(`**/api/points/${point.id}/flushes`, async (route) => {
    automaticPosts++;
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await page.evaluate(() =>
      sessionStorage.setItem("__server_confirmed", "true"),
    );
    await route.fulfill({ response });
  });
  await page.goto(base + "/#/lists/" + list.id);
  const row = page.locator('tr[data-action="select-point"]');
  await row.focus();
  await row.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Spülung dokumentieren", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Trübung festgestellt?", { exact: true })
    .selectOption("true");
  await page
    .getByLabel("Interne Bemerkung", { exact: false })
    .fill("Interner Sensorhinweis");
  await page
    .getByRole("button", { name: "Spülpunkt an ESP32 senden", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Messdaten abrufen", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.goto(base + "/#/devices");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() =>
    window.__ble.notify("LIVE;MEASURING;SP-BLE;4.5;12.4;1.25;2.5;50;1000"),
  );
  await expect(page.locator('[data-live="percent"]:visible')).toHaveText(
    "50 %",
  );
  await expect(page.locator("#measurement-dock .measurement-tile")).toHaveCount(
    2,
  );
  await expect(page.locator("body")).toHaveClass(/has-two-measurements/);
  await page.screenshot({
    path: "/tmp/spuelpilot-live-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.evaluate(() => {
    window.__ble.disconnect();
    window.__ble.state.dropAck = false;
    window.__ble.state.frame = "SP-BLE;2.500;12.45;9.82";
    window.__ble.state.status = "STATUS;READY;SP-BLE";
    window.__ble.state.led = true;
    sessionStorage.removeItem("__server_confirmed");
    window.__ble.notify("LIVE;READY;SP-BLE;4.5;9.82;2.5;2.5;100;0");
  });
  await expect(page.locator('[data-live="flow"]')).toContainText("—");
  assert.equal(automaticPosts, 0);
  await page
    .getByRole("button", { name: "Bluetooth verbinden", exact: true })
    .click();
  await expect.poll(() => automaticPosts).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__ble.commands.filter((c) => c === "ACK;SP-BLE").length,
      ),
    )
    .toBe(2);
  await expect
    .poll(async () =>
      (await (await admin.get("/api/flushes")).json()).filter(
        (f) => f.point_id === point.id,
      ),
    )
    .toHaveLength(2);
  const allRecords = await (await admin.get("/api/flushes")).json();
  const secondRecord = allRecords.find(
    (f) => f.point_id === point.id && f.run_number === 2,
  );
  assert.equal(secondRecord.turbidity, 1);
  assert.equal(secondRecord.temperature_after, 9.82);
  const notes = await (await admin.get("/api/internal-notes")).json();
  assert.ok(
    notes.some(
      (n) => n.content === "Interner Sensorhinweis" && n.run_number === 2,
    ),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((k) =>
          k.startsWith("spuelpilot.ble-job."),
        ),
      ),
    )
    .toEqual([]);
  await expect(page.locator('[data-measurement="ble"]')).toHaveCount(0);
  await expect(page.locator('[data-measurement="flow"]')).toBeVisible();
  await page.locator('[data-measurement="flow"]').click();
  await expect(
    page.getByRole("heading", {
      name: "Parallele Durchflussmessung",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Messung beenden", exact: true })
    .click();
  await expect(page.locator("#measurement-dock")).toBeHidden();
  console.log(
    "PASS: Seitenübergreifende Messungsanzeige für parallele Spül- und Durchflussmessungen, direkte Rückkehr zum Messpunkt ohne Neustart, stabiler Tastaturfokus und druckfreie Anzeige.",
  );
  console.log(
    "PASS: Live im Leerlauf, Fortschritt, Restzeit, Fehler und mobile Anzeige; READY ruft automatisch ab, speichert einmalig und bestätigt erst nach Servererfolg; autonome Messung nach Trennung wird korrekt wiederaufgenommen.",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Bestätigter Messabbruch über ID;0 ohne Protokoll, BLE-Button, exakte UUIDs und Telegramme, Notify-Import mit zwei Dezimalstellen, falsche ID, Speicherfehler ohne ACK, verlorene Serverantwort ohne Dublette, ACK erst nach Servererfolg und wiederaufnehmbare Bestätigung nach Browserneustart.",
  );
} finally {
  await admin?.dispose();
  await browser?.close();
  server?.kill();
  if (server?.exitCode === null)
    await new Promise((r) => server.once("exit", r));
  rmSync(directory, { recursive: true, force: true });
}
