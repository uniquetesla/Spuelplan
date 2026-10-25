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
  users = [],
  points = [],
  currentList,
  status,
  loadVersion = 0;
const app = document.querySelector("#app"),
  modal = document.querySelector("#modal");
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
  app.innerHTML = `<div class="auth"><section class="auth-art">${brand()}<div class="auth-art-main">${icon("drop", "big-drop")}<h1>Unser Wassernetz.<br>Gemeinsam im Blick.</h1><p>Das interne Spülmanagement der Stadtwerke Heppenheim. Ausschließlich für berechtigte Beschäftigte und freigegebene Betrachter.</p></div><div class="auth-art-foot">Stadtwerke Heppenheim · Interner, geschützter Arbeitsbereich</div></section><section class="auth-right"><form class="auth-form" id="auth-form"><div class="login-role">${status.setupRequired ? "Erste Schritte" : "Dein digitaler SpülPilot"}</div><h2>${status.setupRequired ? "Willkommen an Bord." : "Schön, dass du da bist."}</h2><p>${status.setupRequired ? "Richte dein Administrationskonto ein, um Spüllisten und dein Team zu verwalten." : "Melde dich an und bring dein Wassernetz in Bewegung."}</p><div class="form-error" id="auth-error" role="alert"></div>${status.setupRequired ? '<div class="field"><label for="setup-token">Einrichtungsschlüssel</label><input id="setup-token" name="setup_token" type="password" required autocomplete="off"><small>Auf dem Server in data/setup-token hinterlegt.</small></div><div class="field"><label for="name">Dein Name</label><input id="name" name="name" required maxlength="100" autocomplete="name" placeholder="Vor- und Nachname"></div>' : ""}<div class="field"><label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" required autocomplete="username" maxlength="200" placeholder="name@unternehmen.de"></div><div class="field"><label for="password">Passwort</label><input id="password" name="password" type="password" required ${status.setupRequired ? 'minlength="12"' : ""} maxlength="128" autocomplete="${status.setupRequired ? "new-password" : "current-password"}" placeholder="${status.setupRequired ? "Mindestens 12 Zeichen" : "Dein Passwort"}"></div><button class="button" type="submit">${status.setupRequired ? "Administrationskonto erstellen" : "Anmelden"}${icon("arrow")}</button><div class="auth-security">${icon("lock")}Nur für berechtigte Personen · Keine öffentliche Registrierung</div>${status.demo && !status.setupRequired ? '<div class="auth-demo"><strong>Demo mit Beispieldaten</strong><br>Wähle eine Rolle. Das Demo-Passwort wurde beim Start festgelegt.<div><button type="button" data-demo="admin@spuelplan.local">Administration</button><button type="button" data-demo="lena@spuelplan.local">Mitarbeiter</button><button type="button" data-demo="betrachter@spuelplan.local">Betrachter</button></div></div>' : ""}</form></section></div>`;
  document.querySelectorAll("[data-demo]").forEach(
    (b) =>
      (b.onclick = () => {
        document.querySelector("#email").value = b.dataset.demo;
        document.querySelector("#password").focus();
      }),
  );
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
  ...(isAdmin() ? [["users", "Team & Zugänge", "users"]] : []),
  ...(user.role !== "viewer"
    ? [["devices", "Geräte & Sensoren", "bluetooth"]]
    : []),
  ["account", "Mein Passwort", "lock"],
];
function layout(content, section) {
  const nav = navItems();
  app.innerHTML = `<div class="shell"><div class="menu-backdrop" data-action="menu"></div><aside class="sidebar">${brand()}<div class="nav-label">Arbeitsbereich</div><nav class="nav" aria-label="Hauptnavigation">${nav.map(([id, label, ic]) => `<a href="#/${id}" class="${section === id ? "active" : ""}" ${section === id ? 'aria-current="page"' : ""}>${icon(ic)}${label}${id === "lists" ? `<span class="count">${lists.length}</span>` : ""}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="water-note">${icon("wave")}<h4>Jeder Tropfen zählt.</h4><p>Spülmanagement für das Trinkwassernetz der Stadtwerke Heppenheim.</p></div><div class="user"><div class="avatar">${esc(initials(user.name))}</div><div><strong>${esc(user.name)}</strong><small>${roleName[user.role]}</small></div><button class="logout" data-action="logout" title="Abmelden" aria-label="Abmelden">${icon("logout")}</button></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumbs"><button class="mobile-menu" data-action="menu" aria-label="Menü öffnen">${icon("menu")}</button>Arbeitsbereich ${icon("chevron")} <strong>${nav.find((x) => x[0] === section)?.[1] || "Spüllisten"}</strong></div><div class="top-right"><span class="system"><i class="dot"></i>Mit Datenbank verbunden</span><span class="top-date">${new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span><div class="avatar">${esc(initials(user.name))}</div></div></header><div class="content">${status.demo ? '<div class="demo-notice">Demo-Umgebung · Alle Spülpunkte, Personen und Messwerte sind Beispieldaten.</div>' : ""}${content}<footer class="footer"><span>© ${new Date().getFullYear()} SpülPilot · Stadtwerke Heppenheim</span><span>${icon("shield")}Zugriff geschützt · ${roleName[user.role]}</span></footer></div></main></div>`;
  bindActions();
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
  active: "In Bearbeitung",
  review: "Zur Prüfung",
  published: "Für Betrachter freigegeben",
};
const statusBadge = (l) =>
  `<span class="badge ${l.status === "review" ? "amber" : l.status === "published" ? "green" : "blue"}">${statusName[l.status]}</span>`;
function listCard(l) {
  const completed = l.completed_count,
    total = l.point_count;
  return `<a class="list-card" href="#/lists/${l.id}"><div class="list-card-top"><div class="folder">${icon("folder")}</div>${statusBadge(l)}</div><h3>${esc(l.name)}</h3><p class="description">${esc(l.description || "Deine Spülpunkte an einem Ort")}</p><div class="progress-label"><span>Durchgang ${l.run_number} · Bearbeitet</span><strong>${completed} / ${total}</strong></div><div class="segments">${Array.from({ length: Math.min(total || 1, 25) }, (_, i) => `<i class="${i < Math.round((completed / (total || 1)) * Math.min(total || 1, 25)) ? "done" : ""}"></i>`).join("")}</div><div class="card-bottom"><span class="person-chip">${l.assignees.length ? `<span class="avatar">${esc(initials(l.assignees[0].name))}</span>${esc(l.assignees[0].name)}${l.assignees.length > 1 ? ` +${l.assignees.length - 1}` : ""}` : `${icon("users")}Noch nicht freigegeben`}</span>${icon("arrow")}</div></a>`;
}
function overview() {
  const total = lists.reduce((s, l) => s + l.point_count, 0),
    done = lists.reduce((s, l) => s + l.completed_count, 0),
    volume = flushes.reduce((s, f) => s + f.volume, 0);
  return (
    heading(
      "Übersicht",
      "Alles im Fluss. Hier findest du deine Spüllisten und die letzten Aktivitäten.",
      isAdmin()
        ? button("Neue Spülliste", "new-list")
        : button("Zu meinen Spüllisten", "go-lists", "folder"),
    ) +
    `${isAdmin() && lists.some((l) => l.status === "review") ? `<div class="notice review-notice">${icon("circlecheck")}<span><strong>${lists.filter((l) => l.status === "review").length} abgeschlossene Spülliste(n) warten auf deine Prüfung.</strong><br>Öffne die Liste, prüfe die Protokolle und speichere den Durchgang für Betrachter.</span></div>` : ""}<section class="hero"><div class="hero-copy"><div class="hero-kicker">${icon("wave")}Für ein sauberes Trinkwassernetz</div><h2>Klare Planung. Sauberes Wasser.</h2><p>Behalte deine Spülpunkte im Blick und dokumentiere jede Spülung. Einfach, strukturiert und zuverlässig.</p></div><div class="hero-symbol">${icon("drop")}</div></section><div class="stats">${stat("Spülpunkte gesamt", total, "", `In ${lists.length} Spüllisten organisiert`, "pin")}${stat("Spülpunkte dokumentiert", done, "", `<span class="green">${total ? Math.round((done / total) * 100) : 0} %</span> im aktuellen Durchgang bearbeitet`, "circlecheck")}${stat("Ohne Spülprotokoll", total - done, "", "Im aktuellen Durchgang noch offen", "clock")}${stat("Gespülte Menge", number(volume), "m³", `Aus ${flushes.length} dokumentierten Spülungen`, "drop")}</div><div class="section-head"><div><h2>${user.role === "employee" ? "Meine Spüllisten" : "Deine Spüllisten"}</h2><p>Eine Liste. Alle Spülpunkte. Alles im Blick.</p></div><a href="#/lists" class="text-link">Alle Listen ansehen ${icon("arrow")}</a></div><div class="list-grid">${lists.slice(0, 3).map(listCard).join("") || empty("Dein Wassernetz beginnt hier", isAdmin() ? "Lege deine erste Spülliste an und füge Spülpunkte hinzu." : "Hier erscheinen die für dich verfügbaren Spüllisten.", isAdmin() ? button("Erste Spülliste anlegen", "new-list") : "")}</div><section class="panel"><div class="panel-head"><div><h2>Letzte Spülungen</h2><p>Die neuesten Einträge aus deinem Wassernetz</p></div><a href="#/reports" class="text-link">Alle Protokolle ${icon("arrow")}</a></div>${reportTable(flushes.slice(0, 5), true)}</section>`
  );
}
function reportTable(rows, compact = false) {
  if (!rows.length)
    return empty(
      "Noch keine Spülungen",
      "Sobald eine Spülung dokumentiert wird, findest du hier das Protokoll.",
    );
  return `<div class="table-wrap"><table><thead><tr><th>Spülpunkt ID</th><th>Adresse</th>${compact ? "" : "<th>Soll m³</th>"}<th>Ist m³</th>${compact ? "" : "<th>Temp. vorher</th><th>Temp. nachher</th>"}<th>Trübung</th><th>Mitarbeiter</th><th>Datum</th></tr></thead><tbody>${rows.map((f) => `<tr><td><span class="point-id">${esc(f.code)}</span><span class="sub">Durchgang ${f.run_number}</span></td><td><strong>${esc(f.address)}</strong>${compact ? `<span class="sub">${esc(f.list_name)}</span>` : ""}</td>${compact ? "" : `<td>${number(f.target)}</td>`}<td><strong>${number(f.volume)}${compact ? " m³" : ""}</strong></td>${compact ? "" : `<td>${number(f.temperature_before)} °C</td><td>${number(f.temperature_after)} °C</td>`}<td><span class="badge ${f.turbidity ? "amber" : "green"}">${f.turbidity ? "Ja" : "Nein"}</span></td><td>${esc(f.employee)}</td><td>${date(f.flushed_at)}</td></tr>`).join("")}</tbody></table></div>`;
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
    `<div class="lifecycle-strip">${statusBadge(l)}<span>Durchgang ${l.run_number}</span><span>${l.published_count} gespeicherte Durchgänge</span></div><div class="detail-strip"><div><small>Spülpunkte</small><strong>${l.point_count} angelegt</strong></div><div><small>Dokumentiert</small><strong>${l.completed_count} von ${l.point_count} Punkten</strong></div><div><small>Freigegeben für</small><strong>${esc(l.assignees.map((a) => a.name).join(", ") || "Noch keine Personen")}</strong></div><div><small>Letzte Spülung</small><strong>${date(l.last_flush)}</strong></div></div><div class="section-head"><div><h2>Spülpunkte</h2><p>Wähle einen Punkt für Details${canDocument() ? " und die nächste Spülung" : ""}.</p></div>${isAdmin() ? `<div class="actions">${l.status === "active" ? `<button class="text-link" data-action="edit-list">${icon("edit")}Liste bearbeiten</button>` : ""}<button class="text-link" data-action="list-reports">${icon("file")}Protokolle</button><button class="text-link delete-link" data-action="delete-list">${icon("close")}Löschen</button></div>` : ""}</div><div class="toolbar"><div class="search">${icon("search")}<input id="point-search" type="search" placeholder="ID oder Adresse suchen …" aria-label="Spülpunkte suchen"></div></div><section class="panel" id="points-results">${pointTable(points)}</section><div class="notice">${icon("info")}<span>${l.status === "active" ? "Jeder Punkt wird einmal pro Durchgang bearbeitet. Nach dem letzten offenen Punkt geht die Liste automatisch zur Prüfung an die Administration und verschwindet bei den Mitarbeitern." : l.status === "review" ? "Dieser Durchgang ist abgeschlossen. Die Administration prüft und speichert ihn und gibt ihn anschließend für Betrachter frei." : "Dieser Durchgang ist gespeichert und für Betrachter freigegeben. Ein neuer Durchgang beginnt wieder mit offenen Punkten; gespeicherte Ergebnisse bleiben erhalten."}</span></div>`
  );
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
  return `<div class="table-wrap"><table><thead><tr><th>Spülpunkt ID</th><th>Adresse</th><th>Sollmenge</th><th>Letzte Spülung</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr><td><span class="point-id">${esc(p.code)}</span></td><td><strong>${esc(p.address)}</strong></td><td>${number(p.target)} m³</td><td>${p.last_flush ? date(p.last_flush) : "—"}</td><td><span class="badge ${p.completed ? "green" : ""}">${p.completed ? "Bearbeitet" : "Noch offen"}</span></td><td><div class="actions">${canDocument() && !p.completed ? `<button class="table-action" data-action="flush" data-id="${p.id}">Spülung erfassen ${icon("arrow")}</button>` : ""}${isAdmin() || user.role === "viewer" ? `<button class="table-action" data-action="point-detail" data-id="${p.id}">${isAdmin() && currentList.status === "active" && !p.completed ? "Bearbeiten" : "Details"}${icon(isAdmin() ? "edit" : "chevron")}</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>`;
}
function reportsPage() {
  const selected =
    new URLSearchParams(location.hash.split("?")[1] || "").get("list") || "";
  const filtered = selected
    ? flushes.filter((f) => String(f.list_id) === selected)
    : flushes;
  return (
    heading(
      "Spülprotokolle",
      "Alle Messwerte nachvollziehbar dokumentiert und bereit für den Ausdruck.",
      button("Liste drucken", "print", "print", true),
      "DOKUMENTATION & NACHWEISE",
    ) +
    `<div class="print-heading"><h1>Spülprotokoll${selected ? " · " + esc(lists.find((l) => String(l.id) === selected)?.name || "") : ""}</h1><p>Erstellt am ${date(new Date().toISOString())} · ${esc(user.name)} · ${filtered.length} Spülungen</p></div><div class="toolbar"><div class="search">${icon("search")}<input id="report-search" type="search" placeholder="ID, Adresse oder Mitarbeiter suchen …" aria-label="Protokolle suchen"></div><select id="report-list" aria-label="Spülliste filtern"><option value="">Alle Spüllisten</option>${lists.map((l) => `<option value="${l.id}" ${String(l.id) === selected ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select><select id="report-run" aria-label="Durchgang filtern"><option value="">Alle Durchgänge</option>${[...new Map(flushes.map((f) => [f.run_id, f])).values()].map((f) => `<option value="${f.run_id}">${esc(f.list_name)} · Durchgang ${f.run_number}</option>`).join("")}</select></div><section class="panel" id="report-results">${reportTable(filtered)}</section>`
  );
}
function usersPage() {
  return (
    heading(
      "Team & Zugänge",
      "Verwalte dein Team und lege fest, wer was sehen und bearbeiten darf.",
      button("Benutzer anlegen", "new-user", "plus"),
      "GEMEINSAM IM EINSATZ",
    ) +
    `<div class="notice">${icon("shield")}<span><strong>Administration</strong> verwaltet Listen, Spülpunkte und Benutzer. <strong>Administration und Mitarbeiter</strong> dokumentieren Spülungen in ihren freigegebenen Listen. <strong>Betrachter</strong> lesen und drucken Protokolle.</span></div><section class="panel"><div class="panel-head"><div><h2>Dein Team</h2><p>${users.length} Benutzerkonten</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>E-Mail-Adresse</th><th>Rolle</th><th>Status</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong>${u.id === user.id ? '<span class="sub">Dein Konto</span>' : ""}</td><td>${esc(u.email)}</td><td><span class="badge ${u.role === "admin" ? "blue" : ""}">${roleName[u.role]}</span></td><td><span class="badge ${u.active ? "green" : ""}">${u.active ? "Aktiv" : "Deaktiviert"}</span>${u.must_change_password ? '<span class="sub">Passwortwechsel erforderlich</span>' : ""}</td><td><div class="actions"><button class="table-action" data-action="edit-user" data-id="${u.id}">Bearbeiten ${icon("edit")}</button>${u.active && u.id !== user.id ? `<button class="table-action" data-action="reset-password" data-id="${u.id}">Einmalpasswort erstellen ${icon("lock")}</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div></section>`
  );
}
function devicesPage() {
  return (
    heading(
      "Geräte & Sensoren",
      "Die nächste Verbindung für deinen SpülPilot.",
      "",
      "EIN BLICK NACH VORN",
    ) +
    `<div class="device-card"><div class="device-icon">${icon("bluetooth")}</div><div><span class="badge blue">Geplanter ESP32-Ablauf</span><h2>Vom Spülpunkt zum Messprotokoll.</h2><p>Der ESP32 bleibt während des Spülvorgangs per Bluetooth mit dem Smartphone verbunden. Der vorgesehene Ablauf:</p><ol class="device-flow"><li><strong>Spülpunkt auswählen.</strong> Eine freigegebene Person aus Administration oder Mitarbeitern wählt den Punkt bei bestehender Bluetooth-Verbindung aus.</li><li><strong>Auftrag übertragen.</strong> Spülpunkt-ID und Sollmenge in m³ werden an den ESP32 gesendet und vom Gerät bestätigt.</li><li><strong>Temperatur vorher messen.</strong> Sobald erstmals mindestens 1 m³/h Durchfluss erreicht werden, startet eine Wartezeit von 5 Sekunden. Danach wird die Temperatur vorher erfasst.</li><li><strong>Sollmenge erreichen.</strong> Die gespülte Menge wird ab Beginn dieses Auftrags gezählt. Beim Erreichen oder Überschreiten der Sollmenge wird die Temperatur nachher automatisch erfasst.</li><li><strong>Spüldaten übernehmen.</strong> Temperaturen und tatsächlich gespülte Menge werden dem ausgewählten Punkt zugeordnet. Trübung wird weiterhin mit Ja oder Nein angegeben; das Protokoll zeigt ausschließlich das Datum.</li></ol><div class="notice">${icon("info")}Bluetooth ist noch nicht implementiert. BLE-Serviceprofil und Firmware müssen diesen Ablauf unterstützen. Fehlende Messwerte oder eine unterbrochene Verbindung dürfen kein vollständiges Protokoll erzeugen. Web Bluetooth benötigt HTTPS und einen unterstützten Browser; iOS Safari unterstützt es derzeit nicht.</div></div></div>`
  );
}
async function render() {
  if (!user) return renderAuth();
  if (user.must_change_password) return renderPasswordRequired();
  const version = ++loadVersion;
  try {
    const [ls, fs] = await Promise.all([api("/lists"), api("/flushes")]);
    if (version !== loadVersion) return;
    lists = ls;
    flushes = fs;
    const [path] = location.hash.slice(2).split("?"),
      parts = (path || "overview").split("/");
    const section = parts[0];
    if (section === "account") {
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
      currentList = lists.find((l) => l.id === Number(parts[1]));
      points = currentList ? await api(`/lists/${currentList.id}/points`) : [];
      if (version !== loadVersion) return;
      layout(listDetail(), "lists");
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
      const filter = () => {
        const id = document.querySelector("#report-list").value,
          q = document.querySelector("#report-search").value.toLowerCase();
        const rows = flushes.filter(
          (f) =>
            (!id || String(f.list_id) === id) &&
            (!document.querySelector("#report-run").value ||
              String(f.run_id) ===
                document.querySelector("#report-run").value) &&
            `${f.code} ${f.address} ${f.employee}`.toLowerCase().includes(q),
        );
        document.querySelector("#report-results").innerHTML = reportTable(rows);
        document.querySelector(".print-heading p").textContent =
          `Erstellt am ${date(new Date().toISOString())} · ${user.name} · ${rows.length} Spülungen${document.querySelector("#report-run").selectedIndex > 0 ? " · " + document.querySelector("#report-run").selectedOptions[0].textContent : ""}${q ? " · Suche: " + q : ""}`;
        document.querySelector(".print-heading h1").textContent =
          "Spülprotokoll" +
          (id ? " · " + lists.find((l) => String(l.id) === id)?.name : "");
      };
      document.querySelector("#report-search").oninput = filter;
      document.querySelector("#report-list").onchange = () => {
        document.querySelector("#report-run").value = "";
        filter();
      };
      document.querySelector("#report-run").onchange = filter;
      filter();
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
      `<div class="field"><label for="f-list_id">Spülliste</label><select id="f-list_id" name="list_id">${lists.map((l) => `<option value="${l.id}" ${l.id === (p?.list_id || currentList?.id) ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>`,
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
    `<p class="subtitle modal-intro">${restart ? "Der gespeicherte Durchgang bleibt unverändert für Betrachter erhalten. Alle Punkte werden im neuen Durchgang wieder offen. " : ""}Administration und Mitarbeiter können für diese Liste freigegeben werden. Betrachter sehen nur gespeicherte und freigegebene Durchgänge.</p>${eligibleUsers.map((u) => `<label class="checkbox-row"><input type="checkbox" name="assignee" value="${u.id}" ${currentList.assignees.some((a) => a.id === u.id) ? "checked" : ""}><span><strong>${esc(u.name)}</strong><small>${esc(u.email)} · ${roleName[u.role]}</small></span></label>`).join("") || '<div class="notice">Es sind keine aktiven Benutzer aus Administration oder Mitarbeitern verfügbar.</div>'}`,
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
function flushModal(p) {
  showModal(
    "Spülung dokumentieren",
    esc(p.code) + " · " + esc(p.address),
    `<div class="measure-box">${icon("drop")}<div><strong>Geplante Spülmenge</strong><small>${esc(currentList.name)}</small></div><b>${number(p.target)} <small>m³</small></b></div><div class="form-row">${field("Temperatur vorher · °C", "temperature_before", "", "number", 'required min="0" max="100" step="0.1" placeholder="22,0"')}${field("Temperatur nachher · °C", "temperature_after", "", "number", 'required min="0" max="100" step="0.1" placeholder="14,0"')}</div>${field("Tatsächlich gespülte Menge · m³", "volume", "", "number", 'required min="0.001" max="1000000" step="any" placeholder="z. B. 2,6"')}<div class="field"><label for="f-turbidity">Trübung festgestellt?</label><select id="f-turbidity" name="turbidity" required><option value="">Bitte auswählen</option><option value="false">Nein – keine Trübung</option><option value="true">Ja – Trübung vorhanden</option></select></div><div class="notice">${icon("clock")}<span>Das Spüldatum wird beim Speichern automatisch eingetragen.<br>Mitarbeiter: <strong>${esc(user.name)}</strong><br>Das Protokoll bleibt als unveränderlicher Nachweis erhalten.</span></div>`,
    async (data) => {
      const result = await send(`/points/${p.id}/flushes`, {
        temperature_before: Number(data.temperature_before),
        temperature_after: Number(data.temperature_after),
        volume: Number(data.volume),
        turbidity: data.turbidity === "true",
      });
      if (result.status === "review") {
        location.hash = "#/lists";
        toast(
          "Alle Punkte bearbeitet. Die Liste wurde der Administration zur Prüfung übergeben.",
        );
      } else toast("Spülung erfolgreich dokumentiert.");
    },
    "Spülung speichern",
  );
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
function bindActions(root = app) {
  root.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = async () => {
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
          else if (action === "point-detail") await pointDetail(p);
          else if (action === "flush") flushModal(p);
          else if (action === "assign") await assignModal();
          else if (action === "restart") await assignModal(true);
          else if (action === "publish") publishModal();
          else if (action === "delete-list") deleteListModal();
          else if (action === "reset-password")
            resetPasswordModal(
              users.find((u) => u.id === Number(b.dataset.id)),
            );
          else if (action === "new-user") userModal();
          else if (action === "edit-user")
            userModal(users.find((u) => u.id === Number(b.dataset.id)));
          else if (action === "list-reports")
            location.hash = "#/reports?list=" + currentList.id;
          else if (action === "print") window.print();
        } catch (err) {
          toast(err.message);
        }
      }),
  );
}
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
