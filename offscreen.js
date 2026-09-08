// Offscreen document: plays the finish chime on request from the service worker.
// Offscreen docs can play audio without a user gesture, which the service
// worker itself cannot do. Sound synthesis lives in the shared sounds.js
// (loaded before this file) as PomodoroSounds.

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

warmUp();

async function playChime(soundId) {
  const ctx = getContext();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (_) {
      /* ignore */
    }
  }
  self.PomodoroSounds.play(ctx, soundId);
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "ping") {
    sendResponse({ ready: true });
    return; // synchronous response
  }
  if (msg.type === "playChime") {
    playChime(msg.sound)
      .then(() => sendResponse({ played: true }))
      .catch(() => sendResponse({ played: false }));
    return true; // async response
  }
});
