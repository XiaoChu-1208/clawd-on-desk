// chat-stack.js — Claude Baby 头顶的聊天记录栏（最新贴 Claude Baby 、整列往上长）。
// 可聚焦，让最下面那条 <input> 能真实打字；回车 → 经引擎控制口 /text 发出去。
//
// initChatStack(deps) → { chat(payload), clear(), cleanup }
//   payload.type: clear | add{role,text} | input{text?} | live{text} | endinput | hide
//   deps.getPetWindowBounds() / getNearestWorkArea(cx,cy) / ipcMain

const { BrowserWindow, ipcMain, shell, clipboard } = require("electron");
const path = require("path");
const http = require("http");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";

const W = 360;
const GAP = 6;
const ENGINE_PORT = Number(process.env.COACH_CONTROL_PORT || 23390);

module.exports = function initChatStack(deps = {}) {
  const getPetWindowBounds = deps.getPetWindowBounds;
  const getHitRectScreen = deps.getHitRectScreen;
  const getNearestWorkArea = deps.getNearestWorkArea;
  const ipc = deps.ipcMain || ipcMain;

  let win = null, ready = false, queue = [], currentSide = "right";
  let followTimer = null, lastPetKey = "", lastBoundsKey = "";
  let userHidden = false;   // 用户双击隐藏对话面板（内容保留，更新照收但不弹窗）
  let composeExtra = 0;     // 合成(粘图)时窗口在固定高度上【向下】多长出来的高度(px)，由渲染端 reportSize 上报

  // 跟随 Claude Baby 移动：Claude Baby 被拖动时持续重新贴位（窗口固定大小，只在 Claude Baby 位置真的变了才 setBounds）
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

  // 固定高度的对话框：内容在框内从底往上流，超出顶部被透明渐变蒙版吃掉（CSS）。
  // 窗口尺寸恒定 → 内容增减不 resize → 不闪。
  function fixedH(wa) { return wa ? Math.round(wa.height * 0.45) : 420; }

  function pushSide() {
    if (win && !win.isDestroyed() && ready) {
      try { win.webContents.send("chat-side", currentSide); } catch {}
    }
  }

  function anchor() {
    if (!win || win.isDestroyed() || typeof getPetWindowBounds !== "function") return;
    let pet; try { pet = getPetWindowBounds(); } catch { return; }
    if (!pet) return;
    let hit = null;
    try { hit = typeof getHitRectScreen === "function" ? getHitRectScreen(pet) : null; } catch {}
    const rect = hit && Number.isFinite(hit.left)
      ? { left: hit.left, right: hit.right, top: hit.top }
      : { left: pet.x, right: pet.x + pet.width, top: pet.y + pet.height * 0.55 };
    const cx = (rect.left + rect.right) / 2;
    const wa = typeof getNearestWorkArea === "function" ? (getNearestWorkArea(cx, rect.top) || null) : null;
    const baseH = fixedH(wa);                 // 基础固定高度
    const h = baseH + composeExtra;           // 合成(粘图)时:在基础高度上【向下】增高,把预览图包进来
    const width = W;
    const side = wa ? (cx >= wa.x + wa.width / 2 ? "right" : "left") : "right";
    let x = side === "right" ? Math.round(rect.right - width) : Math.round(rect.left);
    let y = Math.round(rect.top) - baseH - GAP;  // 顶部按【基础高度】定位 → 输入气泡顶不动;composeExtra 全往下长(盖到 Claude Baby 头那块)
    if (wa) {
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
      y = Math.max(wa.y, y);
    }
    const key = x + "," + y + "," + width + "," + h;
    if (key !== lastBoundsKey) { lastBoundsKey = key; try { win.setBounds({ x, y, width, height: h }); } catch {} }
    if (side !== currentSide) { currentSide = side; pushSide(); }
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: W, height: 80,
      show: false, frame: false, transparent: true, alwaysOnTop: true,
      backgroundColor: "#00000000",    // 全透明背景：减少 macOS 透明窗口 resize 闪烁
      resizable: false, skipTaskbar: true, hasShadow: false,
      focusable: true,                 // 要能打字 → 可聚焦
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel", acceptFirstMouse: true } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-chat-stack.js"),
        nodeIntegration: false, contextIsolation: true,
        partition: "chat-stack",   // 内存型 session：重启不吃旧 CSS 磁盘缓存
      },
    });
    ready = false;
    if (isMac) win.setAlwaysOnTop(true, "screen-saver");
    if (isWin) win.setAlwaysOnTop(true, "pop-up-menu");
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
    // 固定大框默认点穿（透明区不挡后面 App）；鼠标移到输入框时前端会通知捕获
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch {}
    win.loadFile(path.join(__dirname, "chat-stack.html"));
    // 把聊天栏渲染器的 console / 崩溃转到主日志（/tmp/clawd-pet.log），方便定位闪退
    try {
      win.webContents.on("console-message", (_e, level, message, line, src) => {
        if (level >= 2 || /error|crash|chat-stack-renderer/i.test(message)) console.error(`[chat-stack-console] ${message} (${src}:${line})`);
      });
      win.webContents.on("render-process-gone", (_e, details) => console.error("[chat-stack] 渲染进程崩溃:", JSON.stringify(details)));
      win.webContents.on("unresponsive", () => console.error("[chat-stack] 渲染进程无响应"));
    } catch (_) {}
    win.webContents.once("did-finish-load", () => {
      ready = true;
      pushSide();                       // 初始告知 Claude Baby 在哪侧
      const q = queue; queue = [];
      for (const p of q) deliver(p);
    });
    win.on("closed", () => { win = null; ready = false; stopFollow(); });
    startFollow();
    return win;
  }

  function deliver(payload) {
    if (!win || win.isDestroyed()) return;
    anchor();
    pushSide();                                // 确保前端拿到最新侧别
    // clear 只清内容、不显示窗口 → 避免新会话时先闪一帧上一会话的残留。
    // userHidden（用户双击隐藏）期间：照常更新 DOM，但不把窗口顶出来——再 show 时内容已最新。
    if (payload.type !== "clear" && !userHidden && !win.isVisible()) win.showInactive();
    win.webContents.send("chat-msg", payload);
  }

  // 渲染端上报合成时缩略图区的额外高度 → 窗口向下增高包住预览;没图时报 0 缩回固定高度。
  function onSize(_e, extra) {
    const v = Math.max(0, Math.min(400, Math.round(Number(extra) || 0)));   // 封顶 400px 防失控
    if (v === composeExtra) return;                                        // 没变化就忽略(正常打字每字都报 0,别每字重算)
    composeExtra = v;
    lastBoundsKey = "";                                                     // 高度变了 → 强制重设界(即使 Claude Baby 没动)
    anchor();
  }
  ipc.on("chat-stack-size", onSize);

  // 前端：鼠标移到输入框 → 捕获（可点/可输入）；离开 → 点穿
  function onCapture(_e, on) {
    if (!win || win.isDestroyed()) return;
    try { win.setIgnoreMouseEvents(on ? false : true, on ? {} : { forward: true }); } catch {}
  }
  ipc.on("chat-capture", onCapture);

  // 打字回车 → 发到引擎 /text
  // 返回 { accepted } —— 渲染端据此决定是否清空输入框（避免"打了字没发出去还消失"）。
  function onSubmit(_e, payload) {
    let t = "", images = null;
    if (typeof payload === "string") t = payload.trim();
    else if (payload && typeof payload === "object") {
      t = String(payload.text || "").trim();
      if (Array.isArray(payload.images) && payload.images.length) images = payload.images;
      else if (payload.image) images = [payload.image];
    }
    if (!t && (!images || !images.length)) return Promise.resolve({ accepted: false });
    const body = JSON.stringify(images ? { text: t, images } : { text: t });
    return new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: ENGINE_PORT, path: "/text", method: "POST", timeout: 8000,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => {
          let accepted = true; try { const j = JSON.parse(d || "{}"); accepted = j.accepted !== false; } catch { accepted = true; }
          resolve({ accepted });
        });
      });
      req.on("error", () => resolve({ accepted: false }));   // 引擎没在听 → 没发出去,别清空
      req.on("timeout", () => { try { req.destroy(); } catch {} resolve({ accepted: false }); });
      req.write(body); req.end();
    });
  }
  ipc.handle("chat-submit", onSubmit);

  // 打字模式开/关 → 引擎停麦/开麦（不暂停会话，打字仍可发）
  function onTyping(_e, on) {
    const req = http.request({ host: "127.0.0.1", port: ENGINE_PORT, path: on ? "/mic-off" : "/mic-on", method: "POST", timeout: 1200 }, (res) => res.resume());
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end();
  }
  ipc.on("chat-typing", onTyping);

  // 点对话里的超链接 → 用系统默认浏览器打开（只放行 http/https）
  function onOpenLink(_e, href) {
    const s = String(href || "");
    if (/^https?:\/\//i.test(s)) { try { Promise.resolve(shell.openExternal(s)).catch(() => {}); } catch {} }
  }
  ipc.on("chat-open-link", onOpenLink);

  // 复制气泡文字到系统剪贴板
  function onCopy(_e, text) { try { clipboard.writeText(String(text || "")); } catch {} }
  ipc.on("chat-copy", onCopy);

  // 暂停按钮 → 打引擎 /toggle，把返回的 paused 回灌给前端驱动锁定视觉
  function onToggleMic() {
    const req = http.request(
      { host: "127.0.0.1", port: ENGINE_PORT, path: "/toggle", method: "POST", timeout: 1500 },
      (res) => {
        let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => {
          let paused = false; try { paused = !!JSON.parse(b).paused; } catch {}
          if (win && !win.isDestroyed()) win.webContents.send("chat-lock", paused);
        });
      }
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end();
  }
  ipc.on("chat-toggle-mic", onToggleMic);

  function chat(payload) {
    if (!payload || typeof payload !== "object") return;
    // 隐藏：标记 userHidden，藏窗口（内容/DOM 保留，后续更新照收只是不弹出）
    if (payload.type === "hide") { userHidden = true; if (win && !win.isDestroyed()) win.hide(); return; }
    // 显示：清掉 userHidden，把窗口显出来（内容已是最新）
    if (payload.type === "show") {
      userHidden = false; ensureWindow();
      if (ready && win && !win.isDestroyed()) { anchor(); win.showInactive(); }
      return;
    }
    // 音量波形(高频) / 上传中 / 工具状态小字 / 锁定(暂停禁输入)：只透传给前端，不触发贴位/弹窗
    if (payload.type === "level" || payload.type === "uploading" || payload.type === "status" || payload.type === "lock") {
      if (win && !win.isDestroyed() && ready) win.webContents.send("chat-msg", payload);
      return;
    }
    // clear（新会话/重画）恢复可见态；fade 由前端做渐隐动画（透传，不动窗口）
    if (payload.type === "clear") userHidden = false;
    ensureWindow();
    if (ready) deliver(payload); else queue.push(payload);
  }

  function cleanup() {
    stopFollow();
    try { ipc.removeListener("chat-stack-size", onSize); } catch {}
    try { ipc.removeHandler("chat-submit"); } catch {}
    try { ipc.removeListener("chat-toggle-mic", onToggleMic); } catch {}
    try { ipc.removeListener("chat-capture", onCapture); } catch {}
    try { ipc.removeListener("chat-typing", onTyping); } catch {}
    try { ipc.removeListener("chat-copy", onCopy); } catch {}
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return { chat, clear: () => chat({ type: "clear" }), reanchor: () => anchor(), cleanup };
};
