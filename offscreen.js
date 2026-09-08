// Offscreen document: plays the finish chime on request from the service worker.
// Offscreen docs can play audio without a user gesture, which the service
// worker itself cannot do.

// Reuse a single AudioContext so we don't repeatedly create/close one.
let audioCtx = null;

function getContext() {
  if (!audioCtx) {
    audioCtx = new (self.AudioContext || self.webkitAudioContext)();
  }
  return audioCtx;
}

// Play a brief silent buffer to spin up the audio hardware pipeline, so the
// first real chime isn't attenuated by cold-start warm-up latency.
async function warmUp() {
  const ctx = getContext();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (_) {
      /* ignore */
    }
  }
  try {
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch (_) {
    /* ignore */
  }
}

// Warm up as soon as the offscreen document loads.
warmUp();

async function playChime() {
  const ctx = getContext();
  // A context may start suspended; resume it before scheduling anything,
  // otherwise the scheduled notes never actually sound.
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (_) {
      /* ignore; we'll still attempt to play */
    }
  }

  // Small lead-in so the attack lands after any hardware warm-up, never inside it.
  const now = ctx.currentTime + 0.06;
  const notes = [523.25, 659.25, 783.99]; // C5 E5 G5, a gentle rising arpeggio

  // Master gain keeps the overall level comfortably audible.
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // Triangle has more presence than a pure sine, so it reads as louder.
    osc.type = "triangle";
    osc.frequency.value = freq;

    const start = now + i * 0.16;
    const peak = 0.6;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);

    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + 0.6);
  });

  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "ping") {
    sendResponse({ ready: true });
    return; // synchronous response
  }
  if (msg.type === "playChime") {
    playChime()
      .then(() => sendResponse({ played: true }))
      .catch(() => sendResponse({ played: false }));
    return true; // async response
  }
});
