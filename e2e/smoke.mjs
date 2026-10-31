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
  async function login(email, loginPassword = password, forced = false) {
    await page.goto(base);
    await expect(page).toHaveTitle("SpülPilot · Stadtwerke Heppenheim");
    await page.getByLabel("E-Mail-Adresse", { exact: true }).fill(email);
    await page.getByLabel("Passwort", { exact: true }).fill(loginPassword);
    await click("Anmelden");
    await expect(
      heading(forced ? "Neues Passwort festlegen" : "Übersicht"),
    ).toBeVisible();
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
  async function documentPoint(code, amount, note = "") {
    await page
      .getByRole("row")
      .filter({ has: page.getByText(code, { exact: true }) })
      .locator("td")
      .nth(1)
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
    if (note)
      await page.getByLabel("Interne Bemerkung", { exact: false }).fill(note);
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
  const internalNote = "Hydrant tropft – interne Prüfung erforderlich.";
  await documentPoint("UI-002", "2.7", internalNote);
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
  await expect(page.locator(".subtitle")).toContainText(
    "Zur Betrachtung freigegeben am",
  );
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await click("Protokolle");
  await expect(heading("Spülprotokolle")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: /Interne Hinweise/ }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(internalNote);
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
  await page.getByRole("link", { name: /Interne Hinweise/ }).click();
  await expect(heading("Interne Hinweise")).toBeVisible();
  await expect(page.locator(".issue-card")).toContainText(internalNote);
  await page.screenshot({ path: "/tmp/spuelpilot-notes.png", fullPage: true });
  await click("Quittieren");
  await expect(page.locator(".issue-card")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Keine offenen Hinweise", exact: true }),
  ).toBeVisible();
  await openList();
  await click("Neuen Durchgang freigeben");
  await expect(
    page.locator('dialog input[name="assignee"]:checked'),
  ).toHaveCount(0);
  await page.getByRole("checkbox", { name: /Lena Fischer/ }).check();
  await click("Speichern");
  await closed();
  await expect(
    page.getByRole("button", { name: "Spülung erfassen", exact: true }),
  ).toHaveCount(0);
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
  await expect(page.locator(".subtitle")).toContainText("Durchgang 1");
  await click("Protokolle");
  await expect(heading("Spülprotokolle")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Liste drucken", exact: true }),
  ).toBeVisible();
  console.log(
    "PASS: Neuer Durchgang setzt Bearbeitungsstand zurück; veröffentlichte Historie bleibt unverändert sichtbar.",
  );
  await logout();
  await login("lena@spuelplan.local");
  await openList();
  await documentPoint("UI-002", "3.1");
  await logout();
  await login("admin@spuelplan.local");
  await openList();
  await expect(
    page.getByText("Noch keine Personen", { exact: true }),
  ).toBeVisible();
  await click("Speichern & für Betrachter freigeben");
  await click("Speichern & freigeben");
  await closed();
  await logout();
  await login("betrachter@spuelplan.local");
  await page.goto(base + "/#/reports");
  await expect(heading("Spülprotokolle")).toBeVisible();
  const archiveCards = page
    .locator(".list-card")
    .filter({ hasText: "UI-Testgebiet" });
  await expect(archiveCards).toHaveCount(2);
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Liste drucken", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Spülprotokolle suchen").fill("kein Treffer");
  await expect(archiveCards).toHaveCount(0);
  await page.getByLabel("Spülprotokolle suchen").fill("UI-Testgebiet");
  await expect(archiveCards).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    await expect(archiveCards.nth(index)).toContainText(
      "Zur Betrachtung freigegeben am",
    );
    await archiveCards.nth(index).click();
    await expect(heading("Spülprotokolle")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator(".subtitle")).toContainText(
      `Durchgang ${2 - index}`,
    );
    await expect(
      page.locator("tbody tr").filter({ hasText: "UI-001" }),
    ).toContainText(index === 0 ? "2,8" : "2,6");
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator(".print-heading")).toContainText(
      `Durchgang ${2 - index}`,
    );
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await page.pdf({
      path: join(directory, `durchgang-${2 - index}.pdf`),
      landscape: true,
    });
    await page.emulateMedia({ media: "screen" });
    await page.goto(base + "/#/reports");
  }
  await page.screenshot({
    path: "/tmp/spuelpilot-archive.png",
    fullPage: true,
  });
  console.log(
    "PASS: Zwei veröffentlichte Durchläufe erscheinen separat mit Freigabedatum und öffnen ausschließlich ihre eigenen Messwerte.",
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
  await expect(
    page.getByRole("link", { name: "Geräte & Sensoren", exact: true }),
  ).toHaveCount(0);
  await page.goto(base + "/#/notes");
  await expect(heading("Übersicht")).toBeVisible();
  await expect(page.locator(".issue-card")).toHaveCount(0);
  await page.goto(base + "/#/devices");
  await expect(heading("Übersicht")).toBeVisible();
  await expect(page.locator(".device-flow")).toHaveCount(0);
  await click("Menü öffnen");
  await page.getByRole("link", { name: "Mein Passwort", exact: true }).click();
  await expect(heading("Mein Passwort")).toBeVisible();
  const viewerPassword = "Viewer-Passwort-2026!";
  await page.getByLabel("Aktuelles Passwort", { exact: true }).fill(password);
  await page.getByLabel("Neues Passwort", { exact: true }).fill(viewerPassword);
  await page
    .getByLabel("Neues Passwort wiederholen", { exact: true })
    .fill(viewerPassword);
  await click("Passwort speichern");
  await expect(page.getByLabel("Neues Passwort", { exact: true })).toHaveValue(
    "",
  );
  await click("Menü öffnen");
  await logout();
  console.log(
    "PASS: Betrachter sehen keinen Sensormenüpunkt, auch nicht per Direktlink; eigener Passwortwechsel funktioniert.",
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
  await login("admin@spuelplan.local");
  await page.getByRole("link", { name: "Team & Zugänge", exact: true }).click();
  await expect(heading("Team & Zugänge")).toBeVisible();
  await page
    .getByRole("row")
    .filter({ has: page.getByText("Chris Weber", { exact: true }) })
    .getByRole("button", { name: "Einmalpasswort erstellen", exact: true })
    .click();
  await click("Einmalpasswort generieren");
  await expect(page.locator("#one-time-password")).toBeVisible();
  const temporary = await page.locator("#one-time-password").inputValue();
  assert.match(temporary, /^[A-Z][a-z]+\d{4}$/);
  await click("Fertig");
  await closed();
  await expect(page.locator("#one-time-password")).toHaveCount(0);
  await logout();
  await login("betrachter@spuelplan.local", temporary, true);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.goto(base + "/#/lists");
  await expect(heading("Neues Passwort festlegen")).toBeVisible();
  const newPersonal = "Persoenlich-Neu-2026!";
  await page.getByLabel("Neues Passwort", { exact: true }).fill(newPersonal);
  await page
    .getByLabel("Neues Passwort wiederholen", { exact: true })
    .fill(newPersonal);
  await click("Passwort speichern");
  await expect(heading("Übersicht")).toBeVisible();
  const fresh = await browser.newContext();
  const reused = await fresh.request.post(base + "/api/login", {
    headers: { Origin: base },
    data: { email: "betrachter@spuelplan.local", password: temporary },
  });
  assert.equal(reused.status(), 401);
  await fresh.close();
  await logout();
  await login("betrachter@spuelplan.local", newPersonal);
  await logout();
  console.log(
    "PASS: Admin erzeugt Einmalpasswort; Pflichtwechsel sperrt Navigation und Arbeitsdaten; Einmalpasswort kann nicht wiederverwendet werden.",
  );
  await login("admin@spuelplan.local");
  await page
    .getByRole("link", { name: "Geräte & Sensoren", exact: true })
    .click();
  await expect(heading("Geräte & Sensoren")).toBeVisible();
  const flow = await page.locator(".device-flow").textContent();
  assert.match(flow, /mindestens 1 m³\/h/);
  assert.match(flow, /5 Sekunden/);
  await page.getByRole("link", { name: "Team & Zugänge", exact: true }).click();
  await click("Einstellungen");
  await expect(
    page.getByRole("heading", {
      name: "Administration · Einstellungen",
      exact: true,
    }),
  ).toBeVisible();
  await click("Abbrechen");
  await closed();
  await click("Einstellungen");
  await page
    .getByLabel("Zur Bestätigung STATISTIK ZURÜCKSETZEN eingeben", {
      exact: true,
    })
    .fill("STATISTIK ZURÜCKSETZEN");
  await click("Statistik zurücksetzen");
  await closed();
  await page.goto(base + "/#/overview");
  await expect(
    page
      .locator(".stat")
      .filter({ hasText: "Gespülte Menge" })
      .locator(".stat-number"),
  ).toHaveText("0m³");
  await expect(
    page
      .locator(".stat")
      .filter({ hasText: "Dokumentierte Spülungen" })
      .locator(".stat-number"),
  ).toHaveText("0");
  await page.goto(base + "/#/reports");
  await expect(
    page.locator(".list-card").filter({ hasText: "UI-Testgebiet" }),
  ).toHaveCount(2);
  await page
    .locator(".list-card")
    .filter({ hasText: "UI-Testgebiet" })
    .first()
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page
    .locator("tbody tr")
    .filter({ hasText: "UI-001" })
    .getByRole("button", { name: "Protokoll löschen", exact: true })
    .click();
  await click("Abbrechen");
  await closed();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page
    .locator("tbody tr")
    .filter({ hasText: "UI-001" })
    .getByRole("button", { name: "Protokoll löschen", exact: true })
    .click();
  await page
    .getByLabel("Zur Bestätigung die Spülpunkt-ID eingeben", { exact: true })
    .fill("UI-001");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Protokoll löschen", exact: true })
    .click();
  await closed();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.emulateMedia({ media: "print" });
  await expect(
    page.getByRole("button", { name: "Protokoll löschen", exact: true }),
  ).not.toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await click("Durchlauf löschen");
  await click("Abbrechen");
  await closed();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await click("Durchlauf löschen");
  await page
    .getByLabel("Zur Bestätigung den Listennamen eingeben", { exact: true })
    .fill("UI-Testgebiet");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Durchlauf löschen", exact: true })
    .click();
  await closed();
  await expect(
    page.locator(".list-card").filter({ hasText: "UI-Testgebiet" }),
  ).toHaveCount(1);
  console.log(
    "PASS: Bestätigter Statistikreset erhält Protokolle; Abbrechen erhält Messungen und Durchläufe; bestätigtes Löschen entfernt nur ausgewählte Daten.",
  );
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
