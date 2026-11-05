// Generated locally: no external audio files and no changes to BLE acknowledgements.
export class CompletionSound {
  constructor({
    AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
    storage = null,
  } = {}) {
    this.AudioContext = AudioContext;
    this.storage = storage;
    this.owner = null;
    this.enabled = false;
    this.seen = new Set();
    this.context = null;
    this.error = "";
  }
  bindUser(id, enabled = false) {
    if (this.owner !== id) {
      this.owner = id;
      this.seen = new Set();
      if (id) {
        try {
          const saved = JSON.parse(
            this.storage?.getItem("spuelpilot.sound-completions." + id) || "[]",
          );
          if (Array.isArray(saved))
            this.seen = new Set(
              saved.filter((x) => typeof x === "string").slice(-100),
            );
        } catch {}
      }
    }
    this.enabled = !!enabled;
    this.error = "";
  }
  async unlock(force = false) {
    if (!force && !this.enabled) return false;
    if (!this.AudioContext)
      throw Error("Dieser Browser unterstützt den Abschlusston nicht.");
    this.context ??= new this.AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    if (this.context.state !== "running")
      throw Error(
        "Bitte „Ton testen“ drücken, um die Tonausgabe im Browser freizugeben.",
      );
    return true;
  }
  async play(force = false, owner = this.owner) {
    if (!(await this.unlock(force))) return false;
    if (!force && (owner !== this.owner || !this.enabled)) return false;
    const ctx = this.context,
      start = ctx.currentTime;
    for (const [i, frequency] of [784, 988, 1175].entries()) {
      const tone = ctx.createOscillator(),
        gain = ctx.createGain(),
        at = start + i * 0.14;
      tone.type = "sine";
      tone.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.13, at + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      tone.connect(gain);
      gain.connect(ctx.destination);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
      tone.start(at);
      tone.stop(at + 0.14);
    }
    return true;
  }
  async notify(owner, requestId) {
    if (
      !owner ||
      owner !== this.owner ||
      typeof requestId !== "string" ||
      this.seen.has(requestId)
    )
      return false;
    this.seen.add(requestId);
    this.seen = new Set([...this.seen].slice(-100));
    try {
      this.storage?.setItem(
        "spuelpilot.sound-completions." + owner,
        JSON.stringify([...this.seen]),
      );
    } catch {}
    if (!this.enabled) return false;
    try {
      return await this.play(false, owner);
    } catch (error) {
      this.error = error.message;
      return false;
    }
  }
}
