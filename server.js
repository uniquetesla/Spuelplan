import express from "express";
import { DatabaseSync, backup } from "node:sqlite";
import {
  randomBytes,
  randomInt,
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

if (process.env.NODE_ENV === "production") {
  let origin;
  try {
    origin = new URL(process.env.APP_ORIGIN);
  } catch {
    throw new Error(
      "Für den internen Produktivbetrieb ist eine gültige APP_ORIGIN erforderlich.",
    );
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== process.env.APP_ORIGIN ||
    process.env.COOKIE_SECURE !== "true" ||
    process.env.DEMO_MODE === "true"
  )
    throw new Error(
      "Produktivbetrieb benötigt HTTPS, COOKIE_SECURE=true und ausgeschalteten Demomodus.",
    );
}
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
// Additive migration: keep all existing lists, accounts and measurements.
const needsWorkflowMigration = !db
  .prepare("PRAGMA table_info(flushes)")
  .all()
  .some((c) => c.name === "run_id");
if (needsWorkflowMigration && db.prepare("SELECT 1 FROM lists LIMIT 1").get()) {
  await backup(db, dbPath + ".before-workflow-" + Date.now() + ".sqlite");
}
if (
  !db
    .prepare("PRAGMA table_info(lists)")
    .all()
    .some((c) => c.name === "deleted_at")
)
  db.exec("ALTER TABLE lists ADD COLUMN deleted_at TEXT");
if (needsWorkflowMigration)
  db.exec(
    "ALTER TABLE flushes ADD COLUMN run_id INTEGER REFERENCES list_runs(id)",
  );
db.exec(`
CREATE TABLE IF NOT EXISTS list_runs(id INTEGER PRIMARY KEY,list_id INTEGER NOT NULL REFERENCES lists(id),number INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','review','published')),created_at TEXT NOT NULL,completed_at TEXT,published_at TEXT,name_snapshot TEXT NOT NULL,description_snapshot TEXT NOT NULL,UNIQUE(list_id,number));
CREATE TABLE IF NOT EXISTS run_points(run_id INTEGER NOT NULL REFERENCES list_runs(id),point_id INTEGER NOT NULL REFERENCES points(id),code TEXT NOT NULL,address TEXT NOT NULL,target REAL NOT NULL,PRIMARY KEY(run_id,point_id));
CREATE INDEX IF NOT EXISTS list_runs_list_idx ON list_runs(list_id,number DESC);
CREATE INDEX IF NOT EXISTS flushes_run_point_idx ON flushes(run_id,point_id);
`);
for (const [name, definition] of [
  ["must_change_password", "INTEGER NOT NULL DEFAULT 0"],
  ["temporary_expires", "INTEGER"],
  ["temporary_used", "INTEGER NOT NULL DEFAULT 0"],
]) {
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((c) => c.name === name)
  )
    db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}
if (
  !db
    .prepare("PRAGMA table_info(flushes)")
    .all()
    .some((c) => c.name === "request_id")
)
  db.exec("ALTER TABLE flushes ADD COLUMN request_id TEXT");
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS flushes_request_idx ON flushes(request_id) WHERE request_id IS NOT NULL",
);
db.exec(
  `CREATE TABLE IF NOT EXISTS internal_notes(id INTEGER PRIMARY KEY,flush_id INTEGER NOT NULL UNIQUE REFERENCES flushes(id),content TEXT NOT NULL,acknowledged_at TEXT,acknowledged_by INTEGER REFERENCES users(id));`,
);
// Keep deleted measurements for audit and prevent old device requests from resurrecting them.
for (const table of ["flushes", "list_runs"]) {
  for (const [column, type] of [
    ["deleted_at", "TEXT"],
    ["deleted_by", "INTEGER REFERENCES users(id)"],
  ]) {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === column)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
db.exec(
  "CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
);
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
const SESSION_LIFETIME = 30 * 24 * 3600000;
const sessionCookieOptions = (lifetime) => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "true",
  sameSite: "strict",
  maxAge: lifetime,
  path: "/",
});
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
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
      "SELECT s.*,u.name,u.email,u.role,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1",
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
  must_change_password: !!s.must_change_password,
});
const openSession = (res, u) => {
  const token = randomBytes(32).toString("hex"),
    csrf = randomBytes(24).toString("hex");
  const lifetime = u.must_change_password ? 10 * 60000 : SESSION_LIFETIME;
  run("DELETE FROM sessions WHERE expires<?", Date.now());
  run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(token),
    u.id,
    csrf,
    Date.now() + lifetime,
  );
  res.cookie("sp_session", token, sessionCookieOptions(lifetime));
  return { user: publicUser({ ...u, user_id: u.id }), csrf };
};
const temporaryWords = [
  "Giraffe",
  "Elefant",
  "Zebra",
  "Pinguin",
  "Delfin",
  "Adler",
  "Biber",
  "Fuchs",
  "Igel",
  "Tiger",
  "Panda",
  "Koala",
  "Otter",
  "Dachs",
  "Loewe",
  "Eule",
  "Ente",
  "Hase",
  "Wolf",
  "Falke",
  "Kamel",
  "Kranich",
  "Reh",
  "Schwan",
  "Specht",
  "Robbe",
  "Wal",
  "Gecko",
  "Amsel",
  "Marder",
  "Wombat",
  "Luchs",
  "Tisch",
  "Stuhl",
  "Lampe",
  "Tasse",
  "Becher",
  "Kanne",
  "Loeffel",
  "Gabel",
  "Teller",
  "Besen",
  "Eimer",
  "Korb",
  "Koffer",
  "Schrank",
  "Teppich",
  "Hammer",
  "Zange",
  "Schaufel",
  "Leiter",
  "Buch",
  "Heft",
  "Stift",
  "Uhr",
  "Radio",
  "Telefon",
  "Fahrrad",
  "Auto",
  "Boot",
  "Ball",
  "Kerze",
  "Spiegel",
  "Kissen",
];
const temporaryNumbers = [
  "1234",
  "0815",
  "1111",
  "2222",
  "3333",
  "4444",
  "5555",
  "6666",
  "7777",
  "8888",
  "9999",
  "0000",
  "4321",
  "2468",
  "1357",
  "1212",
  "2026",
  "9090",
  "1010",
  "5050",
];
const generateTemporaryPassword = () =>
  temporaryWords[randomInt(temporaryWords.length)] +
  temporaryNumbers[randomInt(temporaryNumbers.length)];
const passwordChangeBlocked = (key) => {
  const a = one("SELECT * FROM login_attempts WHERE key=?", key);
  return a && a.expires > Date.now() && a.count >= 8;
};
const countPasswordFailure = (key) =>
  run(
    "INSERT INTO login_attempts(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END",
    key,
    Date.now() + 900000,
    Date.now(),
    Date.now(),
  );
const currentRun = (id) =>
  one(
    "SELECT * FROM list_runs WHERE list_id=? ORDER BY number DESC LIMIT 1",
    id,
  );
const publishedRun = (id) =>
  one(
    "SELECT * FROM list_runs WHERE list_id=? AND deleted_at IS NULL AND status='published' ORDER BY number DESC LIMIT 1",
    id,
  );
const assigned = (userId, listId) =>
  !!one(
    "SELECT 1 FROM assignments WHERE list_id=? AND user_id=?",
    listId,
    userId,
  );
const visibleRun = (session, id, runId = null) => {
  if (!one("SELECT 1 FROM lists WHERE id=? AND deleted_at IS NULL", id))
    return null;
  const r =
    runId !== null
      ? one(
          "SELECT * FROM list_runs WHERE id=? AND list_id=?",
          Number(runId),
          id,
        )
      : session.role === "viewer"
        ? publishedRun(id)
        : currentRun(id);
  if (
    !r ||
    (session.role === "viewer" && (r.status !== "published" || r.deleted_at)) ||
    (session.role === "employee" &&
      (r.deleted_at || r.status !== "active" || !assigned(session.user_id, id)))
  )
    return null;
  return r;
};
const finishIfComplete = (id) => {
  const r = currentRun(id);
  if (r?.status !== "active" || r.deleted_at) return;
  const counts = one(
    "SELECT count(*) total,sum(CASE WHEN EXISTS(SELECT 1 FROM flushes f WHERE f.deleted_at IS NULL AND f.point_id=p.id AND f.run_id=?) THEN 1 ELSE 0 END) completed FROM points p WHERE list_id=? AND active=1",
    r.id,
    id,
  );
  if (counts.total > 0 && counts.total === counts.completed) {
    run(
      "UPDATE list_runs SET status='review',completed_at=? WHERE id=?",
      new Date().toISOString(),
      r.id,
    );
    run("DELETE FROM assignments WHERE list_id=?", id);
  }
};
const newRun = (id, number) => {
  const l = one("SELECT * FROM lists WHERE id=?", id);
  return Number(
    run(
      "INSERT INTO list_runs(list_id,number,created_at,name_snapshot,description_snapshot) VALUES(?,?,?,?,?)",
      id,
      number,
      new Date().toISOString(),
      l.name,
      l.description,
    ).lastInsertRowid,
  );
};
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
  const ipKey = digest(`ip:${req.socket.remoteAddress}`);
  const accountKey = digest(`login-account:${email.trim().toLowerCase()}`);
  for (const [k, limit] of [
    [accountKey, 8],
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
  if (
    !u ||
    !matches ||
    (u.must_change_password &&
      (u.temporary_used ||
        !u.temporary_expires ||
        u.temporary_expires <= Date.now()))
  ) {
    for (const k of [ipKey, accountKey])
      run(
        "INSERT INTO login_attempts(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END",
        k,
        Date.now() + 900000,
        Date.now(),
        Date.now(),
      );
    return fail(res, 401, "E-Mail oder Passwort ist falsch.");
  }
  const auth = transaction(() => {
    if (u.must_change_password) {
      const consumed = run(
        "UPDATE users SET temporary_used=1 WHERE id=? AND temporary_used=0 AND must_change_password=1 AND temporary_expires>?",
        u.id,
        Date.now(),
      );
      if (consumed.changes !== 1) return null;
    }
    for (const k of [accountKey])
      run("DELETE FROM login_attempts WHERE key=?", k);
    return openSession(res, u);
  });
  if (!auth) return fail(res, 401, "E-Mail oder Passwort ist falsch.");
  res.json(auth);
});
app.use("/api", requireAuth);
// Refresh at most daily. Password-change sessions keep their strict ten-minute
// deadline; logout and password rotation issue their own cookie responses.
app.use("/api", (req, res, next) => {
  if (
    !req.session.must_change_password &&
    !["/api/logout", "/api/account/password"].includes(
      req.originalUrl.split("?")[0],
    ) &&
    req.session.expires < Date.now() + SESSION_LIFETIME - 24 * 3600000
  ) {
    const expires = Date.now() + SESSION_LIFETIME;
    run(
      "UPDATE sessions SET expires=? WHERE token=?",
      expires,
      req.session.token,
    );
    req.session.expires = expires;
    const token = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("sp_session="))
      ?.slice(11);
    res.cookie("sp_session", token, sessionCookieOptions(SESSION_LIFETIME));
  }
  next();
});
app.get("/api/me", (req, res) =>
  res.json({ user: publicUser(req.session), csrf: req.session.csrf }),
);
app.post("/api/logout", (req, res) => {
  run("DELETE FROM sessions WHERE token=?", req.session.token);
  res.clearCookie("sp_session", { path: "/" });
  res.json({ ok: true });
});
app.post("/api/account/password", (req, res) => {
  const u = one(
      "SELECT * FROM users WHERE id=? AND active=1",
      req.session.user_id,
    ),
    b = req.body;
  if (!validPassword(b.new_password))
    return fail(res, 400, "Das neue Passwort muss 12–128 Zeichen lang sein.");
  if (b.new_password !== b.confirm_password)
    return fail(res, 400, "Die neuen Passwörter stimmen nicht überein.");
  const key = digest(`password-change:${u.id}`);
  if (passwordChangeBlocked(key))
    return fail(
      res,
      429,
      "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.",
    );
  if (
    !u.must_change_password &&
    (typeof b.current_password !== "string" ||
      b.current_password.length > 128 ||
      !verify(b.current_password, u.password))
  ) {
    countPasswordFailure(key);
    return fail(res, 400, "Das aktuelle Passwort ist falsch.");
  }
  if (verify(b.new_password, u.password))
    return fail(
      res,
      400,
      "Wähle ein anderes Passwort als dein bisheriges Passwort.",
    );
  const auth = transaction(() => {
    run(
      "UPDATE users SET password=?,must_change_password=0,temporary_expires=NULL,temporary_used=0 WHERE id=?",
      hash(b.new_password),
      u.id,
    );
    run("DELETE FROM sessions WHERE user_id=?", u.id);
    run("DELETE FROM login_attempts WHERE key=?", key);
    return openSession(res, { ...u, must_change_password: 0 });
  });
  res.json(auth);
});
// A one-time-password login only authorizes password replacement and logout.
app.use("/api", (req, res, next) => {
  if (req.session.must_change_password)
    return res.status(403).json({
      error: "Bitte vergib zuerst ein neues persönliches Passwort.",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  next();
});
app.post("/api/users/:id/reset-password", admin, (req, res) => {
  const id = Number(req.params.id),
    u = one("SELECT * FROM users WHERE id=?", id);
  if (!u) return fail(res, 404, "Benutzer nicht gefunden.");
  if (id === req.session.user_id)
    return fail(res, 400, "Ändere dein eigenes Passwort unter Mein Passwort.");
  if (!u.active) return fail(res, 409, "Aktiviere das Benutzerkonto zuerst.");
  let temporaryPassword;
  do {
    temporaryPassword = generateTemporaryPassword();
  } while (verify(temporaryPassword, u.password));
  const expires = Date.now() + 10 * 60000;
  transaction(() => {
    run(
      "UPDATE users SET password=?,must_change_password=1,temporary_expires=?,temporary_used=0 WHERE id=?",
      hash(temporaryPassword),
      expires,
      id,
    );
    run("DELETE FROM sessions WHERE user_id=?", id);
    // A newly issued credential must be usable even after earlier failed logins.
    run(
      "DELETE FROM login_attempts WHERE key=?",
      digest(`login-account:${u.email}`),
    );
    run(
      "DELETE FROM login_attempts WHERE key=?",
      digest(`password-change:${id}`),
    );
    run(
      "DELETE FROM login_attempts WHERE key=?",
      digest(`${req.socket.remoteAddress}:${u.email}`),
    );
  });
  res.json({ temporary_password: temporaryPassword, expires_in_minutes: 10 });
});
app.get("/api/lists", (req, res) => {
  const result = [];
  for (const l of all(
    "SELECT * FROM lists WHERE deleted_at IS NULL ORDER BY id DESC",
  )) {
    const runs =
      req.session.role === "viewer"
        ? all(
            "SELECT * FROM list_runs WHERE list_id=? AND deleted_at IS NULL AND status='published' ORDER BY published_at DESC,id DESC",
            l.id,
          )
        : [visibleRun(req.session, l.id)].filter(Boolean);
    for (const r of runs) {
      const historical = r.status === "published" || !!r.deleted_at;
      const total = r.deleted_at
        ? 0
        : historical
          ? one(
              "SELECT count(*) n FROM run_points rp WHERE run_id=? AND EXISTS(SELECT 1 FROM flushes f WHERE f.run_id=rp.run_id AND f.point_id=rp.point_id AND f.deleted_at IS NULL)",
              r.id,
            ).n
          : one(
              "SELECT count(*) n FROM points WHERE list_id=? AND active=1",
              l.id,
            ).n;
      const completed = historical
        ? total
        : one(
            "SELECT count(*) n FROM points p WHERE p.list_id=? AND p.active=1 AND EXISTS(SELECT 1 FROM flushes f WHERE f.deleted_at IS NULL AND f.point_id=p.id AND f.run_id=?)",
            l.id,
            r.id,
          ).n;
      result.push({
        ...l,
        name: historical ? r.name_snapshot : l.name,
        description: historical ? r.description_snapshot : l.description,
        run_id: r.id,
        run_number: r.number,
        status: r.deleted_at ? "deleted" : r.status,
        deleted_run: !!r.deleted_at,
        published_at: r.published_at,
        completed_at: r.completed_at,
        point_count: total,
        completed_count: completed,
        last_flush: one(
          "SELECT max(flushed_at) d FROM flushes WHERE deleted_at IS NULL AND run_id=?",
          r.id,
        ).d,
        published_count: one(
          "SELECT count(*) n FROM list_runs WHERE list_id=? AND deleted_at IS NULL AND status='published'",
          l.id,
        ).n,
        assignees:
          req.session.role === "viewer"
            ? []
            : all(
                "SELECT u.id,u.name FROM users u JOIN assignments a ON u.id=a.user_id WHERE a.list_id=? AND u.active=1",
                l.id,
              ),
      });
    }
  }
  if (req.session.role === "viewer")
    result.sort(
      (a, b) =>
        b.published_at.localeCompare(a.published_at) || b.run_id - a.run_id,
    );
  if (req.session.role === "admin")
    result.sort(
      (a, b) =>
        ({ review: 0, active: 1, published: 2, deleted: 3 })[a.status] -
          { review: 0, active: 1, published: 2, deleted: 3 }[b.status] ||
        b.id - a.id,
    );
  res.json(result);
});
app.get("/api/lists/:id/points", (req, res) => {
  const id = Number(req.params.id),
    r = visibleRun(req.session, id, req.query.run ?? null);
  if (!r) return fail(res, 403, "Diese Liste ist nicht für dich freigegeben.");
  if (r.deleted_at) return res.json([]);
  const points =
    r.status === "published"
      ? all(
          "SELECT point_id id,? list_id,code,address,target FROM run_points rp WHERE run_id=? AND EXISTS(SELECT 1 FROM flushes f WHERE f.run_id=rp.run_id AND f.point_id=rp.point_id AND f.deleted_at IS NULL) ORDER BY code",
          id,
          r.id,
        )
      : all(
          "SELECT * FROM points WHERE list_id=? AND active=1 ORDER BY code",
          id,
        );
  res.json(
    points.map((p) => ({
      ...p,
      completed: !!one(
        "SELECT 1 FROM flushes WHERE deleted_at IS NULL AND run_id=? AND point_id=?",
        r.id,
        p.id,
      ),
      last_flush:
        r.status === "published"
          ? one(
              "SELECT max(flushed_at) d FROM flushes WHERE deleted_at IS NULL AND point_id=? AND run_id=?",
              p.id,
              r.id,
            ).d
          : one(
              "SELECT max(flushed_at) d FROM flushes WHERE deleted_at IS NULL AND point_id=?",
              p.id,
            ).d,
      last_volume:
        one(
          "SELECT volume FROM flushes WHERE deleted_at IS NULL AND run_id=? AND point_id=? ORDER BY id DESC LIMIT 1",
          r.id,
          p.id,
        )?.volume ?? null,
    })),
  );
});
app.get("/api/lists/:id/runs", (req, res) => {
  const id = Number(req.params.id);
  if (!visibleRun(req.session, id))
    return fail(res, 403, "Diese Liste ist nicht für dich freigegeben.");
  const filter =
    req.session.role === "viewer"
      ? " AND status='published'"
      : req.session.role === "employee"
        ? " AND status='active'"
        : "";
  res.json(
    all(
      "SELECT id,number,status,created_at,completed_at,published_at FROM list_runs WHERE deleted_at IS NULL AND list_id=?" +
        filter +
        " ORDER BY number DESC",
      id,
    ),
  );
});
app.get("/api/report-runs", (req, res) => {
  const scope =
    req.session.role === "viewer"
      ? "AND r.status='published'"
      : req.session.role === "employee"
        ? "AND r.status='active' AND EXISTS(SELECT 1 FROM assignments a WHERE a.list_id=r.list_id AND a.user_id=?)"
        : "";
  res.json(
    all(
      `SELECT r.id,r.list_id listId,r.name_snapshot name,r.number,r.status,r.published_at publishedAt,count(f.id) measurement_count FROM list_runs r JOIN lists l ON l.id=r.list_id LEFT JOIN flushes f ON f.run_id=r.id AND f.deleted_at IS NULL WHERE r.deleted_at IS NULL AND l.deleted_at IS NULL ${scope} GROUP BY r.id HAVING count(f.id)>0 OR r.status IN ('review','published') ORDER BY coalesce(r.published_at,r.created_at) DESC,r.id DESC`,
      ...(req.session.role === "employee" ? [req.session.user_id] : []),
    ),
  );
});
app.get("/api/statistics/settings", (req, res) => {
  res.json({
    after_id: Number(
      one("SELECT value FROM app_settings WHERE key='statistics_after_id'")
        ?.value || 0,
    ),
    reset_at:
      one("SELECT value FROM app_settings WHERE key='statistics_reset_at'")
        ?.value || null,
  });
});
app.post("/api/statistics/reset", admin, (req, res) => {
  if (req.body.confirm !== "STATISTIK ZURÜCKSETZEN")
    return fail(
      res,
      400,
      "Bitte bestätige das Zurücksetzen mit STATISTIK ZURÜCKSETZEN.",
    );
  const at = new Date().toISOString();
  transaction(() => {
    for (const [key, value] of [
      [
        "statistics_after_id",
        String(one("SELECT coalesce(max(id),0) id FROM flushes").id),
      ],
      ["statistics_reset_at", at],
      ["statistics_reset_by", String(req.session.user_id)],
    ])
      run(
        "INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        value,
      );
  });
  res.json({ ok: true, reset_at: at });
});
app.delete("/api/flushes/:id", admin, (req, res) => {
  const f = one(
    "SELECT f.*,r.status,r.list_id FROM flushes f JOIN list_runs r ON r.id=f.run_id JOIN lists l ON l.id=r.list_id WHERE f.id=? AND f.deleted_at IS NULL AND r.deleted_at IS NULL AND l.deleted_at IS NULL",
    Number(req.params.id),
  );
  if (!f) return fail(res, 404, "Protokoll nicht gefunden.");
  if (req.body.confirm_code !== f.code_snapshot)
    return fail(res, 400, "Bitte bestätige die Spülpunkt-ID.");
  run(
    "UPDATE flushes SET deleted_at=?,deleted_by=? WHERE id=?",
    new Date().toISOString(),
    req.session.user_id,
    f.id,
  );
  res.json({ ok: true });
});
app.delete("/api/runs/:id", admin, (req, res) => {
  const r = one(
    "SELECT r.* FROM list_runs r JOIN lists l ON l.id=r.list_id WHERE r.id=? AND r.deleted_at IS NULL AND l.deleted_at IS NULL",
    Number(req.params.id),
  );
  if (!r) return fail(res, 404, "Durchlauf nicht gefunden.");
  if (r.status === "active")
    return fail(
      res,
      409,
      "Nur abgeschlossene Durchläufe können gelöscht werden.",
    );
  if (req.body.confirm_name !== r.name_snapshot)
    return fail(res, 400, "Bitte bestätige den Listennamen.");
  transaction(() => {
    const at = new Date().toISOString();
    run(
      "UPDATE list_runs SET deleted_at=?,deleted_by=? WHERE id=?",
      at,
      req.session.user_id,
      r.id,
    );
    run(
      "UPDATE flushes SET deleted_at=coalesce(deleted_at,?),deleted_by=coalesce(deleted_by,?) WHERE run_id=?",
      at,
      req.session.user_id,
      r.id,
    );
    if (currentRun(r.list_id).id === r.id)
      run("DELETE FROM assignments WHERE list_id=?", r.list_id);
  });
  res.json({ ok: true });
});
app.get("/api/flushes", (req, res) => {
  const filters = [
      "l.deleted_at IS NULL",
      "r.deleted_at IS NULL",
      "f.deleted_at IS NULL",
    ],
    args = [];
  if (req.session.role === "viewer") filters.push("r.status='published'");
  if (req.session.role === "employee") {
    filters.push(
      "r.status='active' AND r.id=(SELECT id FROM list_runs WHERE list_id=r.list_id ORDER BY number DESC LIMIT 1) AND EXISTS(SELECT 1 FROM assignments a WHERE a.list_id=r.list_id AND a.user_id=?)",
    );
    args.push(req.session.user_id);
  }
  if (req.query.list) {
    filters.push("r.list_id=?");
    args.push(Number(req.query.list));
  }
  if (req.query.point) {
    filters.push("f.point_id=?");
    args.push(Number(req.query.point));
  }
  if (req.query.run) {
    filters.push("r.id=?");
    args.push(Number(req.query.run));
  }
  res.json(
    all(
      `SELECT f.*,r.list_id,r.number run_number,r.status run_status,r.published_at run_published_at,f.code_snapshot code,f.address_snapshot address,f.target_snapshot target,f.employee_snapshot employee,r.name_snapshot list_name FROM flushes f JOIN list_runs r ON r.id=f.run_id JOIN lists l ON l.id=r.list_id WHERE ${filters.join(" AND ")} ORDER BY f.flushed_at DESC,f.id DESC`,
      ...args,
    ),
  );
});
const internalRole = (req, res, next) =>
  ["admin", "employee"].includes(req.session.role)
    ? next()
    : fail(
        res,
        403,
        "Interne Bemerkungen sind für Betrachter nicht zugänglich.",
      );
const noteVisible = (session, id) =>
  !!one(
    `SELECT n.id FROM internal_notes n JOIN flushes f ON f.id=n.flush_id JOIN list_runs r ON r.id=f.run_id JOIN lists l ON l.id=r.list_id WHERE n.id=? AND f.deleted_at IS NULL AND r.deleted_at IS NULL AND l.deleted_at IS NULL ${session.role === "admin" ? "" : "AND (f.user_id=? OR EXISTS(SELECT 1 FROM assignments a WHERE a.list_id=r.list_id AND a.user_id=?))"}`,
    id,
    ...(session.role === "admin" ? [] : [session.user_id, session.user_id]),
  );
app.get("/api/internal-notes", internalRole, (req, res) => {
  const scope =
    req.session.role === "admin"
      ? ""
      : " AND (f.user_id=? OR EXISTS(SELECT 1 FROM assignments a WHERE a.list_id=r.list_id AND a.user_id=?))";
  res.json(
    all(
      `SELECT n.id,n.content,n.acknowledged_at,f.point_id,f.code_snapshot code,f.address_snapshot address,f.employee_snapshot employee,f.flushed_at,r.list_id,r.number run_number,r.name_snapshot list_name FROM internal_notes n JOIN flushes f ON f.id=n.flush_id JOIN list_runs r ON r.id=f.run_id JOIN lists l ON l.id=r.list_id WHERE f.deleted_at IS NULL AND r.deleted_at IS NULL AND l.deleted_at IS NULL AND n.acknowledged_at IS NULL${scope} ORDER BY f.flushed_at DESC,n.id DESC`,
      ...(req.session.role === "admin"
        ? []
        : [req.session.user_id, req.session.user_id]),
    ),
  );
});
app.post("/api/internal-notes/acknowledge", internalRole, (req, res) => {
  const ids = req.body.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 1000 ||
    ids.some((id) => !Number.isInteger(id))
  )
    return fail(res, 400, "Bitte gültige Bemerkungen auswählen.");
  if (ids.some((id) => !noteVisible(req.session, id)))
    return fail(
      res,
      403,
      "Mindestens eine Bemerkung ist dir nicht zugänglich.",
    );
  transaction(() => {
    for (const id of new Set(ids))
      run(
        "UPDATE internal_notes SET acknowledged_at=?,acknowledged_by=? WHERE id=? AND acknowledged_at IS NULL",
        new Date().toISOString(),
        req.session.user_id,
        id,
      );
  });
  res.json({ ok: true });
});
const measurementReceipt = (id) => {
  const record = one(
    "SELECT id,request_id,point_id,run_id,user_id,source,code_snapshot code,target_snapshot target,volume,temperature_before,temperature_after FROM flushes WHERE deleted_at IS NULL AND id=? AND run_id IN(SELECT id FROM list_runs WHERE deleted_at IS NULL)",
    id,
  );
  return record ? { ...record, saved: true } : null;
};
app.get("/api/flushes/:id/receipt", (req, res) => {
  const receipt = measurementReceipt(Number(req.params.id));
  if (
    !["admin", "employee"].includes(req.session.role) ||
    !receipt ||
    receipt.source !== "esp32" ||
    receipt.user_id !== req.session.user_id
  )
    return fail(res, 404, "Keine eigene ESP32-Speicherbestätigung gefunden.");
  res.json(receipt);
});
app.get("/api/measurement-receipts/:requestId", (req, res) => {
  const record = one(
    "SELECT id FROM flushes WHERE deleted_at IS NULL AND run_id IN(SELECT id FROM list_runs WHERE deleted_at IS NULL) AND request_id=? AND user_id=? AND source='esp32'",
    req.params.requestId,
    req.session.user_id,
  );
  if (!record || !["admin", "employee"].includes(req.session.role))
    return fail(
      res,
      404,
      "Es liegt noch keine eigene Server-Speicherbestätigung für diesen Auftrag vor.",
    );
  res.json(measurementReceipt(record.id));
});
app.post("/api/points/:id/flushes", (req, res) => {
  if (!["admin", "employee"].includes(req.session.role))
    return fail(res, 403, "Betrachter können keine Spülungen dokumentieren.");
  const b = req.body,
    source = b.source ?? "manual";
  if (
    b.note !== undefined &&
    (typeof b.note !== "string" || b.note.length > 2000)
  )
    return fail(
      res,
      400,
      "Die interne Bemerkung darf maximal 2.000 Zeichen enthalten.",
    );
  const note = (b.note ?? "").trim();
  if (!["manual", "esp32"].includes(source))
    return fail(res, 400, "Unbekannte Messwertquelle.");
  if (
    (b.request_id !== undefined || source === "esp32") &&
    (typeof b.request_id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.request_id))
  )
    return fail(res, 400, "Eine gültige Übertragungs-ID ist erforderlich.");
  if (b.request_id) {
    const cached = one(
      "SELECT * FROM flushes WHERE request_id=?",
      b.request_id,
    );
    if (cached) {
      if (
        cached.deleted_at ||
        one("SELECT deleted_at FROM list_runs WHERE id=?", cached.run_id)
          ?.deleted_at
      )
        return fail(
          res,
          409,
          "Dieses Protokoll wurde von der Administration gelöscht. Starte für eine neue Messung einen neuen Auftrag.",
        );
      if (
        cached.user_id !== req.session.user_id ||
        cached.point_id !== Number(req.params.id) ||
        cached.source !== source ||
        (one("SELECT content FROM internal_notes WHERE flush_id=?", cached.id)
          ?.content ?? "") !== note ||
        cached.volume !== b.volume ||
        cached.temperature_before !== b.temperature_before ||
        cached.temperature_after !== b.temperature_after ||
        typeof b.turbidity !== "boolean" ||
        cached.turbidity !== (b.turbidity ? 1 : 0) ||
        (source === "esp32" &&
          (cached.run_id !== b.run_id ||
            cached.code_snapshot !== b.measurement_point_code ||
            cached.target_snapshot !== b.measurement_target))
      )
        return fail(
          res,
          409,
          "Die Übertragungs-ID gehört zu anderen gespeicherten Messdaten.",
        );
      return res.json({
        id: cached.id,
        status: one("SELECT status FROM list_runs WHERE id=?", cached.run_id)
          .status,
        receipt: source === "esp32" ? measurementReceipt(cached.id) : undefined,
      });
    }
  }
  const p = one(
    "SELECT p.* FROM points p JOIN lists l ON l.id=p.list_id WHERE p.id=? AND p.active=1 AND l.deleted_at IS NULL",
    Number(req.params.id),
  );
  if (!p) return fail(res, 404, "Spülpunkt nicht gefunden.");
  const r = currentRun(p.list_id);
  if (!assigned(req.session.user_id, p.list_id))
    return fail(res, 403, "Diese Liste ist dir nicht freigegeben.");
  if (r?.status !== "active")
    return fail(
      res,
      409,
      "Dieser Durchgang ist abgeschlossen und wird von der Administration geprüft.",
    );
  if (
    source === "esp32" &&
    (b.run_id !== r.id ||
      b.measurement_point_code !== p.code ||
      b.measurement_target !== p.target ||
      b.volume < p.target)
  )
    return fail(
      res,
      409,
      "Die ESP32-Messung passt nicht zum aktuellen Spülpunkt, zur Sollmenge oder zum Durchgang.",
    );
  if (
    ["temperature_before", "temperature_after", "volume"].some(
      (k) => typeof b[k] !== "number" || !Number.isFinite(b[k]),
    ) ||
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
  if (
    one(
      "SELECT 1 FROM flushes WHERE deleted_at IS NULL AND run_id=? AND point_id=?",
      r.id,
      p.id,
    )
  )
    return fail(
      res,
      409,
      "Dieser Spülpunkt wurde in diesem Durchgang bereits bearbeitet.",
    );
  const result = transaction(() => {
    const inserted = run(
      "INSERT INTO flushes(point_id,user_id,temperature_before,temperature_after,volume,turbidity,flushed_at,source,code_snapshot,address_snapshot,target_snapshot,employee_snapshot,run_id,request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      p.id,
      req.session.user_id,
      b.temperature_before,
      b.temperature_after,
      b.volume,
      b.turbidity ? 1 : 0,
      new Date().toISOString(),
      source,
      p.code,
      p.address,
      p.target,
      req.session.name,
      r.id,
      b.request_id ?? null,
    );
    if (note)
      run(
        "INSERT INTO internal_notes(flush_id,content) VALUES(?,?)",
        Number(inserted.lastInsertRowid),
        note,
      );
    finishIfComplete(p.list_id);
    return inserted;
  });
  res.status(201).json({
    id: Number(result.lastInsertRowid),
    status: currentRun(p.list_id).status,
    receipt:
      source === "esp32"
        ? measurementReceipt(Number(result.lastInsertRowid))
        : undefined,
  });
});
app.post("/api/lists/:id/publish", admin, (req, res) => {
  const id = Number(req.params.id),
    l = one("SELECT * FROM lists WHERE id=? AND deleted_at IS NULL", id),
    r = currentRun(id);
  if (!l) return fail(res, 404, "Liste nicht gefunden.");
  if (r?.status !== "review" || r.deleted_at)
    return fail(
      res,
      409,
      "Nur vollständig bearbeitete Durchgänge können gespeichert und freigegeben werden.",
    );
  transaction(() => {
    run(
      "INSERT INTO run_points(run_id,point_id,code,address,target) SELECT ?,id,code,address,target FROM points WHERE list_id=? AND active=1",
      r.id,
      id,
    );
    run(
      "UPDATE list_runs SET status='published',published_at=?,name_snapshot=?,description_snapshot=? WHERE id=?",
      new Date().toISOString(),
      l.name,
      l.description,
      r.id,
    );
    run("DELETE FROM assignments WHERE list_id=?", id);
  });
  res.json({ ok: true });
});
const validAssignees = (ids) =>
  Array.isArray(ids) &&
  ids.every(
    (x) =>
      Number.isInteger(x) &&
      !!one(
        "SELECT 1 FROM users WHERE id=? AND role IN ('admin','employee') AND active=1",
        x,
      ),
  );
app.post("/api/lists/:id/restart", admin, (req, res) => {
  const id = Number(req.params.id),
    r = currentRun(id),
    ids = req.body.user_ids;
  if (!one("SELECT 1 FROM lists WHERE id=? AND deleted_at IS NULL", id))
    return fail(res, 404, "Liste nicht gefunden.");
  if (!r || (r.status !== "published" && !r.deleted_at))
    return fail(
      res,
      409,
      "Speichere den abgeschlossenen Durchgang zuerst und gib ihn für Betrachter frei.",
    );
  if (!validAssignees(ids) || ids.length === 0)
    return fail(
      res,
      400,
      "Wähle mindestens eine aktive Person aus Administration oder Mitarbeitern.",
    );
  const runId = transaction(() => {
    const runId = newRun(id, r.number + 1);
    run("DELETE FROM assignments WHERE list_id=?", id);
    for (const uid of new Set(ids))
      run("INSERT INTO assignments VALUES(?,?)", id, uid);
    return runId;
  });
  res.status(201).json({ id: runId });
});
app.delete("/api/lists/:id", admin, (req, res) => {
  const id = Number(req.params.id),
    l = one("SELECT * FROM lists WHERE id=? AND deleted_at IS NULL", id);
  if (!l) return fail(res, 404, "Liste nicht gefunden.");
  if (req.body.confirm_name !== l.name)
    return fail(res, 400, "Bitte bestätige den exakten Listennamen.");
  transaction(() => {
    run(
      "UPDATE lists SET deleted_at=? WHERE id=?",
      new Date().toISOString(),
      id,
    );
    run("DELETE FROM assignments WHERE list_id=?", id);
  });
  res.json({ ok: true });
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
  const id = transaction(() => {
    const id = Number(
      run(
        "INSERT INTO lists(name,description) VALUES(?,?)",
        req.body.name.trim(),
        req.body.description || "",
      ).lastInsertRowid,
    );
    newRun(id, 1);
    return id;
  });
  res.status(201).json({ id });
});
app.put("/api/lists/:id", admin, (req, res) => {
  const id = Number(req.params.id);
  if (!one("SELECT 1 FROM lists WHERE id=? AND deleted_at IS NULL", id))
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
  if (!one("SELECT 1 FROM lists WHERE id=? AND deleted_at IS NULL", id))
    return fail(res, 404, "Liste nicht gefunden.");
  if (currentRun(id)?.status !== "active")
    return fail(
      res,
      409,
      "Freigaben können nur im aktiven Durchgang geändert werden.",
    );
  if (!validAssignees(ids))
    return fail(
      res,
      400,
      "Bitte aktive Benutzer aus Administration oder Mitarbeitern auswählen.",
    );
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
  !!one("SELECT 1 FROM lists WHERE id=? AND deleted_at IS NULL", b.list_id);
app.post("/api/points", admin, (req, res) => {
  const b = req.body;
  if (!pointValid(b))
    return fail(
      res,
      400,
      "ID, Adresse, Liste und positive Sollmenge bis 1.000.000 m³ erforderlich.",
    );
  if (currentRun(b.list_id)?.status !== "active")
    return fail(
      res,
      409,
      "Spülpunkte können nur im aktiven Durchgang angelegt werden.",
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
  const original = one("SELECT * FROM points WHERE id=?", id),
    originalRun = currentRun(original.list_id);
  if (
    originalRun?.status !== "active" ||
    currentRun(b.list_id)?.status !== "active"
  )
    return fail(
      res,
      409,
      "Spülpunkte können nur im aktiven Durchgang bearbeitet werden.",
    );
  if (
    one(
      "SELECT 1 FROM flushes WHERE deleted_at IS NULL AND point_id=? AND run_id=?",
      id,
      originalRun.id,
    )
  )
    return fail(
      res,
      409,
      "Bereits bearbeitete Spülpunkte bleiben bis zum nächsten Durchgang unverändert.",
    );
  run(
    "UPDATE points SET list_id=?,code=?,address=?,target=? WHERE id=?",
    b.list_id,
    b.code.trim(),
    b.address.trim(),
    b.target,
    id,
  );
  finishIfComplete(original.list_id);
  res.json({ ok: true });
});
app.get("/api/users", admin, (req, res) =>
  res.json(
    all(
      "SELECT id,name,email,role,active,must_change_password FROM users ORDER BY name",
    ),
  ),
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
  if (b.password)
    return fail(
      res,
      400,
      "Verwende Einmalpasswort erstellen, um ein Benutzerpasswort zurückzusetzen.",
    );
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
    if (b.role === "viewer" || !b.active)
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
// Migrate existing measurements once, including demo data; never publish old records implicitly.
transaction(() => {
  for (const l of all("SELECT * FROM lists")) {
    let r = currentRun(l.id);
    if (!r) {
      newRun(l.id, 1);
      r = currentRun(l.id);
    }
    run(
      "UPDATE flushes SET run_id=? WHERE run_id IS NULL AND point_id IN(SELECT id FROM points WHERE list_id=?)",
      r.id,
      l.id,
    );
    finishIfComplete(l.id);
    if (currentRun(l.id)?.status !== "active")
      run("DELETE FROM assignments WHERE list_id=?", l.id);
  }
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, process.env.HOST || "0.0.0.0");
server.on("listening", () =>
  console.log(
    `SpülPilot läuft auf Port ${server.address().port}${process.env.DEMO_MODE === "true" ? " (Demo mit Beispieldaten)" : ""}`,
  ),
);
server.on("error", (error) => {
  console.error(
    `SpülPilot konnte nicht starten (${error.code || "Fehler"}). Prüfe HOST und PORT; ein belegter Port darf nicht überschrieben werden.`,
  );
  db.close();
  process.exitCode = 1;
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
