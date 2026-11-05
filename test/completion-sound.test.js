import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionSound } from "../public/completion-sound.js";
function fixture() {
  const frames = [],
    memory = new Map();
  let contexts = 0;
  class Audio {
    constructor() {
      contexts++;
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
    }
    createOscillator() {
      const tone = {
        frequency: { setValueAtTime: (value) => (tone.hz = value) },
        connect() {},
        disconnect() {},
        start: () => frames.push(tone.hz),
        stop() {},
      };
      return tone;
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    }
  }
  const storage = {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  };
  return {
    sound: new CompletionSound({ AudioContext: Audio, storage }),
    storage,
    Audio,
    frames,
    contexts: () => contexts,
  };
}
test("Abschlusston ist standardmäßig aus; ein Testton ändert keine persönliche Einstellung", async () => {
  const f = fixture();
  f.sound.bindUser(1, false);
  assert.equal(await f.sound.notify(1, "disabled"), false);
  assert.equal(f.contexts(), 0);
  assert.equal(await f.sound.play(true), true);
  assert.equal(f.frames.length, 3);
  assert.equal(f.sound.enabled, false);
});
test("Benutzerbezogener Ton erklingt je validiertem Auftrag einmal, auch nach Neuladen oder Reconnect", async () => {
  const f = fixture();
  f.sound.bindUser(1, true);
  assert.equal(await f.sound.notify(1, "request-1"), true);
  assert.equal(await f.sound.notify(1, "request-1"), false);
  assert.equal(f.frames.length, 3);
  const restored = new CompletionSound({
    AudioContext: f.Audio,
    storage: f.storage,
  });
  restored.bindUser(1, true);
  assert.equal(await restored.notify(1, "request-1"), false);
  f.sound.bindUser(2, false);
  assert.equal(await f.sound.notify(1, "foreign"), false);
  assert.equal(await f.sound.notify(2, "request-2"), false);
  assert.equal(f.frames.length, 3);
});
test("Blockierte Audioausgabe beeinflusst weder Speicherung noch Wiederholschutz", async () => {
  const sound = new CompletionSound({
    AudioContext: class {
      state = "suspended";
      resume() {
        throw Error("Audio gesperrt");
      }
    },
  });
  sound.bindUser(1, true);
  assert.equal(await sound.notify(1, "request-1"), false);
  assert.match(sound.error, /Audio gesperrt/);
  assert.equal(await sound.notify(1, "request-1"), false);
});
