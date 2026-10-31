import { FlowRecorder } from "./flow-recorder.js";
import { flowChart as renderFlowChart, flowDuration } from "./flow-chart.js";
import { Esp32Client, STATUS_LABELS } from "./esp32.js";
const icons = {
  drop: '<path d="M12 3s-6.5 7.1-6.5 11.2a6.5 6.5 0 0 0 13 0C18.5 10.1 12 3 12 3Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  circlecheck: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  print:
    '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6zM18 12h.01"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z M13 6l5 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  wave: '<path d="M2 8q3-4 5 0t5 0 5 0 5 0M2 15q3-4 5 0t5 0 5 0 5 0"/>',
  thermo: '<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z M12 9v9"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
};
const icon = (name, cls = "") =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}">${icons[name] || icons.drop}</svg>`;
const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (x, d = 3) =>
  new Intl.NumberFormat("de-DE", { maximumFractionDigits: d }).format(x || 0);
const date = (x) =>
  x
    ? new Date(x).toLocaleDateString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : "Noch keine Spülung";
const initials = (name) =>
  name
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const roleName = {
  admin: "Administration",
  employee: "Mitarbeiter",
  viewer: "Betrachter",
};
let user,
  csrf,
  lists = [],
  flushes = [],
  notes = [],
  users = [],
  archivedRuns = [],
  statistics = { after_id: 0, reset_at: null },
  points = [],
  currentList,
  status,
  loadVersion = 0,
  flowRecords = [],
  flowDetail = null,
  flowSeries = [];
const app = document.querySelector("#app"),
  modal = document.querySelector("#modal");
let bleStorage = null;
try {
  bleStorage = window.localStorage;
} catch {}
const ble = new Esp32Client({ storage: bleStorage });
async function flowRequest(path, body, method = "GET") {
  try {
    return await api(path, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error instanceof TypeError || error.name === "TimeoutError")
      throw Error(
        "Server momentan nicht erreichbar. Messwerte bleiben lokal gesichert.",
      );
    throw error;
  }
}
const flowRecorder = new FlowRecorder({ request: flowRequest });
function flowChart(points) {
  return renderFlowChart(points, {
    width: window.innerWidth < 650 ? 420 : 800,
  });
}
let flowResize;
window.addEventListener("resize", () => {
  clearTimeout(flowResize);
  flowResize = setTimeout(updateFlowPanels, 200);
});
flowRecorder.addEventListener("change", () => updateFlowPanels());
ble.addEventListener("message", (event) => {
  if (
    event.message.type === "live" &&
    ble.connected &&
    user?.id === flowRecorder.ownerId
  )
    flowRecorder.capture(event.message);
});
window.addEventListener("beforeunload", (event) => {
  if (
    flowRecorder.active &&
    (flowRecorder.running ||
      flowRecorder.pending ||
      flowRecorder.active.stopping)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
let activeBleForm = null;
let completedMeasurement = null,
  bleDraft = null,
  readyAttempt = null,
  autoSaveAttempt = null,
  automaticRunning = false,
  savingMeasurement = false;
modal.addEventListener("close", () => {
  if (!modal.open) {
    activeBleForm = null;
    modal.innerHTML = "";
    refreshPointStates();
  }
});
ble.addEventListener("change", () => {
  updateBlePanels();
  syncBleForm();
  refreshPointStates();
  updateMeasurementDock();
  updateFlowPanels();
  queueMicrotask(processReadyMeasurement);
});
const isAdmin = () => user?.role === "admin";
const canDocument = () =>
  ["admin", "employee"].includes(user?.role) &&
  currentList?.status === "active" &&
  currentList?.assignees.some((a) => a.id === user.id);
const button = (label, action, ic = "plus", secondary = false) =>
  `<button class="button ${secondary ? "secondary" : ""}" data-action="${action}">${icon(ic)}${label}</button>`;
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && user) {
      ++loadVersion;
      user = null;
      csrf = null;
      renderAuth();
    }
    if (data.code === "PASSWORD_CHANGE_REQUIRED" && user) {
      ++loadVersion;
      user.must_change_password = true;
      renderPasswordRequired();
    }
    throw new Error(data.error || "Die Anfrage ist fehlgeschlagen.");
  }
  return data;
}
const send = (path, body, method = "POST") =>
  api(path, { method, body: JSON.stringify(body) });
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 4500);
}
function brand() {
  return `<div class="brand"><span class="brand-icon">${icon("drop")}</span><span>SpülPilot<small>Stadtwerke Heppenheim</small></span></div>`;
}
function renderAuth() {
  updateMeasurementDock();
  document.body.classList.remove(
    "has-measurement-dock",
    "has-two-measurements",
  );
  void flowRecorder.bindUser(null);

  ble.bindUser(null);
  app.innerHTML = `<div class="auth"><section class="auth-art">${brand()}<div class="auth-art-main">${icon("drop", "big-drop")}<h1>Unser Wassernetz.<br>Gemeinsam im Blick.</h1><p>Das interne Spülmanagement der Stadtwerke Heppenheim. Ausschließlich für berechtigte Beschäftigte und freigegebene Betrachter.</p></div><div class="auth-art-foot">Stadtwerke Heppenheim · Interner, geschützter Arbeitsbereich</div></section><section class="auth-right"><form class="auth-form" id="auth-form">${brand()}<div class="login-role">${status.setupRequired ? "Erste Schritte" : "Dein digitaler SpülPilot"}</div><h2>${status.setupRequired ? "Willkommen an Bord." : "Schön, dass du da bist."}</h2><p>${status.setupRequired ? "Richte dein Administrationskonto ein, um Spüllisten und dein Team zu verwalten." : "Melde dich an und bring dein Wassernetz in Bewegung."}</p><div class="form-error" id="auth-error" role="alert"></div>${status.setupRequired ? '<div class="field"><label for="setup-token">Einrichtungsschlüssel</label><input id="setup-token" name="setup_token" type="password" required autocomplete="off"><small>Auf dem Server in data/setup-token hinterlegt.</small></div><div class="field"><label for="name">Dein Name</label><input id="name" name="name" required maxlength="100" autocomplete="name" placeholder="Vor- und Nachname"></div>' : ""}<div class="field"><label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" required autocomplete="username" maxlength="200" placeholder="name@unternehmen.de"></div><div class="field"><label for="password">Passwort</label><input id="password" name="password" type="password" required ${status.setupRequired ? 'minlength="12"' : ""} maxlength="128" autocomplete="${status.setupRequired ? "new-password" : "current-password"}" placeholder="${status.setupRequired ? "Mindestens 12 Zeichen" : "Dein Passwort"}"></div><button class="button" type="submit">${status.setupRequired ? "Administrationskonto erstellen" : "Anmelden"}${icon("arrow")}</button><div class="auth-security">${icon("lock")}Nur für berechtigte Personen · Keine öffentliche Registrierung</div></form></section></div>`;
  document.querySelector("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const submit = e.target.querySelector("[type=submit]");
    submit.disabled = true;
    const data = Object.fromEntries(new FormData(e.target));
    try {
      if (status.setupRequired) {
        await send("/setup", data);
        status.setupRequired = false;
      }
      const result = await send("/login", {
        email: data.email,
        password: data.password,
      });
      user = result.user;
      csrf = result.csrf;
      location.hash = "#/overview";
      await render();
    } catch (err) {
      document.querySelector("#auth-error").textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };
}
const navItems = () => [
  ["overview", "Übersicht", "grid"],
  ["lists", "Spüllisten", "folder"],
  ["reports", "Spülprotokolle", "file"],
  ...(user.role !== "viewer"
    ? [
        ["flow", "Durchflussmessung", "wave"],
        ["notes", "Interne Hinweise", "info"],
      ]
    : []),
  ...(isAdmin() ? [["users", "Team & Zugänge", "users"]] : []),
  ...(user.role !== "viewer"
    ? [["devices", "Geräte & Sensoren", "bluetooth"]]
    : []),
  ["account", "Mein Passwort", "lock"],
];
function layout(content, section) {
  const nav = navItems();
  app.innerHTML = `<div class="shell"><div class="menu-backdrop" data-action="menu"></div><aside class="sidebar">${brand()}<div class="nav-label">Arbeitsbereich</div><nav class="nav" aria-label="Hauptnavigation">${nav.map(([id, label, ic]) => `<a href="#/${id}" class="${section === id ? "active" : ""}" ${section === id ? 'aria-current="page"' : ""}>${icon(ic)}${label}${id === "lists" ? `<span class="count">${lists.length}</span>` : id === "notes" && notes.length ? `<span class="count issue-count">${new Set(notes.map((n) => n.point_id)).size}</span>` : ""}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="water-note">${icon("wave")}<h4>Jeder Tropfen zählt.</h4><p>Spülmanagement für das Trinkwassernetz der Stadtwerke Heppenheim.</p></div><div class="user"><div class="avatar">${esc(initials(user.name))}</div><div><strong>${esc(user.name)}</strong><small>${roleName[user.role]}</small></div><button class="logout" data-action="logout" title="Abmelden" aria-label="Abmelden">${icon("logout")}</button></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumbs"><button class="mobile-menu" data-action="menu" aria-label="Menü öffnen">${icon("menu")}</button>Arbeitsbereich ${icon("chevron")} <strong>${nav.find((x) => x[0] === section)?.[1] || "Spüllisten"}</strong></div><div class="top-right"><span class="system"><i class="dot"></i>Interner Arbeitsbereich</span><span class="top-date">${new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span><div class="avatar">${esc(initials(user.name))}</div></div></header><div class="content">${user.role !== "viewer" && notes.length && section !== "notes" ? `<div class="internal-alert no-print">${icon("info")}<a href="#/notes">${new Set(notes.map((n) => n.point_id)).size} Spülpunkt(e) mit offenen internen Bemerkungen ansehen</a></div>` : ""}${content}<footer class="footer"><span>© ${new Date().getFullYear()} SpülPilot · Stadtwerke Heppenheim</span><span>${icon("shield")}Zugriff geschützt · ${roleName[user.role]}</span></footer></div></main></div>`;
  bindActions();
  updateBlePanels();
  updateMeasurementDock();
}
function heading(
  title,
  subtitle,
  actions = "",
  eyebrow = "DEIN WASSERNETZ IM BLICK",
) {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
}
function empty(title, description, action = "") {
  return `<div class="empty">${icon("drop")}<h3>${title}</h3><p>${description}</p>${action}</div>`;
}
function stat(label, value, unit, foot, ic) {
  return `<div class="stat"><div class="stat-head">${label}<span class="stat-icon">${icon(ic)}</span></div><div class="stat-number">${value}<small>${unit}</small></div><div class="stat-foot">${foot}</div></div>`;
}
const statusName = {
  deleted: "Durchlauf gelöscht",
  active: "In Bearbeitung",
  review: "Zur Prüfung",
  published: "Für Betrachter freigegeben",
};
const statusBadge = (l) =>
  `<span class="badge ${l.status === "review" ? "amber" : l.status === "published" ? "green" : "blue"}">${statusName[l.status]}</span>`;
function listCard(l) {
  const completed = l.completed_count,
    total = l.point_count;
  return `<a class="list-card" href="#/lists/${l.id}${user.role === "viewer" ? "?run=" + l.run_id : ""}"><div class="list-card-top"><div class="folder">${icon("folder")}</div>${statusBadge(l)}</div><h3>${esc(l.name)}</h3>${l.published_at ? `<p class="archive-date">Zur Betrachtung freigegeben am <strong>${date(l.published_at)}</strong></p>` : ""}<p class="description">${esc(l.description || "Deine Spülpunkte an einem Ort")}</p><div class="progress-label"><span>Durchgang ${l.run_number} · Bearbeitet</span><strong>${completed} / ${total}</strong></div><div class="segments">${Array.from({ length: Math.min(total || 1, 25) }, (_, i) => `<i class="${i < Math.round((completed / (total || 1)) * Math.min(total || 1, 25)) ? "done" : ""}"></i>`).join("")}</div><div class="card-bottom"><span class="person-chip">${l.assignees.length ? `<span class="avatar">${esc(initials(l.assignees[0].name))}</span>${esc(l.assignees[0].name)}${l.assignees.length > 1 ? ` +${l.assignees.length - 1}` : ""}` : `${icon("users")}${l.status === "active" ? "Noch nicht freigegeben" : "Keine Bearbeitungsfreigaben"}`}</span>${icon("arrow")}</div></a>`;
}
function overview() {
  const total = lists.reduce((s, l) => s + l.point_count, 0),
    done = lists.reduce((s, l) => s + l.completed_count, 0),
    measured = flushes.filter((f) => f.id > statistics.after_id),
    volume = measured.reduce((s, f) => s + f.volume, 0);
  return (
    heading(
      "Übersicht",
      "Alles im Fluss. Hier findest du deine Spüllisten und die letzten Aktivitäten.",
      isAdmin()
        ? button("Neue Spülliste", "new-list")
        : button("Zu meinen Spüllisten", "go-lists", "folder"),
    ) +
    `${isAdmin() && lists.some((l) => l.status === "review") ? `<div class="notice review-notice">${icon("circlecheck")}<span><strong>${lists.filter((l) => l.status === "review").length} abgeschlossene Spülliste(n) warten auf deine Prüfung.</strong><br>Öffne die Liste, prüfe die Protokolle und speichere den Durchgang für Betrachter.</span></div>` : ""}<section class="hero"><div class="hero-copy"><div class="hero-kicker">${icon("wave")}Für ein sauberes Trinkwassernetz</div><h2>Klare Planung. Sauberes Wasser.</h2><p>Behalte deine Spülpunkte im Blick und dokumentiere jede Spülung. Einfach, strukturiert und zuverlässig.</p></div><div class="hero-symbol">${icon("drop")}</div></section><div class="stats">${stat("Spülpunkte gesamt", total, "", `In ${lists.length} Spüllisten organisiert`, "pin")}${stat("Dokumentierte Spülungen", measured.length, "", statistics.reset_at ? `Seit Statistikreset am ${date(statistics.reset_at)}` : "Seit Beginn der Statistik", "circlecheck")}${stat("Ohne Spülprotokoll", total - done, "", "Im aktuellen Durchgang noch offen", "clock")}${stat("Gespülte Menge", number(volume), "m³", `Aus ${measured.length} dokumentierten Spülungen`, "drop")}</div><div class="section-head"><div><h2>${user.role === "employee" ? "Meine Spüllisten" : "Deine Spüllisten"}</h2><p>Eine Liste. Alle Spülpunkte. Alles im Blick.</p></div><a href="#/lists" class="text-link">Alle Listen ansehen ${icon("arrow")}</a></div><div class="list-grid">${lists.slice(0, 3).map(listCard).join("") || empty("Dein Wassernetz beginnt hier", isAdmin() ? "Lege deine erste Spülliste an und füge Spülpunkte hinzu." : "Hier erscheinen die für dich verfügbaren Spüllisten.", isAdmin() ? button("Erste Spülliste anlegen", "new-list") : "")}</div><section class="panel"><div class="panel-head"><div><h2>Letzte Spülungen</h2><p>Die neuesten Einträge aus deinem Wassernetz</p></div><a href="#/reports" class="text-link">Alle Protokolle ${icon("arrow")}</a></div>${reportTable(flushes.slice(0, 5), true)}</section>`
  );
}
function reportTable(rows, compact = false) {
  if (!rows.length)
    return empty(
      "Noch keine Spülungen",
      "Sobald eine Spülung dokumentiert wird, findest du hier das Protokoll.",
    );
  return `<div class="table-wrap"><table><thead><tr><th>Spülpunkt ID</th><th>Adresse</th>${compact ? "" : "<th>Soll m³</th>"}<th>Ist m³</th>${compact ? "" : "<th>Temp. vorher</th><th>Temp. nachher</th>"}<th>Trübung</th><th>Mitarbeiter</th><th>Datum</th>${isAdmin() && !compact ? '<th class="no-print">Aktionen</th>' : ""}</tr></thead><tbody>${rows.map((f) => `<tr><td><span class="point-id">${esc(f.code)}</span><span class="sub">Durchgang ${f.run_number}</span></td><td><strong>${esc(f.address)}</strong>${compact ? `<span class="sub">${esc(f.list_name)}</span>` : ""}</td>${compact ? "" : `<td>${number(f.target)}</td>`}<td><strong>${number(f.volume)}${compact ? " m³" : ""}</strong></td>${compact ? "" : `<td>${number(f.temperature_before)} °C</td><td>${number(f.temperature_after)} °C</td>`}<td><span class="badge ${f.turbidity ? "amber" : "green"}">${f.turbidity ? "Ja" : "Nein"}</span></td><td>${esc(f.employee)}</td><td>${date(f.flushed_at)}</td>${isAdmin() && !compact ? `<td class="no-print"><button class="table-action delete-link" data-action="delete-record" data-id="${f.id}">Protokoll löschen ${icon("close")}</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function listsPage() {
  return (
    heading(
      "Spüllisten",
      "Organisiere Spülpunkte in Listen und plane die Arbeit im Team.",
      isAdmin() ? button("Neue Spülliste", "new-list") : "",
    ) +
    `<div class="toolbar"><div class="search">${icon("search")}<input id="list-search" type="search" placeholder="Spüllisten suchen …" aria-label="Spüllisten suchen"></div><span class="muted list-count">${lists.length} Spüllisten</span></div><div class="list-grid" id="list-results">${lists.map(listCard).join("") || empty("Noch keine Spüllisten", isAdmin() ? "Lege eine Liste an und organisiere deine Spülpunkte." : "Aktuell sind keine Listen für dich verfügbar.", isAdmin() ? button("Spülliste anlegen", "new-list") : "")}</div>`
  );
}
function listDetail() {
  const l = currentList;
  if (!l)
    return empty(
      "Liste nicht gefunden",
      "Diese Liste existiert nicht oder ist nicht für dich freigegeben.",
    );
  if (l.deleted_run)
    return (
      `<a class="back" href="#/lists">${icon("back")}Zurück zu den Spüllisten</a>` +
      heading(
        esc(l.name),
        "Der letzte Durchlauf wurde gelöscht. Die Listenvorlage und Spülpunkte bleiben für den nächsten Durchlauf erhalten.",
        button("Neuen Durchgang freigeben", "restart", "plus") +
          button("Löschen", "delete-list", "close", true),
      ) +
      `<div class="notice">${icon("info")}<span>Wähle die berechtigten Personen neu aus, um diese Liste wieder zu bearbeiten.</span></div>`
    );
  if (user.role === "viewer")
    return (
      `<a class="back" href="#/lists">${icon("back")}Zurück zu den Spüllisten</a>` +
      heading(
        esc(l.name),
        `Zur Betrachtung freigegeben am ${date(l.published_at)} · Durchgang ${l.run_number}`,
        button("Protokolle", "list-reports", "file", true) +
          button("Liste drucken", "print", "print", true),
        "GESPEICHERTE SPÜLLISTE",
      ) +
      `<div class="print-heading"><h1>${esc(l.name)} · Durchgang ${l.run_number}</h1><p>Zur Betrachtung freigegeben am ${date(l.published_at)}</p></div><section class="panel">${reportTable(flushes.filter((f) => f.run_id === l.run_id))}</section>`
    );
  return (
    `<a class="back" href="#/lists">${icon("back")}Zurück zu den Spüllisten</a>` +
    heading(
      esc(l.name),
      esc(l.description || "Spülpunkte und Dokumentation dieser Liste"),
      isAdmin()
        ? l.status === "active"
          ? button("Freigabe", "assign", "users", true) +
            button("Spülpunkt anlegen", "new-point")
          : l.status === "review"
            ? button("Speichern & für Betrachter freigeben", "publish", "check")
            : button("Neuen Durchgang freigeben", "restart", "plus")
        : button("Protokolle", "list-reports", "file", true),
      "DEINE SPÜLLISTE",
    ) +
    `<div class="lifecycle-strip">${statusBadge(l)}<span>Durchgang ${l.run_number}</span><span>${l.published_count} gespeicherte Durchgänge</span></div><div class="detail-strip"><div><small>Spülpunkte</small><strong>${l.point_count} angelegt</strong></div><div><small>Dokumentiert</small><strong>${l.completed_count} von ${l.point_count} Punkten</strong></div><div><small>Freigegeben für</small><strong>${esc(l.assignees.map((a) => a.name).join(", ") || "Noch keine Personen")}</strong></div><div><small>Letzte Spülung</small><strong>${date(l.last_flush)}</strong></div></div><div class="section-head"><div><h2>Spülpunkte</h2><p>Wähle einen Punkt für Details${canDocument() ? " und die nächste Spülung" : ""}.</p></div>${isAdmin() ? `<div class="actions">${l.status === "active" ? `<button class="text-link" data-action="edit-list">${icon("edit")}Liste bearbeiten</button>` : ""}<button class="text-link" data-action="list-reports">${icon("file")}Protokolle</button>${l.status !== "active" ? '<button class="text-link delete-link" data-action="delete-run">Durchlauf löschen</button>' : ""}<button class="text-link delete-link" data-action="delete-list">${icon("close")}Löschen</button></div>` : ""}</div><div class="toolbar"><div class="search">${icon("search")}<input id="point-search" type="search" placeholder="ID oder Adresse suchen …" aria-label="Spülpunkte suchen"></div></div><section class="panel" id="points-results">${pointTable(points)}</section><div class="notice">${icon("info")}<span>${l.status === "active" ? "Jeder Punkt wird einmal pro Durchgang bearbeitet. Nach dem letzten offenen Punkt geht die Liste automatisch zur Prüfung an die Administration und verschwindet bei den Mitarbeitern." : l.status === "review" ? "Dieser Durchgang ist abgeschlossen. Die Administration prüft und speichert ihn und gibt ihn anschließend für Betrachter frei." : "Dieser Durchgang ist gespeichert und für Betrachter freigegeben. Ein neuer Durchgang beginnt wieder mit offenen Punkten; gespeicherte Ergebnisse bleiben erhalten."}</span></div>`
  );
}
function pointState(p) {
  if (notes.some((n) => n.point_id === p.id)) return "point-issue";
  if (p.completed) return "point-complete";
  const editing =
    modal.open &&
    activeBleForm?.point.id === p.id &&
    activeBleForm.runId === currentList?.run_id;
  const measuring =
    ble.job &&
    !ble.job.savedId &&
    ble.job.pointId === p.id &&
    ble.job.runId === currentList?.run_id;
  return editing || measuring ? "point-working" : "";
}
function refreshPointStates() {
  document.querySelectorAll('tr[data-action="select-point"]').forEach((row) => {
    const p = points.find((p) => p.id === Number(row.dataset.id));
    if (!p) return;
    const state = pointState(p);
    for (const name of ["point-issue", "point-complete", "point-working"])
      row.classList.toggle(name, state === name);
    const badge = row.querySelector("td:nth-child(5) .badge");
    if (badge) {
      badge.textContent =
        state === "point-working"
          ? "In Bearbeitung"
          : p.completed
            ? "Bearbeitet"
            : "Noch offen";
      badge.classList.toggle("amber", state === "point-working");
    }
  });
}
function pointTable(rows) {
  if (!rows.length)
    return empty(
      "Keine Spülpunkte gefunden",
      isAdmin()
        ? "Füge dieser Liste einen Spülpunkt hinzu."
        : "Für diese Auswahl sind keine Spülpunkte vorhanden.",
      isAdmin() && currentList.status === "active"
        ? button("Spülpunkt anlegen", "new-point")
        : "",
    );
  return `<div class="table-wrap"><table><thead><tr><th>Spülpunkt ID</th><th>Adresse</th><th>Sollmenge</th><th>Letzte Spülung</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr class="point-selectable ${pointState(p)}" data-action="select-point" data-id="${p.id}" tabindex="0" aria-label="Spülpunkt ${esc(p.code)} auswählen"><td><span class="point-id">${esc(p.code)}</span></td><td><strong>${esc(p.address)}</strong></td><td>${number(p.target)} m³</td><td>${p.last_flush ? date(p.last_flush) : "—"}</td><td><span class="badge ${p.completed ? "green" : pointState(p) === "point-working" ? "amber" : ""}">${p.completed ? "Bearbeitet" : pointState(p) === "point-working" ? "In Bearbeitung" : "Noch offen"}</span></td><td><div class="actions">${canDocument() && !p.completed ? `<button class="table-action" data-action="flush" data-id="${p.id}">Spülung erfassen ${icon("arrow")}</button>` : ""}${isAdmin() || user.role === "viewer" ? `<button class="table-action" data-action="point-detail" data-id="${p.id}">${isAdmin() && currentList.status === "active" && !p.completed ? "Bearbeiten" : "Details"}${icon(isAdmin() ? "edit" : "chevron")}</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>`;
}
function reportRuns() {
  return archivedRuns.map((r) => ({
    ...r,
    rows: flushes.filter((f) => f.run_id === r.id),
  }));
}
function reportCards(runs) {
  return (
    runs
      .map(
        (r) =>
          `<a class="list-card" href="#/reports?list=${r.listId}&run=${r.id}"><div class="list-card-top"><div class="folder">${icon("folder")}</div>${statusBadge({ status: r.status })}</div><h3>${esc(r.name)}</h3><p>${r.publishedAt ? `Zur Betrachtung freigegeben am <strong>${date(r.publishedAt)}</strong>` : "Noch nicht zur Betrachtung freigegeben"}</p><div class="card-bottom"><span>Durchgang ${r.number} · ${r.rows.length} Messungen</span>${icon("arrow")}</div></a>`,
      )
      .join("") ||
    empty(
      "Keine Spülprotokolle",
      "Hier erscheinen die für dich verfügbaren Spüllisten mit ihren Messungen.",
    )
  );
}
function reportsPage() {
  const params = new URLSearchParams(location.hash.split("?")[1] || ""),
    selectedRun = params.get("run"),
    selectedList = params.get("list"),
    runs = reportRuns(),
    run = runs.find(
      (r) =>
        String(r.id) === selectedRun &&
        (!selectedList || String(r.listId) === selectedList),
    );
  if (!selectedRun)
    return (
      heading(
        "Spülprotokolle",
        "Wähle eine Spülliste aus. Jeder Durchlauf enthält seine eigenen Messwerte und seinen eigenen Ausdruck.",
        "",
        "DOKUMENTATION & NACHWEISE",
      ) +
      `<div class="print-heading"><h1>Spülprotokolle</h1><p>Bitte zuerst eine Spülliste zum Drucken auswählen.</p></div><div class="toolbar"><div class="search">${icon("search")}<input id="report-search" type="search" placeholder="Spülliste suchen …" aria-label="Spülprotokolle suchen"></div></div><div class="list-grid no-print" id="report-cards">${reportCards(runs.filter((r) => !selectedList || String(r.listId) === selectedList))}</div>`
    );
  if (!run)
    return (
      `<a class="back" href="#/reports">${icon("back")}Zurück zu den Spülprotokollen</a>` +
      empty(
        "Spülprotokoll nicht gefunden",
        "Dieser Durchlauf ist nicht für dich verfügbar.",
      )
    );
  const subtitle = `${run.publishedAt ? "Zur Betrachtung freigegeben am " + date(run.publishedAt) : statusName[run.status]} · Durchgang ${run.number}`;
  return (
    `<a class="back" href="#/reports">${icon("back")}Zurück zu den Spülprotokollen</a>` +
    heading(
      "Spülprotokolle",
      esc(`${run.name} · ${subtitle}`),
      button("Liste drucken", "print", "print", true) +
        (isAdmin() && run.status !== "active"
          ? button("Durchlauf löschen", "delete-run", "close", true)
          : ""),
      "DOKUMENTATION & NACHWEISE",
    ) +
    `<div class="print-heading"><h1>${esc(run.name)} · Durchgang ${run.number}</h1><p>${esc(subtitle)} · ${run.rows.length} Messungen</p></div><section class="panel" id="report-results">${reportTable(run.rows)}</section>`
  );
}
function notesPage() {
  const groups = new Map();
  for (const note of notes) {
    if (!groups.has(note.point_id)) groups.set(note.point_id, []);
    groups.get(note.point_id).push(note);
  }
  return (
    heading(
      "Interne Hinweise",
      "Offene Bemerkungen zu Spülpunkten. Quittierte Hinweise verschwinden aus dieser Übersicht.",
      "",
      "NUR FÜR DEN INTERNEN DIENST",
    ) +
    `<div class="issue-grid">${
      [...groups.values()]
        .map((group) => {
          const first = group[0];
          return `<article class="issue-card"><header><span class="point-id">${esc(first.code)}</span><span class="badge issue-badge">Offener Hinweis</span></header><h2>${esc(first.address)}</h2><p class="subtitle">${esc(first.list_name)}</p>${group.map((note) => `<div class="issue-note"><p>${esc(note.content)}</p><small>${esc(note.employee)} · ${date(note.flushed_at)} · Durchgang ${note.run_number}</small></div>`).join("")}<button class="button secondary" data-action="ack-notes" data-ids="${group.map((n) => n.id).join(",")}">${icon("check")}Quittieren</button></article>`;
        })
        .join("") ||
      empty(
        "Keine offenen Hinweise",
        "Alle internen Bemerkungen sind quittiert oder es wurden noch keine gemeldet.",
      )
    }</div>`
  );
}
function usersPage() {
  return (
    heading(
      "Team & Zugänge",
      "Verwalte dein Team und lege fest, wer was sehen und bearbeiten darf.",
      button("Einstellungen", "settings", "edit", true) +
        button("Benutzer anlegen", "new-user", "plus"),
      "GEMEINSAM IM EINSATZ",
    ) +
    `<div class="notice">${icon("shield")}<span><strong>Administration</strong> verwaltet Listen, Spülpunkte und Benutzer. <strong>Administration und Mitarbeiter</strong> dokumentieren Spülungen in ihren freigegebenen Listen. <strong>Betrachter</strong> lesen und drucken Protokolle.</span></div><section class="panel"><div class="panel-head"><div><h2>Dein Team</h2><p>${users.length} Benutzerkonten</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>E-Mail-Adresse</th><th>Rolle</th><th>Status</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong>${u.id === user.id ? '<span class="sub">Dein Konto</span>' : ""}</td><td>${esc(u.email)}</td><td><span class="badge ${u.role === "admin" ? "blue" : ""}">${roleName[u.role]}</span></td><td><span class="badge ${u.active ? "green" : ""}">${u.active ? "Aktiv" : "Deaktiviert"}</span>${u.must_change_password ? '<span class="sub">Passwortwechsel erforderlich</span>' : ""}</td><td><div class="actions"><button class="table-action" data-action="edit-user" data-id="${u.id}">Bearbeiten ${icon("edit")}</button>${u.active && u.id !== user.id ? `<button class="table-action" data-action="reset-password" data-id="${u.id}">Einmalpasswort erstellen ${icon("lock")}</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div></section>`
  );
}
function currentMeasurementCards() {
  if (!user || user.must_change_password || user.role === "viewer") return [];
  const cards = [];
  const job = ble.userId === user.id ? ble.job : null;
  if (job) {
    const live =
      ble.connected &&
      ble.live?.code === job.code &&
      ble.live.target === job.target
        ? ble.live
        : null;
    const state =
      ble.connected && ble.deviceStatus?.code === job.code
        ? ble.deviceStatus
        : null;
    cards.push({
      key: "ble",
      href:
        job.savedId || !lists.some((l) => l.run_id === job.runId)
          ? "#/devices"
          : `#/lists/${lists.find((l) => l.run_id === job.runId).id}?point=${job.pointId}`,
      title: `Spülmessung · ${job.code}`,
      icon: "drop",
      status: job.savedId
        ? "Gespeichert · Bestätigung offen"
        : !ble.connected
          ? "Bluetooth getrennt · Auftrag bleibt offen"
          : job.cancelPending
            ? "Abbruchbestätigung offen"
            : state
              ? STATUS_LABELS[state.state]
              : "Messauftrag offen",
      metric: live
        ? `${number(live.volume)} / ${number(job.target)} m³ · ${number(live.percent, 1)} %`
        : `Soll ${number(job.target)} m³`,
      percent: live?.percent ?? null,
      active: !!live && !job.savedId && live.state !== "ERROR",
    });
  }
  const flow = flowRecorder.ownerId === user.id ? flowRecorder.active : null;
  if (flow) {
    const live =
      flowRecorder.running && ble.connected && ble.live?.state !== "ERROR"
        ? ble.live
        : null;
    const record =
      flowDetail?.id === flow.id
        ? flowDetail
        : flowRecords.find((m) => m.id === flow.id);
    cards.push({
      key: "flow",
      href: `#/flow/${flow.id}`,
      title: record?.address
        ? `Durchfluss · ${record.address}`
        : `Durchflussmessung #${flow.id}`,
      icon: "wave",
      status: flow.stopping
        ? "Abschluss noch nicht bestätigt"
        : !flowRecorder.running
          ? "Aufzeichnung pausiert · Fortsetzen"
          : live
            ? "Durchflussaufzeichnung läuft"
            : "Wartet auf Live-Daten · Messung bleibt offen",
      metric: `${live ? number(live.flow) + " m³/h · " : ""}${flowRecorder.pending ? flowRecorder.pending + " Werte ausstehend" : flow.nextSeq + " Messwerte"}`,
      percent: null,
      active: !!live,
    });
  }
  return cards;
}
function updateMeasurementDock() {
  const cards = currentMeasurementCards(),
    dock = document.getElementById("measurement-dock");
  document.body.classList.toggle("has-measurement-dock", !!cards.length);
  document.body.classList.toggle("has-two-measurements", cards.length > 1);
  if (!dock) return;
  dock.hidden = !cards.length;
  const key = cards.map((c) => c.key).join(":");
  if (dock.dataset.keys !== key) {
    dock.dataset.keys = key;
    dock.innerHTML = cards
      .map(
        (c) =>
          `<a class="measurement-tile" data-measurement="${c.key}" href="${esc(c.href)}"><span class="measurement-icon">${icon(c.icon)}</span><span class="measurement-info"><strong data-measurement-title></strong><span data-measurement-status></span><small data-measurement-metric></small><progress class="measurement-progress" max="100" aria-label="Fortschritt der Spülmessung" hidden></progress></span><span class="measurement-open">${icon("arrow")}</span></a>`,
      )
      .join("");
  }
  for (const card of cards) {
    const tile = dock.querySelector(`[data-measurement="${card.key}"]`);
    tile.href = card.href;
    tile.classList.toggle("is-live", card.active);
    tile.querySelector("[data-measurement-title]").textContent = card.title;
    tile.querySelector("[data-measurement-status]").textContent = card.status;
    tile.querySelector("[data-measurement-metric]").textContent = card.metric;
    const progress = tile.querySelector("progress");
    progress.hidden = card.percent === null;
    if (card.percent !== null) progress.value = card.percent;
    tile.setAttribute(
      "aria-label",
      `${card.title}. ${card.status}. Aktuelle Messung öffnen`,
    );
  }
}
document.addEventListener("click", async (event) => {
  const link = event.target.closest('[data-measurement="ble"]');
  if (!link) return;
  event.preventDefault();
  const job = ble.job;
  if (!job) return;
  const list = lists.find((l) => l.run_id === job.runId);
  const route =
    job.savedId || !list
      ? "#/devices"
      : `#/lists/${list.id}?point=${job.pointId}`;
  if (location.hash === route) await render();
  else location.hash = route;
});
function flowBluetoothPanel() {
  return `<div class="ble-head"><div class="ble-title">${icon("bluetooth")}<strong>SpuelPilot-ESP32</strong><span class="badge ${ble.connected ? "green" : ""}">${ble.connected ? "Verbunden" : "Nicht verbunden"}</span></div><button type="button" class="button secondary" data-ble-action="${ble.connected ? "disconnect" : "connect"}" ${ble.busy ? "disabled" : ""}>${ble.connected ? "Trennen" : "Bluetooth verbinden"}</button></div><div class="flow-current"><small>Aktueller Durchfluss</small><strong>${ble.connected && ble.live ? number(ble.live.flow) : "—"} <span>m³/h</span></strong></div><p class="ble-hint">Nur der Durchfluss wird aufgezeichnet. Keine Temperatur und kein Spülauftrag erforderlich.</p>${ble.error ? `<p class="ble-error">${esc(ble.error)}</p>` : ""}`;
}
function flowPage() {
  const m = flowDetail;
  if (!m)
    return (
      heading(
        "Durchflussmessungen",
        "Zeichne den Durchfluss bis zum manuellen Beenden auf. Diagramm, Adresse und Bemerkung bleiben gespeichert.",
        button("Neue Durchflussmessung", "new-flow", "plus"),
      ) +
      `<div class="ble-widget" data-ble-panel="flow"></div>${flowRecorder.active ? `<section class="panel flow-recording" data-flow-recording="${flowRecorder.active.id}"></section>` : ""}<div class="list-grid">${flowRecords.map((m) => `<a class="list-card" href="#/flow/${m.id}"><div class="list-card-top"><div class="folder">${icon("wave")}</div><span class="badge ${m.status === "active" ? "amber" : "green"}">${m.status === "active" ? "Noch offen" : "Abgeschlossen"}</span></div><h3>${esc(m.address)}</h3><p>${date(m.started_at)} · ${esc(m.employee)}</p><div class="card-bottom"><span>${m.sample_count} Messwerte</span>${icon("arrow")}</div></a>`).join("") || empty("Noch keine Durchflussmessungen", "Verbinde den ESP32 und starte deine erste Aufzeichnung.")}</div>`
    );
  const own = m.user_id === user.id;
  return (
    `<a class="back" href="#/flow">${icon("back")}Alle Durchflussmessungen</a>` +
    heading(
      esc(m.address),
      `${date(m.started_at)} · ${esc(m.employee)} · ${m.status === "active" ? "Noch offen" : "Abgeschlossen"}`,
      button("Adresse / Bemerkung bearbeiten", "edit-flow", "edit", true) +
        (m.status === "completed"
          ? button("Messung löschen", "delete-flow", "close", true)
          : ""),
      "DURCHFLUSSMESSUNG",
    ) +
    `${m.status === "active" && own ? '<div class="ble-widget" data-ble-panel="flow"></div>' : ""}${own && (m.status === "active" || flowRecorder.active?.id === m.id) ? `<section class="panel flow-recording" data-flow-recording="${m.id}"></section>` : ""}<section class="panel flow-chart-panel"><div class="panel-head"><div><h2>Durchflussverlauf</h2><p>m³/h über die Messdauer · Unterbrechungen werden nicht als Nullwerte gewertet.</p></div><span class="badge ${m.status === "active" ? "amber" : "green"}">${m.status === "active" ? "Offene Messung" : "Gespeichert"}</span></div><div data-flow-chart="${m.id}">${flowChart(flowSeries)}</div><div class="flow-summary" data-flow-summary="${m.id}"></div></section><section class="panel flow-note"><h2>Bemerkung</h2><p class="flow-note-text">${esc(m.remark || "Keine Bemerkung eingetragen.")}</p></section>`
  );
}
function updateFlowPanels() {
  updateMeasurementDock();
  if (!user || user.role === "viewer") return;
  document.querySelectorAll("[data-flow-recording]").forEach((panel) => {
    const id = Number(panel.dataset.flowRecording),
      local = flowRecorder.active?.id === id,
      running = local && flowRecorder.running,
      pending = local ? flowRecorder.pending : 0;
    panel.innerHTML = `<div class="flow-recording-head"><div><h2>${running ? (ble.connected && ble.live ? "Aufzeichnung läuft" : "Wartet auf Live-Daten") : local && flowRecorder.active.stopping ? "Abschluss noch nicht bestätigt" : "Aufzeichnung fortsetzen"}</h2><p>${pending ? `${pending} Messwert(e) lokal gesichert, Übertragung steht aus.` : "Messwerte werden fortlaufend gesichert."}</p></div><div class="actions">${!running && !flowRecorder.active?.stopping ? `<button class="button" data-flow-action="resume" data-id="${id}" ${!ble.connected ? "disabled" : ""}>Fortsetzen</button>` : ""}<button class="button secondary" data-flow-action="finish" data-id="${id}">${local && flowRecorder.active.stopping ? "Speicherung erneut versuchen" : "Messung beenden"}</button></div></div>${flowRecorder.error ? `<p class="ble-error" role="alert">${esc(flowRecorder.error)}</p>` : ""}<p class="ble-hint">Seite und Bluetooth-Verbindung für die Aufzeichnung geöffnet halten. Bei einer Unterbrechung bleiben gespeicherte Daten erhalten; fehlende Werte erscheinen als Lücke. Beenden stoppt nur die Aufzeichnung, kein Ventil.</p>`;
  });
  document.querySelectorAll("[data-flow-chart]").forEach((panel) => {
    const id = Number(panel.dataset.flowChart),
      local = flowRecorder.active?.id === id,
      points =
        local && flowRecorder.points.length ? flowRecorder.points : flowSeries;
    panel.innerHTML = flowChart(points);
    panel.querySelector("svg")?.addEventListener("pointermove", (event) => {
      const rect = event.currentTarget.getBoundingClientRect(),
        ratio = Math.max(
          0,
          Math.min(
            1,
            (((event.clientX - rect.left) / rect.width) *
              event.currentTarget.viewBox.baseVal.width -
              60) /
              (event.currentTarget.viewBox.baseVal.width - 82),
          ),
        );
      const time = ratio * Math.max(1000, ...points.map((p) => p.elapsed_ms));
      const nearest = points.reduce(
        (best, p) =>
          Math.abs(p.elapsed_ms - time) < Math.abs(best.elapsed_ms - time)
            ? p
            : best,
        points[0],
      );
      if (nearest)
        panel.querySelector("[data-flow-hover]").textContent =
          `${flowDuration(nearest.elapsed_ms)} · ${number(nearest.flow)} m³/h`;
    });
    const summary = document.querySelector(`[data-flow-summary="${id}"]`);
    if (summary) {
      const m = flowDetail,
        count = local
          ? Math.max(m?.sample_count || 0, flowRecorder.active.nextSeq)
          : m?.sample_count || 0;
      summary.innerHTML = `<span>Messwerte<strong>${number(count, 0)}</strong></span><span>Dauer<strong>${flowDuration(local ? flowRecorder.active.lastElapsed : m?.elapsed_ms || 0)}</strong></span><span>Maximum<strong>${number(Math.max(m?.max_flow || 0, ...points.map((p) => p.flow)))} m³/h</strong></span>`;
    }
  });
}
function newFlowModal() {
  if (!ble.connected)
    throw Error("Bitte zuerst den ESP32 über Bluetooth verbinden.");
  if (flowRecorder.active)
    throw Error(
      "Bitte die offene Durchflussmessung zuerst fortsetzen oder beenden.",
    );
  const request_id = crypto.randomUUID();
  showModal(
    "Durchflussmessung starten",
    "Ohne Temperatur und ohne Sollmenge",
    field("Adresse", "address", "", "text", 'required maxlength="300"') +
      `<div class="field"><label for="f-remark">Bemerkung (optional)</label><textarea id="f-remark" name="remark" rows="3" maxlength="2000"></textarea></div><div class="notice">${icon("info")}Die Aufzeichnung läuft bis „Messung beenden“. LIVE-Daten werden fortlaufend gesichert. Betrachter haben keinen Zugriff.</div>`,
    async (data) => {
      await flowRecorder.start({ ...data, request_id });
      location.hash = "#/flow/" + flowRecorder.active.id;
      toast("Durchflussaufzeichnung gestartet.");
    },
    "Aufzeichnung starten",
  );
}
function editFlowModal() {
  const m = flowDetail;
  if (!m) return;
  showModal(
    "Durchflussmessung bearbeiten",
    esc(m.address),
    field("Adresse", "address", m.address, "text", 'required maxlength="300"') +
      `<div class="field"><label for="f-remark">Bemerkung (optional)</label><textarea id="f-remark" name="remark" rows="3" maxlength="2000">${esc(m.remark)}</textarea></div>`,
    (data) =>
      api("/flow-measurements/" + m.id, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  );
}
function deleteFlowModal() {
  const m = flowDetail;
  if (!m) return;
  showModal(
    "Durchflussmessung löschen",
    esc(m.address),
    `<div class="notice">Diese Messung mit ihrem Diagramm wird aus der Anwendung entfernt. Andere Messungen bleiben erhalten.</div>` +
      field(
        "Zur Bestätigung die Adresse eingeben",
        "confirm_address",
        "",
        "text",
        "required",
      ),
    async (data) => {
      await api("/flow-measurements/" + m.id, {
        method: "DELETE",
        body: JSON.stringify(data),
      });
      location.hash = "#/flow";
      toast("Durchflussmessung gelöscht.");
    },
    "Messung löschen",
  );
}
app.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-flow-action]");
  if (!target || target.disabled) return;
  const id = Number(target.dataset.id);
  target.disabled = true;
  try {
    if (target.dataset.flowAction === "resume") {
      if (!ble.connected) throw Error("Bitte Bluetooth verbinden.");
      await flowRecorder.resume(id);
    } else {
      if (flowRecorder.active?.id !== id)
        await flowRecorder.resume(id, { record: false });
      await flowRecorder.finish();
      toast("Durchflussmessung und Diagramm gespeichert.");
      await render();
    }
  } catch (error) {
    toast(error.message);
    flowRecorder.error = error.message;
  }
  updateFlowPanels();
});
function devicesPage() {
  return (
    heading(
      "Geräte & Sensoren",
      "Verbinde SpuelPilot-ESP32 und übertrage Messaufträge und Ergebnisse.",
      "",
      "BLUETOOTH-MESSERFASSUNG",
    ) +
    `<div class="ble-widget" data-ble-panel="device"></div><div class="device-card"><div class="device-icon">${icon("bluetooth")}</div><div><span class="badge blue">SpuelPilot-ESP32 · BLE</span><h2>Vom Spülpunkt zum Messprotokoll.</h2><p>Der ESP32 bleibt während des Spülvorgangs per Bluetooth mit dem Smartphone verbunden. Der vorgesehene Ablauf:</p><ol class="device-flow"><li><strong>Spülpunkt auswählen.</strong> Eine freigegebene Person aus Administration oder Mitarbeitern wählt den Punkt bei bestehender Bluetooth-Verbindung aus.</li><li><strong>Auftrag übertragen.</strong> Spülpunkt-ID und Sollmenge werden mit Semikolon getrennt übertragen, zum Beispiel SP-1024;2.50.</li><li><strong>Temperatur vorher messen.</strong> Sobald erstmals mindestens 1 m³/h Durchfluss erreicht werden, startet eine Wartezeit von 5 Sekunden. Danach wird die Temperatur vorher erfasst.</li><li><strong>Sollmenge erreichen.</strong> Die gespülte Menge wird ab Beginn dieses Auftrags gezählt. Beim Erreichen oder Überschreiten der Sollmenge wird die Temperatur nachher automatisch erfasst.</li><li><strong>Spüldaten übernehmen.</strong> Bei READY fordert die Anwendung das vollständige Ergebnis automatisch mit GET an. Live-Werte allein werden niemals gespeichert. Mit ausgewählter Trübung (Ja/Nein) wird das Ergebnis automatisch gespeichert und erst danach bestätigt. Der Abrufbutton bleibt als Rückfallebene verfügbar.</li></ol><div class="notice">${icon("info")}Erst „Spülung speichern“ sichert die Daten auf dem Server. Danach bestätigt die Anwendung den Empfang mit ACK;Spülpunkt-ID. Der ESP32 löscht erst dann sein Ergebnis und schaltet die LED aus. Bei Speicherfehlern bleibt das Ergebnis auf dem Gerät. Web Bluetooth benötigt HTTPS und einen unterstützten Browser; iOS Safari unterstützt es nicht.</div></div></div>`
  );
}
async function render() {
  if (!user) return renderAuth();
  if (user.must_change_password) return renderPasswordRequired();
  const version = ++loadVersion,
    owner = user.id;
  ble.bindUser(user.role === "viewer" ? null : user.id);
  await flowRecorder.bindUser(user.role === "viewer" ? null : user.id);
  if (version !== loadVersion || user?.id !== owner) return;
  try {
    const [ls, fs, ns, rs, ss] = await Promise.all([
      api("/lists"),
      api("/flushes"),
      user.role !== "viewer" ? api("/internal-notes") : Promise.resolve([]),
      api("/report-runs"),
      api("/statistics/settings"),
    ]);
    if (version !== loadVersion) return;
    lists = ls;
    flushes = fs;
    notes = ns;
    archivedRuns = rs;
    statistics = ss;
    const [path] = location.hash.slice(2).split("?"),
      parts = (path || "overview").split("/");
    const section = parts[0];
    if (section === "flow") {
      if (user.role === "viewer") {
        location.hash = "#/overview";
        return;
      }
      flowRecords = await api("/flow-measurements");
      flowDetail = null;
      flowSeries = [];
      if (parts[1]) {
        const id = Number(parts[1]);
        [flowDetail, flowSeries] = await Promise.all([
          api("/flow-measurements/" + id),
          api("/flow-measurements/" + id + "/series"),
        ]);
      }
      if (version !== loadVersion) return;
      layout(flowPage(), "flow");
      updateFlowPanels();
    } else if (section === "notes") {
      if (user.role === "viewer") {
        location.hash = "#/overview";
        return;
      }
      layout(notesPage(), "notes");
    } else if (section === "account") {
      layout(accountPage(), "account");
      bindPasswordForm();
    } else if (section === "devices" && user.role === "viewer") {
      location.hash = "#/overview";
      return;
    } else if (section === "users" && isAdmin()) {
      users = await api("/users");
      if (version !== loadVersion) return;
      layout(usersPage(), "users");
    } else if (section === "lists" && parts[1]) {
      const requestedRun = new URLSearchParams(
        location.hash.split("?")[1] || "",
      ).get("run");
      currentList = lists.find(
        (l) =>
          l.id === Number(parts[1]) &&
          (!requestedRun || l.run_id === Number(requestedRun)),
      );
      points = currentList
        ? await api(`/lists/${currentList.id}/points?run=${currentList.run_id}`)
        : [];
      if (version !== loadVersion) return;
      layout(listDetail(), "lists");
      const selectedPoint = Number(
        new URLSearchParams(location.hash.split("?")[1] || "").get("point"),
      );
      if (selectedPoint && ble.job) {
        const point = points.find((p) => p.id === selectedPoint);
        if (
          point &&
          !point.completed &&
          canDocument() &&
          ble.matches(point, currentList.run_id)
        )
          flushModal(point);
        else {
          location.hash = "#/devices";
          return;
        }
      }
      document
        .querySelector("#point-search")
        ?.addEventListener("input", (e) => {
          document.querySelector("#points-results").innerHTML = pointTable(
            points.filter((p) =>
              (p.code + " " + p.address)
                .toLowerCase()
                .includes(e.target.value.toLowerCase()),
            ),
          );
          bindActions(document.querySelector("#points-results"));
        });
    } else if (section === "lists") {
      layout(listsPage(), "lists");
      document.querySelector("#list-search").oninput = (e) => {
        document.querySelector("#list-results").innerHTML =
          lists
            .filter((l) =>
              (l.name + " " + l.description)
                .toLowerCase()
                .includes(e.target.value.toLowerCase()),
            )
            .map(listCard)
            .join("") ||
          empty("Keine Treffer", "Versuche einen anderen Suchbegriff.");
      };
    } else if (section === "reports") {
      layout(reportsPage(), "reports");
      const search = document.querySelector("#report-search");
      if (search)
        search.oninput = () => {
          const listId = new URLSearchParams(
            location.hash.split("?")[1] || "",
          ).get("list");
          document.querySelector("#report-cards").innerHTML = reportCards(
            reportRuns().filter(
              (r) =>
                (!listId || String(r.listId) === listId) &&
                `${r.name} ${r.number} ${r.publishedAt ? date(r.publishedAt) : ""}`
                  .toLowerCase()
                  .includes(search.value.toLowerCase()),
            ),
          );
        };
    } else if (section === "devices") {
      layout(devicesPage(), "devices");
    } else {
      layout(overview(), "overview");
    }
  } catch (e) {
    if (version !== loadVersion || user?.must_change_password) return;
    toast(e.message);
    if (user)
      app.innerHTML = `<div class="error-page"><h1>Verbindung unterbrochen</h1><p>${esc(e.message)}</p><button class="button" id="retry">Erneut versuchen</button></div>`;
    document.querySelector("#retry")?.addEventListener("click", render);
  }
}
function field(label, name, value = "", type = "text", extra = "") {
  return `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
}
function showModal(title, subtitle, body, onSubmit, submitLabel = "Speichern") {
  activeBleForm = null;
  modal.oncancel = null;
  modal.innerHTML = `<form id="modal-form"><header class="modal-head"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="close" type="button" data-close aria-label="Schließen">${icon("close")}</button></header><div class="modal-body"><div class="form-error" id="modal-error" role="alert"></div>${body}</div><footer class="modal-footer"><button type="button" class="button secondary" data-close>Abbrechen</button>${onSubmit ? `<button type="submit" class="button">${icon("check")}${submitLabel}</button>` : ""}</footer></form>`;
  modal
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = () => modal.close()));
  modal.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const b = e.target.querySelector("[type=submit]");
    b.disabled = true;
    try {
      const outcome = await onSubmit(
        Object.fromEntries(new FormData(e.target)),
        e.target,
      );
      if (outcome === "keep-open") return;
      modal.close();
      await render();
    } catch (err) {
      modal.querySelector("#modal-error").textContent = err.message;
      b.disabled = false;
    }
  };
  modal.showModal();
}
function listModal(edit = false) {
  const l = edit ? currentList : {};
  showModal(
    edit ? "Spülliste bearbeiten" : "Neue Spülliste",
    "Ein gemeinsamer Ort für deine Spülpunkte.",
    field(
      "Listenname",
      "name",
      l.name,
      "text",
      'required maxlength="100" placeholder="z. B. Versorgungszone Nord"',
    ) +
      `<div class="field"><label for="f-description">Beschreibung <span class="muted">(optional)</span></label><textarea id="f-description" name="description" rows="3" maxlength="500" placeholder="Gebiet oder Hinweise für dein Team">${esc(l.description || "")}</textarea></div>`,
    async (data) => {
      await send(
        edit ? "/lists/" + l.id : "/lists",
        data,
        edit ? "PUT" : "POST",
      );
      toast(edit ? "Spülliste aktualisiert." : "Spülliste angelegt.");
    },
  );
}
function pointModal(p) {
  showModal(
    p ? "Spülpunkt bearbeiten" : "Spülpunkt anlegen",
    "Die eindeutige ID verbindet alle Spülprotokolle.",
    field(
      "Spülpunkt ID",
      "code",
      p?.code || "",
      "text",
      'required maxlength="50" placeholder="z. B. SP-010"',
    ) +
      field(
        "Adresse des Spülpunkts",
        "address",
        p?.address || "",
        "text",
        'required maxlength="300" placeholder="Straße, Hausnummer, PLZ und Ort"',
      ) +
      field(
        "Sollmenge in m³",
        "target",
        p?.target || "",
        "number",
        'required min="0.001" max="1000000" step="any" placeholder="z. B. 2,5"',
      ) +
      `<div class="field"><label for="f-list_id">Spülliste</label><select id="f-list_id" name="list_id">${[...new Map(lists.map((l) => [l.id, l])).values()].map((l) => `<option value="${l.id}" ${l.id === (p?.list_id || currentList?.id) ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>`,
    async (data) => {
      await send(
        p ? "/points/" + p.id : "/points",
        { ...data, target: Number(data.target), list_id: Number(data.list_id) },
        p ? "PUT" : "POST",
      );
      toast(p ? "Spülpunkt aktualisiert." : "Spülpunkt angelegt.");
    },
  );
}
async function assignModal(restart = false) {
  users = await api("/users");
  const eligibleUsers = users.filter(
    (u) => ["admin", "employee"].includes(u.role) && u.active,
  );
  showModal(
    restart ? "Neuen Durchgang freigeben" : "Liste freigeben",
    esc(currentList.name),
    `<p class="subtitle modal-intro">${restart ? "Der gespeicherte Durchgang bleibt unverändert für Betrachter erhalten. Alle Punkte werden im neuen Durchgang wieder offen. " : ""}Administration und Mitarbeiter können für diese Liste freigegeben werden. Betrachter sehen nur gespeicherte und freigegebene Durchgänge.</p>${eligibleUsers.map((u) => `<label class="checkbox-row"><input type="checkbox" name="assignee" value="${u.id}" ${!restart && currentList.assignees.some((a) => a.id === u.id) ? "checked" : ""}><span><strong>${esc(u.name)}</strong><small>${esc(u.email)} · ${roleName[u.role]}</small></span></label>`).join("") || '<div class="notice">Es sind keine aktiven Benutzer aus Administration oder Mitarbeitern verfügbar.</div>'}`,
    async (data, form) => {
      await send(
        `/lists/${currentList.id}/${restart ? "restart" : "assignments"}`,
        { user_ids: new FormData(form).getAll("assignee").map(Number) },
        restart ? "POST" : "PUT",
      );
      toast(
        restart
          ? "Neuer Durchgang freigegeben. Alle Punkte sind wieder offen."
          : "Listenfreigabe aktualisiert.",
      );
    },
  );
}
function userModal(u) {
  showModal(
    u ? "Benutzer bearbeiten" : "Benutzer anlegen",
    "Persönlicher Zugang mit klaren Berechtigungen.",
    field(
      "Vor- und Nachname",
      "name",
      u?.name || "",
      "text",
      'required maxlength="100" autocomplete="off"',
    ) +
      field(
        "E-Mail-Adresse",
        "email",
        u?.email || "",
        "email",
        'required maxlength="200" autocomplete="off"',
      ) +
      `<div class="field"><label for="f-role">Benutzerrolle</label><select name="role" id="f-role">${Object.entries(
        roleName,
      )
        .map(
          ([value, label]) =>
            `<option value="${value}" ${(u?.role || "employee") === value ? "selected" : ""}>${label}</option>`,
        )
        .join("")}</select></div>` +
      (u
        ? '<div class="notice">Benutzerpasswörter werden über „Einmalpasswort erstellen“ zurückgesetzt. Das persönliche Passwort vergibt die Person anschließend selbst.</div>'
        : field(
            "Passwort",
            "password",
            "",
            "password",
            'required minlength="12" maxlength="128" autocomplete="new-password" placeholder="Mindestens 12 Zeichen"',
          )) +
      (u
        ? `<label class="checkbox-row"><input type="checkbox" name="active" ${u.active ? "checked" : ""}><span><strong>Konto aktiv</strong><small>Deaktivierte Konten haben keinen Zugriff mehr.</small></span></label>`
        : "") +
      `<div class="notice">${icon("info")}Übermittle Zugangsdaten ausschließlich über einen sicheren Kanal. Passwörter werden nur als gesalzener Hash gespeichert.</div>`,
    async (data, form) => {
      const b = {
        ...data,
        ...(u ? { active: new FormData(form).has("active") } : {}),
      };
      await send(u ? "/users/" + u.id : "/users", b, u ? "PUT" : "POST");
      if (u?.id === user.id)
        user = { ...user, name: data.name, email: data.email };
      toast(u ? "Benutzer aktualisiert." : "Benutzer angelegt.");
    },
  );
}
async function storeFlush(point, runId, data, fromEsp32, context) {
  if (savingMeasurement) throw Error("Die Messung wird bereits gespeichert.");
  if (![true, false, "true", "false"].includes(data.turbidity))
    throw Error("Bitte die Trübung mit Ja oder Nein auswählen.");
  const owner = user?.id,
    job = fromEsp32 ? { ...ble.job } : null;
  if (
    fromEsp32 &&
    (!ble.matches(point, runId) || !job.received || job.cancelPending)
  )
    throw Error("Die vollständigen Messdaten passen nicht zum Auftrag.");
  savingMeasurement = true;
  if (context) context.serverSaving = true;
  updateBlePanels();
  syncBleForm();
  try {
    const result = await send(`/points/${point.id}/flushes`, {
      temperature_before: Number(data.temperature_before),
      temperature_after: Number(data.temperature_after),
      volume: Number(data.volume),
      turbidity: data.turbidity === true || data.turbidity === "true",
      note: data.note ?? "",
      ...(fromEsp32
        ? {
            source: "esp32",
            request_id: job.requestId,
            run_id: runId,
            measurement_point_code: point.code,
            measurement_target: point.target,
          }
        : {}),
    });
    if (context) context.serverSaved = true;
    let pendingAck = false;
    if (fromEsp32) {
      const current = ble.markSaved(result.receipt);
      try {
        if (!current) throw Error("Benutzerkonto gewechselt.");
        await ble.acknowledge(result.receipt);
      } catch {
        pendingAck = true;
      }
      if (completedMeasurement?.requestId === job.requestId)
        completedMeasurement = null;
    }
    if (user?.id === owner) {
      if (result.status === "review") location.hash = "#/lists";
      toast(
        pendingAck
          ? "Messung gespeichert. ESP32-Empfangsbestätigung steht noch aus."
          : result.status === "review"
            ? "Alle Punkte bearbeitet. Die Liste wurde zur Prüfung übergeben."
            : "Spülung erfolgreich gespeichert.",
      );
    }
    return result;
  } finally {
    savingMeasurement = false;
    if (context) context.serverSaving = false;
    updateBlePanels();
    syncBleForm();
  }
}
function currentBleDraft() {
  const context = activeBleForm;
  if (context && modal.open && ble.matches(context.point, context.runId)) {
    const value = document.querySelector("#f-turbidity").value;
    const draft = {
      requestId: ble.job.requestId,
      userId: user.id,
      turbidity: value === "" ? null : value === "true",
      note: document.querySelector("#f-note").value,
    };
    bleDraft = draft;
    // Only a boolean joins the existing local job metadata. Internal notes and
    // sensor values stay in memory and are never persisted in browser storage.
    if (ble.job.turbidity !== draft.turbidity) {
      ble.job.turbidity = draft.turbidity;
      ble.persist();
    }
    return draft;
  }
  if (
    bleDraft &&
    ble.job &&
    bleDraft.requestId === ble.job.requestId &&
    bleDraft.userId === user?.id
  )
    return bleDraft;
  return {
    turbidity:
      typeof ble.job?.turbidity === "boolean" ? ble.job.turbidity : null,
    note: "",
  };
}
function importCompletedMeasurement() {
  const context = activeBleForm,
    pending = completedMeasurement;
  if (
    !context ||
    !modal.open ||
    !pending ||
    pending.userId !== user?.id ||
    pending.requestId !== ble.job?.requestId ||
    !ble.matches(context.point, context.runId)
  )
    return;
  for (const key of ["volume", "temperature_before", "temperature_after"])
    document.querySelector("#f-" + key).value = String(pending.values[key]);
  context.imported = true;
}
async function processReadyMeasurement() {
  if (
    automaticRunning ||
    savingMeasurement ||
    !user ||
    user.role === "viewer" ||
    user.id !== ble.userId ||
    !ble.connected ||
    ble.busy ||
    !ble.job ||
    ble.job.cancelPending
  )
    return;
  const job = ble.job,
    owner = user.id,
    requestId = job.requestId;
  const ready =
    ble.deviceStatus?.state === "READY" && ble.deviceStatus.code === job.code;
  const attempt = `${owner}:${requestId}:${ble.generation}`;
  if (!ready && completedMeasurement?.requestId !== requestId) return;
  automaticRunning = true;
  try {
    if (ready && readyAttempt !== attempt && !job.savedId) {
      readyAttempt = attempt;
      if (ble.live?.code === job.code && ble.live.target !== job.target)
        throw Error(
          "Live-Sollmenge passt nicht zum Auftrag. Keine automatische Übernahme.",
        );
      const values = await ble.exchange(
        { id: job.pointId, code: job.code, target: job.target },
        job.runId,
      );
      if (user?.id !== owner || ble.job?.requestId !== requestId) return;
      completedMeasurement = { requestId, userId: owner, values };
      importCompletedMeasurement();
    }
    if (job.savedId) {
      if (readyAttempt === attempt) return;
      readyAttempt = attempt;
      const receipt = await api(`/flushes/${job.savedId}/receipt`);
      if (user?.id !== owner || ble.job?.requestId !== requestId) return;
      await ble.acknowledge(receipt);
      return;
    }
    if (
      completedMeasurement?.requestId !== requestId ||
      completedMeasurement.userId !== owner
    )
      return;
    importCompletedMeasurement();
    const draft = currentBleDraft();
    if (typeof draft.turbidity !== "boolean") return;
    const saveKey = `${attempt}:${JSON.stringify(draft)}`;
    if (autoSaveAttempt === saveKey) return;
    autoSaveAttempt = saveKey;
    const context =
      activeBleForm &&
      modal.open &&
      ble.matches(activeBleForm.point, activeBleForm.runId)
        ? activeBleForm
        : null;
    await storeFlush(
      { id: job.pointId, code: job.code, target: job.target },
      job.runId,
      {
        ...completedMeasurement.values,
        turbidity: draft.turbidity,
        note: draft.note,
      },
      true,
      context,
    );
    if (user?.id === owner) {
      if (context && context === activeBleForm && modal.open) modal.close();
      await render();
    }
  } catch (error) {
    if (user?.id === owner) ble.error = error.message;
  } finally {
    automaticRunning = false;
    updateBlePanels();
    syncBleForm();
  }
}
function flushModal(p) {
  showModal(
    "Spülung dokumentieren",
    esc(p.code) + " · " + esc(p.address),
    `<div class="measure-box">${icon("drop")}<div><strong>Geplante Spülmenge</strong><small>${esc(currentList.name)}</small></div><b>${number(p.target)} <small>m³</small></b></div><div class="ble-widget" data-ble-panel="form"></div><div class="form-row">${field("Temperatur vorher · °C", "temperature_before", "", "number", 'required min="0" max="100" step="any" placeholder="22,0"')}${field("Temperatur nachher · °C", "temperature_after", "", "number", 'required min="0" max="100" step="any" placeholder="14,0"')}</div>${field("Tatsächlich gespülte Menge · m³", "volume", "", "number", 'required min="0.001" max="1000000" step="any" placeholder="z. B. 2,6"')}<div class="field"><label for="f-turbidity">Trübung festgestellt?</label><select id="f-turbidity" name="turbidity" required><option value="false" selected>Nein – keine Trübung</option><option value="true">Ja – Trübung vorhanden</option></select></div><div class="field"><label for="f-note">Interne Bemerkung <span class="muted">(optional)</span></label><textarea id="f-note" name="note" maxlength="2000" rows="3" placeholder="Zum Beispiel: Hydrant undicht oder Beschädigung festgestellt"></textarea><small class="field-hint">Nur für Administration und berechtigte Mitarbeiter. Nicht für Betrachter oder den Ausdruck.</small></div><div class="notice">${icon("clock")}<span>Bei READY wird automatisch abgerufen und gespeichert, sobald die Trübung ausgewählt ist. Interne Bemerkungen bitte vor Messende ergänzen.<br>Das Spüldatum wird beim Speichern automatisch eingetragen.<br>Mitarbeiter: <strong>${esc(user.name)}</strong><br>Das Protokoll bleibt als unveränderlicher Nachweis erhalten.</span></div>`,
    async (data) => {
      const context = activeBleForm;
      if (context?.serverSaved)
        throw Error(
          "Diese Messung ist bereits gespeichert. Bestätige nur noch den ESP32-Empfang.",
        );
      const fromEsp32 = !!context?.imported;
      if (
        ble.matches(p, context.runId) &&
        (!fromEsp32 || ble.job.cancelPending)
      )
        throw Error("Frage zuerst die vollständigen Messdaten vom ESP32 ab.");
      await storeFlush(p, context.runId, data, fromEsp32, context);
    },
    "Spülung speichern",
  );
  activeBleForm = {
    point: p,
    runId: currentList.run_id,
    imported: false,
    seenRequest: null,
    serverSaving: false,
    serverSaved: false,
  };
  for (const id of ["f-turbidity", "f-note"])
    document.getElementById(id).addEventListener("change", () => {
      currentBleDraft();
      queueMicrotask(processReadyMeasurement);
    });
  document.getElementById("f-note").addEventListener("input", currentBleDraft);
  if (
    bleDraft &&
    bleDraft.userId === user?.id &&
    bleDraft.requestId === ble.job?.requestId &&
    ble.matches(p, activeBleForm.runId)
  )
    document.getElementById("f-note").value = bleDraft.note;
  if (
    ble.matches(p, activeBleForm.runId) &&
    typeof ble.job.turbidity === "boolean"
  )
    document.getElementById("f-turbidity").value = String(ble.job.turbidity);
  updateBlePanels();
  syncBleForm();
  importCompletedMeasurement();
  refreshPointStates();
  queueMicrotask(processReadyMeasurement);
}
async function pointDetail(p) {
  if (isAdmin() && currentList.status === "active" && !p.completed)
    return pointModal(p);
  const history = await api("/flushes?point=" + p.id);
  showModal(
    esc(p.code),
    esc(p.address),
    `<div class="measure-box">${icon("drop")}<div><strong>Sollmenge</strong><small>Letzte Spülung: ${date(p.last_flush)}</small></div><b>${number(p.target)} <small>m³</small></b></div><h3 class="history-heading">Bisherige Spülungen</h3>${reportTable(history)}`,
    null,
  );
}
function publishModal() {
  showModal(
    "Durchgang speichern & freigeben",
    esc(currentList.name),
    `<div class="notice">${icon("shield")}<span>Durchgang ${currentList.run_number} mit ${currentList.point_count} bearbeiteten Punkten wird unverändert gespeichert und für alle Betrachter freigegeben. Danach kannst du einen neuen Durchgang starten. Die bisherigen Protokolle bleiben erhalten.</span></div>`,
    async () => {
      await send(`/lists/${currentList.id}/publish`, {});
      toast("Durchgang gespeichert und für Betrachter freigegeben.");
    },
    "Speichern & freigeben",
  );
}
function deleteListModal() {
  showModal(
    "Spülliste löschen",
    esc(currentList.name),
    `<div class="notice">${icon("info")}<span>Die Liste und sämtliche Durchgänge werden aus der Anwendung entfernt. Es gibt keine automatische Löschung; diese Aktion ist nur der Administration möglich. Intern werden die Daten als gelöscht markiert.</span></div>` +
      field(
        "Zur Bestätigung den Listennamen eingeben",
        "confirm_name",
        "",
        "text",
        "required",
      ),
    async (data) => {
      await send(`/lists/${currentList.id}`, data, "DELETE");
      location.hash = "#/lists";
      toast("Spülliste gelöscht.");
    },
    "Liste löschen",
  );
}
function deleteRecordModal(record) {
  if (!record || !isAdmin()) return;
  showModal(
    "Messprotokoll löschen",
    `${esc(record.code)} · ${date(record.flushed_at)}`,
    `<div class="notice">${icon("info")}<span>Dieses Messprotokoll mit ${number(record.volume)} m³ wird aus Ansichten, Ausdrucken und Statistik entfernt. Zugehörige interne Hinweise werden ausgeblendet. Ein laufender Durchlauf erhält dadurch einen offenen Punkt; abgeschlossene Durchläufe bleiben geschlossen. Andere Messungen bleiben erhalten.</span></div>` +
      field(
        "Zur Bestätigung die Spülpunkt-ID eingeben",
        "confirm_code",
        "",
        "text",
        "required",
      ),
    async (data) => {
      await send(`/flushes/${record.id}`, data, "DELETE");
      toast("Messprotokoll gelöscht.");
    },
    "Protokoll löschen",
  );
}
function deleteRunModal() {
  const id = Number(
      location.hash.startsWith("#/lists/")
        ? currentList?.run_id
        : new URLSearchParams(location.hash.split("?")[1] || "").get("run"),
    ),
    run = reportRuns().find((r) => r.id === id);
  if (!run || !isAdmin()) return;
  showModal(
    "Abgeschlossene Spülliste löschen",
    `${esc(run.name)} · Durchgang ${run.number}`,
    `<div class="notice">${icon("info")}<span>Dieser abgeschlossene Durchlauf und seine ${run.rows.length} Messprotokolle werden aus Ansichten, Ausdrucken und Statistik entfernt. Die Listenvorlage, Spülpunkte und andere Durchläufe bleiben erhalten.</span></div>` +
      field(
        "Zur Bestätigung den Listennamen eingeben",
        "confirm_name",
        "",
        "text",
        "required",
      ),
    async (data) => {
      await send(`/runs/${run.id}`, data, "DELETE");
      location.hash = "#/reports";
      toast("Abgeschlossener Durchlauf gelöscht.");
    },
    "Durchlauf löschen",
  );
}
function settingsModal() {
  if (!isAdmin()) return;
  showModal(
    "Administration · Einstellungen",
    "Statistik verwalten",
    `<div class="notice">${icon("info")}<span>Setzt die gezählten Spülungen und gespülten m³ für alle Benutzer zurück. Ab jetzt erfasste Messungen zählen neu. Gespeicherte Messprotokolle, Spüllisten und der tatsächliche Bearbeitungsstand bleiben erhalten. ${statistics.reset_at ? "Letzter Reset: " + date(statistics.reset_at) + "." : "Bisher kein Statistikreset."}</span></div>` +
      field(
        "Zur Bestätigung STATISTIK ZURÜCKSETZEN eingeben",
        "confirm",
        "",
        "text",
        "required",
      ),
    async (data) => {
      await send("/statistics/reset", data);
      toast("Statistik zurückgesetzt. Protokolle bleiben gespeichert.");
    },
    "Statistik zurücksetzen",
  );
}
function passwordForm(forced = false) {
  return `<form id="password-form" class="password-form"><div class="form-error" id="password-error" role="alert"></div>${forced ? "" : field("Aktuelles Passwort", "current_password", "", "password", 'required maxlength="128" autocomplete="current-password"')}${field("Neues Passwort", "new_password", "", "password", 'required minlength="12" maxlength="128" autocomplete="new-password"')}${field("Neues Passwort wiederholen", "confirm_password", "", "password", 'required minlength="12" maxlength="128" autocomplete="new-password"')}<div class="notice">${icon("shield")}<span>Wähle ein persönliches Passwort mit mindestens 12 Zeichen. Nach dem Speichern werden alle anderen Sitzungen abgemeldet.</span></div><button type="submit" class="button">${icon("check")}Passwort speichern</button>${forced ? '<button type="button" class="button secondary" id="password-logout">Abmelden</button>' : ""}</form>`;
}
function accountPage() {
  return (
    heading(
      "Mein Passwort",
      "Ändere dein persönliches Passwort. Dein Zugang bleibt deiner Rolle zugeordnet.",
      "",
      "PERSÖNLICHER ZUGANG",
    ) +
    `<section class="panel account-panel"><div class="panel-head"><div><h2>${esc(user.name)}</h2><p>${esc(user.email)}</p></div></div><div class="account-body">${passwordForm()}</div></section>`
  );
}
function renderPasswordRequired() {
  updateMeasurementDock();
  document.body.classList.remove(
    "has-measurement-dock",
    "has-two-measurements",
  );
  ble.bindUser(null);
  if (modal.open) modal.close();
  app.innerHTML = `<div class="required-password"><div class="required-card">${brand()}<div class="login-role">Persönlichen Zugang einrichten</div><h1>Neues Passwort festlegen</h1><p class="subtitle">Du bist mit einem Einmalpasswort angemeldet. Vergib zuerst dein eigenes Passwort, um SpülPilot zu verwenden.</p>${passwordForm(true)}</div></div>`;
  bindPasswordForm(true);
}
function bindPasswordForm(forced = false) {
  const form = document.querySelector("#password-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      const result = await send(
        "/account/password",
        Object.fromEntries(new FormData(form)),
      );
      user = result.user;
      csrf = result.csrf;
      toast(
        "Dein Passwort wurde geändert. Andere Sitzungen wurden abgemeldet.",
      );
      if (forced) location.hash = "#/overview";
      await render();
    } catch (error) {
      const message = document.querySelector("#password-error");
      if (message) message.textContent = error.message;
      submit.disabled = false;
    }
  };
  document
    .querySelector("#password-logout")
    ?.addEventListener("click", async () => {
      try {
        await send("/logout", {});
        ++loadVersion;
        user = null;
        csrf = null;
        renderAuth();
      } catch (error) {
        toast(error.message);
      }
    });
}
function resetPasswordModal(u) {
  showModal(
    "Einmalpasswort erstellen",
    esc(u.name),
    `<div class="notice">${icon("lock")}<span>Das bisherige Passwort wird ungültig und alle Sitzungen von ${esc(u.name)} werden beendet. Ein neues Tier-/Gegenstand-Passwort mit Zahlen ist 10 Minuten gültig und kann nur einmal zur Anmeldung verwendet werden. Danach muss die Person ein eigenes Passwort festlegen.</span></div>`,
    async () => {
      const resetForm = modal.querySelector("#modal-form");
      const result = await send(`/users/${u.id}/reset-password`, {});
      if (!modal.open || modal.querySelector("#modal-form") !== resetForm)
        return "keep-open";
      resetForm.onsubmit = (e) => e.preventDefault();
      // The secret exists only in this response and this open dialog, never in storage or logs.
      modal.querySelector(".modal-body").innerHTML =
        `<p class="subtitle">Einmalpasswort für ${esc(u.name)}. Übermittle es persönlich über einen sicheren Kanal.</p><label for="one-time-password">Neu erzeugtes Einmalpasswort</label><input id="one-time-password" class="one-time-password" readonly autocomplete="off" spellcheck="false"><div class="notice">${icon("clock")}Einmalige Anmeldung innerhalb von ${result.expires_in_minutes} Minuten. Anschließend ist ein eigenes Passwort erforderlich. Nach dem Schließen wird das Passwort nicht erneut angezeigt.</div>`;
      modal.querySelector("#one-time-password").value =
        result.temporary_password;
      modal.querySelector(".modal-footer").innerHTML =
        '<button type="button" class="button" id="close-reset">Fertig</button>';
      modal.querySelector("#close-reset").onclick = () => {
        modal.querySelector("#one-time-password").value = "";
        modal.close();
        modal.innerHTML = "";
        render();
      };
      modal.querySelector("[data-close]").onclick = () => {
        modal.close();
        modal.innerHTML = "";
        render();
      };
      modal.oncancel = () => {
        setTimeout(() => {
          modal.innerHTML = "";
          render();
        }, 0);
        modal.oncancel = null;
      };
      return "keep-open";
    },
    "Einmalpasswort generieren",
  );
}
function remainingTime(seconds) {
  if (seconds === -1) return "Nicht berechenbar";
  const total = Math.ceil(seconds),
    hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    rest = total % 60;
  return hours
    ? `${hours} Std. ${minutes} Min.`
    : minutes
      ? `${minutes} Min. ${rest} Sek.`
      : `${rest} Sek.`;
}
function livePanel() {
  const live = ble.connected ? ble.live : null;
  const active = live?.code && live.state !== "IDLE";
  const mismatch =
    active &&
    ble.job &&
    (live.code !== ble.job.code || live.target !== ble.job.target);
  return `<section class="live-panel ${live?.state === "ERROR" ? "live-error" : ""}" aria-label="ESP32 Live-Daten"><div class="live-heading"><strong>${icon("wave")}Live-Messung</strong><span class="live-indicator ${live ? "fresh" : ""}">${live ? "Live · 1 Sekunde" : ble.connected ? "Warte auf aktuelle Daten" : "Offline"}</span></div><div class="live-metrics"><div><small>Durchfluss</small><strong data-live="flow">${live ? number(live.flow, 3) : "—"}<span>m³/h</span></strong></div><div><small>Temperatur</small><strong data-live="temperature">${live ? number(live.temperature, 2) : "—"}<span>°C</span></strong></div></div>${active ? `<div class="live-progress-head"><span>Spülpunkt <strong>${esc(live.code)}</strong></span><strong data-live="percent">${number(live.percent, 1)} %</strong></div><div class="live-progress" role="progressbar" aria-label="Spülfortschritt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${live.percent}"><span style="width:${live.percent}%"></span></div><div class="live-summary"><span>Gespült <strong data-live="volume">${number(live.volume)} / ${number(live.target)} m³</strong></span><span>Geschätzte Restzeit <strong data-live="remaining">${remainingTime(live.remaining)}</strong></span></div>` : ""}${mismatch ? '<p class="ble-error">Die Live-Daten gehören zu einem anderen Auftrag oder einer anderen Sollmenge. Sie werden nicht als Messergebnis übernommen.</p>' : ""}${!live ? '<p class="live-footnote">Keine aktuellen Live-Werte. Bei Verbindungsabbruch misst der ESP32 autonom weiter.</p>' : live.state === "ERROR" ? '<p class="ble-error">Der ESP32 meldet einen Messfehler. Live-Werte sind kein vollständiges Ergebnis; es wird kein ACK gesendet.</p>' : ""}</section>`;
}
function blePanel(context) {
  const supported = !!navigator.bluetooth && window.isSecureContext;
  const connected = ble.connected,
    job = ble.job,
    conflict = context && job && !ble.matches(context.point, context.runId);
  const linked = context && ble.matches(context.point, context.runId);
  const state = ble.deviceStatus;
  const status = state
    ? `${STATUS_LABELS[state.state]}${state.code ? " · " + state.code : ""}`
    : connected
      ? "Verbunden. Wähle einen Spülpunkt für den Messauftrag."
      : "Noch nicht verbunden";
  return `<div class="ble-head"><div class="ble-title">${icon("bluetooth")}<strong>${connected ? esc(ble.device.name || "SpuelPilot-ESP32") : "SpuelPilot-ESP32"}</strong><span class="badge ${connected ? "green" : ""}">${connected ? "Verbunden" : "Nicht verbunden"}</span></div><div class="actions">${connected ? '<button type="button" class="button secondary" data-ble-action="disconnect">Trennen</button>' : `<button type="button" class="button secondary" data-ble-action="connect" ${!supported || ble.busy ? "disabled" : ""}>${icon("bluetooth")}${ble.busy ? "Verbindet …" : "Bluetooth verbinden"}</button>`}</div></div><p class="ble-status" role="status" aria-live="polite">${esc(status)}</p>${livePanel()}${!supported ? '<div class="notice">Web Bluetooth benötigt HTTPS und einen unterstützten Browser, z. B. Chrome auf Android. iOS Safari unterstützt es nicht. Die manuelle Erfassung bleibt verfügbar.</div>' : ""}${job ? `<p class="ble-job">Auftrag <strong>${esc(job.code)}</strong> · ${number(job.target)} m³${job.savedId ? " · Auf Server gespeichert; Empfang bestätigen" : ""}</p>` : ""}${context && !job?.savedId ? `<button type="button" class="button ble-exchange" data-ble-action="exchange" ${!connected || ble.busy || context?.serverSaving ? "disabled" : ""}>${icon(job && linked ? "drop" : "arrow")}${ble.busy ? "Übertragung läuft …" : job && linked ? "Messdaten abrufen" : "Spülpunkt an ESP32 senden"}</button>` : ""}${job?.savedId ? `<button type="button" class="button" data-ble-action="ack" ${!connected || ble.busy ? "disabled" : ""}>${icon("check")}Empfang am ESP32 bestätigen</button>` : ""}${job && !job.savedId && !job.received ? `<div class="ble-cancel"><button type="button" class="button danger" data-ble-action="cancel" ${!connected || ble.busy || context?.serverSaving ? "disabled" : ""}>${ble.job.cancelPending ? "Abbruch prüfen / erneut versuchen" : "Messung abbrechen"}</button>${context && linked && !ble.job.cancelPending ? '<button type="button" class="button secondary" data-ble-action="restart">Neue Messung starten</button>' : ""}</div>` : ""}${conflict ? '<p class="ble-hint">Beim Start dieses Spülpunkts wird gefragt, ob die laufende Messung zuerst abgebrochen werden soll.</p>' : ""}${context?.imported ? '<p class="ble-success">Messdaten übernommen. Nach Auswahl der Trübung wird bei READY automatisch gespeichert. Erst nach Serverbestätigung wird ACK gesendet.</p>' : job && !job.savedId ? '<p class="ble-hint">Bei READY wird das vollständige Ergebnis automatisch per GET abgerufen. Wähle die Trübung und ergänze Bemerkungen möglichst vor Messende. Ohne Trübungsangabe wird nicht gespeichert und kein ACK gesendet.</p>' : ""}${ble.error ? `<p class="ble-error" role="status">${esc(ble.error)}</p>` : ""}${job && !job.savedId && !context ? '<button type="button" class="button secondary" data-ble-action="open-job">Spülpunkt öffnen / Trübung ergänzen</button>' : ""}${job && !job.savedId ? '<button type="button" class="text-link ble-abandon" data-ble-action="recover">Server-Speicherstatus prüfen</button><button type="button" class="text-link ble-abandon" data-ble-action="abandon">Lokalen Auftrag verwerfen</button>' : ""}`;
}
function updateBlePanels() {
  document.querySelectorAll("[data-ble-panel]").forEach((panel) => {
    const context = panel.dataset.blePanel === "form" ? activeBleForm : null;
    const focusedAction = panel.contains(document.activeElement)
      ? document.activeElement.dataset.bleAction
      : null;
    panel.innerHTML =
      panel.dataset.blePanel === "flow"
        ? flowBluetoothPanel()
        : blePanel(context);
    if (focusedAction)
      panel
        .querySelector(`[data-ble-action="${focusedAction}"]`)
        ?.focus({ preventScroll: true });
    panel.querySelectorAll("[data-ble-action]").forEach(
      (button) =>
        (button.onclick = async () => {
          try {
            const action = button.dataset.bleAction;
            if (savingMeasurement && action !== "disconnect")
              throw Error("Die Messung wird gerade gespeichert. Bitte warten.");
            if (action === "connect") await ble.connect();
            else if (action === "disconnect") ble.disconnect();
            else if (action === "exchange" || action === "restart") {
              if (!activeBleForm || context !== activeBleForm)
                throw Error("Öffne den ausgewählten Spülpunkt erneut.");
              currentBleDraft();
              const confirmAbort = (code) =>
                window.confirm(
                  `Messung für ${code} läuft bereits oder ist noch offen. Soll sie abgebrochen und anschließend eine neue Messung für ${context.point.code} gestartet werden?`,
                );
              const result =
                action === "restart"
                  ? await ble.startMeasurement(
                      context.point,
                      context.runId,
                      confirmAbort,
                    )
                  : await ble.exchange(
                      context.point,
                      context.runId,
                      confirmAbort,
                    );
              if (ble.matches(context.point, context.runId)) currentBleDraft();
              if (result && context === activeBleForm && modal.open) {
                for (const key of [
                  "volume",
                  "temperature_before",
                  "temperature_after",
                ])
                  document.querySelector("#f-" + key).value = String(
                    result[key],
                  );
                context.imported = true;
                toast(
                  "ESP32-Messdaten übernommen. Bitte Trübung ergänzen und speichern.",
                );
              }
            } else if (action === "cancel") {
              if (
                window.confirm(
                  `Laufende Messung für ${ble.job.code} abbrechen? Es wird ${ble.job.code};0 gesendet. Ein fertiges Ergebnis bleibt geschützt. Dieser Abbruch schließt kein Ventil.`,
                )
              ) {
                await ble.cancelMeasurement();
                if (context) {
                  context.imported = false;
                  context.seenRequest = null;
                  for (const key of [
                    "volume",
                    "temperature_before",
                    "temperature_after",
                  ])
                    document.querySelector("#f-" + key).value = "";
                }
                toast(
                  "Der ESP32 hat den Messabbruch bestätigt. Der Spülpunkt bleibt offen.",
                );
              }
            } else if (action === "open-job") {
              const job = ble.job;
              const list = lists.find((l) => l.run_id === job.runId);
              if (!list)
                throw Error(
                  "Dieser Auftrag ist nicht mehr zur Bearbeitung freigegeben. Prüfe den Server-Speicherstatus.",
                );
              const rows = await api(
                `/lists/${list.id}/points?run=${job.runId}`,
              );
              const point = rows.find(
                (p) =>
                  p.id === job.pointId &&
                  p.code === job.code &&
                  p.target === job.target,
              );
              if (!point)
                throw Error("Der Spülpunkt passt nicht zum offenen Auftrag.");
              currentList = list;
              flushModal(point);
            } else if (action === "recover") {
              const receipt = await api(
                `/measurement-receipts/${ble.job.requestId}`,
              );
              ble.markSaved(receipt);
              toast(
                "Messung auf dem Server gefunden. Bitte den ESP32-Empfang bestätigen.",
              );
              await render();
            } else if (action === "ack") {
              const receipt = await api(`/flushes/${ble.job.savedId}/receipt`);
              await ble.acknowledge(receipt);
              toast(
                "ESP32-Empfang bestätigt. Das Gerät kann den nächsten Auftrag annehmen.",
              );
              await render();
            } else if (action === "abandon") {
              if (
                window.confirm(
                  "Lokalen Auftrag verwerfen? Das sendet keinen Abbruch- oder Löschbefehl an den ESP32. Gerätedaten bleiben erhalten.",
                )
              ) {
                ble.abandon();
                if (context) {
                  context.imported = false;
                  context.seenRequest = null;
                }
              }
            }
          } catch (error) {
            ble.error = error.message;
          }
          updateBlePanels();
          syncBleForm();
        }),
    );
  });
}
function syncBleForm() {
  const context = activeBleForm;
  if (!context || !modal.open) return;
  const linked = ble.matches(context.point, context.runId);
  if (linked && context.seenRequest !== ble.job.requestId) {
    context.seenRequest = ble.job.requestId;
    context.imported = false;
    for (const key of ["volume", "temperature_before", "temperature_after"])
      document.querySelector("#f-" + key).value = "";
  }
  for (const key of ["volume", "temperature_before", "temperature_after"])
    document.querySelector("#f-" + key).readOnly = !!(
      linked || context.imported
    );
  const submit = modal.querySelector("[type=submit]");
  if (submit)
    submit.disabled = !!(
      ble.busy ||
      context.serverSaving ||
      context.serverSaved ||
      (linked && !context.imported)
    );
}
function bindActions(root = app) {
  root.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = async (event) => {
        if (event.target.closest("[data-action]") !== b) return;
        try {
          const action = b.dataset.action,
            p = points.find((x) => x.id === Number(b.dataset.id));
          if (action === "menu") {
            document.querySelector(".sidebar").classList.toggle("open");
            document.querySelector(".menu-backdrop").classList.toggle("open");
          } else if (action === "logout") {
            await send("/logout", {});
            ++loadVersion;
            user = null;
            csrf = null;
            renderAuth();
          } else if (action === "new-list") listModal();
          else if (action === "edit-list") listModal(true);
          else if (action === "go-lists") location.hash = "#/lists";
          else if (action === "new-point") pointModal();
          else if (action === "select-point") {
            if (canDocument() && !p.completed) flushModal(p);
            else await pointDetail(p);
          } else if (action === "point-detail") await pointDetail(p);
          else if (action === "flush") flushModal(p);
          else if (action === "assign") await assignModal();
          else if (action === "restart") await assignModal(true);
          else if (action === "publish") publishModal();
          else if (action === "delete-list") deleteListModal();
          else if (action === "ack-notes") {
            await send("/internal-notes/acknowledge", {
              ids: b.dataset.ids.split(",").map(Number),
            });
            toast(
              "Bemerkungen quittiert. Der Spülpunkt wurde aus den offenen Hinweisen entfernt.",
            );
            await render();
          } else if (action === "reset-password")
            resetPasswordModal(
              users.find((u) => u.id === Number(b.dataset.id)),
            );
          else if (action === "new-user") userModal();
          else if (action === "edit-user")
            userModal(users.find((u) => u.id === Number(b.dataset.id)));
          else if (action === "list-reports")
            location.hash =
              "#/reports?list=" + currentList.id + "&run=" + currentList.run_id;
          else if (action === "delete-record")
            deleteRecordModal(
              flushes.find((f) => f.id === Number(b.dataset.id)),
            );
          else if (action === "delete-run") deleteRunModal();
          else if (action === "settings") settingsModal();
          else if (action === "new-flow") newFlowModal();
          else if (action === "edit-flow") editFlowModal();
          else if (action === "delete-flow") deleteFlowModal();
          else if (action === "print") window.print();
        } catch (err) {
          toast(err.message);
        }
      }),
  );
}
app.addEventListener("keydown", (event) => {
  const row = event.target.closest('tr[data-action="select-point"]');
  if (row && event.target === row && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    row.click();
  }
});
window.addEventListener("hashchange", () => {
  if (modal.open) modal.close();
  render();
});
async function init() {
  try {
    status = await api("/status");
    try {
      const me = await api("/me");
      user = me.user;
      csrf = me.csrf;
    } catch {}
    await render();
  } catch (e) {
    app.innerHTML = `<div class="error-page"><h1>SpülPilot ist gerade nicht erreichbar.</h1><p>${esc(e.message)}</p><p>Bitte lade die Seite erneut.</p></div>`;
  }
}
init();
