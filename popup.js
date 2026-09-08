// Cozy Pomodoro - popup UI logic

const RING_CIRCUMFERENCE = 2 * Math.PI * 90; // matches r=90 in the SVG

const el = {
  app: document.querySelector(".app"),
  tabs: document.querySelectorAll(".tab"),
  time: document.getElementById("time"),
  modeLabel: document.getElementById("modeLabel"),
  ring: document.querySelector(".ring-progress"),
  startBtn: document.getElementById("startBtn"),
  resetBtn: document.getElementById("resetBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  closeSettings: document.getElementById("closeSettings"),
  saveSettings: document.getElementById("saveSettings"),
  testSound: document.getElementById("testSound"),
  pomoDots: document.getElementById("pomoDots"),
  todayCount: document.getElementById("todayCount"),
  fields: {
    focusMin: document.getElementById("focusMin"),
    shortMin: document.getElementById("shortMin"),
    longMin: document.getElementById("longMin"),
    longEvery: document.getElementById("longEvery"),
    autoStart: document.getElementById("autoStart"),
    sound: document.getElementById("sound"),
    completionSound: document.getElementById("completionSound"),
    pinOverlay: document.getElementById("pinOverlay"),
  },
};

// Populate the completion-sound dropdown from the shared engine.
(function populateSoundOptions() {
  const sel = el.fields.completionSound;
  if (!sel || !self.PomodoroSounds) return;
  self.PomodoroSounds.SOUND_IDS.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = self.PomodoroSounds.LABELS[id];
    sel.appendChild(opt);
  });
})();

const MODE_LABELS = { focus: "Focus", short: "Short Break", long: "Long Break" };

let current = { settings: null, state: null };
let localTimer = null;
let overlayActive = false;

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function modeDurationMs(mode, settings) {
  const min =
    mode === "focus" ? settings.focusMin : mode === "short" ? settings.shortMin : settings.longMin;
  return Math.max(1, Math.round(min * 60 * 1000));
}

function remainingMs(state, settings) {
  if (state.running && state.endsAt) return Math.max(0, state.endsAt - Date.now());
  if (state.remainingMs != null) return state.remainingMs;
  return modeDurationMs(state.mode, settings);
}

function fmt(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function render() {
  const { settings, state } = current;
  if (!settings || !state) return;

  el.app.dataset.mode = state.mode;
  el.modeLabel.textContent = MODE_LABELS[state.mode];

  el.tabs.forEach((t) => t.classList.toggle("active", t.dataset.mode === state.mode));

  const total = modeDurationMs(state.mode, settings);
  const left = remainingMs(state, settings);
  el.time.textContent = fmt(left);

  const progress = total > 0 ? 1 - left / total : 0;
  el.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  el.ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * progress);

  el.startBtn.textContent = state.running ? "Pause" : left < total ? "Resume" : "Start";

  // Progress dots for the current cycle.
  const every = settings.longEvery;
  const doneInCycle = state.completedFocus % every;
  el.pomoDots.innerHTML = "";
  for (let i = 0; i < every; i++) {
    const dot = document.createElement("span");
    dot.className = "dot" + (i < doneInCycle ? " filled" : "");
    el.pomoDots.appendChild(dot);
  }
  el.todayCount.textContent = `${state.completedToday} today`;
}

function startLocalTick() {
  stopLocalTick();
  localTimer = setInterval(async () => {
    if (!current.state?.running || !current.state?.endsAt) {
      stopLocalTick();
      return;
    }
    if (Date.now() >= current.state.endsAt) {
      // Background completes the session and plays the chime; refresh from the
      // source of truth after it has had a moment to update state.
      stopLocalTick();
      setTimeout(refresh, 300);
      return;
    }
    render();
  }, 250);
}

function stopLocalTick() {
  if (localTimer) clearInterval(localTimer);
  localTimer = null;
}

async function refresh() {
  // A cold service worker can occasionally drop the very first message, so
  // retry once before giving up.
  let res = await safeSend("getStatus");
  if (!res || !res.state) res = await safeSend("getStatus");
  if (res && res.state) current = res;
  const pinRes = await safeSend("getPinState");
  overlayActive = !!(pinRes && pinRes.pinned);
  syncSettingsFields();
  render();
  if (current.state?.running) startLocalTick();
  else stopLocalTick();
}

async function safeSend(type, payload = {}) {
  try {
    return await send(type, payload);
  } catch (_) {
    return null;
  }
}

function syncSettingsFields() {
  const s = current.settings;
  if (!s) return;
  el.fields.focusMin.value = s.focusMin;
  el.fields.shortMin.value = s.shortMin;
  el.fields.longMin.value = s.longMin;
  el.fields.longEvery.value = s.longEvery;
  el.fields.autoStart.checked = s.autoStart;
  el.fields.sound.checked = s.sound;
  el.fields.completionSound.value = s.completionSound || "chime";
  el.fields.pinOverlay.checked = !!overlayActive;
}

// Events
el.startBtn.addEventListener("click", async () => {
  current = await send(current.state.running ? "pause" : "start");
  render();
  if (current.state.running) startLocalTick();
  else stopLocalTick();
});

el.resetBtn.addEventListener("click", async () => {
  current = await send("reset");
  stopLocalTick();
  render();
});

el.tabs.forEach((tab) =>
  tab.addEventListener("click", async () => {
    current = await send("switchMode", { mode: tab.dataset.mode });
    stopLocalTick();
    render();
  })
);

el.settingsBtn.addEventListener("click", () => {
  const willOpen = el.settingsPanel.hidden;
  el.settingsPanel.hidden = !willOpen;
  el.settingsBtn.classList.toggle("active-cog", willOpen);
  if (willOpen) {
    // Bring the panel into view within the popup.
    el.settingsPanel.scrollIntoView({ behavior: "smooth", block: "end" });
  }
});
el.closeSettings.addEventListener("click", () => {
  el.settingsPanel.hidden = true;
  el.settingsBtn.classList.remove("active-cog");
});

el.testSound.addEventListener("click", () => {
  // Preview the currently-selected sound locally (guaranteed user gesture).
  playPopupChime(el.fields.completionSound.value);
});

// Preview immediately when a different sound is chosen.
el.fields.completionSound.addEventListener("change", () => {
  playPopupChime(el.fields.completionSound.value);
});

// Pin toggle: explicitly pin/unpin the overlay on the active tab based on the
// checkbox's new value (no blind toggling).
el.fields.pinOverlay.addEventListener("change", async () => {
  const desired = el.fields.pinOverlay.checked;
  const res = await safeSend("setPin", { pinned: desired });
  if (res && typeof res.pinned === "boolean") {
    overlayActive = res.pinned;
    el.fields.pinOverlay.checked = res.pinned;
    if (res.error === "restricted-page") {
      showPinHint("Can't pin on this page. Try a normal website tab.");
    } else if (res.error) {
      showPinHint("Couldn't pin here." + (res.detail ? " (" + res.detail + ")" : ""));
    } else {
      clearPinHint();
    }
  } else {
    // Revert the toggle if the call failed.
    el.fields.pinOverlay.checked = overlayActive;
    showPinHint("Couldn't pin here.");
  }
});

function showPinHint(text) {
  let hint = document.getElementById("pinHint");
  if (!hint) {
    hint = document.createElement("div");
    hint.id = "pinHint";
    hint.className = "pin-hint";
    el.fields.pinOverlay.closest("label").insertAdjacentElement("afterend", hint);
  }
  hint.textContent = text;
}

function clearPinHint() {
  const hint = document.getElementById("pinHint");
  if (hint) hint.remove();
}

// A local preview player used only for the Test button. We keep ONE reused,
// pre-warmed AudioContext so the first click sounds just as strong as later ones
// (a fresh context starts cold/suspended, which clipped the first chime's attack).
let popupAudioCtx = null;

function getPopupContext() {
  if (!popupAudioCtx) {
    popupAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return popupAudioCtx;
}

async function playPopupChime(soundId) {
  try {
    const ctx = getPopupContext();
    if (ctx.state === "suspended") await ctx.resume();
    self.PomodoroSounds.play(ctx, soundId);
    // Intentionally do NOT close the context, so it stays warm for reuse.
  } catch (_) {
    /* ignore */
  }
}

el.saveSettings.addEventListener("click", async () => {
  const settings = {
    focusMin: clampNum(el.fields.focusMin.value, 1, 120, 25),
    shortMin: clampNum(el.fields.shortMin.value, 1, 60, 5),
    longMin: clampNum(el.fields.longMin.value, 1, 60, 15),
    longEvery: clampNum(el.fields.longEvery.value, 1, 12, 4),
    autoStart: el.fields.autoStart.checked,
    sound: el.fields.sound.checked,
    completionSound: el.fields.completionSound.value,
  };
  const res = await safeSend("saveSettings", { settings });
  if (res && res.state) current = res;
  el.settingsPanel.hidden = true;
  el.settingsBtn.classList.remove("active-cog");
  render();
});

function clampNum(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Prime the audio context on the first user interaction anywhere in the popup,
// so by the time the Test button is clicked the context is already running.
function primeAudioOnce() {
  const ctx = getPopupContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => { });
  document.removeEventListener("pointerdown", primeAudioOnce);
}
document.addEventListener("pointerdown", primeAudioOnce);

refresh();
