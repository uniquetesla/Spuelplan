import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "spuelpilot-ui-"));
const password = "UI-Test-Passwort-2026!";
let browser, server;
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
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Server exit " + code));
    });
  });
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
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("401"))
      errors.push(msg.text());
  });
  const heading = (name) =>
    page.getByRole("heading", { name, exact: true, level: 1 });
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  const closed = () => expect(page.locator("dialog")).not.toBeVisible();
  async function login(email) {
    await page.goto(base);
    await expect(page).toHaveTitle("SpülPilot · Stadtwerke Heppenheim");
    await page.getByLabel("E-Mail-Adresse", { exact: true }).fill(email);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await click("Anmelden");
    await expect(heading("Übersicht")).toBeVisible();
  }
  async function logout() {
    await click("Abmelden");
    await expect(
      page.getByRole("button", { name: "Anmelden", exact: true }),
    ).toBeVisible();
  }
  async function openList() {
    await page.goto(base + "/#/lists");
    await page.getByRole("link", { name: /UI-Testgebiet/ }).click();
    await expect(heading("UI-Testgebiet")).toBeVisible();
  }
  async function newPoint(code) {
    await page
      .getByRole("button", { name: "Spülpunkt anlegen", exact: true })
      .first()
      .click();
    await page.getByLabel("Spülpunkt ID", { exact: true }).fill(code);
    await page
      .getByLabel("Adresse des Spülpunkts", { exact: true })
      .fill(code + " · 64646 Heppenheim");
    await page.getByLabel("Sollmenge in m³", { exact: true }).fill("2.5");
    await click("Speichern");
    await closed();
    await expect(page.getByText(code, { exact: true })).toBeVisible();
  }
  async function documentPoint(code, amount) {
    await page
      .getByRole("row")
      .filter({ has: page.getByText(code, { exact: true }) })
      .getByRole("button", { name: "Spülung erfassen", exact: true })
      .click();
    await page
      .getByLabel("Temperatur vorher · °C", { exact: true })
      .fill("23.1");
    await page
      .getByLabel("Temperatur nachher · °C", { exact: true })
      .fill("14.3");
    await page
      .getByLabel("Tatsächlich gespülte Menge · m³", { exact: true })
      .fill(amount);
    await page
      .getByLabel("Trübung festgestellt?", { exact: true })
      .selectOption("false");
    assert.doesNotMatch(await page.locator("dialog").textContent(), /Uhrzeit/);
    await click("Spülung speichern");
    await closed();
  }
  await login("admin@spuelplan.local");
  await click("Neue Spülliste");
  await page.getByLabel("Listenname", { exact: true }).fill("UI-Testgebiet");
  await click("Speichern");
  await closed();
  await openList();
  await newPoint("UI-001");
  await newPoint("UI-002");
  await click("Freigabe");
  await page.getByRole("checkbox", { name: /Alex Morgan/ }).check();
  await page.getByRole("checkbox", { name: /Lena Fischer/ }).check();
  await expect(page.getByRole("checkbox")).toHaveCount(2);
  await click("Speichern");
  await closed();
  await expect(
    page.getByRole("button", { name: "Spülung erfassen", exact: true }),
  ).toHaveCount(2);
  await documentPoint("UI-001", "2.6");
  await expect(
    page.getByRole("button", { name: "Spülung erfassen", exact: true }),
  ).toHaveCount(1);
  await logout();
  console.log(
    "PASS: SpülPilot-Branding; Administration legt Liste und Punkte an, gibt sie frei und erfasst einen Punkt.",
  );
  await login("betrachter@spuelplan.local");
  await page.goto(base + "/#/lists");
  await expect(heading("Spüllisten")).toBeVisible();
  await expect(page.getByRole("link", { name: /UI-Testgebiet/ })).toHaveCount(
    0,
  );
  await logout();
  await login("lena@spuelplan.local");
  await openList();
  await documentPoint("UI-002", "2.7");
  await expect(heading("Spüllisten")).toBeVisible();
  await expect(page.getByRole("link", { name: /UI-Testgebiet/ })).toHaveCount(
    0,
  );
  await logout();
  console.log(
    "PASS: Letzte Spülung entfernt die Liste automatisch bei Mitarbeitern; Betrachter sehen vorher keine Daten.",
  );
  await login("admin@spuelplan.local");
  await expect(
    page.getByText(/abgeschlossene Spülliste\(n\) warten/),
  ).toBeVisible();
  await openList();
  await expect(page.getByText("Zur Prüfung", { exact: true })).toBeVisible();
  await click("Speichern & für Betrachter freigeben");
  await click("Speichern & freigeben");
  await closed();
  await expect(
    page.getByRole("button", {
      name: "Neuen Durchgang freigeben",
      exact: true,
    }),
  ).toBeVisible();
  await logout();
  await login("betrachter@spuelplan.local");
  await openList();
  await click("Protokolle");
  await expect(heading("Spülprotokolle")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  for (const value of await page
    .locator("tbody tr td:last-child")
    .allTextContents())
    assert.match(value, /^\d{2}\.\d{2}\.\d{4}$/);
  assert.doesNotMatch(
    await page.locator(".print-heading").textContent(),
    /\d{1,2}:\d{2}/,
  );
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: join(directory, "protokoll.pdf"),
    landscape: true,
    preferCSSPageSize: true,
  });
  await expect(page.locator(".sidebar")).not.toBeVisible();
  for (const name of [
    "Spülpunkt ID",
    "Adresse",
    "Soll m³",
    "Ist m³",
    "Temp. vorher",
    "Temp. nachher",
    "Trübung",
    "Mitarbeiter",
  ])
    assert.ok((await page.locator("thead").textContent()).includes(name));
  await page.emulateMedia({ media: "screen" });
  await logout();
  console.log(
    "PASS: Administration speichert und veröffentlicht; Betrachter erhalten danach die datierte Druckliste.",
  );
  await login("admin@spuelplan.local");
  await openList();
  await click("Neuen Durchgang freigeben");
  await page.getByRole("checkbox", { name: /Lena Fischer/ }).check();
  await click("Speichern");
  await closed();
  await expect(
    page.getByRole("button", { name: "Spülung erfassen", exact: true }),
  ).toHaveCount(2);
  await expect(page.getByText("Durchgang 2", { exact: true })).toBeVisible();
  await logout();
  await login("lena@spuelplan.local");
  await openList();
  await expect(
    page.getByRole("button", { name: "Spülung erfassen", exact: true }),
  ).toHaveCount(2);
  await documentPoint("UI-001", "2.8");
  await logout();
  await login("betrachter@spuelplan.local");
  await openList();
  await expect(page.getByText("Durchgang 1", { exact: true })).toBeVisible();
  await click("Protokolle");
  await expect(heading("Spülprotokolle")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Durchgang filtern").selectOption({ index: 1 });
  await expect(page.locator("tbody tr")).toHaveCount(2);
  console.log(
    "PASS: Neuer Durchgang setzt Bearbeitungsstand zurück; veröffentlichte Historie bleibt unverändert sichtbar.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await click("Menü öffnen");
  await page.getByRole("link", { name: "Übersicht", exact: true }).click();
  await expect(heading("Übersicht")).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "/tmp/spuelpilot-mobile.png", fullPage: true });
  await click("Menü öffnen");
  await page
    .getByRole("link", { name: "Geräte & Sensoren", exact: true })
    .click();
  await expect(heading("Geräte & Sensoren")).toBeVisible();
  const flow = await page.locator(".device-flow").textContent();
  assert.match(flow, /mindestens 1 m³\/h/);
  assert.match(flow, /5 Sekunden/);
  await click("Menü öffnen");
  await logout();
  await page.setViewportSize({ width: 1440, height: 1050 });
  await login("admin@spuelplan.local");
  await openList();
  await page.screenshot({ path: "/tmp/spuelpilot-list.png", fullPage: true });
  await click("Löschen");
  await page
    .getByLabel("Zur Bestätigung den Listennamen eingeben", { exact: true })
    .fill("UI-Testgebiet");
  await click("Liste löschen");
  await closed();
  await expect(heading("Spüllisten")).toBeVisible();
  await expect(page.getByRole("link", { name: /UI-Testgebiet/ })).toHaveCount(
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Mobile Navigation, ESP32-Spezifikation und ausdrücklich bestätigte Admin-Löschung; keine Browserfehler.",
  );
} finally {
  await browser?.close();
  server?.kill();
  if (server?.exitCode === null)
    await new Promise((r) => server.once("exit", r));
  rmSync(directory, { recursive: true, force: true });
}
