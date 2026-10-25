import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "spuelplan-test-"));
let child, base, admin, employee, viewer, other, list, point;
const password = "Test-Passwort-2026!";
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
  const data = await response.json();
  return {
    status: response.status,
    data,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
async function login(email) {
  const r = await request("/login", { body: { email, password } });
  assert.equal(r.status, 200);
  return { ...r.data, cookie: r.cookie };
}
before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      DB_PATH: join(dir, "test.sqlite"),
      DEMO_MODE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Server timeout: " + stderr)),
      10000,
    );
    child.stdout.on("data", (d) => {
      const m = d.toString().match(/Port (\d+)/);
      if (m) {
        base = "http://127.0.0.1:" + m[1];
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Server stopped " + code + ": " + stderr));
    });
  });
});
after(async () => {
  child?.kill();
  if (child?.exitCode === null)
    await new Promise((resolve) => child.once("exit", resolve));
  rmSync(dir, { recursive: true, force: true });
});

test("Ersteinrichtung ist schlüsselgeschützt und nur einmal möglich", async () => {
  assert.equal((await request("/status")).data.setupRequired, true);
  const data = { name: "Admin Test", email: "admin@example.de", password };
  assert.equal((await request("/setup", { body: data })).status, 403);
  assert.equal(
    (
      await request("/setup", {
        body: {
          ...data,
          setup_token: readFileSync(join(dir, "setup-token"), "utf8"),
        },
      })
    ).status,
    201,
  );
  assert.equal(existsSync(join(dir, "setup-token")), false);
  assert.equal((await request("/setup", { body: data })).status, 409);
  assert.equal((await request("/status")).data.setupRequired, false);
  admin = await login(data.email);
  assert.match(admin.cookie, /^sp_session=/);
});
test("Login verweigert falsches Passwort, API benötigt Sitzung und CSRF", async () => {
  assert.equal(
    (
      await request("/login", {
        body: { email: "admin@example.de", password: "wrong" },
      })
    ).status,
    401,
  );
  assert.equal((await request("/lists")).status, 401);
  assert.equal(
    (
      await request("/lists", {
        session: admin,
        body: { name: "Test" },
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/lists", {
        session: admin,
        body: { name: "Test" },
        origin: false,
      })
    ).status,
    403,
  );
});
test("Administration legt Mitarbeiter, Betrachter, Liste und Punkt an", async () => {
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
  const l = await request("/lists", {
    session: admin,
    body: { name: "Testliste", description: "Prüfgebiet" },
  });
  assert.equal(l.status, 201);
  list = l.data.id;
  const p = await request("/points", {
    session: admin,
    body: {
      list_id: list,
      code: "SP-TEST",
      address: "Wasserstraße 1",
      target: 2.5,
    },
  });
  assert.equal(p.status, 201);
  point = p.data.id;
  assert.equal(
    (
      await request("/points", {
        session: admin,
        body: { list_id: list, code: "SP-TEST", address: "Doppelt", target: 2 },
      })
    ).status,
    409,
  );
});
test("Listenfreigabe schützt Punkte und Protokolle serverseitig", async () => {
  assert.deepEqual((await request("/lists", { session: employee })).data, []);
  assert.equal(
    (await request(`/lists/${list}/points`, { session: employee })).status,
    403,
  );
  assert.equal(
    (
      await request(`/lists/${list}/assignments`, {
        session: admin,
        method: "PUT",
        body: { user_ids: [employee.user.id] },
      })
    ).status,
    200,
  );
  assert.equal((await request("/lists", { session: employee })).data.length, 1);
  assert.equal(
    (await request(`/lists/${list}/points`, { session: employee })).data.length,
    1,
  );
  assert.equal((await request("/lists", { session: viewer })).data.length, 1);
  assert.equal((await request("/users", { session: employee })).status, 403);
  assert.equal((await request("/users", { session: viewer })).status, 403);
  assert.equal(
    (await request("/lists", { session: viewer, body: { name: "Unzulässig" } }))
      .status,
    403,
  );
});
test("Nur freigegebene Mitarbeiter erfassen validierte, automatisch datierte Spülungen", async () => {
  const data = {
    temperature_before: 22.5,
    temperature_after: 14.2,
    volume: 2.7,
    turbidity: false,
    flushed_at: "2000-01-01",
    user_id: admin.user.id,
  };
  for (const session of [viewer, admin, other])
    assert.equal(
      (await request(`/points/${point}/flushes`, { session, body: data }))
        .status,
      403,
    );
  for (const change of [
    { temperature_before: -1 },
    { temperature_after: 101 },
    { volume: 0 },
    { turbidity: "Nein" },
    { volume: "2.7" },
  ])
    assert.equal(
      (
        await request(`/points/${point}/flushes`, {
          session: employee,
          body: { ...data, ...change },
        })
      ).status,
      400,
    );
  const before = Date.now();
  assert.equal(
    (
      await request(`/points/${point}/flushes`, {
        session: employee,
        body: data,
      })
    ).status,
    201,
  );
  const rows = (await request("/flushes", { session: viewer })).data;
  assert.equal(rows.length, 1);
  const f = rows[0];
  assert.equal(f.employee, "Mitarbeiter");
  assert.equal(f.user_id, employee.user.id);
  assert.equal(f.volume, 2.7);
  assert.equal(f.target, 2.5);
  assert.equal(f.turbidity, 0);
  assert.equal(f.list_id, list);
  assert.ok(new Date(f.flushed_at).getTime() >= before);
  assert.equal(
    (await request(`/lists/${list}/points`, { session: employee })).data[0]
      .last_flush,
    f.flushed_at,
  );
  assert.deepEqual((await request("/flushes", { session: other })).data, []);
});
test("Änderungen an Stammdaten verändern keinen historischen Nachweis", async () => {
  assert.equal(
    (
      await request("/points/" + point, {
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
  assert.equal(
    (
      await request("/users/" + employee.user.id, {
        session: admin,
        method: "PUT",
        body: {
          name: "Neuer Name",
          email: "employee@example.de",
          role: "employee",
          active: true,
        },
      })
    ).status,
    200,
  );
  const f = (await request("/flushes", { session: viewer })).data[0];
  assert.equal(f.code, "SP-TEST");
  assert.equal(f.address, "Wasserstraße 1");
  assert.equal(f.target, 2.5);
  assert.equal(f.employee, "Mitarbeiter");
});
test("Administration erhält Listenfreigaben; Betrachter bleiben ausgeschlossen", async () => {
  const values = {
    temperature_before: 21,
    temperature_after: 15,
    volume: 5,
    turbidity: false,
  };
  assert.equal(
    (
      await request(`/lists/${list}/assignments`, {
        session: admin,
        method: "PUT",
        body: { user_ids: [viewer.user.id] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/points/${point}/flushes`, {
        session: admin,
        body: values,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/lists/${list}/assignments`, {
        session: admin,
        method: "PUT",
        body: { user_ids: [admin.user.id, employee.user.id] },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/points/${point}/flushes`, {
        session: admin,
        body: values,
      })
    ).status,
    201,
  );
  const row = (await request("/flushes", { session: admin })).data[0];
  assert.equal(row.user_id, admin.user.id);
  assert.equal(row.employee, "Admin Test");
  // Editing an administrator must preserve their existing list assignment.
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
    (await request("/lists", { session: admin })).data[0].assignees.some(
      (a) => a.id === admin.user.id,
    ),
  );
  assert.equal(
    (
      await request(`/lists/${list}/assignments`, {
        session: admin,
        method: "PUT",
        body: { user_ids: [employee.user.id] },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/points/${point}/flushes`, {
        session: admin,
        body: values,
      })
    ).status,
    403,
  );
  // Downgrading a previously assigned person to viewer removes their assignment.
  assert.equal(
    (
      await request(`/lists/${list}/assignments`, {
        session: admin,
        method: "PUT",
        body: { user_ids: [employee.user.id, other.user.id] },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/users/${other.user.id}`, {
        session: admin,
        method: "PUT",
        body: {
          name: "Ohne Freigabe",
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
    (await request("/lists", { session: admin })).data[0].assignees.some(
      (a) => a.id === other.user.id,
    ),
    false,
  );
  other = await login("other@example.de");
  assert.equal(
    (
      await request(`/points/${point}/flushes`, {
        session: other,
        body: values,
      })
    ).status,
    403,
  );
});
test("Freigabeentzug und deaktivierte Benutzer verlieren Zugriff", async () => {
  assert.equal(
    (
      await request(`/lists/${list}/assignments`, {
        session: admin,
        method: "PUT",
        body: { user_ids: [] },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/lists/${list}/points`, { session: employee })).status,
    403,
  );
  assert.deepEqual((await request("/flushes", { session: employee })).data, []);
  assert.equal(
    (
      await request("/users/" + viewer.user.id, {
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
  assert.equal(
    (
      await request("/users/" + admin.user.id, {
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
test("Abmeldung entwertet die Sitzung und Login wird gedrosselt", async () => {
  assert.equal(
    (await request("/logout", { session: employee, body: {} })).status,
    200,
  );
  assert.equal((await request("/me", { session: employee })).status, 401);
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
