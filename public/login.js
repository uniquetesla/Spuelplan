const icons = {
  drop: '<path d="M12 3s-6.5 7.1-6.5 11.2a6.5 6.5 0 0 0 13 0C18.5 10.1 12 3 12 3Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
};
const icon = (name, cls = "") =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}">${icons[name] || icons.drop}</svg>`;
const app = document.querySelector("#app");
let status;
async function send(path, body) {
  const response = await fetch("/api" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Anmeldung fehlgeschlagen.");
  return data;
}
function brand() {
  return `<div class="brand"><span class="brand-icon">${icon("drop")}</span><span>SpülPilot<small>Stadtwerke Heppenheim</small></span></div>`;
}
function renderAuth() {
  app.innerHTML = `<div class="auth faucet-auth"><section class="auth-art">${brand()}<div class="faucet-intro"><span class="login-role">Dein Zugang zum Wassernetz</span><button class="faucet-toggle" id="faucet-toggle" type="button" aria-expanded="false" aria-controls="login-panel" aria-label="Wasserhahn öffnen und Anmeldung anzeigen"><svg class="faucet-drawing" viewBox="0 0 280 260" fill="none" aria-hidden="true"><defs><linearGradient id="tap-metal" x1="55" y1="60" x2="210" y2="200" gradientUnits="userSpaceOnUse"><stop stop-color="#eef5ff"/><stop offset=".45" stop-color="#9aaed2"/><stop offset="1" stop-color="#526786"/></linearGradient><linearGradient id="tap-water" x1="202" y1="157" x2="202" y2="246" gradientUnits="userSpaceOnUse"><stop stop-color="#a7f3ff"/><stop offset="1" stop-color="#5bafff" stop-opacity="0"/></linearGradient></defs><ellipse class="faucet-pool" cx="202" cy="245" rx="34" ry="7"/><g class="faucet-handle"><path d="M140 62V91" stroke="url(#tap-metal)" stroke-width="12" stroke-linecap="round"/><path d="M106 61H174" stroke="url(#tap-metal)" stroke-width="12" stroke-linecap="round"/><circle cx="140" cy="61" r="9" fill="#c5c4ff"/></g><path d="M49 113H117V100H163V113H179C203 113 218 129 218 151V165H188V151C188 145 185 143 178 143H163V154H117V143H49Z" fill="url(#tap-metal)" stroke="#d4e5ff" stroke-opacity=".5" stroke-width="2"/><path d="M51 104V153" stroke="url(#tap-metal)" stroke-width="14" stroke-linecap="round"/><path d="M190 165H216" stroke="#dcecff" stroke-width="5" stroke-linecap="round"/><path class="faucet-stream" d="M202 171V239" stroke="url(#tap-water)" stroke-width="17" stroke-linecap="round"/><g class="faucet-drops" stroke="#b7f3ff" stroke-width="3" stroke-linecap="round"><path d="M198 181V191M207 204V214M197 227V233"/></g></svg><span class="faucet-switch-label">Wasserhahn öffnen</span><span class="faucet-switch-hint">Antippen, um dich anzumelden</span></button><h1>Ein Dreh.<br>Alles im Fluss.</h1><p>Das interne Spülmanagement der Stadtwerke Heppenheim.</p></div><div class="auth-art-foot">Nur für berechtigte Personen · Interner, geschützter Arbeitsbereich</div></section><section class="auth-right" id="login-panel" hidden><form class="auth-form" id="auth-form"><div class="login-role">${status.setupRequired ? "Erste Schritte" : "Dein digitaler SpülPilot"}</div><h2>${status.setupRequired ? "Willkommen an Bord." : "Schön, dass du da bist."}</h2><p>${status.setupRequired ? "Richte dein Administrationskonto ein, um Spüllisten und dein Team zu verwalten." : "Melde dich an und bring dein Wassernetz in Bewegung."}</p><div class="form-error" id="auth-error" role="alert"></div>${status.setupRequired ? '<div class="field"><label for="setup-token">Einrichtungsschlüssel</label><input id="setup-token" name="setup_token" type="password" required autocomplete="off"><small>Auf dem Server in data/setup-token hinterlegt.</small></div><div class="field"><label for="name">Dein Name</label><input id="name" name="name" required maxlength="100" autocomplete="name" placeholder="Vor- und Nachname"></div>' : ""}<div class="field"><label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" required autocomplete="username" maxlength="200" placeholder="name@unternehmen.de"></div><div class="field"><label for="password">Passwort</label><input id="password" name="password" type="password" required ${status.setupRequired ? 'minlength="12"' : ""} maxlength="128" autocomplete="${status.setupRequired ? "new-password" : "current-password"}" placeholder="${status.setupRequired ? "Mindestens 12 Zeichen" : "Dein Passwort"}"></div><button class="button" type="submit">${status.setupRequired ? "Administrationskonto erstellen" : "Anmelden"}${icon("arrow")}</button><div class="auth-security">${icon("lock")}Nur für berechtigte Personen · Keine öffentliche Registrierung</div></form></section></div>`;
  const faucet = document.querySelector("#faucet-toggle");
  const loginPanel = document.querySelector("#login-panel");
  faucet.onclick = () => {
    const open = faucet.getAttribute("aria-expanded") !== "true";
    faucet.setAttribute("aria-expanded", String(open));
    faucet.setAttribute(
      "aria-label",
      open
        ? "Wasserhahn schließen und Anmeldung ausblenden"
        : "Wasserhahn öffnen und Anmeldung anzeigen",
    );
    faucet.querySelector(".faucet-switch-label").textContent = open
      ? "Wasserhahn schließen"
      : "Wasserhahn öffnen";
    faucet.querySelector(".faucet-switch-hint").textContent = open
      ? "Deine Anmeldung ist bereit"
      : "Antippen, um dich anzumelden";
    loginPanel.hidden = !open;
    document
      .querySelector(".faucet-auth")
      .classList.toggle("faucet-open", open);
    if (open) loginPanel.querySelector("input").focus({ preventScroll: true });
  };
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
      await send("/login", {
        email: data.email,
        password: data.password,
      });
      location.hash = "#/overview";
      location.reload();
    } catch (err) {
      document.querySelector("#auth-error").textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };
}

try {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error();
  status = await response.json();
  renderAuth();
} catch {
  app.textContent =
    "SpülPilot ist gerade nicht erreichbar. Bitte lade die Seite erneut.";
}
