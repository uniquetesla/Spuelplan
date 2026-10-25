import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "spuelplan-ui-"));
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
      () => reject(new Error("Serverstart fehlgeschlagen")),
      10000,
    );
    server.stdout.on("data", (data) => {
      const port = data.toString().match(/Port (\d+)/);
      if (port) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:" + port[1]);
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Server beendet: " + code));
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
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      !msg.text().includes("401") &&
      !msg.text().includes("favicon")
    )
      errors.push(msg.text());
  });
  async function login(email) {
    await page.goto(base);
    await page.getByLabel("E-Mail-Adresse", { exact: true }).fill(email);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await page
      .getByRole("heading", { name: "Übersicht", exact: true })
      .waitFor();
  }
  async function logout() {
    await page.getByRole("button", { name: "Abmelden", exact: true }).click();
    await page.getByRole("button", { name: "Anmelden", exact: true }).waitFor();
  }
  await login("admin@spuelplan.local");
  await page
    .getByRole("button", { name: "Neue Spülliste", exact: true })
    .click();
  await page.getByLabel("Listenname", { exact: true }).fill("UI-Testgebiet");
  await page
    .getByLabel("Beschreibung", { exact: false })
    .fill("Automatisiert geprüftes Gebiet");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.getByRole("link", { name: /Alle Listen ansehen/ }).click();
  await page.getByRole("link", { name: /UI-Testgebiet/ }).click();
  await page
    .getByRole("button", { name: "Spülpunkt anlegen", exact: true })
    .first()
    .click();
  await page.getByLabel("Spülpunkt ID", { exact: true }).fill("UI-001");
  await page
    .getByLabel("Adresse des Spülpunkts", { exact: true })
    .fill("Teststraße 42, Berlin");
  await page.getByLabel("Sollmenge in m³", { exact: true }).fill("2.5");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.getByText("UI-001", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Freigabe", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.getByText("Lena Fischer", { exact: true }).waitFor();
  await logout();
  console.log(
    "PASS: Administration erstellt Liste und Punkt und gibt gesamte Liste frei.",
  );
  await login("lena@spuelplan.local");
  await page.getByRole("link", { name: /UI-Testgebiet/ }).click();
  await page
    .getByRole("button", { name: "Spülung erfassen", exact: true })
    .click();
  await page.getByLabel("Temperatur vorher · °C", { exact: true }).fill("23.1");
  await page
    .getByLabel("Temperatur nachher · °C", { exact: true })
    .fill("14.3");
  await page
    .getByLabel("Tatsächlich gespülte Menge · m³", { exact: true })
    .fill("2.7");
  await page
    .getByLabel("Trübung festgestellt?", { exact: true })
    .selectOption("false");
  await page
    .getByRole("button", { name: "Spülung speichern", exact: true })
    .click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Protokolle", exact: true }).click();
  await page.getByRole("heading", { name: "Spülprotokolle", exact: true }).waitFor();
  await page.getByText("UI-001", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.match(await page.locator("tbody").textContent(), /2,7/);
  await logout();
  console.log(
    "PASS: Mitarbeiter erfasst Messwerte; Protokoll wird gespeichert und richtig gefiltert.",
  );
  await login("betrachter@spuelplan.local");
  assert.equal(
    await page.getByRole("link", { name: /Team & Zugänge/ }).count(),
    0,
  );
  await page.getByRole("link", { name: /Spülprotokolle/ }).click();
  await page.getByRole("heading", { name: "Spülprotokolle", exact: true }).waitFor();
  await page.getByLabel("Protokolle suchen", { exact: true }).fill("UI-001");
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: join(directory, "protokoll.pdf"),
    landscape: true,
    preferCSSPageSize: true,
  });
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  for (const title of [
    "Spülpunkt ID",
    "Adresse",
    "Soll m³",
    "Ist m³",
    "Temp. vorher",
    "Temp. nachher",
    "Trübung",
    "Mitarbeiter",
  ])
    assert.ok((await page.locator("thead").textContent()).includes(title));
  await page.emulateMedia({ media: "screen" });
  console.log(
    "PASS: Betrachter kann gefilterte Protokolle ansehen; PDF enthält alle geforderten Spalten.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menü öffnen" }).click();
  await page.getByRole("link", { name: "Übersicht", exact: true }).click();
  await page.getByRole("heading", { name: "Übersicht", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "/tmp/spuelplan-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Mobile Navigation bei 390 px; keine horizontale Seitenverschiebung oder JavaScript-Fehler.",
  );
} finally {
  await browser?.close();
  server?.kill();
  if (server?.exitCode === null)
    await new Promise((r) => server.once("exit", r));
  rmSync(directory, { recursive: true, force: true });
}
