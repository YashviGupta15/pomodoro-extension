// Floating "pinned" timer overlay, injected into the active tab.
// Reads timer state from chrome.storage.local and stays in sync via
// chrome.storage.onChanged, so it needs no direct message pipe to the worker.

(function () {
  const HOST_ID = "cozy-pomodoro-overlay";

  // Idempotent: if the overlay is already present, do nothing (never duplicate,
  // never self-remove). Presence in the DOM is the source of truth; removal is
  // handled explicitly by the service worker via a separate injected call.
  if (document.getElementById(HOST_ID)) {
    return;
  }

  const MODE_LABELS = { focus: "Focus", short: "Short Break", long: "Long Break" };
  const MODE_COLORS = { focus: "#ff6b6b", short: "#4ecdc4", long: "#5c7cfa" };
  const DEFAULT_SETTINGS = { focusMin: 25, shortMin: 5, longMin: 15 };

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Shadow DOM isolates our styles from the page's CSS.
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .card {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      width: 150px;
      padding: 12px 14px;
      border-radius: 16px;
      background: #fffdfb;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #4a4453;
      user-select: none;
      cursor: grab;
      border-top: 4px solid var(--accent, #ff6b6b);
    }
    .card.dragging { cursor: grabbing; }
    .row { display: flex; align-items: center; justify-content: space-between; }
    .label {
      font-size: 10px; font-weight: 700; letter-spacing: 1px;
      text-transform: uppercase; color: #9b95a3;
    }
    .close {
      border: none; background: transparent; cursor: pointer;
      font-size: 15px; line-height: 1; color: #9b95a3; padding: 0;
    }
    .close:hover { color: #4a4453; }
    .time {
      font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums;
      text-align: center; margin: 4px 0 2px;
    }
    .state { font-size: 10px; text-align: center; color: #9b95a3; }
  `;

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="row">
      <span class="label" id="cp-label">Focus</span>
      <button class="close" id="cp-close" title="Unpin">✕</button>
    </div>
    <div class="time" id="cp-time">25:00</div>
    <div class="state" id="cp-state">paused</div>
  `;

  shadow.appendChild(style);
  shadow.appendChild(card);
  document.documentElement.appendChild(host);

  const timeEl = shadow.getElementById("cp-time");
  const labelEl = shadow.getElementById("cp-label");
  const stateEl = shadow.getElementById("cp-state");

  function modeDurationMs(mode, s) {
    const min = mode === "focus" ? s.focusMin : mode === "short" ? s.shortMin : s.longMin;
    return Math.max(1, Math.round(min * 60 * 1000));
  }

  function fmt(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  let cache = { state: null, settings: DEFAULT_SETTINGS };
  let raf = null;

  function draw() {
    const { state, settings } = cache;
    if (!state) return;
    card.style.setProperty("--accent", MODE_COLORS[state.mode] || "#ff6b6b");
    labelEl.textContent = MODE_LABELS[state.mode] || "Focus";

    let left;
    if (state.running && state.endsAt) left = state.endsAt - Date.now();
    else if (state.remainingMs != null) left = state.remainingMs;
    else left = modeDurationMs(state.mode, settings);

    timeEl.textContent = fmt(left);
    stateEl.textContent = state.running ? "running" : "paused";
  }

  function loop() {
    draw();
    if (cache.state?.running) raf = requestAnimationFrame(loop);
  }

  function refreshFromStorage() {
    chrome.storage.local.get(["state", "settings"], (res) => {
      if (res.state) cache.state = res.state;
      if (res.settings) cache.settings = { ...DEFAULT_SETTINGS, ...res.settings };
      if (raf) cancelAnimationFrame(raf);
      loop();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.state) cache.state = changes.state.newValue;
    if (changes.settings) cache.settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    if (raf) cancelAnimationFrame(raf);
    loop();
  });

  refreshFromStorage();

  // --- Dragging -----------------------------------------------------------
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  card.addEventListener("pointerdown", (e) => {
    if (e.target.id === "cp-close") return;
    dragging = true;
    card.classList.add("dragging");
    const rect = card.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - card.offsetWidth, e.clientX - offsetX));
    const y = Math.max(0, Math.min(window.innerHeight - card.offsetHeight, e.clientY - offsetY));
    card.style.left = x + "px";
    card.style.top = y + "px";
    card.style.right = "auto";
  });

  card.addEventListener("pointerup", (e) => {
    dragging = false;
    card.classList.remove("dragging");
    card.releasePointerCapture(e.pointerId);
  });

  // Close/unpin: tell the worker to unpin this tab (so it won't re-inject on
  // reload), then remove ourselves.
  shadow.getElementById("cp-close").addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage({ type: "unpinSelf" });
    } catch (_) {
      /* worker may be asleep; removal below still happens */
    }
    host.remove();
  });
})();
