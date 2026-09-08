// Shared completion-sound engine.
// Exposes a global `PomodoroSounds` with:
//   PomodoroSounds.SOUND_IDS  -> ["chime","bell","digital","marimba","gong"]
//   PomodoroSounds.LABELS     -> { chime: "Chime", ... }
//   PomodoroSounds.play(ctx, id) -> schedules the given sound on an AudioContext
//
// Kept dependency-free and usable from both the popup and the offscreen document
// by loading this file before their own scripts.

(function (global) {
  const LABELS = {
    chime: "Chime",
    bell: "Bell",
    digital: "Digital",
    marimba: "Marimba",
    gong: "Gong",
  };
  const SOUND_IDS = Object.keys(LABELS);

  // Schedule a single note. `type` is an oscillator waveform.
  function note(ctx, master, { freq, start, attack = 0.02, release = 0.5, peak = 0.6, type = "triangle" }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + release);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + release + 0.05);
  }

  const RENDERERS = {
    // Rising three-note arpeggio (the original).
    chime(ctx, master, t0) {
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        note(ctx, master, { freq, start: t0 + i * 0.16, release: 0.55, type: "triangle" });
      });
    },

    // Warm bell: fundamental plus a couple of harmonics with a longer decay.
    bell(ctx, master, t0) {
      const fundamental = 587.33; // D5
      const partials = [
        { mult: 1, peak: 0.6, release: 1.4 },
        { mult: 2.01, peak: 0.25, release: 1.1 },
        { mult: 3.02, peak: 0.12, release: 0.9 },
      ];
      partials.forEach((p) => {
        note(ctx, master, {
          freq: fundamental * p.mult,
          start: t0,
          attack: 0.005,
          release: p.release,
          peak: p.peak,
          type: "sine",
        });
      });
    },

    // Two short electronic blips.
    digital(ctx, master, t0) {
      [880, 1174.66].forEach((freq, i) => {
        note(ctx, master, {
          freq,
          start: t0 + i * 0.12,
          attack: 0.005,
          release: 0.14,
          peak: 0.5,
          type: "square",
        });
      });
    },

    // Soft woody marimba-like triad.
    marimba(ctx, master, t0) {
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        note(ctx, master, {
          freq,
          start: t0 + i * 0.1,
          attack: 0.008,
          release: 0.35,
          peak: 0.55,
          type: "triangle",
        });
      });
    },

    // Low gong with a long decay and a slight detuned shimmer.
    gong(ctx, master, t0) {
      const base = 196; // G3
      [1, 1.48, 2.34].forEach((mult, i) => {
        note(ctx, master, {
          freq: base * mult,
          start: t0,
          attack: 0.01,
          release: 1.8 - i * 0.3,
          peak: i === 0 ? 0.6 : 0.2,
          type: "sine",
        });
      });
    },
  };

  function play(ctx, id) {
    const render = RENDERERS[id] || RENDERERS.chime;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    // Small lead-in so the attack lands after any hardware warm-up.
    const t0 = ctx.currentTime + 0.06;
    render(ctx, master, t0);
  }

  global.PomodoroSounds = { SOUND_IDS, LABELS, play };
})(typeof self !== "undefined" ? self : this);
