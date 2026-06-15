"use strict";

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerPetInteractionIpc requires ${name}`);
  return value;
}

function registerPetInteractionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const showContextMenu = requiredDependency(options.showContextMenu, "showContextMenu");
  const moveWindowForDrag = requiredDependency(options.moveWindowForDrag, "moveWindowForDrag");
  const setIdlePaused = requiredDependency(options.setIdlePaused, "setIdlePaused");
  const isMiniTransitioning = requiredDependency(options.isMiniTransitioning, "isMiniTransitioning");
  const getCurrentState = requiredDependency(options.getCurrentState, "getCurrentState");
  const getCurrentSvg = requiredDependency(options.getCurrentSvg, "getCurrentSvg");
  const sendToRenderer = requiredDependency(options.sendToRenderer, "sendToRenderer");
  const setDragLocked = requiredDependency(options.setDragLocked, "setDragLocked");
  const setMouseOverPet = requiredDependency(options.setMouseOverPet, "setMouseOverPet");
  const beginDragSnapshot = requiredDependency(options.beginDragSnapshot, "beginDragSnapshot");
  const clearDragSnapshot = requiredDependency(options.clearDragSnapshot, "clearDragSnapshot");
  const syncHitWin = requiredDependency(options.syncHitWin, "syncHitWin");
  const isMiniMode = requiredDependency(options.isMiniMode, "isMiniMode");
  const checkMiniModeSnap = requiredDependency(options.checkMiniModeSnap, "checkMiniModeSnap");
  const hasPetWindow = requiredDependency(options.hasPetWindow, "hasPetWindow");
  const getPetWindowBounds = requiredDependency(options.getPetWindowBounds, "getPetWindowBounds");
  const getKeepSizeAcrossDisplays = requiredDependency(
    options.getKeepSizeAcrossDisplays,
    "getKeepSizeAcrossDisplays"
  );
  const getCurrentPixelSize = requiredDependency(options.getCurrentPixelSize, "getCurrentPixelSize");
  const computeDragEndBounds = requiredDependency(options.computeDragEndBounds, "computeDragEndBounds");
  const applyPetWindowBounds = requiredDependency(options.applyPetWindowBounds, "applyPetWindowBounds");
  const reassertWinTopmost = requiredDependency(options.reassertWinTopmost, "reassertWinTopmost");
  const scheduleHwndRecovery = requiredDependency(options.scheduleHwndRecovery, "scheduleHwndRecovery");
  const repositionFloatingBubbles = requiredDependency(
    options.repositionFloatingBubbles,
    "repositionFloatingBubbles"
  );
  const exitMiniMode = requiredDependency(options.exitMiniMode, "exitMiniMode");
  const getDisableMiniMode = options.getDisableMiniMode || (() => false);
  const getFocusableLocalHudSessionIds = requiredDependency(
    options.getFocusableLocalHudSessionIds,
    "getFocusableLocalHudSessionIds"
  );
  const focusLog = requiredDependency(options.focusLog, "focusLog");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const revealSessionHud = requiredDependency(options.revealSessionHud, "revealSessionHud");
  const setLowPowerIdlePaused = requiredDependency(
    options.setLowPowerIdlePaused,
    "setLowPowerIdlePaused"
  );
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("show-context-menu", showContextMenu);
  on("drag-move", () => moveWindowForDrag());

  on("pause-cursor-polling", () => {
    setIdlePaused(true);
  });
  on("resume-from-reaction", () => {
    setIdlePaused(false);
    if (isMiniTransitioning()) return;
    sendToRenderer("state-change", getCurrentState(), getCurrentSvg());
  });
  on("low-power-idle-paused", (_event, paused) => {
    setLowPowerIdlePaused(!!paused);
  });

  on("drag-lock", (_event, locked) => {
    setDragLocked(!!locked);
    if (locked) {
      setMouseOverPet(true);
      beginDragSnapshot();
    } else {
      clearDragSnapshot();
      syncHitWin();
    }
  });

  on("start-drag-reaction", (_event, direction) => {
    sendToRenderer("start-drag-reaction", direction === "left" || direction === "right" ? direction : null);
  });
  on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  on("play-click-reaction", (_event, svg, duration) => {
    sendToRenderer("play-click-reaction", svg, duration);
  });

  // English-coach fork: 连点 4 次 → 开/关语音练习。引擎在就 toggle；
  // 引擎没开 → 自动把 coach-engine.js 拉起来，等端口就绪再 /start。
  const COACH_PORT = Number(process.env.COACH_CONTROL_PORT || 23390);
  let coachEngineProc = null;
  let spawningEngine = false;

  function postEngine(reqPath, cb) {
    const req = require("http").request(
      { host: "127.0.0.1", port: COACH_PORT, path: reqPath, method: "POST", timeout: 1500 },
      (res) => { res.resume(); res.on("end", () => cb && cb(null)); }
    );
    req.on("error", (e) => cb && cb(e));
    req.on("timeout", () => { req.destroy(); cb && cb(new Error("timeout")); });
    req.end();
  }

  function waitForEngine(triesLeft, cb) {
    const s = require("net").connect(COACH_PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); cb(true); });
    s.on("error", () => {
      s.destroy();
      if (triesLeft <= 0) return cb(false);
      setTimeout(() => waitForEngine(triesLeft - 1, cb), 300);
    });
  }

  function spawnEngine(cb) {
    if (spawningEngine || (coachEngineProc && !coachEngineProc.killed)) return cb && cb(false);
    spawningEngine = true;
    const path = require("path");
    const entry = process.env.COACH_ENGINE_ENTRY ||
      path.join(__dirname, "..", "..", "english-speaking-coach", "coach-engine.js");
    try {
      // 用 Electron 内置 node 跑引擎（ELECTRON_RUN_AS_NODE=1），不依赖系统 node 在 PATH
      coachEngineProc = require("child_process").spawn(process.execPath, [entry], {
        cwd: path.dirname(entry),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore",
      });
      coachEngineProc.on("exit", () => { coachEngineProc = null; });
      console.log("[coach] 引擎未运行 → 已拉起 coach-engine:", entry);
    } catch (e) {
      console.warn("[coach] 拉起引擎失败:", e.message);
      spawningEngine = false;
      return cb && cb(false);
    }
    waitForEngine(20, (up) => { spawningEngine = false; cb && cb(up); }); // 最多等 ~6s
  }

  on("coach-toggle", () => {
    console.log("[coach] 连点4次 → /toggle-session");
    postEngine("/toggle-session", (err) => {
      if (!err) return;                       // 引擎在，已 toggle
      console.log("[coach] 引擎没开 → 自动拉起再 /start");
      spawnEngine((up) => { if (up) postEngine("/start"); });
    });
  });

  // English-coach fork: 单击 Claude Baby → /poke。引擎只在「正说话」时打断并把回合交给你；
  // 没说话/引擎没开 → 静默忽略（不自动拉引擎，单击不该把它叫醒）。
  on("coach-poke", () => {
    postEngine("/poke", () => {});
  });

  on("drag-end", () => {
    try {
      if (!isMiniMode() && !isMiniTransitioning()) {
        if (!getDisableMiniMode()) checkMiniModeSnap();
        if (isMiniMode() || isMiniTransitioning()) return;
        if (hasPetWindow()) {
          const virtualBounds = getPetWindowBounds();
          const size = getKeepSizeAcrossDisplays()
            ? { width: virtualBounds.width, height: virtualBounds.height }
            : getCurrentPixelSize();
          const clamped = computeDragEndBounds(virtualBounds, size);
          if (clamped) applyPetWindowBounds(clamped);
          reassertWinTopmost();
          scheduleHwndRecovery();
          syncHitWin();
          repositionFloatingBubbles();
        }
      }
    } finally {
      setDragLocked(false);
      clearDragSnapshot();
    }
  });

  on("exit-mini-mode", () => {
    if (isMiniMode()) exitMiniMode();
  });

  on("pet-interaction:reveal-session-hud", () => {
    revealSessionHud();
  });

  on("focus-terminal", () => {
    const focusableIds = getFocusableLocalHudSessionIds();
    focusLog(`focus request source=pet-body sid=- focusableCount=${focusableIds.length}`);
    if (focusableIds.length > 1) {
      focusLog(`focus result branch=none reason=multi-session-open-dashboard count=${focusableIds.length}`);
      showDashboard();
      return;
    }
    if (focusableIds.length === 1) {
      focusSession(focusableIds[0], { requestSource: "pet-body" });
      return;
    }
    focusLog("focus result branch=none reason=no-focusable-session source=pet-body");
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerPetInteractionIpc,
};
