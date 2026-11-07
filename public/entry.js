// Public entry loads business modules only after the server confirms a session.
try {
  const response = await fetch("/api/me", { cache: "no-store" });
  if (response.ok) await import("./app.js");
  else if (response.status === 401) await import("./login.js");
  else throw new Error();
} catch {
  document.querySelector("#app").textContent =
    "SpülPilot ist gerade nicht erreichbar. Bitte lade die Seite erneut.";
}
