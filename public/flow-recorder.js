// Durable, user-scoped queue. No temperatures, BLE commands or flushing ACKs.
export class IndexedFlowStore {
  async open() {
    if (!this.dbPromise)
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("spuelpilot-flow", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("states", { keyPath: "ownerId" });
          req.result.createObjectStore("samples", {
            keyPath: ["ownerId", "id", "seq"],
          });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () =>
          reject(Error("Der lokale Messwertspeicher ist nicht verfügbar."));
      });
    return this.dbPromise;
  }
  async transact(stores, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value, failure;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () =>
        reject(
          failure || Error("Messwerte konnten lokal nicht gesichert werden."),
        );
      tx.onerror = () => {};
      fn(
        tx,
        (v) => {
          value = v;
        },
        (error) => {
          failure = error;
          tx.abort();
        },
      );
    });
  }
  state(ownerId) {
    return this.transact(["states"], "readonly", (tx, set) => {
      const r = tx.objectStore("states").get(ownerId);
      r.onsuccess = () => set(r.result || null);
    });
  }
  save(state) {
    return this.transact(["states"], "readwrite", (tx) =>
      tx.objectStore("states").put(state),
    );
  }
  append(state, sample) {
    return this.transact(
      ["states", "samples"],
      "readwrite",
      (tx, set, abort) => {
        const states = tx.objectStore("states"),
          r = states.get(state.ownerId);
        r.onsuccess = () => {
          if (
            !r.result ||
            r.result.id !== state.id ||
            r.result.nextSeq !== sample.seq
          )
            return abort(
              Error("Eine andere Aufzeichnung verwendet diesen Messauftrag."),
            );
          tx.objectStore("samples").add({
            ownerId: state.ownerId,
            id: state.id,
            ...sample,
          });
          states.put({
            ...state,
            nextSeq: sample.seq + 1,
            lastElapsed: sample.elapsed_ms,
          });
        };
      },
    );
  }
  range(owner, id, max = Number.MAX_SAFE_INTEGER) {
    return IDBKeyRange.bound([owner, id, 0], [owner, id, max]);
  }
  peek(owner, id) {
    return this.transact(["samples"], "readonly", (tx, set) => {
      const r = tx.objectStore("samples").getAll(this.range(owner, id), 200);
      r.onsuccess = () =>
        set(
          r.result.map(({ seq, elapsed_ms, flow }) => ({
            seq,
            elapsed_ms,
            flow,
          })),
        );
    });
  }
  count(owner, id) {
    return this.transact(["samples"], "readonly", (tx, set) => {
      const r = tx.objectStore("samples").count(this.range(owner, id));
      r.onsuccess = () => set(r.result);
    });
  }
  accepted(owner, id, seq) {
    return this.transact(["samples"], "readwrite", (tx) =>
      tx.objectStore("samples").delete(this.range(owner, id, seq)),
    );
  }
  clear(owner) {
    return this.transact(["states"], "readwrite", (tx) =>
      tx.objectStore("states").delete(owner),
    );
  }
}
export function thinPoints(points, limit = 1200) {
  if (points.length <= limit) return points;
  const size = Math.ceil(points.length / (limit / 2)),
    result = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size),
      low = chunk.reduce((a, b) => (a.flow < b.flow ? a : b)),
      high = chunk.reduce((a, b) => (a.flow > b.flow ? a : b));
    result.push(
      ...(low.seq === high.seq
        ? [low]
        : [low, high].sort((a, b) => a.seq - b.seq)),
    );
  }
  for (const p of [points[0], points.at(-1)])
    if (!result.some((r) => r.seq === p.seq)) result.push(p);
  return result.sort((a, b) => a.seq - b.seq);
}
export class FlowRecorder extends EventTarget {
  constructor({
    request,
    store = new IndexedFlowStore(),
    locks = globalThis.navigator?.locks,
    clock = () => performance.now(),
  } = {}) {
    super();
    Object.assign(this, { request, store, locks, clock });
    this.ownerId = null;
    this.active = null;
    this.running = false;
    this.points = [];
    this.pending = 0;
    this.error = "";
    this.serial = Promise.resolve();
    this.flight = null;
    this.generation = 0;
  }
  changed() {
    this.dispatchEvent(new Event("change"));
  }
  assertOwner(owner, generation) {
    if (this.ownerId !== owner || this.generation !== generation)
      throw Error("Benutzerkonto gewechselt.");
  }
  async bindUser(id) {
    if (this.ownerId === id) return;
    this.generation++;
    this.running = false;
    clearInterval(this.timer);
    this.release?.();
    this.release = null;
    this.ownerId = id;
    this.active = null;
    this.points = [];
    this.pending = 0;
    this.error = "";
    const generation = this.generation;
    if (id) {
      try {
        const state = await this.store.state(id);
        if (generation !== this.generation) return;
        const pending = state ? await this.store.count(id, state.id) : 0;
        if (generation !== this.generation) return;
        this.active = state;
        this.pending = pending;
      } catch (error) {
        if (generation === this.generation) this.error = error.message;
      }
    }
    if (generation === this.generation) this.changed();
  }
  async lock() {
    if (this.release) return;
    if (!this.locks)
      throw Error(
        "Dieser Browser unterstützt die sichere Aufzeichnung nicht. Bitte aktuelles Chrome mit HTTPS verwenden.",
      );
    const owner = this.ownerId,
      generation = this.generation;
    await new Promise((resolve, reject) => {
      this.locks
        .request(
          "spuelpilot-flow-" + owner,
          { ifAvailable: true },
          async (lock) => {
            if (this.ownerId !== owner || this.generation !== generation) {
              reject(Error("Benutzerkonto gewechselt."));
              return;
            }
            if (!lock) {
              reject(
                Error(
                  "Die Durchflussmessung läuft bereits in einem anderen Tab.",
                ),
              );
              return;
            }
            await new Promise((done) => {
              this.release = done;
              resolve();
            });
          },
        )
        .catch(reject);
    });
  }
  async start(data) {
    if (!this.ownerId) throw Error("Bitte anmelden.");
    if (this.active)
      throw Error("Bitte die offene Messung zuerst fortsetzen oder beenden.");
    const owner = this.ownerId,
      generation = this.generation;
    await this.store.open?.();
    this.assertOwner(owner, generation);
    await this.lock();
    try {
      this.assertOwner(owner, generation);
      const detail = await this.request("/flow-measurements", data, "POST");
      this.assertOwner(owner, generation);
      await this.activate(detail);
    } catch (error) {
      if (this.ownerId === owner && this.generation === generation) {
        this.release?.();
        this.release = null;
      }
      throw error;
    }
  }
  async resume(id, { record = true } = {}) {
    if (this.active && this.active.id !== id)
      throw Error("Bitte zuerst die lokal offene Messung sichern.");
    const owner = this.ownerId,
      generation = this.generation;
    await this.lock();
    try {
      this.assertOwner(owner, generation);
      const detail = await this.request("/flow-measurements/" + id);
      this.assertOwner(owner, generation);
      if (detail.status === "completed") {
        const local = await this.store.state(owner);
        this.assertOwner(owner, generation);
        if (local?.id === id && local.stopping) {
          this.active = local;
          await this.finish();
          return;
        }
      }
      await this.activate(detail, record);
    } catch (error) {
      if (this.ownerId === owner && this.generation === generation) {
        this.release?.();
        this.release = null;
      }
      throw error;
    }
  }
  async activate(detail, record = true) {
    const owner = this.ownerId,
      generation = this.generation;
    if (detail.user_id !== this.ownerId)
      throw Error("Nur die erfassende Person kann diese Messung fortsetzen.");
    if (detail.status !== "active")
      throw Error(
        "Die Messung ist bereits beendet. Bitte die Seite neu laden.",
      );
    const local = await this.store.state(owner);
    this.assertOwner(owner, generation);
    this.active = {
      ownerId: this.ownerId,
      id: detail.id,
      nextSeq: Math.max(
        detail.last_seq + 1,
        local?.id === detail.id ? local.nextSeq : 0,
      ),
      lastElapsed: Math.max(
        detail.last_ms,
        local?.id === detail.id ? local.lastElapsed : 0,
      ),
      stopping: local?.id === detail.id && !!local.stopping,
    };
    await this.store.save(this.active);
    this.assertOwner(owner, generation);
    const points = await this.request(`/flow-measurements/${detail.id}/series`);
    this.assertOwner(owner, generation);
    const pending = await this.store.count(owner, detail.id);
    this.assertOwner(owner, generation);
    this.points = points;
    this.pending = pending;
    this.base = Math.max(detail.elapsed_ms, this.active.lastElapsed);
    this.origin = this.clock();
    this.lastArrival = -Infinity;
    this.running = record && !this.active.stopping;
    this.error = "";
    clearInterval(this.timer);
    this.timer = setInterval(
      () =>
        this.flush().catch((error) => {
          if (generation === this.generation) {
            this.error = error.message;
            this.changed();
          }
        }),
      5000,
    );
    this.timer.unref?.();
    this.changed();
    if (this.active.stopping) await this.finish();
  }
  capture(live) {
    if (
      !this.running ||
      !this.active ||
      live.type !== "live" ||
      live.state === "ERROR" ||
      !Number.isFinite(live.flow) ||
      live.flow < 0 ||
      live.flow > 1000000
    )
      return;
    const now = this.clock();
    if (now - this.lastArrival < 500) return;
    this.lastArrival = now;
    const generation = this.generation,
      elapsed = Math.floor(this.base + now - this.origin);
    this.serial = this.serial
      .then(async () => {
        if (generation !== this.generation || !this.active) return;
        const state = { ...this.active },
          sample = {
            seq: state.nextSeq,
            elapsed_ms: Math.max(elapsed, state.lastElapsed + 1),
            flow: live.flow,
          };
        await this.store.append(state, sample);
        if (generation !== this.generation) return;
        this.active = {
          ...state,
          nextSeq: sample.seq + 1,
          lastElapsed: sample.elapsed_ms,
        };
        this.pending++;
        this.points = thinPoints([
          ...this.points,
          {
            ...sample,
            gap_ms: sample.elapsed_ms - state.lastElapsed,
            segment:
              (this.points.at(-1)?.segment || 0) +
              (sample.elapsed_ms - state.lastElapsed > 5000 ? 1 : 0),
          },
        ]);
        this.changed();
      })
      .catch((error) => {
        if (generation === this.generation) {
          this.running = false;
          this.error =
            error.message +
            " Aufzeichnung angehalten; gespeicherte Werte bleiben erhalten.";
          this.changed();
        }
      });
  }
  async flush() {
    if (this.flight) return this.flight;
    if (!this.active || !this.ownerId) return;
    const owner = this.ownerId,
      id = this.active.id,
      generation = this.generation;
    this.flight = (async () => {
      await this.serial;
      while (this.ownerId === owner && this.active?.id === id) {
        const batch = await this.store.peek(owner, id);
        if (
          generation !== this.generation ||
          this.ownerId !== owner ||
          this.active?.id !== id
        )
          return;
        if (!batch.length) break;
        const receipt = await this.request(
          `/flow-measurements/${id}/samples`,
          { samples: batch },
          "POST",
        );
        if (
          !receipt.ok ||
          receipt.id !== id ||
          receipt.last_seq < batch.at(-1).seq
        )
          throw Error(
            "Keine passende Speicherbestätigung. Lokale Messwerte bleiben erhalten.",
          );
        await this.store.accepted(owner, id, batch.at(-1).seq);
        if (generation !== this.generation) return;
        const pending = await this.store.count(owner, id);
        if (generation !== this.generation) return;
        this.pending = pending;
        this.error = "";
        this.changed();
      }
    })();
    try {
      await this.flight;
    } finally {
      this.flight = null;
    }
  }
  async finish() {
    if (!this.active || this.active.ownerId !== this.ownerId)
      throw Error("Keine eigene offene Messung.");
    const owner = this.ownerId,
      id = this.active.id,
      generation = this.generation;
    await this.lock();
    this.assertOwner(owner, generation);
    this.running = false;
    await this.serial;
    this.assertOwner(owner, generation);
    this.active = { ...this.active, stopping: true };
    await this.store.save(this.active);
    this.assertOwner(owner, generation);
    this.changed();
    try {
      await this.flush();
      if (this.ownerId !== owner || this.active?.id !== id) return;
      const pending = await this.store.count(owner, id);
      this.assertOwner(owner, generation);
      if (pending)
        throw Error(
          "Es liegen noch ungespeicherte Werte vor. Bitte erneut versuchen.",
        );
      const result = await this.request(
        `/flow-measurements/${id}/finish`,
        { last_seq: this.active.nextSeq - 1 },
        "POST",
      );
      if (result.status !== "completed" || result.id !== id)
        throw Error("Abschluss nicht bestätigt.");
      await this.store.clear(owner);
      if (this.ownerId !== owner || generation !== this.generation)
        return result;
      clearInterval(this.timer);
      this.release?.();
      this.release = null;
      this.active = null;
      this.pending = 0;
      this.error = "";
      this.changed();
      return result;
    } catch (error) {
      if (generation === this.generation) {
        this.error = error.message;
        this.changed();
      }
      throw error;
    }
  }
}
