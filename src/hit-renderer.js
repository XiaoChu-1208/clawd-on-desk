// --- Input window: pointer capture, drag, click detection ---
// This is the "controller" — all input decisions happen here.
// Render window is pure "view" — receives reaction commands via IPC relay.

const area = document.getElementById("hit-area");

// ── Theme config (injected via preload-hit.js additionalArguments) ──
let tc = window.hitThemeConfig || {};
let _reactions = (tc && tc.reactions) || {};

// ── Platform (injected via preload-hit.js additionalArguments) ──
const isMac = !!(window.hitPlatform && window.hitPlatform.isMac);

// Theme switch: IPC push overrides additionalArguments
if (window.hitAPI && window.hitAPI.onThemeConfig) {
  window.hitAPI.onThemeConfig((cfg) => {
    tc = cfg || {};
    _reactions = (tc && tc.reactions) || {};
  });
}

// --- State synced from main ---
let currentSvg = null;
let currentState = null;
let miniMode = false;
let dndEnabled = false;

window.hitAPI.onStateSync((data) => {
  if (data.currentSvg !== undefined) currentSvg = data.currentSvg;
  if (data.currentState !== undefined) currentState = data.currentState;
  if (data.miniMode !== undefined) {
    miniMode = data.miniMode;
    area.style.cursor = miniMode ? "default" : "";
  }
  if (data.dndEnabled !== undefined) dndEnabled = data.dndEnabled;
});

// --- Drag state ---
let isDragging = false;
let didDrag = false;
let mouseDownX, mouseDownY;
let lastDragClientX;
let dragReactionDirection = null;
let dragMoveRAF = null;
const DRAG_THRESHOLD = 7;  // 放宽：点击时小抖动(≤7px)仍算点击，不被误判成拖动而丢掉这次点击

// --- Reaction state (tracked here to gate input) ---
let isReacting = false;
let isDragReacting = false;

// Cancel signal from main (e.g. state change)
window.hitAPI.onCancelReaction(() => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickCount = 0; firstClickDir = null; }
  isReacting = false;
  isDragReacting = false;
  dragReactionDirection = null;
});

function queueDragMove() {
  if (dragMoveRAF !== null) return;
  dragMoveRAF = requestAnimationFrame(() => {
    dragMoveRAF = null;
    if (!isDragging) return;
    window.hitAPI.dragMove();
  });
}

function clearQueuedDragMove() {
  if (dragMoveRAF === null) return;
  cancelAnimationFrame(dragMoveRAF);
  dragMoveRAF = null;
}

// --- Pointer handlers ---
area.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (miniMode) { didDrag = false; return; }
    area.setPointerCapture(e.pointerId);
    isDragging = true;
    didDrag = false;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    lastDragClientX = e.clientX;
    dragReactionDirection = null;
    window.hitAPI.dragLock(true);
    area.classList.add("dragging");
  }
});

document.addEventListener("pointermove", (e) => {
  if (isDragging) {
    if (!didDrag) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
        didDrag = true;
        startDragReaction(totalDx < 0 ? "left" : (totalDx > 0 ? "right" : null));
      }
    } else {
      const stepDx = e.clientX - lastDragClientX;
      if (stepDx !== 0) startDragReaction(stepDx < 0 ? "left" : "right");
    }
    lastDragClientX = e.clientX;
    queueDragMove();
  }
});

function stopDrag() {
  if (!isDragging) return;
  clearQueuedDragMove();
  isDragging = false;
  window.hitAPI.dragLock(false);
  area.classList.remove("dragging");
  if (didDrag) {
    window.hitAPI.dragEnd();
  }
  endDragReaction();
}

document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const wasDrag = didDrag;
  stopDrag();
  if (wasDrag) return;

  // macOS Ctrl-click is the system right-click gesture. Let the OS / our
  // contextmenu handler deal with it; do NOT treat it as the Dashboard
  // shortcut, and do NOT fall through to handleClick (would otherwise
  // leak into the click accumulator).
  if (isMac && e.ctrlKey && !e.metaKey) {
    resetClickAccumulator();
    return;
  }

  // Dashboard shortcut: Cmd-click on mac, Ctrl-click elsewhere.
  const isDashboardShortcut = isMac ? e.metaKey : (e.ctrlKey && !e.metaKey);
  if (isDashboardShortcut) {
    resetClickAccumulator();
    window.hitAPI.showDashboard();
    return;
  }

  handleClick(e.clientX);
});

area.addEventListener("pointercancel", () => stopDrag());
area.addEventListener("lostpointercapture", () => { if (isDragging) stopDrag(); });
window.addEventListener("blur", stopDrag);

// --- Click reaction logic (双击 = 开/关语音会话 + 反应动画；单击 = 显示 HUD) ---
const CLICK_WINDOW_MS = 600;  // 放宽连击窗口：4 连击不必那么急，间隔 ≤600ms 都算连击

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;
let lastToggleTime = 0;
const TOGGLE_DEBOUNCE_MS = 500;  // 双击 toggle 去抖：一次连点不会反复开关，但隔开的两次意图能跟手

function _getReaction(name) {
  return _reactions[name] || null;
}

function resetClickAccumulator() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  clickCount = 0;
  firstClickDir = null;
}

// Fresh-read at reaction timer fire time, NOT closured at click time —
// state / DND may change inside the 400 ms accumulator window.
function canPlayReactionNow() {
  return currentState === "idle" && !dndEnabled && !isReacting;
}

function handleClick(clientX) {
  if (miniMode) {
    window.hitAPI.exitMiniMode();
    return;
  }
  if (isDragReacting) return;

  clickCount++;
  if (clickCount === 1) {
    firstClickDir = clientX < area.offsetWidth / 2 ? "left" : "right";
    // First click reveals the session HUD. Lightweight side effect — NOT
    // gated by isReacting (HUD reveal is independent of pet animation).
    window.hitAPI.revealSessionHud();
  }

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  const doubleReact = _getReaction("double");
  const annoyedReact = _getReaction("annoyed");
  const leftReact = _getReaction("clickLeft");
  const rightReact = _getReaction("clickRight");

  if (clickCount >= 2) {
    // English-coach fork: 双击 → 开/关语音练习（带去抖，连点多下不反复开关）+ 播反应动画
    clickCount = 0;
    firstClickDir = null;
    const now = Date.now();
    if (now - lastToggleTime > TOGGLE_DEBOUNCE_MS) {
      lastToggleTime = now;
      try { window.hitAPI.coachToggle && window.hitAPI.coachToggle(); } catch (_) {}
    }
    // 反应动画也跟到双击：优先 double(flail)，没有就用 annoyed / 左右点
    if (canPlayReactionNow()) {
      const react = doubleReact || annoyedReact || leftReact || rightReact;
      if (react) {
        const files = react.files || [react.file];
        const file = files[Math.floor(Math.random() * files.length)];
        playReaction(file, react.duration || 3000);
      }
    }
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      // English-coach fork: 只在「确认为单击」(等过双击窗口、没第二下) 才打断 Claude。
      // 这样双击=暂停的第一下不会误触打断，意外的连点也不会。打断会有 ~CLICK_WINDOW_MS 的延迟，可接受。
      if (clickCount === 1) { try { window.hitAPI.coachPoke && window.hitAPI.coachPoke(); } catch (_) {} }
      clickCount = 0;
      firstClickDir = null;
    }, CLICK_WINDOW_MS);
  }
}

function playReaction(svg, duration) {
  if (!svg) return;
  isReacting = true;
  window.hitAPI.playClickReaction(svg, duration);
  // Local timer to ungate input after duration
  setTimeout(() => { isReacting = false; }, duration);
}

// --- Drag reaction ---
function startDragReaction(direction) {
  if (dndEnabled) return;
  if (isDragReacting && dragReactionDirection === direction) return;

  if (isReacting) {
    isReacting = false;
  }

  isDragReacting = true;
  dragReactionDirection = direction;
  window.hitAPI.startDragReaction(direction);
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  dragReactionDirection = null;
  window.hitAPI.endDragReaction();
}

// --- Right-click context menu ---
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.hitAPI.showContextMenu();
});
