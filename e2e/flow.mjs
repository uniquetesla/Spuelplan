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
const directory = mkdtempSync(join(tmpdir(), "spuelpilot-flow-ui-")),
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
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.addInitScript(() => {
    const tx = new EventTarget();
    tx.properties = { read: true, notify: true };
    const view = (s) => new DataView(new TextEncoder().encode(s).buffer);
    const notify = (s) => {
      tx.value = view(s);
      tx.dispatchEvent(new Event("characteristicvaluechanged"));
    };
    tx.startNotifications = async () => tx;
    tx.readValue = async () => view("NONE");
    const commands = [];
    const rx = {
      properties: { write: true },
      writeValueWithResponse: async (bytes) => {
        const text = new TextDecoder().decode(bytes);
        commands.push(text);
        if (text !== "STATUS")
          throw Error("Durchflussaufzeichnung darf keine Spülbefehle senden");
        notify("NONE");
      },
    };
    const device = new EventTarget();
    device.name = "SpuelPilot-ESP32";
    device.gatt = {
      connected: false,
      connect: async () => {
        device.gatt.connected = true;
        return {
          getPrimaryService: async () => ({
            getCharacteristic: async (id) =>
              id === "5f6d0002-7ad8-4cb4-8cf5-909d54aa0001" ? rx : tx,
          }),
        };
      },
      disconnect: () => {
        device.gatt.connected = false;
        device.dispatchEvent(new Event("gattserverdisconnected"));
      },
    };
    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: { requestDevice: async () => device },
    });
    window.__flow = {
      send: (value) => notify(`LIVE;IDLE;;${value};14;0;0;0;-1`),
      disconnect: () => device.gatt.disconnect(),
      commands,
    };
  });
  async function login(email) {
    await page.goto(base);
    await page.getByLabel("E-Mail-Adresse", { exact: true }).fill(email);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Übersicht", exact: true, level: 1 }),
    ).toBeVisible();
  }
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  await login("lena@spuelplan.local");
  await page
    .getByRole("link", { name: "Durchflussmessung", exact: true })
    .click();
  await click("Bluetooth verbinden");
  await click("Neue Durchflussmessung");
  await page
    .getByLabel("Adresse", { exact: true })
    .fill("Hydrant Marktstraße 12");
  await page
    .getByLabel("Bemerkung (optional)", { exact: true })
    .fill("Interne Durchflussprüfung");
  await click("Aufzeichnung starten");
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Hydrant Marktstraße 12",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-flow-recording]")).toContainText(
    "Wartet auf Live-Daten",
  );
  await expect(page.locator('input[name="temperature_before"]')).toHaveCount(0);
  const id = Number(page.url().split("/").at(-1));
  await page.route("**/api/flow-measurements/*/samples", (route) =>
    route.abort("failed"),
  );
  await page.evaluate(() => window.__flow.send(0));
  await page.waitForTimeout(650);
  await page.evaluate(() => window.__flow.send(4.5));
  await page.waitForTimeout(650);
  await page.evaluate(() => window.__flow.send(8));
  await expect(page.locator("[data-flow-summary]")).toContainText("3");
  await page.evaluate(() => window.__flow.disconnect());
  await expect(page.locator(".flow-current")).toContainText("—");
  await page.waitForTimeout(5100);
  await click("Bluetooth verbinden");
  await page.evaluate(() => window.__flow.send(6.2));
  await expect(page.locator("[data-flow-summary]")).toContainText("4");
  await expect(page.locator(".flow-chart-line")).toHaveCount(2);
  await page.screenshot({
    path: "/tmp/spuelpilot-flow-desktop.png",
    fullPage: true,
  });
  await click("Messung beenden");
  await expect(page.locator("[data-flow-recording]")).toContainText(
    "Abschluss noch nicht bestätigt",
  );
  const open = await (await admin.get("/api/flow-measurements/" + id)).json();
  assert.equal(open.status, "active");
  assert.ok(
    await page.evaluate(() =>
      window.__flow.commands.every((c) => c === "STATUS"),
    ),
  );
  await page.unroute("**/api/flow-measurements/*/samples");
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Speicherung erneut versuchen",
      exact: true,
    }),
  ).toBeVisible();
  await click("Speicherung erneut versuchen");
  await expect(page.locator("[data-flow-recording]")).toHaveCount(0);
  const saved = await (await admin.get("/api/flow-measurements/" + id)).json();
  assert.equal(saved.status, "completed");
  assert.equal(saved.sample_count, 4);
  assert.equal("temperature" in saved, false);
  const series = await (
    await admin.get("/api/flow-measurements/" + id + "/series")
  ).json();
  assert.deepEqual(
    series.map((s) => s.flow),
    [0, 4.5, 8, 6.2],
  );
  await expect(page.locator(".flow-chart-line")).toHaveCount(2);
  await click("Adresse / Bemerkung bearbeiten");
  await page
    .getByLabel("Adresse", { exact: true })
    .fill("Marktstraße 12, Heppenheim");
  await page
    .getByLabel("Bemerkung (optional)", { exact: true })
    .fill("Ventil kontrollieren – intern");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Marktstraße 12, Heppenheim",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator(".flow-note-text")).toHaveText(
    "Ventil kontrollieren – intern",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".flow-chart")).toHaveAttribute(
    "viewBox",
    "0 0 420 270",
  );
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "/tmp/spuelpilot-flow-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.reload();
  await expect(page.locator(".flow-chart-line")).toHaveCount(2);
  await click("Messung löschen");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Abbrechen", exact: true })
    .click();
  await expect(page.locator(".flow-chart-line")).toHaveCount(2);
  await click("Messung löschen");
  await page
    .getByLabel("Zur Bestätigung die Adresse eingeben", { exact: true })
    .fill("Marktstraße 12, Heppenheim");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Messung löschen", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Durchflussmessungen",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator(".list-card")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await click("Abmelden");
  await login("betrachter@spuelplan.local");
  await expect(
    page.getByRole("link", { name: "Durchflussmessung", exact: true }),
  ).toHaveCount(0);
  await page.goto(base + "/#/flow");
  await expect(
    page.getByRole("heading", { name: "Übersicht", exact: true, level: 1 }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Mitarbeiter zeichnen Durchfluss ohne Spülbefehl und Temperatur auf; Diagramm markiert Bluetooth-Lücken; Offlinewerte überstehen Reload und werden beim Beenden gespeichert; Bearbeiten, bestätigtes Löschen und Betrachter-Sperre funktionieren.",
  );
} finally {
  await admin?.dispose();
  await browser?.close();
  server?.kill();
  if (server?.exitCode === null)
    await new Promise((resolve) => server.once("exit", resolve));
  rmSync(directory, { recursive: true, force: true });
}
