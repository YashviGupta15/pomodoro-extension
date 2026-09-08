// Cozy Pomodoro - background service worker
// Owns the timer state so it keeps running even when the popup is closed.

const MODES = {
  focus: { label: "Focus", color: "#ff6b6b" },
  short: { label: "Short Break", color: "#4ecdc4" },
  long: { label: "Long Break", color: "#5c7cfa" },
};

const DEFAULT_SETTINGS = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4, // long break after this many focus sessions
  autoStart: false,
  sound: true,
  completionSound: "chime", // chime | bell | digital | marimba | gong
};

const DEFAULT_STATE = {
  mode: "focus", // focus | short | long
  running: false,
  // endsAt: epoch ms when the current run finishes (null when not running)
  endsAt: null,
  // remaining ms when paused (used to resume without recomputing from settings)
  remainingMs: null,
  completedFocus: 0, // focus sessions completed in the current cycle
  completedToday: 0,
  today: todayKey(),
};

const BADGE_ALARM = "pomodoro-badge"; // periodic, refreshes the toolbar badge
const END_ALARM = "pomodoro-end"; // one-shot, fires exactly when the session ends

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  const merged = { ...DEFAULT_STATE, ...(state || {}) };
  // Reset daily counter if the day rolled over.
  if (merged.today !== todayKey()) {
    merged.today = todayKey();
    merged.completedToday = 0;
  }
  return merged;
}

async function setState(patch) {
  const state = await getState();
  const next = { ...state, ...patch };
  await chrome.storage.local.set({ state: next });
  return next;
}

function modeDurationMs(mode, settings) {
  const min =
    mode === "focus"
      ? settings.focusMin
      : mode === "short"
        ? settings.shortMin
        : settings.longMin;
  return Math.max(1, Math.round(min * 60 * 1000));
}

async function updateBadge(state) {
  if (!state.running || !state.endsAt) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const msLeft = Math.max(0, state.endsAt - Date.now());
  const minLeft = Math.ceil(msLeft / 60000);
  await chrome.action.setBadgeBackgroundColor({ color: MODES[state.mode].color });
  await chrome.action.setBadgeText({ text: String(minLeft) });
}

async function startTicking(endsAt) {
  // chrome.alarms clamps periodInMinutes to a 1-minute minimum, so a periodic
  // alarm alone can't detect completion on time. We therefore use TWO alarms:
  //  - END_ALARM: a precise one-shot at endsAt so completion (and auto-start)
  //    fire exactly on time.
  //  - BADGE_ALARM: a periodic alarm that just keeps the minute badge fresh.
  await chrome.alarms.create(END_ALARM, { when: endsAt });
  await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
}

async function stopTicking() {
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(BADGE_ALARM);
}

async function start() {
  const settings = await getSettings();
  let state = await getState();
  let remaining =
    state.remainingMs != null ? state.remainingMs : modeDurationMs(state.mode, settings);
  const endsAt = Date.now() + remaining;
  state = await setState({
    running: true,
    endsAt,
    remainingMs: null,
  });
  await startTicking(endsAt);
  await updateBadge(state);
}

async function pause() {
  let state = await getState();
  if (!state.running || !state.endsAt) return;
  const remaining = Math.max(0, state.endsAt - Date.now());
  state = await setState({ running: false, remainingMs: remaining, endsAt: null });
  await stopTicking();
  await updateBadge(state);
}

async function reset() {
  const settings = await getSettings();
  const state = await getState();
  await setState({
    running: false,
    endsAt: null,
    remainingMs: modeDurationMs(state.mode, settings),
  });
  await stopTicking();
  await chrome.action.setBadgeText({ text: "" });
}

async function switchMode(mode) {
  const settings = await getSettings();
  await setState({
    mode,
    running: false,
    endsAt: null,
    remainingMs: modeDurationMs(mode, settings),
  });
  await stopTicking();
  await chrome.action.setBadgeText({ text: "" });
}

async function completeSession() {
  const settings = await getSettings();
  let state = await getState();
  await stopTicking();

  const finishedMode = state.mode;
  let nextMode;
  let completedFocus = state.completedFocus;
  let completedToday = state.completedToday;

  if (finishedMode === "focus") {
    completedFocus += 1;
    completedToday += 1;
    nextMode =
      completedFocus % settings.longEvery === 0 ? "long" : "short";
  } else {
    nextMode = "focus";
    if (finishedMode === "long") completedFocus = 0;
  }

  notify(finishedMode, nextMode);
  if (settings.sound) await playChime(settings.completionSound);

  state = await setState({
    mode: nextMode,
    running: false,
    endsAt: null,
    remainingMs: modeDurationMs(nextMode, settings),
    completedFocus,
    completedToday,
  });

  await chrome.action.setBadgeText({ text: "" });

  if (settings.autoStart) {
    await start();
  }
}

function notify(finishedMode, nextMode) {
  const finished = MODES[finishedMode].label;
  const next = MODES[nextMode].label;
  chrome.notifications.create(`pomodoro-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${finished} complete!`,
    message:
      nextMode === "focus"
        ? "Break's over. Ready to focus? 🍅"
        : `Nice work. Time for a ${next.toLowerCase()}. ☕`,
    priority: 2,
  });
}

async function tick() {
  const state = await getState();
  if (!state.running || !state.endsAt) {
    await stopTicking();
    return;
  }
  if (Date.now() >= state.endsAt) {
    await completeSession();
  } else {
    await updateBadge(state);
  }
}

// --- Offscreen audio ------------------------------------------------------
// The service worker can't play audio directly, so we use an offscreen
// document. We create it lazily and reuse it across sessions.
let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a short chime when a Pomodoro session ends.",
  });
  try {
    await creatingOffscreen;
  } catch (_) {
    // A document may already exist due to a race; ignore.
  } finally {
    creatingOffscreen = null;
  }
}

// Wait until the offscreen document's message listener is actually ready.
// Freshly created documents need a moment to load offscreen.js, and a message
// sent before then is silently dropped (this is why the first chime was lost).
async function waitForOffscreenReady(timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "ping", target: "offscreen" });
      if (res?.ready) return true;
    } catch (_) {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

async function playChime(soundId = "chime") {
  try {
    await ensureOffscreen();
    await waitForOffscreenReady();
    await chrome.runtime.sendMessage({ type: "playChime", target: "offscreen", sound: soundId });
  } catch (_) {
    /* offscreen unavailable; the notification still fires */
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // Both the precise end alarm and the periodic badge alarm route through tick();
  // tick() completes the session if we've reached endsAt, otherwise refreshes.
  if (alarm.name === END_ALARM || alarm.name === BADGE_ALARM) tick();
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ settings });
  await reset();
});

chrome.runtime.onStartup.addListener(async () => {
  // Recover badge/ticking if a timer was running before the browser restarted.
  const state = await getState();
  if (state.running && state.endsAt) {
    await startTicking(state.endsAt);
    await updateBadge(state);
  }
});

// Message bridge for the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "getStatus": {
        const [settings, state] = await Promise.all([getSettings(), getState()]);
        sendResponse({ settings, state });
        break;
      }
      case "start":
        await start();
        sendResponse(await snapshot());
        break;
      case "pause":
        await pause();
        sendResponse(await snapshot());
        break;
      case "reset":
        await reset();
        sendResponse(await snapshot());
        break;
      case "switchMode":
        await switchMode(msg.mode);
        sendResponse(await snapshot());
        break;
      case "testSound":
        await playChime(msg.sound || (await getSettings()).completionSound);
        sendResponse({ ok: true });
        break;
      case "getPinState": {
        const tab = await getActiveTab();
        sendResponse({ pinned: tab ? await isTabPinned(tab.id) : false });
        break;
      }
      case "setPin":
        try {
          sendResponse(await setPin(!!msg.pinned));
        } catch (e) {
          sendResponse({ pinned: false, error: "handler-threw", detail: String((e && e.message) || e) });
        }
        break;
      case "unpinSelf":
        // Sent from the overlay's close button; _sender.tab tells us which tab.
        if (_sender?.tab?.id != null) await removeTabFromPinned(_sender.tab.id);
        sendResponse({ ok: true });
        break;
      case "saveSettings":
        await chrome.storage.local.set({ settings: { ...(await getSettings()), ...msg.settings } });
        // Re-derive remaining time for the current mode if idle.
        {
          const s = await getState();
          if (!s.running) await reset();
        }
        sendResponse(await snapshot());
        break;
      default:
        sendResponse({ error: "unknown message" });
    }
  })();
  return true; // keep the channel open for async sendResponse
});

async function snapshot() {
  const [settings, state] = await Promise.all([getSettings(), getState()]);
  return { settings, state };
}

// --- Pin overlay ----------------------------------------------------------
// Presence of the overlay in a tab is the source of truth. We remember which
// tab IDs the user pinned (persisted) so we can re-inject after a reload.

async function getPinnedTabs() {
  const { pinnedTabs } = await chrome.storage.local.get("pinnedTabs");
  return Array.isArray(pinnedTabs) ? pinnedTabs : [];
}

async function setPinnedTabs(ids) {
  await chrome.storage.local.set({ pinnedTabs: [...new Set(ids)] });
}

async function addTabToPinned(tabId) {
  const ids = await getPinnedTabs();
  if (!ids.includes(tabId)) await setPinnedTabs([...ids, tabId]);
}

async function removeTabFromPinned(tabId) {
  const ids = await getPinnedTabs();
  await setPinnedTabs(ids.filter((id) => id !== tabId));
}

async function isTabPinned(tabId) {
  const ids = await getPinnedTabs();
  return ids.includes(tabId);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id != null ? tab : null;
}

function isRestrictedUrl(url) {
  if (!url) return false; // empty means we couldn't read it; let injection decide
  return (
    /^(chrome|edge|about|chrome-extension|edge-extension|view-source|devtools):/i.test(url) ||
    /^https:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com)/i.test(url)
  );
}

// Ask the tab whether the overlay is currently present.
async function overlayPresent(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!document.getElementById("cozy-pomodoro-overlay"),
    });
    return !!res?.result;
  } catch (_) {
    return false;
  }
}

async function injectOverlay(tabId) {
  // overlay.js is idempotent: it only adds the overlay if missing.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
}

async function removeOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const host = document.getElementById("cozy-pomodoro-overlay");
        if (host) host.remove();
      },
    });
  } catch (_) {
    /* tab may be gone; ignore */
  }
}

// Explicitly pin or unpin the active tab based on the desired state.
async function setPin(desiredPinned) {
  const tab = await getActiveTab();
  if (!tab) return { pinned: false, error: "no-active-tab" };
  if (isRestrictedUrl(tab.url)) return { pinned: false, error: "restricted-page" };

  try {
    if (desiredPinned) {
      await injectOverlay(tab.id);
      // Confirm it actually landed (catches restricted pages with empty URL).
      const present = await overlayPresent(tab.id);
      if (!present) return { pinned: false, error: "restricted-page" };
      await addTabToPinned(tab.id);
      return { pinned: true };
    } else {
      await removeOverlay(tab.id);
      await removeTabFromPinned(tab.id);
      return { pinned: false };
    }
  } catch (e) {
    return { pinned: false, error: "inject-failed", detail: String(e && e.message || e) };
  }
}

// Re-inject the overlay when a pinned tab finishes (re)loading.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  if (await isTabPinned(tabId)) {
    try {
      await injectOverlay(tabId);
    } catch (_) {
      // If we can no longer inject (e.g. navigated to a restricted page),
      // drop it from the pinned set so the state stays honest.
      await removeTabFromPinned(tabId);
    }
  }
});

// Clean up the pinned set when a tab is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabFromPinned(tabId);
});
