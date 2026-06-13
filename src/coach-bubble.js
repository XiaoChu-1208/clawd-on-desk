// coach-bubble.js — speech bubble STACK for the English-coach fork.
// Each spoken line is its own transparent always-on-top window. New lines
// appear right above the pet's head; older lines get pushed upward (newest =
// bottom = closest to the pet, like a chat log growing upward). Each entry
// auto-fades after its own ttl. Independent of the permission-bubble stack.
//
// initCoachBubble(deps) → { showSpeechBubble({text, state, ttl, theme}), cleanup }
//   deps.getPetWindowBounds()        -> { x, y, width, height }
//   deps.getNearestWorkArea(cx, cy)  -> { x, y, width, height }
//   deps.ipcMain                     (electron ipcMain)

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";

// CARD_* are the visible card (max) size; the window is the card + a uniform
// transparent CARD_MARGIN on every side so the drop shadow never clips.
const CARD_MARGIN = 20;     // MUST match .speech margin in coach-bubble.css
const CARD_MAX_WIDTH = 300; // MUST match .speech max-width in coach-bubble.css
const ESTIMATED_CARD_H = 48;
const STACK_GAP = 8;        // px between stacked bubble CARDS
const GAP_ABOVE_HEAD = 12;  // px between newest bubble's corner and the pet head
const HEAD_TOP_RATIO = 0.48; // fallback: pet head top ≈ this fraction down the window
const EDGE_INSET = 0;       // nudge the aligned edge inward from the pet's edge
const MAX_STACK = 4;        // older bubbles beyond this are dropped immediately
const WIN_W = CARD_MAX_WIDTH + 2 * CARD_MARGIN; // window width at creation (max)

function clampTtl(ttl, text) {
  const n = Number(ttl);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 20000);
  const len = typeof text === "string" ? text.length : 0;
  return Math.min(12000, Math.round(2600 + len * 55));
}

module.exports = function initCoachBubble(deps = {}) {
  const getPetWindowBounds = deps.getPetWindowBounds;
  const getHitRectScreen = deps.getHitRectScreen;
  const getNearestWorkArea = deps.getNearestWorkArea;
  const ipc = deps.ipcMain || ipcMain;

  // entries oldest → newest. Each: { win, ready, height, payload, hideTimer, destroyTimer, closing }
  const stack = [];

  // Resolve the VISIBLE pet rectangle (the on-screen sprite, not the padded
  // window) plus which side of the screen it's on. Falls back to the window
  // bounds + a head-ratio if the hit rect isn't available.
  function petAnchor() {
    let pet = null;
    try { pet = typeof getPetWindowBounds === "function" ? getPetWindowBounds() : null; } catch {}
    if (!pet) return null;
    let hit = null;
    try { hit = typeof getHitRectScreen === "function" ? getHitRectScreen(pet) : null; } catch {}
    const rect = hit && Number.isFinite(hit.left)
      ? { left: hit.left, right: hit.right, top: hit.top, bottom: hit.bottom }
      : { left: pet.x, right: pet.x + pet.width,
          top: pet.y + pet.height * HEAD_TOP_RATIO, bottom: pet.y + pet.height };
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const wa = typeof getNearestWorkArea === "function" ? (getNearestWorkArea(cx, cy) || null) : null;
    const side = wa ? (cx >= wa.x + wa.width / 2 ? "right" : "left") : "right";
    return { rect, wa, side };
  }

  function reposition() {
    if (!stack.length) return;
    const a = petAnchor();
    if (!a) return;
    const { rect, wa, side } = a;

    // We position in CARD coordinates (the visible bubble), then expand each
    // window outward by CARD_MARGIN on every side. The newest card's square
    // corner sits just above the pet head; older cards stack upward.
    const M = CARD_MARGIN;
    let cardBottomY = Math.round(rect.top) - GAP_ABOVE_HEAD;

    for (let i = stack.length - 1; i >= 0; i--) {
      const e = stack[i];
      const cw = Math.ceil(e.width || CARD_MAX_WIDTH);   // card box size
      const ch = Math.ceil(e.height || ESTIMATED_CARD_H);
      // card left edge aligned to the pet's edge on the correct side
      let cardX = side === "right"
        ? Math.round(rect.right - EDGE_INSET - cw)  // card right == pet right
        : Math.round(rect.left + EDGE_INSET);       // card left  == pet left
      let cardTop = cardBottomY - ch;
      // window = card + uniform margin on every side
      let x = cardX - M;
      let y = cardTop - M;
      const winW = cw + 2 * M;
      const winH = ch + 2 * M;
      if (wa) {
        x = Math.max(wa.x - M, Math.min(x, wa.x + wa.width - winW + M));
        if (y < wa.y - M) y = wa.y - M; // keep the card on-screen at the top
      }
      if (e.win && !e.win.isDestroyed()) {
        try { e.win.setBounds({ x, y, width: winW, height: winH }); } catch {}
      }
      cardBottomY = cardTop - STACK_GAP;
    }
  }

  function removeEntry(e) {
    const idx = stack.indexOf(e);
    if (idx !== -1) stack.splice(idx, 1);
    if (e.hideTimer) clearTimeout(e.hideTimer);
    if (e.destroyTimer) clearTimeout(e.destroyTimer);
    if (e.win && !e.win.isDestroyed()) {
      try { e.win.destroy(); } catch {}
    }
    e.win = null;
  }

  function fadeOut(e) {
    if (e.closing) return;
    e.closing = true;
    if (e.win && !e.win.isDestroyed()) {
      try { e.win.webContents.send("coach-speech-hide"); } catch {}
      e.destroyTimer = setTimeout(() => removeEntry(e), 240);
    } else {
      removeEntry(e);
    }
  }

  function createEntry(payload, ttl) {
    const win = new BrowserWindow({
      width: WIN_W,
      height: ESTIMATED_CARD_H + 2 * CARD_MARGIN,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      // macOS rounds frameless-window corners by default, which masks our
      // square corner round no matter what CSS says. Turn it off so the card's
      // own border-radius (3 round + 1 square) is what shows.
      roundedCorners: false,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel", acceptFirstMouse: true } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-coach-bubble.js"),
        nodeIntegration: false,
        contextIsolation: true,
        // in-memory session (no "persist:" prefix) → never serve coach-bubble
        // css/js from a stale on-disk cache across restarts.
        partition: "coach-bubble",
      },
    });
    if (isMac) win.setAlwaysOnTop(true, "screen-saver");
    if (isWin) win.setAlwaysOnTop(true, "pop-up-menu");
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}

    const entry = { win, ready: false, width: CARD_MAX_WIDTH, height: ESTIMATED_CARD_H, payload, hideTimer: null, destroyTimer: null, closing: false };

    win.loadFile(path.join(__dirname, "coach-bubble.html"));
    win.webContents.once("did-finish-load", () => {
      entry.ready = true;
      if (entry.win && !entry.win.isDestroyed()) {
        reposition();
        entry.win.webContents.send("coach-speech-show", entry.payload);
        entry.win.showInactive();
      }
    });
    win.on("closed", () => {
      entry.win = null;
      const idx = stack.indexOf(entry);
      if (idx !== -1) stack.splice(idx, 1);
    });

    entry.hideTimer = setTimeout(() => fadeOut(entry), clampTtl(ttl, payload && payload.text));
    return entry;
  }

  // renderer reports its measured {width,height} → match it to its entry,
  // resize the window to hug the text, and restack.
  function onSize(event, size) {
    const e = stack.find((s) => s.win && !s.win.isDestroyed() && s.win.webContents === event.sender);
    if (!e) return;
    const w = size && Number(size.width);
    const h = size && Number(size.height);
    e.width = Math.max(40, Math.min(Number.isFinite(w) ? w : CARD_MAX_WIDTH, CARD_MAX_WIDTH));
    e.height = Math.max(20, Math.min(Number.isFinite(h) ? h : ESTIMATED_CARD_H, 600));
    reposition();
  }
  ipc.on("coach-bubble-size", onSize);

  function showSpeechBubble(opts = {}) {
    const text = typeof opts.text === "string" ? opts.text : String(opts.text || "");
    if (!text.trim()) return;

    // figure out the pet's side now so the bubble grows from the right corner
    const a = petAnchor();
    const side = a ? a.side : "right";

    const payload = { text, side, theme: opts.theme === "warm" ? "warm" : "dark" };

    // drop the oldest if we're at the cap (newest pushes others up & off)
    while (stack.length >= MAX_STACK) {
      removeEntry(stack[0]);
    }
    const entry = createEntry(payload, opts.ttl);
    stack.push(entry);
    reposition();
  }

  // 跟随桌宠移动：拖动时持续重新贴位（仅当有气泡且桌宠位置真的变了）
  let lastPetKey = "";
  const followTimer = setInterval(() => {
    if (!stack.length || typeof getPetWindowBounds !== "function") return;
    let pet; try { pet = getPetWindowBounds(); } catch { return; }
    if (!pet) return;
    const key = pet.x + "," + pet.y + "," + pet.width + "," + pet.height;
    if (key !== lastPetKey) { lastPetKey = key; reposition(); }
  }, 60);

  function cleanup() {
    clearInterval(followTimer);
    try { ipc.removeListener("coach-bubble-size", onSize); } catch {}
    for (const e of [...stack]) removeEntry(e);
    stack.length = 0;
  }

  return { showSpeechBubble, reanchor: () => reposition(), cleanup };
};
