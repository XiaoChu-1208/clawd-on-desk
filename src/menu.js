"use strict";

const { app, BrowserWindow, screen, Menu, Tray, nativeImage, dialog } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";

// Login-item / autostart helpers and the openAtLogin write path live in
// src/login-item.js + main.js's settings-actions effect. menu.js used to
// inline them but now just renders a checkbox bound to ctx.openAtLogin.

const WIN_TOPMOST_LEVEL = "pop-up-menu"; // above taskbar-level UI

// ── Window size presets (mirrored from main.js for resizeWindow) ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// i18n string pool + translator factory live in src/i18n.js so the future
// settings panel can share them. menu.js binds the translator to ctx.lang.
const { createTranslator } = require("./i18n");

module.exports = function initMenu(ctx) {
  // ── Translation helper (bound to ctx.lang via the shared i18n module) ──
  const t = createTranslator(() => ctx.lang);

  // ── English-coach fork: 会话（新建/切换）——POST 给引擎控制端口，列表缓存在菜单里 ──
  const COACH = !!process.env.CLAWD_COACH_MODE;
  const COACH_PORT = Number(process.env.COACH_CONTROL_PORT || 23390);
  let coachSessions = [];     // [{id,title,updatedAt,count}]
  let coachCurrent = "";
  function coachPost(reqPath, body, cb) {
    const data = body ? JSON.stringify(body) : "";
    const headers = data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {};
    const req = require("http").request(
      { host: "127.0.0.1", port: COACH_PORT, path: reqPath, method: "POST", timeout: 1500, headers },
      (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} cb && cb(null, j); }); }
    );
    req.on("error", (e) => cb && cb(e));
    req.on("timeout", () => { req.destroy(); cb && cb(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  }
  function refreshCoachSessions(cb) {
    coachPost("/sessions", null, (err, j) => {
      if (!err && j) { coachSessions = Array.isArray(j.sessions) ? j.sessions : []; coachCurrent = j.current || ""; }
      cb && cb();
    });
  }
  // 会话菜单的多语言（跟随 ctx.lang：en / zh / zh-TW / ko / ja）
  function coachT(key) {
    const lang = ctx.lang || "en";
    const M = {
      newSession:    { en: "New Session",    zh: "新建会话",     "zh-TW": "新建會話",     ja: "新規セッション",   ko: "새 세션" },
      switchSession: { en: "Switch Session", zh: "切换会话",     "zh-TW": "切換會話",     ja: "セッション切替",   ko: "세션 전환" },
      endSession:    { en: "End Session",    zh: "结束会话",     "zh-TW": "結束會話",     ja: "セッション終了",   ko: "세션 종료" },
      noSessions:    { en: "(no past sessions)", zh: "（暂无历史会话）", "zh-TW": "（暫無歷史會話）", ja: "（履歴なし）", ko: "（지난 세션 없음）" },
      volume:        { en: "Volume",         zh: "音量",         "zh-TW": "音量",         ja: "音量",            ko: "볼륨" },
      mute:          { en: "Mute",           zh: "静音",         "zh-TW": "靜音",         ja: "ミュート",        ko: "음소거" },
    };
    const row = M[key] || {};
    return row[lang] || row.en || key;
  }
  function buildCoachSessionItems() {
    const items = [
      { label: coachT("newSession"), click: () => coachPost("/session/new", null, () => refreshCoachSessions(() => {})) },
    ];
    const list = coachSessions.length
      ? coachSessions.map((s) => ({
          label: (s.title || "—") + (s.count ? `  (${s.count})` : ""),
          type: "checkbox",
          checked: s.id === coachCurrent,   // 当前会话用原生勾选标记，不用字符
          click: () => coachPost("/session/switch", { id: s.id }, () => {}),
        }))
      : [{ label: coachT("noSessions"), enabled: false }];
    items.push({ label: coachT("switchSession"), submenu: list });
    items.push({ label: coachT("endSession"), click: () => coachPost("/session/close", null, () => {}) });
    return items;
  }

  // English-coach fork: 音量(右键菜单第一项)。原生菜单不支持拖动滑块,用离散档(单选打勾)。
  // 选中 → POST /volume 给引擎,引擎用 afplay -v 控制 Claude Baby 说话音量。
  let coachVolume = 1.0;
  const COACH_VOLUME_LEVELS = [
    { v: 0 },     // 静音（标签本地化）
    { v: 0.25 }, { v: 0.5 }, { v: 0.75 }, { v: 1.0 },   // 百分比通用，不本地化
  ];
  function buildCoachVolumeMenuItem() {
    return {
      label: coachT("volume"),
      submenu: COACH_VOLUME_LEVELS.map((lv) => ({
        label: lv.v === 0 ? coachT("mute") : `${Math.round(lv.v * 100)}%`,
        type: "checkbox",
        checked: Math.abs(coachVolume - lv.v) < 0.001,
        click: () => { coachVolume = lv.v; coachPost("/volume", { level: lv.v }, () => {}); },
      })),
    };
  }

  function isMiniSupported() {
    const caps = typeof ctx.getActiveThemeCapabilities === "function"
      ? ctx.getActiveThemeCapabilities()
      : null;
    if (caps && typeof caps.miniMode === "boolean") return caps.miniMode;
    return true;
  }

  function buildMiniModeMenuItem() {
    const miniSupported = isMiniSupported();
    const inMiniMode = ctx.getMiniMode();
    const miniDisabled = typeof ctx.getDisableMiniMode === "function" && ctx.getDisableMiniMode();
    return {
      label: inMiniMode ? t("exitMiniMode") : t("miniMode"),
      enabled: !ctx.getMiniTransitioning()
        && (inMiniMode || (!miniDisabled && miniSupported && !(ctx.doNotDisturb && !inMiniMode))),
      click: () => {
        if (inMiniMode) return ctx.exitMiniMode();
        if (miniDisabled) return undefined;
        return ctx.enterMiniViaMenu();
      },
    };
  }

  // DANGER "auto-pilot" quick toggle. Enabling auto-approves EVERY agent
  // permission request with no prompt, so the enable path is gated behind a
  // native modal confirm. Disabling is immediate. After either decision we
  // rebuild menus so the checkbox reflects the committed value (Electron has
  // already flipped the visual optimistically on click).
  function buildAutoApproveMenuItem() {
    return {
      label: t("menuAutoApproveAll"),
      type: "checkbox",
      checked: !!ctx.autoApproveAllPermissions,
      click: (menuItem) => {
        const wantOn = menuItem.checked;
        if (!wantOn) {
          ctx.autoApproveAllPermissions = false;
          return;
        }
        // Revert the optimistic check until the user confirms.
        menuItem.checked = false;
        // No parent window: attaching the dialog to ctx.win (the small pet
        // window) makes macOS render it as a sheet centered on the pet. A
        // parentless dialog is a standalone window centered on the screen,
        // which is what a danger confirmation should be.
        Promise.resolve(
          dialog.showMessageBox({
            type: "warning",
            buttons: [t("autoApproveAllConfirmEnable"), t("autoApproveAllConfirmCancel")],
            defaultId: 1,
            cancelId: 1,
            title: t("autoApproveAllConfirmTitle"),
            message: t("autoApproveAllConfirmTitle"),
            detail: t("autoApproveAllConfirmDetail"),
          })
        ).then((res) => {
          if (res && res.response === 0) {
            ctx.autoApproveAllPermissions = true;
          }
          rebuildAllMenus();
        }).catch((err) => {
          console.warn("Clawd: auto-pilot confirm failed:", err && err.message);
          rebuildAllMenus();
        });
      },
    };
  }

  function buildBringToPrimaryDisplayMenuItem() {
    return {
      label: t("bringPetToPrimaryDisplay"),
      enabled: typeof ctx.bringPetToPrimaryDisplay === "function"
        && !ctx.getMiniMode()
        && !ctx.getMiniTransitioning(),
      click: () => {
        if (typeof ctx.bringPetToPrimaryDisplay === "function") {
          ctx.bringPetToPrimaryDisplay();
        }
      },
    };
  }

  // ── System tray ──
  function createTray() {
    if (ctx.tray) return;
    let icon;
    if (isMac) {
      icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-iconTemplate.png"));
      icon.setTemplateImage(true);
    } else {
      icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-icon.png")).resize({ width: 32, height: 32 });
    }
    ctx.tray = new Tray(icon);
    ctx.tray.setToolTip("Clawd Desktop Pet");
    buildTrayMenu();
  }

  function destroyTray() {
    if (!ctx.tray) return;
    ctx.tray.destroy();
    ctx.tray = null;
  }

  function applyDockVisibility() {
    if (!isMac) return;
    if (ctx.showDock) {
      app.setActivationPolicy("regular");
      if (app.dock) app.dock.show();
    } else {
      app.setActivationPolicy("accessory");
      if (app.dock) app.dock.hide();
    }
    // dock.hide()/show() resets NSWindowCollectionBehavior — re-apply fullscreen visibility
    ctx.reapplyMacVisibility();
  }

  function buildTrayMenu() {
    if (!ctx.tray) return;
    const items = [
      {
        label: ctx.doNotDisturb ? t("wake") : t("sleep"),
        click: () => ctx.doNotDisturb ? ctx.disableDoNotDisturb() : ctx.enableDoNotDisturb(),
      },
      buildMiniModeMenuItem(),
      { type: "separator" },
      // Quick-toggle noise controls. Other settings (language, theme, bubble
      // follow, start-with-Claude, updates, etc.) were moved out of the tray
      // and now live only in the Settings panel / About tab.
      {
        label: t("hideBubbles"),
        type: "checkbox",
        checked: ctx.hideBubbles,
        click: (menuItem) => { ctx.hideBubbles = menuItem.checked; },
      },
      buildAutoApproveMenuItem(),
      {
        label: t("soundEffects"),
        type: "checkbox",
        checked: !ctx.soundMuted,
        click: (menuItem) => { ctx.soundMuted = !menuItem.checked; },
      },
      { type: "separator" },
      {
        label: t("startOnLogin"),
        type: "checkbox",
        // Bound to prefs via ctx.openAtLogin. The setter routes to
        // settings-controller → openAtLogin pre-commit gate, which calls the
        // OS API. Subscriber in main.js rebuilds the menu on commit, so the
        // checkbox updates without explicit buildTrayMenu/buildContextMenu().
        checked: ctx.openAtLogin,
        click: (menuItem) => { ctx.openAtLogin = menuItem.checked; },
      },
    ];
    // macOS: Dock and Menu Bar visibility toggles
    if (isMac) {
      items.push(
        { type: "separator" },
        {
          label: t("showInMenuBar"),
          type: "checkbox",
          checked: ctx.showTray,
          enabled: ctx.showTray ? ctx.showDock : true, // can't uncheck if Dock is already hidden
          click: (menuItem) => { ctx.showTray = menuItem.checked; },
        },
        {
          label: t("showInDock"),
          type: "checkbox",
          checked: ctx.showDock,
          enabled: ctx.showDock ? ctx.showTray : true, // can't uncheck if Menu Bar is already hidden
          click: (menuItem) => { ctx.showDock = menuItem.checked; },
        },
      );
    }
    items.push(
      { type: "separator" },
      {
        label: t("settings"),
        click: () => ctx.openSettingsWindow(),
      },
      buildBringToPrimaryDisplayMenuItem(),
    );
    // #329: surface the update item in the tray menu. The label switches
    // to "Update available · vX" / "Update Ready" when applicable. Click
    // routes to checkForUpdates / quitAndInstall via getUpdateMenuItem.
    if (typeof ctx.getUpdateMenuItem === "function") {
      const updateItem = ctx.getUpdateMenuItem();
      if (updateItem) items.push({ type: "separator" }, updateItem);
    }
    items.push(
      { type: "separator" },
      {
        label: ctx.petHidden ? t("showPet") : t("hidePet"),
        click: () => ctx.togglePetVisibility(),
      },
      { type: "separator" },
      { label: t("quit"), click: () => requestAppQuit() },
    );
    ctx.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  function rebuildAllMenus() {
    buildTrayMenu();
    buildContextMenu();
  }

  function requestAppQuit() {
    ctx.isQuitting = true;
    // Claude-Baby/coach mode: right-click「退出」should behave exactly like `hello stop` —
    // tell the brain (coach-engine) to say goodbye and shut its voice engine down first,
    // then quit the pet. coachPost always invokes its callback (success/error/timeout),
    // and if the brain isn't running we just quit ourselves.
    if (COACH) {
      let done = false;
      const finish = () => { if (done) return; done = true; app.quit(); };
      try { coachPost("/quit", null, finish); } catch (_) { finish(); }
      setTimeout(finish, 3000);   // safety net: never leave the pet hanging if the callback never fires
      return;
    }
    app.quit();
  }

  function ensureContextMenuOwner() {
    if (ctx.contextMenuOwner && !ctx.contextMenuOwner.isDestroyed()) return ctx.contextMenuOwner;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    ctx.contextMenuOwner = new BrowserWindow({
      parent: ctx.win,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focusable: true,
      closable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
    });

    // Chromium reclaims empty (about:blank) hidden renderers, which defeats
    // the "persistent helper window" design — every right-click ends up
    // re-spawning a renderer process. Load a minimal data: URL so the
    // renderer has a real document and stays alive across menu invocations.
    ctx.contextMenuOwner.loadURL("data:text/html,%3C!doctype%20html%3E");

    // macOS: ensure owner can appear on fullscreen Spaces
    ctx.reapplyMacVisibility();

    ctx.contextMenuOwner.on("close", (event) => {
      if (!ctx.isQuitting) {
        event.preventDefault();
        ctx.contextMenuOwner.hide();
      }
    });

    ctx.contextMenuOwner.on("closed", () => {
      ctx.contextMenuOwner = null;
    });

    return ctx.contextMenuOwner;
  }

  function popupMenuAt(menu) {
    if (ctx.menuOpen) return;
    const owner = ensureContextMenuOwner();
    if (!owner) return;

    const cursor = screen.getCursorScreenPoint();
    owner.setBounds({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
    owner.show();
    keepOutOfTaskbar(owner);
    owner.focus();

    ctx.menuOpen = true;
    menu.popup({
      window: owner,
      callback: () => {
        ctx.menuOpen = false;
        if (owner && !owner.isDestroyed()) owner.hide();
        // ctx.petHidden guard: the menu's own Hide item may have just hidden
        // the pet, and the click handler can fire on either side of this close
        // callback — an unconditional showInactive() would resurrect a window
        // setPetHidden() just hid. Skipping is safe: showPetWindows() re-asserts
        // taskbar/mac flags on the next show, and Windows topmost is held by
        // the window's alwaysOnTop flag plus the topmost-runtime watchdog, not
        // by this callback.
        if (ctx.win && !ctx.win.isDestroyed() && !ctx.petHidden) {
          ctx.win.showInactive();
          keepOutOfTaskbar(ctx.win);
          if (isMac) {
            ctx.reapplyMacVisibility();
          } else if (isWin) {
            ctx.win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
          }
        }
      },
    });
  }

  function buildDisplaySubmenu(displays = screen.getAllDisplays()) {
    if (displays.length <= 1) return [{ label: t("displayLabel").replace("{n}", 1), enabled: false }];
    const currentBounds = ctx.getPetWindowBounds ? ctx.getPetWindowBounds() : null;
    const current = currentBounds
      ? screen.getDisplayNearestPoint({
        x: Math.round(currentBounds.x + currentBounds.width / 2),
        y: Math.round(currentBounds.y + currentBounds.height / 2),
      })
      : null;
    return displays.map((d, i) => {
      const isPrimary = d.bounds.x === 0 && d.bounds.y === 0;
      const labelKey = isPrimary ? "displayLabelPrimary" : "displayLabel";
      const res = t("displayResolution").replace("{w}", d.bounds.width).replace("{h}", d.bounds.height);
      const isCurrent = current && current.id === d.id;
      return {
        label: `${t(labelKey).replace("{n}", i + 1)}  ${res}`,
        enabled: !isCurrent,
        click: () => sendToDisplay(d),
      };
    });
  }

  function sendToDisplay(display) {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    if (ctx.getMiniMode()) return;
    const wa = display.workArea;
    const size = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize(wa)
      : (SIZES[ctx.currentSize] || ctx.getCurrentPixelSize(wa));
    const x = Math.round(wa.x + (wa.width - size.width) / 2);
    const y = Math.round(wa.y + (wa.height - size.height) / 2);
    ctx.applyPetWindowBounds({ x, y, width: size.width, height: size.height });
    ctx.syncHitWin();
    ctx.repositionBubbles();
    ctx.flushRuntimeStateToPrefs();
  }

  function buildContextMenu() {
    const template = [
      // English-coach fork: 音量放右键菜单第一项
      ...(COACH ? [buildCoachVolumeMenuItem(), { type: "separator" }] : []),
      {
        ...buildMiniModeMenuItem(),
      },
      { type: "separator" },
      {
        label: ctx.doNotDisturb ? t("wake") : t("sleep"),
        click: () => ctx.doNotDisturb ? ctx.disableDoNotDisturb() : ctx.enableDoNotDisturb(),
      },
      { type: "separator" },
      buildAutoApproveMenuItem(),
      { type: "separator" },
      // English-coach fork: coach 模式用「新建/切换会话」替掉上游「按文件夹起 Claude Code」那套
      ...(COACH ? buildCoachSessionItems() : [{
        label: t("newSession"),
        submenu: [
          {
            label: t("newSessionSelectFolder"),
            click: () => {
              if (typeof ctx.newSessionWithFolder === "function") ctx.newSessionWithFolder(t);
            },
          },
          {
            label: t("newSessionHomeDir"),
            click: () => {
              if (typeof ctx.newSessionInCurrentDir === "function") ctx.newSessionInCurrentDir(t);
            },
          },
        ],
      }]),
    ];
    // sendToDisplay is a multi-display-only tail entry. Push dynamically
    // (rather than visible:false) — Electron leaves a phantom gap for
    // hidden separators otherwise.
    const displays = screen.getAllDisplays();
    if (displays.length > 1 && !ctx.getMiniMode()) {
      template.push(
        { type: "separator" },
        {
          label: t("sendToDisplay"),
          submenu: buildDisplaySubmenu(displays),
        },
      );
    }
    // macOS: Dock and Menu Bar visibility toggles
    if (isMac) {
      template.push(
        { type: "separator" },
        {
          label: t("showInMenuBar"),
          type: "checkbox",
          checked: ctx.showTray,
          enabled: ctx.showTray ? ctx.showDock : true, // can't uncheck if Dock is already hidden
          click: (menuItem) => { ctx.showTray = menuItem.checked; },
        },
        {
          label: t("showInDock"),
          type: "checkbox",
          checked: ctx.showDock,
          enabled: ctx.showDock ? ctx.showTray : true, // can't uncheck if Menu Bar is already hidden
          click: (menuItem) => { ctx.showDock = menuItem.checked; },
        },
      );
    }
    template.push(
      { type: "separator" },
      {
        label: t("settings"),
        click: () => ctx.openSettingsWindow(),
      },
    );
    // #329: surface the update item in the right-click context menu too.
    if (typeof ctx.getUpdateMenuItem === "function") {
      const updateItem = ctx.getUpdateMenuItem();
      if (updateItem) template.push({ type: "separator" }, updateItem);
    }
    template.push(
      { type: "separator" },
      {
        label: ctx.petHidden ? t("showPet") : t("hidePet"),
        click: () => ctx.togglePetVisibility(),
      },
      { type: "separator" },
      { label: t("quit"), click: () => requestAppQuit() },
    );
    ctx.contextMenu = Menu.buildFromTemplate(template);
  }

  function showPetContextMenu() {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    // coach 模式：先拉一把最新会话列表（localhost，毫秒级），再建菜单弹出
    if (COACH) {
      refreshCoachSessions(() => {
        if (!ctx.win || ctx.win.isDestroyed()) return;
        buildContextMenu();
        popupMenuAt(ctx.contextMenu);
      });
      return;
    }
    buildContextMenu();
    popupMenuAt(ctx.contextMenu);
  }

  function resizeWindow(sizeKey, options = {}) {
    const mode = options.mode || (options.persist === false ? "preview" : "commit");
    const persist = mode !== "preview";
    // Setter routes through controller.applyUpdate("size", ...) — subscriber
    // rebuilds menus on commit. We still need to physically resize the
    // window and capture the new bounds at the end.
    if (persist) ctx.currentSize = sizeKey;
    const size = (typeof ctx.getPixelSizeFor === "function")
      ? ctx.getPixelSizeFor(sizeKey)
      : (SIZES[sizeKey] || ctx.getCurrentPixelSize());
    if (!ctx.miniHandleResize(sizeKey)) {
      if (ctx.win && !ctx.win.isDestroyed()) {
        const { x, y } = ctx.getPetWindowBounds();
        const clamped = ctx.clampToScreenVisual(x, y, size.width, size.height);
        ctx.applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
      }
    }
    if (mode !== "preview") {
      ctx.syncHitWin();
      ctx.repositionBubbles();
      if (persist) ctx.flushRuntimeStateToPrefs();
    }
  }

  return {
    t,
    buildContextMenu,
    buildTrayMenu,
    rebuildAllMenus,
    createTray,
    destroyTray,
    getTray: () => ctx.tray,
    applyDockVisibility,
    ensureContextMenuOwner,
    popupMenuAt,
    showPetContextMenu,
    resizeWindow,
    requestAppQuit,
  };
};

