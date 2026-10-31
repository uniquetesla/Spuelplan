// Separate internal flow records; existing flushing history stays untouched.
export function installFlowRoutes({
  app,
  db,
  one,
  all,
  run,
  transaction,
  fail,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_measurements(
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
      request_id TEXT NOT NULL UNIQUE,address TEXT NOT NULL,remark TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,ended_at TEXT,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
      deleted_at TEXT,deleted_by INTEGER REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS flow_samples(
      measurement_id INTEGER NOT NULL REFERENCES flow_measurements(id),seq INTEGER NOT NULL,
      elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms>=0),flow REAL NOT NULL CHECK(flow>=0 AND flow<=1000000),
      PRIMARY KEY(measurement_id,seq));
    CREATE INDEX IF NOT EXISTS flow_samples_time_idx ON flow_samples(measurement_id,elapsed_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS flow_one_active_user_idx ON flow_measurements(user_id) WHERE status='active' AND deleted_at IS NULL;
  `);
  const role = (req, res, next) =>
    ["admin", "employee"].includes(req.session.role)
      ? next()
      : fail(
          res,
          403,
          "Durchflussmessungen sind nur für Mitarbeiter und Administration zugänglich.",
        );
  const visible = (req, id) =>
    one(
      `SELECT m.*,u.name employee FROM flow_measurements m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.deleted_at IS NULL ${req.session.role === "admin" ? "" : "AND m.user_id=?"}`,
      Number(id),
      ...(req.session.role === "admin" ? [] : [req.session.user_id]),
    );
  const summary = (m) => {
    const stats = one(
      "SELECT count(*) sample_count,coalesce(max(seq),-1) last_seq,coalesce(max(elapsed_ms),0) last_ms,min(flow) min_flow,max(flow) max_flow,avg(flow) mean_flow FROM flow_samples WHERE measurement_id=?",
      m.id,
    );
    return {
      ...m,
      ...stats,
      elapsed_ms: Math.max(
        stats.last_ms,
        Date.parse(m.ended_at || new Date().toISOString()) -
          Date.parse(m.started_at),
      ),
    };
  };
  const metadata = (b) =>
    typeof b.address === "string" &&
    b.address.trim().length > 0 &&
    b.address.trim().length <= 300 &&
    (b.remark === undefined ||
      (typeof b.remark === "string" && b.remark.length <= 2000));
  app.get("/api/flow-measurements", role, (req, res) => {
    res.json(
      all(
        `SELECT m.*,u.name employee,(SELECT count(*) FROM flow_samples s WHERE s.measurement_id=m.id) sample_count FROM flow_measurements m JOIN users u ON u.id=m.user_id WHERE m.deleted_at IS NULL ${req.session.role === "admin" ? "" : "AND m.user_id=?"} ORDER BY m.started_at DESC,m.id DESC`,
        ...(req.session.role === "admin" ? [] : [req.session.user_id]),
      ),
    );
  });
  app.post("/api/flow-measurements", role, (req, res) => {
    const b = req.body;
    if (
      !metadata(b) ||
      typeof b.request_id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.request_id)
    )
      return fail(
        res,
        400,
        "Adresse (max. 300 Zeichen), gültige Übertragungs-ID und Bemerkung (max. 2.000 Zeichen) erforderlich.",
      );
    const cached = one(
      "SELECT m.*,u.name employee FROM flow_measurements m JOIN users u ON u.id=m.user_id WHERE request_id=?",
      b.request_id,
    );
    if (cached) {
      if (
        cached.user_id !== req.session.user_id ||
        cached.deleted_at ||
        cached.address !== b.address.trim() ||
        cached.remark !== (b.remark ?? "").trim()
      )
        return fail(
          res,
          409,
          "Diese Übertragungs-ID gehört zu einer anderen Messung.",
        );
      return res.json(summary(cached));
    }
    if (
      one(
        "SELECT id FROM flow_measurements WHERE user_id=? AND status='active' AND deleted_at IS NULL",
        req.session.user_id,
      )
    )
      return fail(
        res,
        409,
        "Du hast bereits eine offene Durchflussmessung. Bitte fortsetzen oder beenden.",
      );
    const saved = run(
      "INSERT INTO flow_measurements(user_id,request_id,address,remark,started_at) VALUES(?,?,?,?,?)",
      req.session.user_id,
      b.request_id,
      b.address.trim(),
      (b.remark ?? "").trim(),
      new Date().toISOString(),
    );
    res.status(201).json(summary(visible(req, Number(saved.lastInsertRowid))));
  });
  app.get("/api/flow-measurements/:id", role, (req, res) => {
    const m = visible(req, req.params.id);
    if (!m) return fail(res, 404, "Durchflussmessung nicht gefunden.");
    res.json(summary(m));
  });
  app.get("/api/flow-measurements/:id/series", role, (req, res) => {
    const m = visible(req, req.params.id);
    if (!m) return fail(res, 404, "Durchflussmessung nicht gefunden.");
    const last = one(
      "SELECT coalesce(max(elapsed_ms),0) ms FROM flow_samples WHERE measurement_id=?",
      m.id,
    ).ms;
    const width = Math.max(1, Math.ceil((last + 1) / 250));
    // Preserve each bucket's first/last value and extremes. Raw samples remain
    // stored; only the display is bounded, even for multi-day measurements.
    res.json(
      all(
        `WITH timed AS (
      SELECT seq,elapsed_ms,flow,elapsed_ms-lag(elapsed_ms) OVER(ORDER BY seq) gap_ms,cast(elapsed_ms/? AS INTEGER) bucket FROM flow_samples WHERE measurement_id=?
    ), segmented AS (
      SELECT *,sum(CASE WHEN gap_ms>5000 THEN 1 ELSE 0 END) OVER(ORDER BY seq) segment FROM timed
    ), ranked AS (
      SELECT *,row_number() OVER(PARTITION BY bucket ORDER BY seq) first_n,
      row_number() OVER(PARTITION BY bucket ORDER BY seq DESC) last_n,
      row_number() OVER(PARTITION BY bucket ORDER BY flow,seq) low_n,
      row_number() OVER(PARTITION BY bucket ORDER BY flow DESC,seq) high_n,
      max(coalesce(gap_ms,0)) OVER(PARTITION BY bucket) bucket_gap FROM segmented
    ) SELECT seq,elapsed_ms,flow,segment,CASE WHEN first_n=1 THEN bucket_gap ELSE 0 END gap_ms FROM ranked
      WHERE first_n=1 OR last_n=1 OR low_n=1 OR high_n=1 ORDER BY seq`,
        width,
        m.id,
      ),
    );
  });
  app.post("/api/flow-measurements/:id/samples", role, (req, res) => {
    const m = visible(req, req.params.id);
    if (!m) return fail(res, 404, "Durchflussmessung nicht gefunden.");
    if (m.user_id !== req.session.user_id)
      return fail(
        res,
        403,
        "Nur die erfassende Person kann Messwerte anhängen.",
      );
    const samples = req.body.samples,
      maxTime = Date.now() - Date.parse(m.started_at) + 60000;
    if (
      !Array.isArray(samples) ||
      !samples.length ||
      samples.length > 200 ||
      samples.some(
        (s) =>
          !s ||
          !Number.isSafeInteger(s.seq) ||
          s.seq < 0 ||
          !Number.isSafeInteger(s.elapsed_ms) ||
          s.elapsed_ms < 0 ||
          s.elapsed_ms > maxTime ||
          typeof s.flow !== "number" ||
          !Number.isFinite(s.flow) ||
          s.flow < 0 ||
          s.flow > 1000000,
      )
    )
      return fail(
        res,
        400,
        "Ungültige Durchflusswerte oder Zeitachse (höchstens 200 Werte pro Paket).",
      );
    try {
      transaction(() => {
        let last = one(
          "SELECT seq,elapsed_ms FROM flow_samples WHERE measurement_id=? ORDER BY seq DESC LIMIT 1",
          m.id,
        ) ?? { seq: -1, elapsed_ms: -1 };
        for (const s of samples) {
          const old = one(
            "SELECT elapsed_ms,flow FROM flow_samples WHERE measurement_id=? AND seq=?",
            m.id,
            s.seq,
          );
          if (old) {
            if (old.elapsed_ms !== s.elapsed_ms || old.flow !== s.flow)
              throw Error(
                "Ein gespeicherter Messwert darf nicht überschrieben werden.",
              );
            continue;
          }
          if (m.status !== "active")
            throw Error("Diese Messung ist bereits beendet.");
          if (s.seq !== last.seq + 1 || s.elapsed_ms <= last.elapsed_ms)
            throw Error(
              "Messwerte müssen lückenlos nummeriert und zeitlich aufsteigend übertragen werden.",
            );
          run(
            "INSERT INTO flow_samples VALUES(?,?,?,?)",
            m.id,
            s.seq,
            s.elapsed_ms,
            s.flow,
          );
          last = s;
        }
      });
    } catch (error) {
      return fail(res, 409, error.message);
    }
    res.json({ ok: true, ...summary(m) });
  });
  app.put("/api/flow-measurements/:id", role, (req, res) => {
    const m = visible(req, req.params.id);
    if (!m) return fail(res, 404, "Durchflussmessung nicht gefunden.");
    if (!metadata(req.body))
      return fail(
        res,
        400,
        "Bitte eine Adresse und eine gültige Bemerkung eingeben.",
      );
    run(
      "UPDATE flow_measurements SET address=?,remark=? WHERE id=?",
      req.body.address.trim(),
      (req.body.remark ?? "").trim(),
      m.id,
    );
    res.json(summary(visible(req, m.id)));
  });
  app.post("/api/flow-measurements/:id/finish", role, (req, res) => {
    const m = visible(req, req.params.id);
    if (!m) return fail(res, 404, "Durchflussmessung nicht gefunden.");
    if (m.user_id !== req.session.user_id)
      return fail(
        res,
        403,
        "Die laufende Messung muss von der erfassenden Person beendet werden.",
      );
    const stats = summary(m);
    if (
      !Number.isInteger(req.body.last_seq) ||
      req.body.last_seq !== stats.last_seq
    )
      return fail(
        res,
        409,
        "Zuerst alle aufgezeichneten Messwerte vollständig speichern.",
      );
    if (m.status === "active")
      run(
        "UPDATE flow_measurements SET status='completed',ended_at=? WHERE id=?",
        new Date(
          Math.max(Date.now(), Date.parse(m.started_at) + stats.last_ms),
        ).toISOString(),
        m.id,
      );
    res.json(summary(visible(req, m.id)));
  });
  app.delete("/api/flow-measurements/:id", role, (req, res) => {
    const m = visible(req, req.params.id);
    if (!m) return fail(res, 404, "Durchflussmessung nicht gefunden.");
    if (m.status !== "completed")
      return fail(res, 409, "Bitte die Messung vor dem Löschen beenden.");
    if (req.body.confirm_address !== m.address)
      return fail(res, 400, "Zur Bestätigung bitte die Adresse eingeben.");
    run(
      "UPDATE flow_measurements SET deleted_at=?,deleted_by=? WHERE id=?",
      new Date().toISOString(),
      req.session.user_id,
      m.id,
    );
    res.json({ ok: true });
  });
}
