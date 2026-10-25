import express from "express";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || resolve(root, "data/spuelplan.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','employee','viewer')),active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS lists(id INTEGER PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assignments(list_id INTEGER REFERENCES lists(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(list_id,user_id));
CREATE TABLE IF NOT EXISTS points(id INTEGER PRIMARY KEY,list_id INTEGER NOT NULL REFERENCES lists(id),code TEXT UNIQUE NOT NULL,address TEXT NOT NULL,target REAL NOT NULL CHECK(target>0),active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS flushes(id INTEGER PRIMARY KEY,point_id INTEGER NOT NULL REFERENCES points(id),user_id INTEGER NOT NULL REFERENCES users(id),temperature_before REAL NOT NULL,temperature_after REAL NOT NULL,volume REAL NOT NULL CHECK(volume>0),turbidity INTEGER NOT NULL CHECK(turbidity IN(0,1)),flushed_at TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',code_snapshot TEXT NOT NULL,address_snapshot TEXT NOT NULL,target_snapshot REAL NOT NULL,employee_snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS points_list_idx ON points(list_id);
CREATE INDEX IF NOT EXISTS flushes_point_time_idx ON flushes(point_id,flushed_at DESC);
CREATE INDEX IF NOT EXISTS assignments_user_idx ON assignments(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires);
`);
const setupTokenPath = resolve(dirname(dbPath), "setup-token");
if (!oneUserExists() && !existsSync(setupTokenPath))
  writeFileSync(setupTokenPath, randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
function oneUserExists() {
  return db.prepare("SELECT 1 FROM users LIMIT 1").get();
}
const hash = (password) => {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
};
const verify = (password, stored) => {
  const [salt, digest] = stored.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(digest, "hex"),
  );
};
const all = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const roles = ["admin", "employee", "viewer"];
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (process.env.COOKIE_SECURE === "true")
    res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use("/api", (req, res, next) => {
  req.body ??= {};
  next();
});
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("sp_session="))
    ?.slice(11);
  if (cookie) {
    const session = one(
      "SELECT s.*,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1",
      digest(cookie),
      Date.now(),
    );
    if (session) req.session = session;
  }
  next();
});
const fail = (res, status, message) =>
  res.status(status).json({ error: message });
const requireAuth = (req, res, next) =>
  req.session ? next() : fail(res, 401, "Bitte melde dich an.");
const admin = (req, res, next) =>
  req.session.role === "admin"
    ? next()
    : fail(res, 403, "Nur die Administration hat Zugriff.");
const text = (x, max = 200) =>
  typeof x === "string" && x.trim().length > 0 && x.trim().length <= max;
const validUser = (b) =>
  text(b.name, 100) &&
  text(b.email, 200) &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
  roles.includes(b.role);
const validPassword = (p) =>
  typeof p === "string" && p.length >= 12 && p.length <= 128;
const publicUser = (s) => ({
  id: s.user_id,
  name: s.name,
  email: s.email,
  role: s.role,
});
const canList = (s, id) =>
  s.role !== "employee" ||
  !!one(
    "SELECT 1 FROM assignments WHERE list_id=? AND user_id=?",
    id,
    s.user_id,
  );
const transaction = (fn) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};
// All writes must come from the application origin. Authenticated writes also require a session CSRF token.
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return fail(res, 403, "Anfrage ohne Herkunft abgelehnt.");
  let url;
  try {
    url = new URL(origin);
  } catch {
    return fail(res, 403, "Ungültige Herkunft.");
  }
  const expected =
    process.env.APP_ORIGIN || `${req.protocol}://${req.get("host")}`;
  if (url.origin !== expected)
    return fail(res, 403, "Fremde Herkunft abgelehnt.");
  if (req.session && req.headers["x-csrf-token"] !== req.session.csrf)
    return fail(res, 403, "Sicherheitstoken ungültig. Bitte neu laden.");
  next();
});
app.get("/api/status", (req, res) =>
  res.json({
    setupRequired: !one("SELECT 1 FROM users LIMIT 1"),
    demo: process.env.DEMO_MODE === "true",
  }),
);
app.post("/api/setup", (req, res) => {
  if (one("SELECT 1 FROM users LIMIT 1"))
    return fail(res, 409, "Die Einrichtung ist bereits abgeschlossen.");
  const supplied = req.body.setup_token;
  const expected = existsSync(setupTokenPath)
    ? readFileSync(setupTokenPath, "utf8").trim()
    : "";
  if (
    typeof supplied !== "string" ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !expected ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    return fail(
      res,
      403,
      "Einrichtungsschlüssel ungültig. Er steht in data/setup-token auf dem Server.",
    );
  const { name, email, password } = req.body;
  if (!validUser({ name, email, role: "admin" }) || !validPassword(password))
    return fail(
      res,
      400,
      "Name, gültige E-Mail und Passwort mit 12–128 Zeichen erforderlich.",
    );
  run(
    "INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)",
    name.trim(),
    email.trim().toLowerCase(),
    hash(password),
    "admin",
  );
  if (existsSync(setupTokenPath)) unlinkSync(setupTokenPath);
  res.status(201).json({ ok: true });
});
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  if (
    !text(email, 200) ||
    typeof password !== "string" ||
    password.length > 128
  )
    return fail(res, 400, "E-Mail und Passwort erforderlich.");
  const key = digest(`${req.socket.remoteAddress}:${email.toLowerCase()}`);
  const ipKey = digest(`ip:${req.socket.remoteAddress}`);
  for (const [k, limit] of [
    [key, 8],
    [ipKey, 50],
  ]) {
    const a = one("SELECT * FROM login_attempts WHERE key=?", k);
    if (a && a.expires > Date.now() && a.count >= limit)
      return fail(
        res,
        429,
        "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.",
      );
  }
  const u = one(
    "SELECT * FROM users WHERE email=? AND active=1",
    email.trim().toLowerCase(),
  );
  const dummy = "00000000000000000000000000000000:" + "00".repeat(64);
  const matches = verify(password, u?.password || dummy);
  if (!u || !matches) {
    for (const k of [key, ipKey])
      run(
        "INSERT INTO login_attempts(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END",
        k,
        Date.now() + 900000,
        Date.now(),
        Date.now(),
      );
    return fail(res, 401, "E-Mail oder Passwort ist falsch.");
  }
  run("DELETE FROM login_attempts WHERE key=?", key);
  const token = randomBytes(32).toString("hex"),
    csrf = randomBytes(24).toString("hex");
  run("DELETE FROM sessions WHERE expires<?", Date.now());
  run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(token),
    u.id,
    csrf,
    Date.now() + 8 * 3600000,
  );
  res.cookie("sp_session", token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "strict",
    maxAge: 8 * 3600000,
    path: "/",
  });
  res.json({
    user: { id: u.id, name: u.name, email: u.email, role: u.role },
    csrf,
  });
});
app.use("/api", requireAuth);
app.get("/api/me", (req, res) =>
  res.json({ user: publicUser(req.session), csrf: req.session.csrf }),
);
app.post("/api/logout", (req, res) => {
  run("DELETE FROM sessions WHERE token=?", req.session.token);
  res.clearCookie("sp_session", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/lists", (req, res) => {
  const lists = all(
    `SELECT l.*,(SELECT count(*) FROM points p WHERE p.list_id=l.id AND p.active=1) point_count,(SELECT count(DISTINCT f.point_id) FROM flushes f JOIN points p ON p.id=f.point_id WHERE p.list_id=l.id AND p.active=1) completed_count,(SELECT max(f.flushed_at) FROM flushes f JOIN points p ON p.id=f.point_id WHERE p.list_id=l.id) last_flush FROM lists l ${req.session.role === "employee" ? "WHERE l.id IN(SELECT list_id FROM assignments WHERE user_id=?)" : ""} ORDER BY l.id DESC`,
    ...(req.session.role === "employee" ? [req.session.user_id] : []),
  );
  res.json(
    lists.map((l) => ({
      ...l,
      assignees: all(
        "SELECT u.id,u.name FROM users u JOIN assignments a ON u.id=a.user_id WHERE a.list_id=? AND u.active=1",
        l.id,
      ),
    })),
  );
});
app.get("/api/lists/:id/points", (req, res) => {
  const id = Number(req.params.id);
  if (!canList(req.session, id))
    return fail(res, 403, "Diese Liste ist dir nicht freigegeben.");
  res.json(
    all(
      "SELECT p.*,(SELECT max(flushed_at) FROM flushes f WHERE f.point_id=p.id) last_flush,(SELECT volume FROM flushes f WHERE f.point_id=p.id ORDER BY f.flushed_at DESC,f.id DESC LIMIT 1) last_volume FROM points p WHERE list_id=? AND active=1 ORDER BY code",
      id,
    ),
  );
});
app.get("/api/flushes", (req, res) => {
  const filters = [],
    args = [];
  if (req.session.role === "employee") {
    filters.push(
      "p.list_id IN(SELECT list_id FROM assignments WHERE user_id=?)",
    );
    args.push(req.session.user_id);
  }
  if (req.query.list) {
    filters.push("p.list_id=?");
    args.push(Number(req.query.list));
  }
  if (req.query.point) {
    filters.push("f.point_id=?");
    args.push(Number(req.query.point));
  }
  res.json(
    all(
      `SELECT f.*,p.list_id,f.code_snapshot code,f.address_snapshot address,f.target_snapshot target,f.employee_snapshot employee,l.name list_name FROM flushes f JOIN points p ON p.id=f.point_id JOIN lists l ON l.id=p.list_id ${filters.length ? "WHERE " + filters.join(" AND ") : ""} ORDER BY f.flushed_at DESC,f.id DESC`,
      ...args,
    ),
  );
});
app.post("/api/points/:id/flushes", (req, res) => {
  if (req.session.role !== "employee")
    return fail(res, 403, "Nur Mitarbeiter können Spülungen dokumentieren.");
  const p = one(
    "SELECT * FROM points WHERE id=? AND active=1",
    Number(req.params.id),
  );
  if (!p) return fail(res, 404, "Spülpunkt nicht gefunden.");
  if (!canList(req.session, p.list_id))
    return fail(res, 403, "Diese Liste ist dir nicht freigegeben.");
  const b = req.body;
  for (const k of ["temperature_before", "temperature_after", "volume"])
    if (typeof b[k] !== "number" || !Number.isFinite(b[k]))
      return fail(res, 400, "Bitte alle Messwerte als Zahl eingeben.");
  if (
    b.temperature_before < 0 ||
    b.temperature_before > 100 ||
    b.temperature_after < 0 ||
    b.temperature_after > 100 ||
    b.volume <= 0 ||
    b.volume > 1000000 ||
    typeof b.turbidity !== "boolean"
  )
    return fail(
      res,
      400,
      "Temperaturen: 0–100 °C; Menge: größer 0 bis 1.000.000 m³; Trübung: Ja oder Nein.",
    );
  const result = run(
    "INSERT INTO flushes(point_id,user_id,temperature_before,temperature_after,volume,turbidity,flushed_at,source,code_snapshot,address_snapshot,target_snapshot,employee_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    p.id,
    req.session.user_id,
    b.temperature_before,
    b.temperature_after,
    b.volume,
    b.turbidity ? 1 : 0,
    new Date().toISOString(),
    "manual",
    p.code,
    p.address,
    p.target,
    req.session.name,
  );
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});
app.post("/api/lists", admin, (req, res) => {
  if (
    !text(req.body.name, 100) ||
    typeof (req.body.description ?? "") !== "string" ||
    (req.body.description || "").length > 500
  )
    return fail(
      res,
      400,
      "Listenname erforderlich, Beschreibung maximal 500 Zeichen.",
    );
  const r = run(
    "INSERT INTO lists(name,description) VALUES(?,?)",
    req.body.name.trim(),
    req.body.description || "",
  );
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
app.put("/api/lists/:id", admin, (req, res) => {
  const id = Number(req.params.id);
  if (!one("SELECT 1 FROM lists WHERE id=?", id))
    return fail(res, 404, "Liste nicht gefunden.");
  if (
    !text(req.body.name, 100) ||
    typeof (req.body.description ?? "") !== "string" ||
    (req.body.description || "").length > 500
  )
    return fail(
      res,
      400,
      "Listenname erforderlich, Beschreibung maximal 500 Zeichen.",
    );
  run(
    "UPDATE lists SET name=?,description=? WHERE id=?",
    req.body.name.trim(),
    req.body.description || "",
    id,
  );
  res.json({ ok: true });
});
app.put("/api/lists/:id/assignments", admin, (req, res) => {
  const id = Number(req.params.id),
    ids = req.body.user_ids;
  if (!one("SELECT 1 FROM lists WHERE id=?", id))
    return fail(res, 404, "Liste nicht gefunden.");
  if (
    !Array.isArray(ids) ||
    ids.some(
      (x) =>
        !Number.isInteger(x) ||
        !one(
          "SELECT 1 FROM users WHERE id=? AND role='employee' AND active=1",
          x,
        ),
    )
  )
    return fail(res, 400, "Bitte gültige Mitarbeiter auswählen.");
  transaction(() => {
    run("DELETE FROM assignments WHERE list_id=?", id);
    for (const uid of new Set(ids))
      run("INSERT INTO assignments VALUES(?,?)", id, uid);
  });
  res.json({ ok: true });
});
const pointValid = (b) =>
  text(b.code, 50) &&
  text(b.address, 300) &&
  typeof b.target === "number" &&
  Number.isFinite(b.target) &&
  b.target > 0 &&
  b.target <= 1000000 &&
  Number.isInteger(b.list_id) &&
  !!one("SELECT 1 FROM lists WHERE id=?", b.list_id);
app.post("/api/points", admin, (req, res) => {
  const b = req.body;
  if (!pointValid(b))
    return fail(
      res,
      400,
      "ID, Adresse, Liste und positive Sollmenge bis 1.000.000 m³ erforderlich.",
    );
  const r = run(
    "INSERT INTO points(list_id,code,address,target) VALUES(?,?,?,?)",
    b.list_id,
    b.code.trim(),
    b.address.trim(),
    b.target,
  );
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
app.put("/api/points/:id", admin, (req, res) => {
  const b = req.body,
    id = Number(req.params.id);
  if (!pointValid(b))
    return fail(res, 400, "Bitte gültige Spülpunktdaten eingeben.");
  if (!one("SELECT 1 FROM points WHERE id=?", id))
    return fail(res, 404, "Spülpunkt nicht gefunden.");
  run(
    "UPDATE points SET list_id=?,code=?,address=?,target=? WHERE id=?",
    b.list_id,
    b.code.trim(),
    b.address.trim(),
    b.target,
    id,
  );
  res.json({ ok: true });
});
app.get("/api/users", admin, (req, res) =>
  res.json(all("SELECT id,name,email,role,active FROM users ORDER BY name")),
);
app.post("/api/users", admin, (req, res) => {
  const b = req.body;
  if (!validUser(b) || !validPassword(b.password))
    return fail(
      res,
      400,
      "Gültige Benutzerdaten und Passwort mit 12–128 Zeichen erforderlich.",
    );
  const r = run(
    "INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)",
    b.name.trim(),
    b.email.trim().toLowerCase(),
    hash(b.password),
    b.role,
  );
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
app.put("/api/users/:id", admin, (req, res) => {
  const b = req.body,
    id = Number(req.params.id);
  if (
    !validUser(b) ||
    typeof b.active !== "boolean" ||
    (b.password && !validPassword(b.password))
  )
    return fail(res, 400, "Bitte gültige Benutzerdaten eingeben.");
  const existing = one("SELECT * FROM users WHERE id=?", id);
  if (!existing) return fail(res, 404, "Benutzer nicht gefunden.");
  if (req.session.user_id === id && (!b.active || b.role !== "admin"))
    return fail(
      res,
      400,
      "Das eigene Administrationskonto muss aktiv bleiben.",
    );
  transaction(() => {
    run(
      "UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?",
      b.name.trim(),
      b.email.trim().toLowerCase(),
      b.role,
      b.active ? 1 : 0,
      id,
    );
    if (b.password)
      run("UPDATE users SET password=? WHERE id=?", hash(b.password), id);
    if (b.role !== "employee" || !b.active)
      run("DELETE FROM assignments WHERE user_id=?", id);
    if (b.password || !b.active || existing.role !== b.role)
      run("DELETE FROM sessions WHERE user_id=?", id);
  });
  res.json({ ok: true });
});
app.use("/api", (req, res) => fail(res, 404, "Endpunkt nicht gefunden."));
app.use(express.static(resolve(root, "public")));
app.use((err, req, res, next) => {
  if (
    err.code?.startsWith("SQLITE_CONSTRAINT") ||
    String(err.message).includes("UNIQUE constraint")
  )
    return fail(
      res,
      409,
      "Diese E-Mail oder Spülpunkt-ID ist bereits vergeben.",
    );
  if (err.status === 413) return fail(res, 413, "Die Anfrage ist zu groß.");
  if (err instanceof SyntaxError) return fail(res, 400, "Ungültiges JSON.");
  console.error(err.message);
  fail(res, 500, "Die Anfrage konnte nicht verarbeitet werden.");
});

if (process.env.DEMO_MODE === "true" && !one("SELECT 1 FROM users LIMIT 1")) {
  const password = process.env.DEMO_PASSWORD;
  if (!validPassword(password))
    throw new Error("DEMO_PASSWORD mit mindestens 12 Zeichen erforderlich.");
  transaction(() => {
    for (const [name, email, role] of [
      ["Alex Morgan", "admin@spuelplan.local", "admin"],
      ["Lena Fischer", "lena@spuelplan.local", "employee"],
      ["Chris Weber", "betrachter@spuelplan.local", "viewer"],
    ])
      run(
        "INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)",
        name,
        email,
        hash(password),
        role,
      );
    for (const [name, description] of [
      ["Nordviertel", "Trinkwassernetz · Versorgungszone Nord"],
      ["Altstadt", "Innenstadt · Historisches Versorgungsnetz"],
      ["Gewerbepark West", "Gewerbegebiet · Versorgungszone West"],
    ])
      run("INSERT INTO lists(name,description) VALUES(?,?)", name, description);
    run("INSERT INTO assignments VALUES(1,2)");
    run("INSERT INTO assignments VALUES(2,2)");
    const points = [
      [1, "SP-001", "Birkenstraße 12, 10115 Berlin", 2.5],
      [1, "SP-002", "Lindenallee 8, 10115 Berlin", 3],
      [1, "SP-003", "Parkstraße 24, 10115 Berlin", 1.8],
      [1, "SP-004", "Am Wasserturm 3, 10115 Berlin", 4],
      [2, "SP-005", "Marktplatz 1, 10178 Berlin", 2],
      [2, "SP-006", "Kirchstraße 17, 10178 Berlin", 2.8],
      [2, "SP-007", "Schulstraße 6, 10178 Berlin", 1.5],
      [3, "SP-008", "Industriestraße 42, 13599 Berlin", 5],
      [3, "SP-009", "Am Kanal 9, 13599 Berlin", 3.5],
    ];
    for (const p of points)
      run(
        "INSERT INTO points(list_id,code,address,target) VALUES(?,?,?,?)",
        ...p,
      );
    for (const id of [1, 2, 5]) {
      const p = one("SELECT * FROM points WHERE id=?", id);
      run(
        "INSERT INTO flushes(point_id,user_id,temperature_before,temperature_after,volume,turbidity,flushed_at,code_snapshot,address_snapshot,target_snapshot,employee_snapshot) VALUES(?,2,22.4,14.8,?,0,?,?,?,?,?)",
        id,
        p.target + 0.1,
        new Date(Date.now() - 86400000 * id).toISOString(),
        p.code,
        p.address,
        p.target,
        "Lena Fischer",
      );
    }
  });
}
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, process.env.HOST || "0.0.0.0", () =>
  console.log(
    `Spülplan läuft auf Port ${server.address().port}${process.env.DEMO_MODE === "true" ? " (Demo mit Beispieldaten)" : ""}`,
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
