import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "spuelpilot-test-"));
const password = "Test-Passwort-2026!";
let child, base, admin, employee, viewer, other, list, p1, p2, firstRun;
const values = {
  temperature_before: 22.5,
  temperature_after: 14.2,
  volume: 2.7,
  turbidity: false,
};
async function start(path) {
  const process = spawn(globalThis.process.execPath, ["server.js"], {
    env: {
      ...globalThis.process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      DB_PATH: path,
      DEMO_MODE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  process.stderr.on("data", (d) => (errors += d));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(errors || "Server timeout")),
      10000,
    );
    process.stdout.on("data", (d) => {
      const m = d.toString().match(/Port (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:" + m[1]);
      }
    });
    process.on("exit", (c) => {
      clearTimeout(timer);
      reject(Error("Server exit " + c + " " + errors));
    });
  });
  return { process, base };
}
async function stop(process) {
  if (process.exitCode !== null) return;
  process.kill();
  await new Promise((r) => process.once("exit", r));
}
async function request(
  path,
  { session, body, method, csrf = true, origin = true } = {},
) {
  const response = await fetch(base + "/api" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: base } : {}),
      ...(session
        ? {
            Cookie: session.cookie,
            ...(csrf ? { "X-CSRF-Token": session.csrf } : {}),
          }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
async function login(email) {
  const r = await request("/login", { body: { email, password } });
  assert.equal(r.status, 200);
  return { ...r.data, cookie: r.cookie };
}
const assign = (ids) =>
  request(`/lists/${list}/assignments`, {
    session: admin,
    method: "PUT",
    body: { user_ids: ids },
  });
const flush = (point, session = employee, body = values) =>
  request(`/points/${point}/flushes`, { session, body });
const lists = (session) => request("/lists", { session });
const records = (session) => request("/flushes", { session });
before(async () => {
  const result = await start(join(dir, "test.sqlite"));
  child = result.process;
  base = result.base;
});
after(async () => {
  await stop(child);
  rmSync(dir, { recursive: true, force: true });
});
test("Geschützte Ersteinrichtung und keine öffentliche Registrierung", async () => {
  assert.equal((await request("/status")).data.setupRequired, true);
  const user = { name: "Admin Test", email: "admin@example.de", password };
  assert.equal((await request("/setup", { body: user })).status, 403);
  assert.equal(
    (
      await request("/setup", {
        body: {
          ...user,
          setup_token: readFileSync(join(dir, "setup-token"), "utf8"),
        },
      })
    ).status,
    201,
  );
  assert.equal(existsSync(join(dir, "setup-token")), false);
  assert.equal((await request("/setup", { body: user })).status, 409);
  admin = await login(user.email);
});
test("Sitzung, CSRF, Herkunft und robots-Schutz", async () => {
  assert.equal((await request("/lists")).status, 401);
  assert.equal(
    (
      await request("/lists", {
        session: admin,
        csrf: false,
        body: { name: "Verboten" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/lists", {
        session: admin,
        origin: false,
        body: { name: "Verboten" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/login", {
        body: { email: "admin@example.de", password: "wrong" },
      })
    ).status,
    401,
  );
  const res = await fetch(base);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.match(await res.text(), /SpülPilot/);
});
test("Administration legt Rollen, Liste und zwei Punkte an", async () => {
  for (const [name, email, role] of [
    ["Mitarbeiter", "employee@example.de", "employee"],
    ["Betrachter", "viewer@example.de", "viewer"],
    ["Ohne Freigabe", "other@example.de", "employee"],
  ])
    assert.equal(
      (
        await request("/users", {
          session: admin,
          body: { name, email, role, password },
        })
      ).status,
      201,
    );
  employee = await login("employee@example.de");
  viewer = await login("viewer@example.de");
  other = await login("other@example.de");
  const r = await request("/lists", {
    session: admin,
    body: { name: "Testliste", description: "Heppenheim" },
  });
  list = r.data.id;
  assert.equal(r.status, 201);
  for (const code of ["SP-1", "SP-2"]) {
    const result = await request("/points", {
      session: admin,
      body: {
        list_id: list,
        code,
        address: code + " in Heppenheim",
        target: 2.5,
      },
    });
    assert.equal(result.status, 201);
    if (!p1) p1 = result.data.id;
    else p2 = result.data.id;
  }
  firstRun = (await lists(admin)).data[0].run_id;
});
test("Freigaben für Administration und Mitarbeiter; Betrachter sehen keine laufenden Daten", async () => {
  assert.deepEqual((await lists(employee)).data, []);
  assert.deepEqual((await lists(viewer)).data, []);
  assert.deepEqual((await records(viewer)).data, []);
  assert.equal(
    (await request(`/lists/${list}/points`, { session: viewer })).status,
    403,
  );
  assert.equal((await assign([viewer.user.id])).status, 400);
  assert.equal((await flush(p1, admin)).status, 403);
  assert.equal((await assign([admin.user.id, employee.user.id])).status, 200);
  assert.equal((await lists(employee)).data.length, 1);
  assert.equal((await request("/users", { session: employee })).status, 403);
  assert.equal(
    (await request(`/lists/${list}/publish`, { session: employee, body: {} }))
      .status,
    403,
  );
  assert.equal((await flush(p1, viewer)).status, 403);
  assert.equal((await flush(p1, other)).status, 403);
});
test("Validierte, automatisch datierte Messung und Schutz vor doppelter Erfassung", async () => {
  for (const b of [
    { temperature_before: -1 },
    { temperature_after: 101 },
    { volume: 0 },
    { volume: "2.5" },
    { turbidity: "Nein" },
  ])
    assert.equal((await flush(p1, admin, { ...values, ...b })).status, 400);
  const time = Date.now();
  const responses = await Promise.all([
    flush(p1, admin, {
      ...values,
      user_id: other.user.id,
      flushed_at: "2000-01-01",
    }),
    flush(p1, admin),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const row = (await records(admin)).data[0];
  assert.equal(row.user_id, admin.user.id);
  assert.ok(new Date(row.flushed_at).getTime() >= time);
  assert.equal(row.run_id, firstRun);
  assert.equal((await lists(employee)).data[0].completed_count, 1);
  assert.equal((await lists(admin)).data[0].status, "active");
  assert.deepEqual((await records(viewer)).data, []);
});
test("Letzter Punkt übergibt Liste automatisch zur Prüfung und sperrt weitere Erfassung", async () => {
  assert.equal(
    (await request(`/lists/${list}/publish`, { session: admin, body: {} }))
      .status,
    409,
  );
  const r = await flush(p2);
  assert.equal(r.status, 201);
  assert.equal(r.data.status, "review");
  assert.deepEqual((await lists(employee)).data, []);
  assert.deepEqual((await records(employee)).data, []);
  assert.equal(
    (await request(`/lists/${list}/points`, { session: employee })).status,
    403,
  );
  assert.equal((await lists(admin)).data[0].status, "review");
  assert.deepEqual((await lists(viewer)).data, []);
  assert.equal((await flush(p1, admin)).status, 409);
  assert.equal(
    (
      await request(`/lists/${list}/restart`, {
        session: admin,
        body: { user_ids: [employee.user.id] },
      })
    ).status,
    409,
  );
  assert.equal((await assign([employee.user.id])).status, 409);
});
test("Nur Administration veröffentlicht vollständig bearbeitete Durchgänge für Betrachter", async () => {
  assert.equal(
    (await request(`/lists/${list}/publish`, { session: viewer, body: {} }))
      .status,
    403,
  );
  assert.equal(
    (await request(`/lists/${list}/publish`, { session: admin, body: {} }))
      .status,
    200,
  );
  assert.equal(
    (await request(`/lists/${list}/publish`, { session: admin, body: {} }))
      .status,
    409,
  );
  assert.equal((await lists(viewer)).data[0].status, "published");
  assert.equal((await records(viewer)).data.length, 2);
  assert.equal(
    (await request(`/lists/${list}/points`, { session: viewer })).data.length,
    2,
  );
  assert.equal(
    (await request(`/lists/${list}/runs`, { session: viewer })).data.length,
    1,
  );
});
test("Neuer Durchgang startet bei null, alte veröffentlichte Nachweise bleiben unverändert", async () => {
  assert.equal(
    (
      await request(`/lists/${list}/restart`, {
        session: admin,
        body: { user_ids: [] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/lists/${list}/restart`, {
        session: admin,
        body: { user_ids: [viewer.user.id] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/lists/${list}/restart`, {
        session: admin,
        body: { user_ids: [employee.user.id] },
      })
    ).status,
    201,
  );
  const active = (await lists(employee)).data[0];
  assert.equal(active.run_number, 2);
  assert.equal(active.completed_count, 0);
  assert.equal((await lists(viewer)).data[0].run_number, 1);
  assert.equal((await records(employee)).data.length, 0);
  assert.equal((await records(viewer)).data.length, 2);
  assert.equal((await flush(p1, admin)).status, 403);
  assert.equal(
    (
      await request(`/points/${p1}`, {
        session: admin,
        method: "PUT",
        body: {
          list_id: list,
          code: "SP-NEU",
          address: "Neue Adresse",
          target: 5,
        },
      })
    ).status,
    200,
  );
  const frozen = (
    await request(`/lists/${list}/points`, { session: viewer })
  ).data.find((p) => p.id === p1);
  assert.equal(frozen.code, "SP-1");
  assert.equal(frozen.target, 2.5);
  assert.equal(
    (await flush(p1, employee, { ...values, volume: 5 })).status,
    201,
  );
  assert.equal((await records(viewer)).data.length, 2);
  const hidden = (
    await request(`/flushes?run=${active.run_id}`, { session: viewer })
  ).data;
  assert.deepEqual(hidden, []);
  assert.equal(
    (await request(`/lists/${list}/runs`, { session: viewer })).data.length,
    1,
  );
  assert.equal((await lists(employee)).data[0].completed_count, 1);
});
test("Zweiter Abschluss speichert separate Historie mit eigenen Punkt-Snapshots", async () => {
  assert.equal((await assign([admin.user.id, employee.user.id])).status, 200);
  assert.equal((await flush(p2, admin)).data.status, "review");
  assert.equal(
    (await request(`/lists/${list}/publish`, { session: admin, body: {} }))
      .status,
    200,
  );
  const rows = (await records(viewer)).data;
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((r) => r.run_id)).size, 2);
  assert.equal(
    rows.find((r) => r.run_number === 1 && r.point_id === p1).code,
    "SP-1",
  );
  assert.equal(
    rows.find((r) => r.run_number === 2 && r.point_id === p1).code,
    "SP-NEU",
  );
  assert.equal(
    (await request(`/lists/${list}/runs`, { session: viewer })).data.length,
    2,
  );
  assert.equal((await lists(viewer)).data[0].run_number, 2);
});
test("Rollen- und Freigabeänderungen schützen aktive Listen weiterhin", async () => {
  assert.equal(
    (
      await request(`/lists/${list}/restart`, {
        session: admin,
        body: { user_ids: [admin.user.id, other.user.id] },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(`/users/${admin.user.id}`, {
        session: admin,
        method: "PUT",
        body: {
          name: "Admin Test",
          email: "admin@example.de",
          role: "admin",
          active: true,
        },
      })
    ).status,
    200,
  );
  assert.ok(
    (await lists(admin)).data[0].assignees.some((a) => a.id === admin.user.id),
  );
  assert.equal(
    (
      await request(`/users/${other.user.id}`, {
        session: admin,
        method: "PUT",
        body: {
          name: "Andere Person",
          email: "other@example.de",
          role: "viewer",
          active: true,
        },
      })
    ).status,
    200,
  );
  assert.equal((await request("/me", { session: other })).status, 401);
  assert.equal(
    (await lists(admin)).data[0].assignees.some((a) => a.id === other.user.id),
    false,
  );
  assert.equal(
    (
      await request(`/users/${admin.user.id}`, {
        session: admin,
        method: "PUT",
        body: {
          name: "Admin",
          email: "admin@example.de",
          role: "viewer",
          active: true,
        },
      })
    ).status,
    400,
  );
});
test("Listen bleiben gespeichert bis zur ausdrücklich bestätigten Löschung durch Administration", async () => {
  assert.equal((await lists(admin)).data[0].published_count, 2);
  for (const session of [viewer, employee])
    assert.equal(
      (
        await request(`/lists/${list}`, {
          session,
          method: "DELETE",
          body: { confirm_name: "Testliste" },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await request(`/lists/${list}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_name: "Falsch" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/lists/${list}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_name: "Testliste" },
      })
    ).status,
    200,
  );
  for (const session of [admin, employee, viewer]) {
    assert.deepEqual((await lists(session)).data, []);
    assert.deepEqual((await records(session)).data, []);
    assert.equal(
      (await request(`/lists/${list}/points`, { session })).status,
      403,
    );
  }
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  assert.ok(
    db.prepare("SELECT deleted_at FROM lists WHERE id=?").get(list).deleted_at,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM flushes").get().n, 4);
  db.close();
});
test("Abmeldung, Deaktivierung und Login-Drosselung", async () => {
  assert.equal(
    (await request("/logout", { session: employee, body: {} })).status,
    200,
  );
  assert.equal((await request("/me", { session: employee })).status, 401);
  assert.equal(
    (
      await request(`/users/${viewer.user.id}`, {
        session: admin,
        method: "PUT",
        body: {
          name: "Betrachter",
          email: "viewer@example.de",
          role: "viewer",
          active: false,
        },
      })
    ).status,
    200,
  );
  assert.equal((await request("/me", { session: viewer })).status, 401);
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await request("/login", {
          body: { email: "nobody@example.de", password: "wrong" },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await request("/login", {
        body: { email: "nobody@example.de", password: "wrong" },
      })
    ).status,
    429,
  );
});
test("Migration sichert und erhält alte Messungen, auch wiederholte Spülungen; Neustart ist idempotent", async () => {
  const path = join(dir, "legacy.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE lists(id INTEGER PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);INSERT INTO lists(name) VALUES('Altbestand');CREATE TABLE points(id INTEGER PRIMARY KEY,list_id INTEGER NOT NULL,code TEXT NOT NULL UNIQUE,address TEXT NOT NULL,target REAL NOT NULL,active INTEGER NOT NULL DEFAULT 1);INSERT INTO points(list_id,code,address,target) VALUES(1,'ALT-1','Heppenheim',2),(1,'ALT-2','Heppenheim',3);CREATE TABLE flushes(id INTEGER PRIMARY KEY,point_id INTEGER NOT NULL,user_id INTEGER NOT NULL,temperature_before REAL NOT NULL,temperature_after REAL NOT NULL,volume REAL NOT NULL,turbidity INTEGER NOT NULL,flushed_at TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',code_snapshot TEXT NOT NULL,address_snapshot TEXT NOT NULL,target_snapshot REAL NOT NULL,employee_snapshot TEXT NOT NULL);INSERT INTO flushes(point_id,user_id,temperature_before,temperature_after,volume,turbidity,flushed_at,code_snapshot,address_snapshot,target_snapshot,employee_snapshot) VALUES(1,1,20,14,2,0,'2025-01-01','ALT-1','Heppenheim',2,'Alt'),(1,1,21,15,2.1,0,'2025-01-02','ALT-1','Heppenheim',2,'Alt'),(2,1,20,14,3,0,'2025-01-03','ALT-2','Heppenheim',3,'Alt');`,
  );
  db.close();
  let instance = await start(path);
  await stop(instance.process);
  let migrated = new DatabaseSync(path);
  assert.equal(
    migrated
      .prepare("SELECT count(*) n FROM flushes WHERE run_id IS NOT NULL")
      .get().n,
    3,
  );
  assert.equal(
    migrated.prepare("SELECT status FROM list_runs").get().status,
    "review",
  );
  migrated.close();
  const backups = readdirSync(dir).filter((f) =>
    f.includes(".before-workflow-"),
  );
  assert.equal(backups.length, 1);
  instance = await start(path);
  await stop(instance.process);
  migrated = new DatabaseSync(path);
  assert.equal(migrated.prepare("SELECT count(*) n FROM list_runs").get().n, 1);
  assert.equal(migrated.prepare("SELECT count(*) n FROM flushes").get().n, 3);
  migrated.close();
  assert.equal(
    readdirSync(dir).filter((f) => f.includes(".before-workflow-")).length,
    1,
  );
});

test("Produktivstart verweigert unsichere Herkunft, Cookies und Demo-Konten", () => {
  for (const config of [
    { APP_ORIGIN: "http://intern.example" },
    { COOKIE_SECURE: "false" },
    { DEMO_MODE: "true" },
    { APP_ORIGIN: "" },
  ]) {
    const result = spawnSync(process.execPath, ["server.js"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_ORIGIN: "https://intern.example",
        COOKIE_SECURE: "true",
        DEMO_MODE: "false",
        DB_PATH: join(dir, "guard.sqlite"),
        ...config,
      },
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Produktiv/);
    assert.equal(existsSync(join(dir, "guard.sqlite")), false);
  }
});

test("Alle Rollen ändern das eigene Passwort; andere Sitzungen werden ungültig", async () => {
  for (const role of ["admin", "employee", "viewer"]) {
    const email = `self-${role}@example.de`;
    assert.equal(
      (
        await request("/users", {
          session: admin,
          body: { name: "Eigenes Konto", email, role, password },
        })
      ).status,
      201,
    );
    const primary = await login(email),
      secondary = await login(email),
      nextPassword = "Neues-Passwort-2026!";
    assert.equal(
      (
        await request("/account/password", {
          session: primary,
          body: {
            current_password: "wrong",
            new_password: nextPassword,
            confirm_password: nextPassword,
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/account/password", {
          session: primary,
          csrf: false,
          body: {
            current_password: password,
            new_password: nextPassword,
            confirm_password: nextPassword,
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/account/password", {
          session: primary,
          body: {
            current_password: password,
            new_password: nextPassword,
            confirm_password: "mismatch",
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/account/password", {
          session: primary,
          body: {
            current_password: password,
            new_password: password,
            confirm_password: password,
          },
        })
      ).status,
      400,
    );
    const changed = await request("/account/password", {
      session: primary,
      body: {
        current_password: password,
        new_password: nextPassword,
        confirm_password: nextPassword,
      },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.must_change_password, false);
    assert.equal((await request("/me", { session: secondary })).status, 401);
    const updated = { ...changed.data, cookie: changed.cookie };
    assert.equal((await request("/me", { session: updated })).status, 200);
    assert.equal(
      (await request("/login", { body: { email, password } })).status,
      401,
    );
    assert.equal(
      (await request("/login", { body: { email, password: nextPassword } }))
        .status,
      200,
    );
  }
});
test("Admin-Einmalpasswort ist nur einmal gültig; erzwungener Wechsel sperrt Arbeitsdaten", async () => {
  const email = "reset@example.de";
  const created = await request("/users", {
    session: admin,
    body: { name: "Reset Konto", email, role: "employee", password },
  });
  assert.equal(created.status, 201);
  const target = await login(email),
    id = created.data.id;
  assert.equal(
    (
      await request(`/users/${id}/reset-password`, {
        session: target,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/users/${id}/reset-password`, {
        session: admin,
        csrf: false,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/users/${admin.user.id}/reset-password`, {
        session: admin,
        body: {},
      })
    ).status,
    400,
  );
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await request("/account/password", {
          session: target,
          body: {
            current_password: "wrong",
            new_password: "Falsches-Alt-2026!",
            confirm_password: "Falsches-Alt-2026!",
          },
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request("/account/password", {
        session: target,
        body: {
          current_password: "wrong",
          new_password: "Falsches-Alt-2026!",
          confirm_password: "Falsches-Alt-2026!",
        },
      })
    ).status,
    429,
  );
  const result = await request(`/users/${id}/reset-password`, {
    session: admin,
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.expires_in_minutes, 10);
  const temporary = result.data.temporary_password;
  assert.match(temporary, /^[A-Z][a-z]+\d{4}$/);
  assert.equal((await request("/me", { session: target })).status, 401);
  assert.equal(
    (await request("/login", { body: { email, password } })).status,
    401,
  );
  const signed = await request("/login", {
    body: { email, password: temporary },
  });
  assert.equal(signed.status, 200);
  assert.equal(signed.data.user.must_change_password, true);
  const restricted = { ...signed.data, cookie: signed.cookie };
  assert.equal(
    (await request("/login", { body: { email, password: temporary } })).status,
    401,
  );
  for (const path of ["/lists", "/flushes", "/users"]) {
    const denied = await request(path, { session: restricted });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, "PASSWORD_CHANGE_REQUIRED");
  }
  assert.equal(
    (await request("/me", { session: restricted })).data.user
      .must_change_password,
    true,
  );
  assert.equal(
    (
      await request("/account/password", {
        session: restricted,
        body: { new_password: "Giraffe1234", confirm_password: "Giraffe1234" },
      })
    ).status,
    400,
  );
  const next = "Persoenliches-Passwort-2026!";
  const changed = await request("/account/password", {
    session: restricted,
    body: { new_password: next, confirm_password: next },
  });
  assert.equal(changed.status, 200);
  assert.equal((await request("/me", { session: restricted })).status, 401);
  const updated = { ...changed.data, cookie: changed.cookie };
  assert.equal((await lists(updated)).status, 200);
  assert.equal(
    (await request("/login", { body: { email, password: temporary } })).status,
    401,
  );
  assert.equal(
    (await request("/login", { body: { email, password: next } })).status,
    200,
  );
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  const stored = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  assert.notEqual(stored.password, temporary);
  assert.notEqual(stored.password, next);
  assert.equal(stored.must_change_password, 0);
  assert.equal(stored.temporary_expires, null);
  db.close();
});
test("Abgelaufene und ersetzte Einmalpasswörter, Admin-Zugänge und Umgehungsversuche", async () => {
  const email = "expire@example.de";
  const created = await request("/users", {
    session: admin,
    body: { name: "Ablauf Konto", email, role: "admin", password },
  });
  const id = created.data.id;
  const first = await request(`/users/${id}/reset-password`, {
    session: admin,
    body: {},
  });
  const second = await request(`/users/${id}/reset-password`, {
    session: admin,
    body: {},
  });
  assert.notEqual(
    first.data.temporary_password,
    second.data.temporary_password,
  );
  assert.equal(
    (
      await request("/login", {
        body: { email, password: first.data.temporary_password },
      })
    ).status,
    401,
  );
  const signed = await request("/login", {
    body: { email, password: second.data.temporary_password },
  });
  assert.equal(signed.status, 200);
  const restricted = { ...signed.data, cookie: signed.cookie };
  assert.equal((await request("/users", { session: restricted })).status, 403);
  assert.equal(
    (
      await request(`/users/${admin.user.id}/reset-password`, {
        session: restricted,
        body: {},
      })
    ).data.code,
    "PASSWORD_CHANGE_REQUIRED",
  );
  assert.equal(
    (await request("/logout", { session: restricted, body: {} })).status,
    200,
  );
  const third = await request(`/users/${id}/reset-password`, {
    session: admin,
    body: {},
  });
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  db.prepare("UPDATE users SET temporary_expires=? WHERE id=?").run(
    Date.now() - 1,
    id,
  );
  db.close();
  assert.equal(
    (
      await request("/login", {
        body: { email, password: third.data.temporary_password },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(`/users/${id}`, {
        session: admin,
        method: "PUT",
        body: {
          name: "Ablauf Konto",
          email,
          role: "admin",
          active: true,
          password: "Admin-Bypass-2026!",
        },
      })
    ).status,
    400,
  );
});
