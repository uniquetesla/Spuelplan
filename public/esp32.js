// Confirmed SpuelPilot-ESP32 BLE profile.
export const DEFAULT_PROFILE = Object.freeze({
  service: "5f6d0001-7ad8-4cb4-8cf5-909d54aa0001",
  command: "5f6d0002-7ad8-4cb4-8cf5-909d54aa0001",
  result: "5f6d0003-7ad8-4cb4-8cf5-909d54aa0001",
});
export function validateProfile(profile) {
  const result = {};
  for (const key of ["service", "command", "result"]) {
    const value = profile?.[key]?.trim().toLowerCase();
    if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))
      throw Error(
        "Bitte drei gültige BLE-UUIDs im Format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx eingeben.",
      );
    result[key] = value;
  }
  return result;
}
function validId(id) {
  if (
    typeof id !== "string" ||
    !id.trim() ||
    id.length > 50 ||
    /[;\u0000-\u001f\u007f]/.test(id)
  )
    throw Error(
      "Die Spülpunkt-ID darf für Bluetooth kein Semikolon und keinen Zeilenumbruch enthalten.",
    );
  if (["GET", "STATUS", "ACK", "NONE"].includes(id.toUpperCase()))
    throw Error("Diese Spülpunkt-ID ist für das ESP32-Protokoll reserviert.");
  return id;
}
function decimal(value) {
  const text = String(value);
  if (!text.includes("e")) return text;
  const [coefficient, exponent] = text.split("e");
  const digits = coefficient.replace(".", "");
  const position =
    (coefficient.includes(".")
      ? coefficient.indexOf(".")
      : coefficient.length) + Number(exponent);
  if (position <= 0) return "0." + "0".repeat(-position) + digits;
  if (position >= digits.length)
    return digits + "0".repeat(position - digits.length);
  return digits.slice(0, position) + "." + digits.slice(position);
}
export function formatCommand(point) {
  const id = validId(point.code);
  if (
    typeof point.target !== "number" ||
    !Number.isFinite(point.target) ||
    point.target <= 0 ||
    point.target > 1000000
  )
    throw Error("Die Sollmenge muss eine positive Zahl bis 1.000.000 m³ sein.");
  const command = `${id};${decimal(point.target)}`;
  if (new TextEncoder().encode(command).length > 512)
    throw Error("Der Auftrag ist für eine BLE-Nachricht zu lang.");
  return command;
}
export class MeasurementNotReady extends Error {
  constructor() {
    super(
      "Die Messung ist noch nicht vollständig verfügbar. Warte auf die LED am ESP32 und frage danach erneut ab.",
    );
    this.name = "MeasurementNotReady";
  }
}
export function parseResult(frame, expected) {
  if (typeof frame !== "string" || new TextEncoder().encode(frame).length > 512)
    throw Error("Die ESP32-Antwort ist ungültig oder zu lang.");
  const text = frame.trim();
  if (!text) throw new MeasurementNotReady();
  const parts = text.split(";");
  if (parts.length !== 4 || /[\r\n\0]/.test(text))
    throw Error(
      "Erwartete ESP32-Antwort: Spülpunkt-ID;Istmenge;Temperatur vorher;Temperatur nachher.",
    );
  if (parts[0] !== validId(expected.code))
    throw Error(
      "Die empfangene Spülpunkt-ID passt nicht zum ausgewählten Auftrag. Es wurden keine Werte übernommen.",
    );
  const numbers = parts.slice(1).map((part) => {
    if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(part.trim()))
      throw Error("Messwerte müssen reine Dezimalzahlen ohne Einheiten sein.");
    const value = Number(part.trim().replace(",", "."));
    if (!Number.isFinite(value))
      throw Error("Ein ESP32-Messwert ist keine gültige Zahl.");
    return value;
  });
  const [volume, temperature_before, temperature_after] = numbers;
  if (
    volume <= 0 ||
    volume > 1000000 ||
    temperature_before < 0 ||
    temperature_before > 100 ||
    temperature_after < 0 ||
    temperature_after > 100
  )
    throw Error(
      "Die ESP32-Messwerte liegen außerhalb der zulässigen Bereiche.",
    );
  if (volume < expected.target) throw new MeasurementNotReady();
  return { volume, temperature_before, temperature_after };
}
export function parseMessage(frame) {
  if (typeof frame !== "string" || new TextEncoder().encode(frame).length > 512)
    throw Error("Ungültige ESP32-Nachricht.");
  const text = frame.trim();
  if (text === "NONE") return { type: "none" };
  if (text === "STATUS;ACK_OK") return { type: "ack" };
  const parts = text.split(";");
  if (parts[0] === "STATUS") {
    if (
      parts.length !== 3 ||
      !["WAIT_FLOW", "COUNTDOWN", "MEASURING", "READY"].includes(parts[1])
    )
      throw Error("Unbekannter ESP32-Status.");
    return { type: "status", state: parts[1], code: validId(parts[2]) };
  }
  const measurement = parseResult(text, { code: parts[0], target: 0 });
  return { type: "result", code: parts[0], ...measurement };
}
export const STATUS_LABELS = {
  WAIT_FLOW: "Wartet auf mindestens 1 m³/h Durchfluss",
  COUNTDOWN: "5-Sekunden-Countdown für Temperatur vorher",
  MEASURING: "Messung läuft",
  READY: "Messung abgeschlossen – Status-LED am ESP32 leuchtet",
};
export class Esp32Client extends EventTarget {
  constructor({
    bluetooth = globalThis.navigator?.bluetooth,
    profile = DEFAULT_PROFILE,
    storage = null,
    timeout = 8000,
  } = {}) {
    super();
    this.bluetooth = bluetooth;
    this.profile = validateProfile(profile);
    this.storage = storage;
    this.timeout = timeout;
    this.device = null;
    this.command = null;
    this.result = null;
    this.job = null;
    this.userId = null;
    this.busy = false;
    this.error = "";
    this.deviceStatus = null;
    this.generation = 0;
    this.waiting = null;
    this.cancelSupported = false;
    this.onDisconnected = () => {
      this.cancelSupported = false;
      this.generation++;
      this.command = null;
      this.result = null;
      this.busy = false;
      this.rejectWaiting(
        Error(
          "Die Bluetooth-Verbindung wurde unterbrochen. Der Auftrag und das ESP32-Ergebnis bleiben erhalten.",
        ),
      );
      this.error =
        "Bluetooth getrennt. Verbinde denselben ESP32 erneut, um den Auftrag fortzusetzen.";
      this.changed();
    };
    this.onNotification = (event) => {
      try {
        const message = parseMessage(
          new TextDecoder("utf-8", { fatal: true }).decode(event.target.value),
        );
        this.receive(message);
      } catch (error) {
        this.error = error.message;
        this.rejectWaiting(error);
        this.changed();
      }
    };
  }
  get connected() {
    return !!(this.device?.gatt?.connected && this.command && this.result);
  }
  changed() {
    this.dispatchEvent(new Event("change"));
  }
  bindUser(id) {
    if (id === this.userId) return;
    this.disconnect();
    this.userId = id;
    this.job = null;
    this.error = "";
    if (id) {
      try {
        const saved = JSON.parse(
          this.storage?.getItem("spuelpilot.ble-job." + id) || "null",
        );
        if (
          saved &&
          typeof saved.requestId === "string" &&
          typeof saved.code === "string" &&
          Number.isInteger(saved.pointId) &&
          Number.isInteger(saved.runId) &&
          typeof saved.target === "number"
        ) {
          validId(saved.code);
          this.job = { ...saved, received: false };
        }
      } catch {}
    }
    this.changed();
  }
  persist() {
    if (!this.userId) return;
    try {
      const key = "spuelpilot.ble-job." + this.userId;
      if (this.job)
        this.storage?.setItem(
          key,
          JSON.stringify({ ...this.job, received: false }),
        );
      else this.storage?.removeItem(key);
    } catch {
      this.error =
        "Der lokale Auftragsvermerk konnte nicht gespeichert werden. Schließe diesen Tab nicht vor der ESP32-Bestätigung.";
    }
  }
  configure(profile) {
    if (this.connected || this.busy || this.job)
      throw Error(
        "Beende zuerst den offenen Auftrag und trenne Bluetooth, bevor du das BLE-Profil änderst.",
      );
    this.profile = validateProfile(profile);
    this.changed();
  }
  receive(message) {
    if (message.type === "status") this.deviceStatus = message;
    this.dispatchEvent(Object.assign(new Event("message"), { message }));
    if (this.waiting?.accept(message)) {
      const waiter = this.waiting;
      this.waiting = null;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    this.changed();
  }
  rejectWaiting(error) {
    if (this.waiting) {
      const waiter = this.waiting;
      this.waiting = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
  async timed(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = Error(
              "Bluetooth-Zeitüberschreitung. Gerätedaten werden nicht gelöscht.",
            );
            error.code = "BLE_TIMEOUT";
            reject(error);
          }, this.timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async connect() {
    if (!this.bluetooth)
      throw Error(
        "Web Bluetooth ist hier nicht verfügbar. Verwende HTTPS und z. B. Chrome auf Android; iOS Safari unterstützt es nicht.",
      );
    if (this.busy) throw Error("Eine Bluetooth-Aktion läuft bereits.");
    if (this.connected) return;
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      const device = await this.bluetooth.requestDevice({
        filters: [{ services: [this.profile.service] }],
      });
      this.device?.removeEventListener(
        "gattserverdisconnected",
        this.onDisconnected,
      );
      this.result?.removeEventListener(
        "characteristicvaluechanged",
        this.onNotification,
      );
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.onDisconnected);
      const generation = ++this.generation;
      const server = await this.timed(device.gatt.connect()),
        service = await this.timed(
          server.getPrimaryService(this.profile.service),
        );
      const command = await this.timed(
          service.getCharacteristic(this.profile.command),
        ),
        result = await this.timed(
          service.getCharacteristic(this.profile.result),
        );
      if (
        (!command.properties.write &&
          !command.properties.writeWithoutResponse) ||
        !result.properties.notify ||
        !result.properties.read
      )
        throw Error(
          "Erwartet werden RX mit Write sowie TX mit Read und Notify. Prüfe das ESP32-Profil.",
        );
      result.addEventListener(
        "characteristicvaluechanged",
        this.onNotification,
      );
      this.result = result;
      await this.timed(result.startNotifications());
      if (generation !== this.generation || !device.gatt.connected)
        throw Error("Bluetooth wurde während des Verbindens getrennt.");
      this.command = command;
      // Status notifications update the UI; the read button still explicitly sends GET.
      await this.write("STATUS");
    } catch (error) {
      this.disconnect();
      this.error =
        error.name === "NotFoundError"
          ? "Kein passender ESP32 ausgewählt. Prüfe den Gerätenamen SpuelPilot-ESP32 und den BLE-Service."
          : error.message;
      throw Error(this.error);
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  disconnect() {
    this.cancelSupported = false;
    this.generation++;
    this.rejectWaiting(Error("Bluetooth wurde getrennt."));
    this.command = null;
    this.result?.removeEventListener(
      "characteristicvaluechanged",
      this.onNotification,
    );
    this.result = null;
    this.deviceStatus = null;
    this.busy = false;
    this.device?.gatt?.disconnect();
    this.changed();
  }
  async write(text) {
    if (!this.connected) throw Error("Verbinde zuerst SpuelPilot-ESP32.");
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 512) throw Error("Die BLE-Nachricht ist zu lang.");
    const generation = this.generation;
    if (this.command.properties.write)
      await this.timed(this.command.writeValueWithResponse(bytes));
    else await this.timed(this.command.writeValueWithoutResponse(bytes));
    if (!this.connected || generation !== this.generation)
      throw Error("Bluetooth wurde während der Übertragung getrennt.");
  }
  async request(command, accept) {
    if (this.waiting) throw Error("Eine ESP32-Antwort steht bereits aus.");
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting?.resolve === resolve) this.waiting = null;
        const error = Error(
          "Keine passende ESP32-Antwort empfangen. Es werden keine Gerätedaten gelöscht.",
        );
        error.code = "BLE_TIMEOUT";
        reject(error);
      }, this.timeout);
      this.waiting = { resolve, reject, accept, timer };
    });
    response.catch(() => {});
    try {
      await this.write(command);
      return await response;
    } catch (error) {
      this.rejectWaiting(error);
      throw error;
    }
  }
  async getResult() {
    try {
      return await this.request(
        "GET",
        (m) => m.type === "result" || m.type === "none",
      );
    } catch (error) {
      if (error.code !== "BLE_TIMEOUT" || !this.connected) throw error;
      // TX Read is a fallback for a missed notification, never a second measurement command.
      const generation = this.generation,
        data = await this.timed(this.result.readValue());
      if (!this.connected || generation !== this.generation)
        throw Error("Die Verbindung wurde unterbrochen.");
      const message = parseMessage(
        new TextDecoder("utf-8", { fatal: true }).decode(data),
      );
      if (message.type !== "result" && message.type !== "none") throw error;
      return message;
    }
  }
  matches(point, runId) {
    return (
      !!this.job &&
      this.job.code === point.code &&
      this.job.pointId === point.id &&
      this.job.target === point.target &&
      this.job.runId === runId
    );
  }
  async exchange(point, runId) {
    if (!this.connected) throw Error("Verbinde zuerst den ESP32.");
    if (this.busy) throw Error("Eine Bluetooth-Aktion läuft bereits.");
    if (!this.userId) throw Error("Melde dich zuerst an.");
    if (this.job && !this.matches(point, runId))
      throw Error(
        `Auftrag ${this.job.code} ist noch offen. Schließe zuerst diesen Auftrag ab.`,
      );
    if (this.job?.savedId)
      throw Error(
        "Die Messung ist bereits gespeichert. Bestätige zuerst den Empfang am ESP32.",
      );
    if (this.job?.cancelPending)
      throw Error(
        "Ein Abbruch ist noch unbestätigt. Prüfe ihn zuerst über Messung abbrechen.",
      );
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      if (!this.job) {
        formatCommand(point);
        if (
          this.deviceStatus &&
          ["WAIT_FLOW", "COUNTDOWN", "MEASURING"].includes(
            this.deviceStatus.state,
          )
        )
          throw Error(
            "Auf dem ESP32 läuft bereits eine Messung. Ein neuer Auftrag wird nicht übertragen.",
          );
        const existing = await this.getResult();
        if (existing.type === "result")
          throw Error(
            "Auf dem ESP32 liegt noch ein unbestätigtes Ergebnis. Es wird nicht durch einen neuen Auftrag überschrieben.",
          );
        this.job = {
          code: point.code,
          pointId: point.id,
          target: point.target,
          runId,
          requestId: globalThis.crypto.randomUUID(),
          received: false,
        };
        this.persist();
        // Keep context on a failed write: the ESP32 may already have received it.
        await this.write(formatCommand(point));
        return null;
      }
      const message = await this.getResult();
      if (message.type === "none") throw new MeasurementNotReady();
      const measurement = parseResult(
        `${message.code};${message.volume};${message.temperature_before};${message.temperature_after}`,
        this.job,
      );
      this.job.received = true;
      this.persist();
      return measurement;
    } catch (error) {
      this.error = error.message;
      throw error;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  markSaved(receipt) {
    const current = receipt?.user_id === this.userId;
    let job = current ? this.job : null;
    if (!current) {
      try {
        job = JSON.parse(
          this.storage?.getItem("spuelpilot.ble-job." + receipt?.user_id) ||
            "null",
        );
      } catch {}
    }
    if (
      !receipt?.saved ||
      receipt.source !== "esp32" ||
      !Number.isInteger(receipt.id) ||
      !job ||
      receipt.request_id !== job.requestId ||
      receipt.code !== job.code ||
      receipt.point_id !== job.pointId ||
      receipt.run_id !== job.runId
    )
      throw Error(
        "Die Serverbestätigung passt nicht zum ESP32-Auftrag. Es wird kein ACK gesendet.",
      );
    job.savedId = receipt.id;
    if (current) {
      this.job = job;
      this.persist();
      this.changed();
    } else {
      this.storage?.setItem(
        "spuelpilot.ble-job." + receipt.user_id,
        JSON.stringify({ ...job, received: false }),
      );
    }
    return current;
  }
  async acknowledge(receipt) {
    if (!this.markSaved(receipt))
      throw Error(
        "Die Messung ist gespeichert. Melde dich mit dem ursprünglichen Benutzerkonto an, um den ESP32-Empfang zu bestätigen.",
      );
    if (!this.connected)
      throw Error(
        "Die Messung ist gespeichert. Verbinde denselben ESP32 erneut, um den Empfang zu bestätigen.",
      );
    if (this.busy) throw Error("Eine Bluetooth-Aktion läuft bereits.");
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      const existing = await this.getResult();
      if (existing.type === "result") {
        if (
          existing.code !== receipt.code ||
          existing.volume !== receipt.volume ||
          existing.temperature_before !== receipt.temperature_before ||
          existing.temperature_after !== receipt.temperature_after
        )
          throw Error(
            "Das ESP32-Ergebnis weicht von den gespeicherten Messwerten ab. Es wird nicht gelöscht.",
          );
        await this.request(`ACK;${receipt.code}`, (m) => m.type === "ack");
      }
      // NONE also resolves a lost ACK_OK notification from a previous successful ACK.
      this.job = null;
      this.deviceStatus = null;
      this.persist();
    } catch (error) {
      this.error = error.message;
      throw error;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async cancelMeasurement() {
    if (!this.connected) throw Error("Verbinde zuerst denselben ESP32.");
    if (this.busy) throw Error("Eine Übertragung läuft bereits.");
    if (!this.cancelSupported)
      throw Error(
        "Bestätige zuerst, dass die ESP32-Firmware den Abbruch über ID;0 unterstützt.",
      );
    if (!this.job || this.job.savedId || this.job.received)
      throw Error(
        "Ein fertiges oder bereits gespeichertes Ergebnis darf nicht abgebrochen werden. Bitte speichern und bestätigen.",
      );
    this.busy = true;
    this.error = "";
    this.changed();
    const finish = () => {
      this.job = null;
      this.deviceStatus = null;
      this.persist();
    };
    try {
      const status = await this.request(
        "STATUS",
        (m) => m.type === "status" || m.type === "none",
      );
      if (status.type === "none") {
        if (this.job.cancelPending) {
          finish();
          return;
        }
        throw Error(
          "Der ESP32 hat keine laufende Messung bestätigt. Es wird kein Abbruchtelegramm gesendet.",
        );
      }
      if (status.code !== this.job.code)
        throw Error(
          "Auf dem ESP32 ist ein anderer Spülpunkt aktiv. Es wird kein Abbruch gesendet.",
        );
      if (status.state === "READY") {
        this.job.cancelPending = false;
        this.persist();
        throw Error(
          "Die Messung ist bereits abgeschlossen. Bitte Messdaten abrufen und speichern; das Ergebnis bleibt erhalten.",
        );
      }
      this.job.cancelPending = true;
      this.persist();
      const response = await this.request(
        `${validId(this.job.code)};0`,
        (m) => m.type === "ack" || m.type === "status",
      );
      if (response.type !== "ack") {
        if (response.code === this.job.code && response.state === "READY") {
          this.job.cancelPending = false;
          this.persist();
        }
        throw Error(
          "Der ESP32 hat den Abbruch nicht bestätigt. Ein inzwischen fertiges Ergebnis bleibt erhalten.",
        );
      }
      finish();
    } catch (error) {
      this.error = this.job?.cancelPending
        ? "Abbruch nicht bestätigt. Die Messung kann noch laufen. Verbinde denselben ESP32 und prüfe den Abbruch erneut."
        : error.message;
      throw Error(this.error);
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  abandon() {
    if (this.busy || this.job?.savedId)
      throw Error(
        "Eine laufende Übertragung oder ausstehende Empfangsbestätigung kann nicht verworfen werden.",
      );
    this.job = null;
    this.persist();
    this.changed();
  }
}
