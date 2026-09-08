// Offscreen document: plays the finish chime on request from the service worker.
// An AudioContext here can start immediately (offscreen docs allow audio playback
// without a user gesture), which the service worker itself cannot do.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "playChime" && msg.target === "offscreen") {
    playChime();
  }
});

function playChime() {
  try {
    const ctx = new (self.AudioContext || self.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5, a gentle rising arpeggio
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
    // Close the context shortly after the sound finishes to free resources.
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch (_) {
    /* audio unavailable; ignore */
  }
}
