// user-bubble.js — 你（用户）的对话气泡：贴在桌宠【下方】（与 coach 气泡反向），蓝字，
// 实时更新（边说边长），带闪烁输入光标。不自动消失——由引擎显式 show/hide。
//
// initUserBubble(deps) → { showUserBubble({mode,text,side}), hideUserBubble(), cleanup }
//   mode: 'prompt'（轮到你说、只显示光标+占位） | 'live'（实时文字+光标）
//   deps.getPetWindowBounds() / getNearestWorkArea(cx,cy) / ipcMain

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const http = require("http");

const ENGINE_PORT = Number(process.env.COACH_CONTROL_PORT || 23390);

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";

const CARD_MARGIN = 20;       // = .speech margin（留给投影），窗口 = 卡片 + 两侧 margin
const CARD_MAX_WIDTH = 300;   // = .speech max-width
const ESTIMATED_CARD_W = 90;
const ESTIMATED_CARD_H = 24;
const GAP_BELOW_PET = 6;

module.exports = function initUserBubble(deps = {}) {
  const getPetWindowBounds = deps.getPetWindowBounds;
  const getNearestWorkArea = deps.getNearestWorkArea;
  const ipc = deps.ipcMain || ipcMain;

  let win = null;
  let ready = false;
  let pendingShow = null;
  let hideTimer = null;
  let lastCardW = ESTIMATED_CARD_W;
  let lastCardH = ESTIMATED_CARD_H;
  let followTimer = null, lastPetKey = "";

  // 跟随桌宠移动：拖动时持续重新贴位
  function startFollow() {
    if (followTimer) return;
    followTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      let pet; try { pet = getPetWindowBounds(); } catch { return; }
      if (!pet) return;
      const key = pet.x + "," + pet.y + "," + pet.width + "," + pet.height;
      if (key !== lastPetKey) { lastPetKey = key; anchor(); }
    }, 60);
  }
  function stopFollow() { if (followTimer) { clearInterval(followTimer); followTimer = null; } }

  function anchor() {
    if (!win || win.isDestroyed() || typeof getPetWindowBounds !== "function") return;
    let pet;
    try { pet = getPetWindowBounds(); } catch { return; }
    if (!pet) return;
    const cx = pet.x + pet.width / 2;
    const cy = pet.y + pet.height / 2;
    const wa = typeof getNearestWorkArea === "function" ? (getNearestWorkArea(cx, cy) || null) : null;

    // 窗口 = 卡片实测尺寸 + 四周 margin（卡片 width:max-content，随字增长/换行）
    const winW = Math.ceil(lastCardW) + 2 * CARD_MARGIN;
    const winH = Math.ceil(lastCardH) + 2 * CARD_MARGIN;
    let x = Math.round(cx - winW / 2);              // 居中对齐桌宠，随字对称变宽
    // 贴桌宠下方：卡片顶部挨着桌宠下半身（78%）→ 窗口顶 = 卡片顶 - margin
    const petAnchorY = Math.round(pet.y + pet.height * 0.78);
    let y = petAnchorY + GAP_BELOW_PET - CARD_MARGIN;

    if (wa) {
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - winW));
      // 下方放不下 → 翻到桌宠上方
      if (y + winH > wa.y + wa.height) {
        y = Math.round(pet.y + pet.height * 0.22) - winH - GAP_BELOW_PET + CARD_MARGIN;
      }
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - winH));
    }
    try { win.setBounds({ x, y, width: winW, height: winH }); } catch {}
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: ESTIMATED_CARD_W + 2 * CARD_MARGIN, height: ESTIMATED_CARD_H + 2 * CARD_MARGIN,
      show: false, frame: false, transparent: true, alwaysOnTop: true,
      resizable: false, skipTaskbar: true, hasShadow: false, focusable: false,
      roundedCorners: false,   // 关掉 macOS 窗口圆角遮罩，让 CSS 的方角说了算
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel", acceptFirstMouse: true } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-user-bubble.js"),
        nodeIntegration: false, contextIsolation: true,
        partition: "user-bubble",   // 内存型 session：重启不吃旧 CSS 磁盘缓存
      },
    });
    ready = false;
    if (isMac) win.setAlwaysOnTop(true, "screen-saver");
    if (isWin) win.setAlwaysOnTop(true, "pop-up-menu");
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}

    win.loadFile(path.join(__dirname, "user-bubble.html"));
    win.webContents.once("did-finish-load", () => {
      ready = true;
      if (pendingShow) { const p = pendingShow; pendingShow = null; deliver(p); }
    });
    win.on("closed", () => { win = null; ready = false; stopFollow(); });
    startFollow();
    return win;
  }

  function deliver(payload) {
    if (!win || win.isDestroyed()) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    anchor();
    win.webContents.send("user-speech-show", payload);
    if (!win.isVisible()) win.showInactive();
  }

  // renderer 回报卡片实测 {width,height} → 窗口随字变宽/变高 + 重新锚定
  function onSize(_event, size) {
    const w = size && Number(size.width);
    const h = size && Number(size.height);
    lastCardW = Math.max(40, Math.min(Number.isFinite(w) ? w : ESTIMATED_CARD_W, CARD_MAX_WIDTH));
    lastCardH = Math.max(18, Math.min(Number.isFinite(h) ? h : ESTIMATED_CARD_H, 400));
    anchor();
  }
  ipc.on("user-bubble-size", onSize);

  // 双击你的气泡 → 打引擎 /toggle 暂停/恢复录音；用返回的 paused 驱动锁定视觉
  function onToggleMic() {
    const req = http.request(
      { host: "127.0.0.1", port: ENGINE_PORT, path: "/toggle", method: "POST", timeout: 1200 },
      (res) => {
        let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => {
          let paused = false; try { paused = !!JSON.parse(b).paused; } catch {}
          ensureWindow();
          const send = () => {
            if (!win || win.isDestroyed()) return;
            win.webContents.send("user-speech-lock", paused);  // 锁定 → 灰色 Claude can't hear
            if (!win.isVisible()) win.showInactive();
          };
          if (ready) send();
          else win.webContents.once("did-finish-load", send);
        });
      }
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end();
  }
  ipc.on("user-toggle-mic", onToggleMic);

  function showUserBubble(opts = {}) {
    const payload = {
      mode: opts.mode === "prompt" ? "prompt" : "live",
      text: typeof opts.text === "string" ? opts.text : "",
      side: opts.side === "left" ? "left" : "right",
    };
    ensureWindow();
    if (ready) deliver(payload); else pendingShow = payload;
  }

  function hideUserBubble() {
    pendingShow = null;
    if (!win || win.isDestroyed()) return;
    win.webContents.send("user-speech-hide");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = null; if (win && !win.isDestroyed()) win.hide(); }, 200);
  }

  function cleanup() {
    stopFollow();
    if (hideTimer) clearTimeout(hideTimer);
    try { ipc.removeListener("user-bubble-size", onSize); } catch {}
    try { ipc.removeListener("user-toggle-mic", onToggleMic); } catch {}
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return { showUserBubble, hideUserBubble, reanchor: () => anchor(), cleanup };
};
