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
  assert.deepEqual((await lists(admin)).data[0].assignees, []);
  assert.deepEqual((await lists(viewer)).data, []);
  assert.equal((await flush(p1, admin)).status, 403);
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
    (
      await request(`/lists/${list}/points?run=${active.run_id}`, {
        session: viewer,
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(`/lists/${list}/points?run=9999999`, { session: viewer }))
      .status,
    403,
  );
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
  const archives = (await lists(viewer)).data;
  assert.equal(archives[0].run_number, 2);
  assert.equal(archives.length, 2);
  assert.equal(archives[0].id, archives[1].id);
  assert.notEqual(archives[0].run_id, archives[1].run_id);
  for (const archive of archives) {
    assert.ok(Number.isFinite(Date.parse(archive.published_at)));
    assert.deepEqual(archive.assignees, []);
    const detail = await request(
      `/lists/${list}/points?run=${archive.run_id}`,
      { session: viewer },
    );
    assert.equal(detail.status, 200);
    assert.equal(
      detail.data.find((p) => p.id === p1).code,
      archive.run_number === 1 ? "SP-1" : "SP-NEU",
    );
    const measurements = (
      await request(`/flushes?run=${archive.run_id}`, { session: viewer })
    ).data;
    assert.equal(measurements.length, 2);
    assert.ok(measurements.every((f) => f.run_id === archive.run_id));
  }
  assert.deepEqual((await lists(admin)).data[0].assignees, []);
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
  const sessionDb = new DatabaseSync(join(dir, "test.sqlite"));
  const restrictedDeadline = sessionDb
    .prepare("SELECT expires FROM sessions WHERE csrf=?")
    .get(restricted.csrf).expires;
  assert.ok(restrictedDeadline <= Date.now() + 10 * 60000);
  await request("/me", { session: restricted });
  assert.equal(
    sessionDb
      .prepare("SELECT expires FROM sessions WHERE csrf=?")
      .get(restricted.csrf).expires,
    restrictedDeadline,
  );
  sessionDb.close();
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

test("ESP32-Messungen erhalten dauerhafte, eigene Speicherbestätigungen und idempotente Wiederholungen", async () => {
  const employeeSession = await login("employee@example.de");
  const l = await request("/lists", {
    session: admin,
    body: { name: "ESP32-Übertragung" },
  });
  const listId = l.data.id;
  const point = await request("/points", {
    session: admin,
    body: {
      list_id: listId,
      code: "SP-BLE",
      address: "Heppenheim",
      target: 2.5,
    },
  });
  assert.equal(
    (
      await request(`/lists/${listId}/assignments`, {
        session: admin,
        method: "PUT",
        body: { user_ids: [employeeSession.user.id] },
      })
    ).status,
    200,
  );
  const runId = (await lists(employeeSession)).data.find(
    (l) => l.id === listId,
  ).run_id;
  const data = {
    ...values,
    volume: 2.5,
    temperature_before: 12.45,
    temperature_after: 9.82,
    source: "esp32",
    request_id: crypto.randomUUID(),
    run_id: runId,
    measurement_point_code: "SP-BLE",
    measurement_target: 2.5,
  };
  assert.equal(
    (
      await request(`/points/${point.data.id}/flushes`, {
        session: employeeSession,
        body: { ...data, request_id: undefined },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/points/${point.data.id}/flushes`, {
        session: employeeSession,
        body: { ...data, measurement_point_code: "FREMD" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/points/${point.data.id}/flushes`, {
        session: employeeSession,
        body: { ...data, run_id: runId + 1 },
      })
    ).status,
    409,
  );
  const saved = await request(`/points/${point.data.id}/flushes`, {
    session: employeeSession,
    body: data,
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.status, "review");
  assert.equal(saved.data.receipt.saved, true);
  assert.equal(saved.data.receipt.source, "esp32");
  assert.equal(saved.data.receipt.request_id, data.request_id);
  assert.equal(saved.data.receipt.temperature_before, 12.45);
  assert.equal(
    (await lists(employeeSession)).data.some((l) => l.id === listId),
    false,
  );
  const receipt = await request(`/flushes/${saved.data.id}/receipt`, {
    session: employeeSession,
  });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.id, saved.data.id);
  const recovered = await request(`/measurement-receipts/${data.request_id}`, {
    session: employeeSession,
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, saved.data.receipt);
  assert.equal(
    (
      await request(`/measurement-receipts/${data.request_id}`, {
        session: admin,
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(`/flushes/${saved.data.id}/receipt`, { session: admin }))
      .status,
    404,
  );
  const retried = await request(`/points/${point.data.id}/flushes`, {
    session: employeeSession,
    body: data,
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.id, saved.data.id);
  assert.deepEqual(retried.data.receipt, saved.data.receipt);
  assert.equal(
    (
      await request(`/points/${point.data.id}/flushes`, {
        session: employeeSession,
        body: { ...data, volume: 3 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/points/${point.data.id}/flushes`, {
        session: admin,
        body: data,
      })
    ).status,
    409,
  );
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM flushes WHERE request_id=?")
      .get(data.request_id).n,
    1,
  );
  db.close();
});

test("Interne Bemerkungen werden quittiert und niemals an Betrachter ausgeliefert", async () => {
  const employeeSession = await login("employee@example.de"),
    viewerSession = await login("other@example.de");
  const l = await request("/lists", {
      session: admin,
      body: { name: "Interne Hinweise" },
    }),
    listId = l.data.id;
  const p = await request("/points", {
    session: admin,
    body: {
      list_id: listId,
      code: "SP-NOTE",
      address: "Heppenheim",
      target: 2,
    },
  });
  await request(`/lists/${listId}/assignments`, {
    session: admin,
    method: "PUT",
    body: { user_ids: [employeeSession.user.id] },
  });
  const requestId = crypto.randomUUID(),
    content = "Hydrant undicht. Interne Telefonnummer: TEST-PRIVAT";
  const data = { ...values, note: content, request_id: requestId };
  assert.equal(
    (
      await request(`/points/${p.data.id}/flushes`, {
        session: employeeSession,
        body: { ...data, note: "x".repeat(2001) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/points/${p.data.id}/flushes`, {
        session: employeeSession,
        body: data,
      })
    ).status,
    201,
  );
  const own = (
    await request("/internal-notes", { session: employeeSession })
  ).data.find((n) => n.content === content);
  assert.ok(own);
  assert.equal(own.point_id, p.data.id);
  assert.ok(
    (await request("/internal-notes", { session: admin })).data.some(
      (n) => n.id === own.id,
    ),
  );
  const outsider = await request("/users", {
    session: admin,
    body: {
      name: "Unbeteiligter Mitarbeiter",
      email: "unbeteiligt@example.de",
      role: "employee",
      password,
    },
  });
  assert.equal(outsider.status, 201);
  const otherEmployee = await login("unbeteiligt@example.de");
  assert.equal(
    (await request("/internal-notes", { session: otherEmployee })).data.some(
      (n) => n.id === own.id,
    ),
    false,
  );
  assert.equal(
    (
      await request("/internal-notes/acknowledge", {
        session: otherEmployee,
        body: { ids: [own.id] },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/internal-notes", { session: viewerSession })).status,
    403,
  );
  assert.equal(
    (
      await request("/internal-notes/acknowledge", {
        session: viewerSession,
        body: { ids: [own.id] },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(`/lists/${listId}/publish`, { session: admin, body: {} }))
      .status,
    200,
  );
  const published = (await records(viewerSession)).data.find(
    (r) => r.point_id === p.data.id,
  );
  assert.ok(published);
  assert.equal("note" in published, false);
  assert.equal("content" in published, false);
  assert.equal(JSON.stringify(published).includes(content), false);
  assert.equal(
    (
      await request(`/points/${p.data.id}/flushes`, {
        session: employeeSession,
        body: data,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/points/${p.data.id}/flushes`, {
        session: employeeSession,
        body: { ...data, note: "Geändert" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/internal-notes/acknowledge", {
        session: employeeSession,
        csrf: false,
        body: { ids: [own.id] },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/internal-notes/acknowledge", {
        session: employeeSession,
        body: { ids: [own.id] },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/internal-notes", { session: admin })).data.some(
      (n) => n.id === own.id,
    ),
    false,
  );
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  const stored = db
    .prepare("SELECT * FROM internal_notes WHERE id=?")
    .get(own.id);
  assert.equal(stored.content, content);
  assert.equal(stored.acknowledged_by, employeeSession.user.id);
  assert.ok(stored.acknowledged_at);
  db.close();
});

test("Admin löscht einzelne Fehlmessungen und abgeschlossene Durchläufe nur nach Bestätigung", async () => {
  const employeeSession = await login("employee@example.de"),
    viewerSession = await login("other@example.de");
  const listId = (
    await request("/lists", { session: admin, body: { name: "Löschprüfung" } })
  ).data.id;
  const pointIds = [];
  for (const code of ["DELETE-1", "DELETE-2"])
    pointIds.push(
      (
        await request("/points", {
          session: admin,
          body: { list_id: listId, code, address: "Heppenheim", target: 2 },
        })
      ).data.id,
    );
  await request(`/lists/${listId}/assignments`, {
    session: admin,
    method: "PUT",
    body: { user_ids: [employeeSession.user.id] },
  });
  const runId = (await lists(admin)).data.find((l) => l.id === listId).run_id;
  const data = {
    ...values,
    source: "esp32",
    request_id: crypto.randomUUID(),
    measurement_point_code: "DELETE-1",
    measurement_target: 2,
    run_id: runId,
    note: "Defekte Messung",
  };
  const saved = await request(`/points/${pointIds[0]}/flushes`, {
    session: employeeSession,
    body: data,
  });
  assert.equal(saved.status, 201);
  assert.equal(
    (
      await request(`/runs/${runId}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_name: "Löschprüfung" },
      })
    ).status,
    409,
  );
  for (const session of [employeeSession, viewerSession]) {
    assert.equal(
      (
        await request(`/flushes/${saved.data.id}`, {
          session,
          method: "DELETE",
          body: { confirm_code: "DELETE-1" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`/runs/${runId}`, {
          session,
          method: "DELETE",
          body: { confirm_name: "Löschprüfung" },
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await request(`/flushes/${saved.data.id}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_code: "falsch" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/flushes/${saved.data.id}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_code: "DELETE-1" },
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/flushes/${saved.data.id}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_code: "DELETE-1" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await records(admin)).data.some((f) => f.id === saved.data.id),
    false,
  );
  assert.equal(
    (await request("/internal-notes", { session: admin })).data.some(
      (n) => n.content === "Defekte Messung",
    ),
    false,
  );
  assert.equal(
    (
      await request(`/flushes/${saved.data.id}/receipt`, {
        session: employeeSession,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/measurement-receipts/${data.request_id}`, {
        session: employeeSession,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/points/${pointIds[0]}/flushes`, {
        session: employeeSession,
        body: data,
      })
    ).status,
    409,
  );
  assert.equal(
    (await lists(employeeSession)).data.find((l) => l.id === listId)
      .completed_count,
    0,
  );
  await flush(pointIds[0], employeeSession);
  const second = await flush(pointIds[1], employeeSession);
  assert.equal(second.data.status, "review");
  await request(`/lists/${listId}/publish`, { session: admin, body: {} });
  assert.equal(
    (
      await request(`/flushes/${second.data.id}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_code: "DELETE-2" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/flushes?run=${runId}`, { session: viewerSession })).data
      .length,
    1,
  );
  assert.equal(
    (
      await request(`/lists/${listId}/points?run=${runId}`, {
        session: viewerSession,
      })
    ).data.length,
    1,
  );
  assert.equal(
    (
      await request(`/lists/${listId}/restart`, {
        session: admin,
        body: { user_ids: [employeeSession.user.id] },
      })
    ).status,
    201,
  );
  const active = (await lists(employeeSession)).data.find(
    (l) => l.id === listId,
  );
  assert.equal(
    (
      await request(`/runs/${runId}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_name: "falsch" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/runs/${runId}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_name: "Löschprüfung" },
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/runs/${runId}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_name: "Löschprüfung" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/report-runs", { session: viewerSession })).data.some(
      (r) => r.id === runId,
    ),
    false,
  );
  assert.equal(
    (
      await request(`/lists/${listId}/points?run=${runId}`, {
        session: viewerSession,
      })
    ).status,
    403,
  );
  assert.equal(
    (await lists(employeeSession)).data.find((l) => l.id === listId).run_id,
    active.run_id,
  );
  await flush(pointIds[0], employeeSession);
  await flush(pointIds[1], employeeSession);
  assert.equal(
    (
      await request(`/runs/${active.run_id}`, {
        session: admin,
        method: "DELETE",
        body: { confirm_name: "Löschprüfung" },
      })
    ).status,
    200,
  );
  const template = (await lists(admin)).data.find((l) => l.id === listId);
  assert.equal(template.deleted_run, true);
  assert.equal(template.point_count, 0);
  assert.equal(
    (
      await request(`/lists/${listId}/restart`, {
        session: admin,
        body: { user_ids: [employeeSession.user.id] },
      })
    ).status,
    201,
  );
  assert.equal(
    (await lists(employeeSession)).data.find((l) => l.id === listId).run_number,
    3,
  );
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  assert.equal(
    db.prepare("SELECT deleted_by FROM flushes WHERE id=?").get(saved.data.id)
      .deleted_by,
    admin.user.id,
  );
  assert.ok(
    db.prepare("SELECT deleted_at FROM list_runs WHERE id=?").get(runId)
      .deleted_at,
  );
  db.close();
});

test("Statistikreset ist bestätigt, rollenbeschränkt, dauerhaft und erhält sämtliche Protokolle", async () => {
  const employeeSession = await login("employee@example.de"),
    viewerSession = await login("other@example.de");
  const before = (await records(admin)).data;
  for (const session of [employeeSession, viewerSession])
    assert.equal(
      (
        await request("/statistics/reset", {
          session,
          body: { confirm: "STATISTIK ZURÜCKSETZEN" },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await request("/statistics/reset", {
        session: admin,
        body: { confirm: "ja" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/statistics/reset", {
        session: admin,
        body: { confirm: "STATISTIK ZURÜCKSETZEN" },
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/statistics/reset", {
        session: admin,
        body: { confirm: "STATISTIK ZURÜCKSETZEN" },
      })
    ).status,
    200,
  );
  const settings = (await request("/statistics/settings", { session: admin }))
    .data;
  assert.ok(settings.reset_at);
  assert.equal(before.filter((f) => f.id > settings.after_id).length, 0);
  assert.deepEqual((await records(admin)).data, before);
  const targetList = (await lists(employeeSession)).data.find(
    (l) => l.name === "Löschprüfung",
  );
  const point = (
    await request(`/lists/${targetList.id}/points`, {
      session: employeeSession,
    })
  ).data[0];
  assert.equal((await flush(point.id, employeeSession)).status, 201);
  const counted = (await records(admin)).data.filter(
    (f) => f.id > settings.after_id,
  );
  assert.equal(counted.length, 1);
  assert.equal(counted[0].volume, values.volume);
  await stop(child);
  const restarted = await start(join(dir, "test.sqlite"));
  child = restarted.process;
  base = restarted.base;
  assert.deepEqual(
    (await request("/statistics/settings", { session: admin })).data,
    settings,
  );
  assert.equal(
    (await request("/report-runs", { session: admin })).data.some(
      (r) => r.name === "Löschprüfung" && r.number < 3,
    ),
    false,
  );
});

test("Normale Anmeldung bleibt 30 Tage bestehen und verlängert sich bei Nutzung; abgelaufene Sitzungen bleiben gesperrt", async () => {
  const response = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email: "admin@example.de", password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const data = await response.json(),
    session = { ...data, cookie: cookie.split(";")[0] };
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  const initial = db
    .prepare("SELECT expires FROM sessions WHERE csrf=?")
    .get(session.csrf).expires;
  assert.ok(initial > Date.now() + 29 * 24 * 3600000);
  assert.equal(
    (await request("/me", { session })).cookie,
    undefined,
    "a recent session need not write a new cookie on every request",
  );
  db.prepare("UPDATE sessions SET expires=? WHERE csrf=?").run(
    Date.now() + 7 * 3600000,
    session.csrf,
  );
  const refreshed = await request("/me", { session });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.cookie?.startsWith("sp_session="));
  const extended = db
    .prepare("SELECT expires FROM sessions WHERE csrf=?")
    .get(session.csrf).expires;
  assert.ok(extended > Date.now() + 29 * 24 * 3600000);
  assert.equal((await request("/me", { session })).cookie, undefined);
  db.prepare("UPDATE sessions SET expires=? WHERE csrf=?").run(
    Date.now() - 1,
    session.csrf,
  );
  assert.equal((await request("/me", { session })).status, 401);
  assert.ok(
    db.prepare("SELECT expires FROM sessions WHERE csrf=?").get(session.csrf)
      .expires < Date.now(),
  );
  db.close();
});

test("Durchflussmessungen bleiben intern, gehören Mitarbeitern und speichern eine vollständige Kurve ohne Temperaturen", async () => {
  const employeeSession = await login("employee@example.de"),
    viewerSession = await login("other@example.de");
  await request("/users", {
    session: admin,
    body: {
      name: "Durchfluss Kollege",
      email: "flow-colleague@example.de",
      role: "employee",
      password,
    },
  });
  const colleague = await login("flow-colleague@example.de");
  const body = {
    address: "Teststraße 10, Heppenheim",
    remark: "Nur intern sichtbar",
    request_id: crypto.randomUUID(),
  };
  const started = await request("/flow-measurements", {
    session: employeeSession,
    body,
  });
  assert.equal(started.status, 201);
  const id = started.data.id;
  assert.equal(started.data.status, "active");
  assert.equal(started.data.last_seq, -1);
  assert.equal(
    (await request("/flow-measurements", { session: employeeSession, body }))
      .data.id,
    id,
  );
  assert.equal(
    (
      await request("/flow-measurements", {
        session: employeeSession,
        body: { ...body, request_id: crypto.randomUUID() },
      })
    ).status,
    409,
  );
  for (const [path, method, payload] of [
    ["/flow-measurements", "GET"],
    ["/flow-measurements", "POST", body],
    [`/flow-measurements/${id}`, "GET"],
    [`/flow-measurements/${id}/series`, "GET"],
    [`/flow-measurements/${id}`, "PUT", body],
    [
      `/flow-measurements/${id}/samples`,
      "POST",
      { samples: [{ seq: 0, elapsed_ms: 0, flow: 2 }] },
    ],
    [`/flow-measurements/${id}/finish`, "POST", { last_seq: -1 }],
    [`/flow-measurements/${id}`, "DELETE", { confirm_address: body.address }],
  ])
    assert.equal(
      (await request(path, { session: viewerSession, method, body: payload }))
        .status,
      403,
    );
  assert.equal(
    (await request(`/flow-measurements/${id}`, { session: colleague })).status,
    404,
  );
  assert.equal(
    (await request(`/flow-measurements/${id}/series`, { session: colleague }))
      .status,
    404,
  );
  assert.deepEqual(
    (await request("/flow-measurements", { session: colleague })).data,
    [],
  );
  assert.equal(
    (await request(`/flow-measurements/${id}`, { session: admin })).status,
    200,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: admin,
        body: { samples: [{ seq: 0, elapsed_ms: 0, flow: 2 }] },
      })
    ).status,
    403,
  );
  const samples = [
    { seq: 0, elapsed_ms: 0, flow: 0 },
    { seq: 1, elapsed_ms: 1000, flow: 4.5 },
    { seq: 2, elapsed_ms: 20000, flow: 8 },
  ];
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: employeeSession,
        body: { samples },
        csrf: false,
      })
    ).status,
    403,
  );
  for (const invalid of [
    [],
    [{ seq: 0, elapsed_ms: 0, flow: -1 }],
    [{ seq: 0, elapsed_ms: 0, flow: "2" }],
    [{ seq: 0, elapsed_ms: 1e12, flow: 2 }],
    [{ seq: 2, elapsed_ms: 0, flow: 2 }],
  ])
    assert.ok(
      [400, 409].includes(
        (
          await request(`/flow-measurements/${id}/samples`, {
            session: employeeSession,
            body: { samples: invalid },
          })
        ).status,
      ),
    );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: employeeSession,
        body: { samples },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: employeeSession,
        body: { samples },
      })
    ).data.sample_count,
    3,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: employeeSession,
        body: { samples: [{ ...samples[0], flow: 99 }] },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: employeeSession,
        body: {
          samples: [
            { seq: 3, elapsed_ms: 21000, flow: 2 },
            { seq: 5, elapsed_ms: 22000, flow: 3 },
          ],
        },
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(`/flow-measurements/${id}`, { session: employeeSession }))
      .data.sample_count,
    3,
    "a rejected batch must roll back atomically",
  );
  const series = (
    await request(`/flow-measurements/${id}/series`, {
      session: employeeSession,
    })
  ).data;
  assert.deepEqual(
    series.map((p) => p.flow),
    [0, 4.5, 8],
  );
  assert.equal(series[2].segment, 1);
  assert.equal("temperature" in series[0], false);
  assert.equal(
    (
      await request(`/flow-measurements/${id}/finish`, {
        session: employeeSession,
        body: { last_seq: 1 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}`, {
        session: employeeSession,
        method: "DELETE",
        body: { confirm_address: body.address },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}`, {
        session: employeeSession,
        method: "PUT",
        body: { address: body.address, remark: "x".repeat(2001) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}`, {
        session: employeeSession,
        method: "PUT",
        body: { address: body.address, remark: "Korrigierte Bemerkung" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/finish`, {
        session: employeeSession,
        body: { last_seq: 2 },
      })
    ).data.status,
    "completed",
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/finish`, {
        session: employeeSession,
        body: { last_seq: 2 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: employeeSession,
        body: { samples },
      })
    ).status,
    200,
    "replay after a lost save response remains idempotent",
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/samples`, {
        session: employeeSession,
        body: { samples: [{ seq: 3, elapsed_ms: 21000, flow: 2 }] },
      })
    ).status,
    409,
  );
  assert.equal(
    JSON.stringify((await records(viewerSession)).data).includes(body.address),
    false,
  );
  await stop(child);
  const restarted = await start(join(dir, "test.sqlite"));
  child = restarted.process;
  base = restarted.base;
  assert.deepEqual(
    (
      await request(`/flow-measurements/${id}/series`, {
        session: employeeSession,
      })
    ).data,
    series,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}`, {
        session: employeeSession,
        method: "DELETE",
        body: { confirm_address: "Falsch" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}`, {
        session: employeeSession,
        method: "DELETE",
        body: { confirm_address: body.address },
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}`, {
        session: employeeSession,
        method: "DELETE",
        body: { confirm_address: body.address },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/flow-measurements/${id}/series`, {
        session: employeeSession,
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("/flow-measurements", { session: employeeSession, body }))
      .status,
    409,
  );
});

test("Lange Durchflussmessungen behalten alle Rohwerte; die Diagrammansicht begrenzt nur die Anzeige und bewahrt Spitzen", async () => {
  const employeeSession = await login("employee@example.de");
  const id = (
    await request("/flow-measurements", {
      session: employeeSession,
      body: { address: "Langzeitkurve", request_id: crypto.randomUUID() },
    })
  ).data.id;
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  db.prepare("UPDATE flow_measurements SET started_at=? WHERE id=?").run(
    new Date(Date.now() - 3600000).toISOString(),
    id,
  );
  db.close();
  const samples = Array.from({ length: 2401 }, (_, seq) => ({
    seq,
    elapsed_ms: seq * 1000,
    flow: seq === 777 ? 900000 : seq % 20,
  }));
  for (let i = 0; i < samples.length; i += 200)
    assert.equal(
      (
        await request(`/flow-measurements/${id}/samples`, {
          session: employeeSession,
          body: { samples: samples.slice(i, i + 200) },
        })
      ).status,
      200,
    );
  const summary = (
    await request(`/flow-measurements/${id}`, { session: employeeSession })
  ).data;
  assert.equal(summary.sample_count, 2401);
  const series = (
    await request(`/flow-measurements/${id}/series`, {
      session: employeeSession,
    })
  ).data;
  assert.ok(series.length <= 1000);
  assert.ok(series.some((p) => p.flow === 900000));
  assert.equal(series.at(-1).seq, 2400);
  assert.equal(
    (
      await request(`/flow-measurements/${id}/finish`, {
        session: employeeSession,
        body: { last_seq: 2400 },
      })
    ).data.status,
    "completed",
  );
});
