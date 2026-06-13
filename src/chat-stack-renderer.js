// chat-stack-renderer.js — 桌宠头顶聊天栏。coach=暖色靠左，user=蓝色靠右。
// 最新在底部，旧的往上挤（最多 6 条）。当前轮你那条是真实 <input>，能打字也能被语音填。
(function () {
  const log = document.getElementById("log");

  // 把文本里的 http(s) 链接渲染成可点的 <a class="lnk">；点它 → 外部浏览器打开。
  const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"，。；：！？、）])/g;
  function appendLinkified(container, text) {
    const t = String(text == null ? "" : text);
    let last = 0, m; URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(t))) {
      if (m.index > last) container.appendChild(document.createTextNode(t.slice(last, m.index)));
      const a = document.createElement("a");
      a.className = "lnk"; a.textContent = m[0]; a.dataset.href = m[0];
      container.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < t.length) container.appendChild(document.createTextNode(t.slice(last)));
  }
  // 滚动粘底：默认贴最新；用户主动上滚翻历史时不把他拽回底部
  let userScrolledUp = false;
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function stickBottom() { log.scrollTop = log.scrollHeight; }
  log.addEventListener("scroll", () => { userScrolledUp = !atBottom(); });

  // 点击对话里的链接 → 交给主进程用系统浏览器打开（事件委托，覆盖后续动态加的气泡）
  log.addEventListener("click", (e) => {
    const a = e.target && e.target.closest && e.target.closest("a.lnk");
    if (a && a.dataset.href && window.chatStackAPI && window.chatStackAPI.openLink) {
      e.preventDefault();
      window.chatStackAPI.openLink(a.dataset.href);
    }
  });
  const MAX = 60;   // 保留更多历史在 DOM 里，配合滚轮上滚翻看（与引擎 restorePanel 的 -60 对齐）
  const FADE_MS = 30000;          // 30s 后渐隐
  const TYPE_MS = 24;             // Claude 逐字流式：每字间隔
  const TYPE_START_MS = 40;       // 几乎立刻开始打字，和 1.8s 长淡入同时进行（一边出字一边渐显）
  let inputEl = null;             // 当前轮的可编辑输入框
  let hintEl = null;              // "Claude is listening" 提示
  let persistentCoach = null;     // 最新那条 Claude 回答（常驻、不渐隐）

  document.body.classList.add("pet-right"); // 默认桌宠在右；onSide 会纠正

  function scheduleFade(el) {
    if (!el || el._fadeTimer) return;
    // 按气泡「出生时间」算它的 30s，而不是从现在重新计时
    const remaining = Math.max(0, FADE_MS - (el._born ? Date.now() - el._born : 0));
    if (remaining <= 0) { fadeOut(el); return; }
    el._fadeTimer = setTimeout(() => fadeOut(el), remaining);
  }
  function fadeOut(el) {
    if (!el || !el.parentNode) return;
    if (el._typeTimer) { clearTimeout(el._typeTimer); el._typeTimer = null; } // 停止未打完的流式
    el.style.animation = "none";                   // 解除 rise 对 opacity 的锁定
    // 只淡透明度、不塌缩高度：气泡在原位淡出，下方气泡（底部锚定）完全不参与、纹丝不动；
    // 整个淡出期间窗口尺寸不变 → 即便此刻来新消息触发 reportSize，读到的也是稳定高度，不会闪。
    requestAnimationFrame(() => {
      el.classList.add("fading");
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        if (el.parentNode) el.remove();            // 淡完移除：顶部透明空隙收掉（底部锚定，不动下方）
        reportSize();                              // 仅此一次重算窗口高度
      };
      el.addEventListener("transitionend", (e) => { if (e.propertyName === "opacity") finish(); });
      setTimeout(finish, 700);                     // 兜底
    });
  }

  // 固定大小的对话框：窗口尺寸恒定、内容在框内从底往上流、超出顶部被透明蒙版吃掉。
  // 所以前端不再驱动窗口尺寸 → 不 resize → 不闪。reportSize 保留为空，兼容旧调用点。
  function reportSize() {}
  function cap() { while (log.children.length > MAX) log.removeChild(log.firstChild); }

  function renderCoach(el, raw) {
    el.textContent = "";
    const m = raw.match(/(^|[\n\r])\s*(Tip:[^\n\r]*)$/);
    if (m) {
      const main = document.createElement("span"); appendLinkified(main, raw.slice(0, m.index).trim());
      const tip = document.createElement("span"); tip.className = "tip"; tip.textContent = m[2].trim();
      el.appendChild(main); el.appendChild(tip);
    } else { appendLinkified(el, raw); }
  }

  // Claude 逐字流式：空气泡先渐显（顶起你的消息），再一个字一个字冒出来，
  // 气泡随字增长 / 换行；打完去掉光标并套用 Tip 格式。
  function typeCoach(el, raw) {
    const full = String(raw == null ? "" : raw);
    const textNode = document.createTextNode("");
    const caret = document.createElement("span"); caret.className = "caret";
    el.textContent = "";
    el.appendChild(textNode); el.appendChild(caret);
    let i = 0;
    function step() {
      if (!el.parentNode) return;            // 已被清掉/渐隐
      i += 1;
      textNode.textContent = full.slice(0, i);
      reportSize();                          // 随字增长 → 窗口拉长、顶起上面
      if (!userScrolledUp) log.scrollTop = log.scrollHeight;   // 逐字时保持贴最新
      if (i < full.length) el._typeTimer = setTimeout(step, TYPE_MS);
      else { el._typeTimer = null; renderCoach(el, full); reportSize(); } // 收尾：去光标 + Tip
    }
    el._typeTimer = setTimeout(step, TYPE_START_MS);
  }

  // 语音一次性上传：气泡以「直角点」为基准缩放放大（像拖窗口右上角：左+底不动，向右上长）。
  // 用 CSS transform 缩放（纯 GPU，不逐帧改布局/窗口 → 不闪）；上面气泡一次性到位。
  // 缩放完全到位后，文字才用 3 秒慢慢渐显。
  function growIn(el, textSpan) {
    textSpan.style.opacity = "0";
    // 用户气泡的直角点：pet-right→左下；pet-left→右下。以它为基准（那两条边不动）
    const petLeft = document.body.classList.contains("pet-left");
    el.style.transformOrigin = petLeft ? "bottom right" : "bottom left";
    el.style.transform = "scale(0.3)";
    reportSize();   // 一次：窗口长到目标高度、把上面推上去（之后 dedup 不再重复 setBounds）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = "transform 440ms cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.transform = "scale(1)";                    // 第一步：从直角点放大展开到目标
      setTimeout(() => {                                  // 第二步：动画放完、到达目标位置后
        el.style.transition = ""; el.style.transform = ""; el.style.transformOrigin = "";
        textSpan.style.transition = "opacity 3000ms ease";
        textSpan.style.opacity = "1";                     // 文字 3 秒渐显
      }, 470);
    }));
  }

  function addBubble(role, text, anim, instant) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "coach");
    el._born = Date.now();   // 记出生时间，用于按 30s 准点渐隐
    const t = String(text == null ? "" : text);
    let textSpan = null;
    if (instant) {
      // 切换会话整体渐显：每条都不要自己的入场动画（coach 的 rise / user 的瞬现），
      // 统一只靠 #log 的整体 3 秒透明度渐显，节奏一致。
      el.style.animation = "none"; el.style.opacity = "1"; el.style.transform = "none";
      if (role === "coach") renderCoach(el, t); else appendLinkified(el, t);
    } else if (role === "coach") {
      typeCoach(el, t);                                    // 逐字流式
    } else if (anim === "grow") {
      textSpan = document.createElement("span");           // 一次性语音：展开 + 文字渐显
      appendLinkified(textSpan, t);
      el.appendChild(textSpan);
    } else {
      appendLinkified(el, t);                              // 打字/流式：直接顶上去
    }
    log.appendChild(el); cap();
    if (instant || !userScrolledUp) stickBottom();   // 新消息/恢复 → 贴最新；除非用户正翻历史
    if (role === "coach") persistentCoach = el;
    else if (!instant && anim === "grow" && textSpan) growIn(el, textSpan);
  }

  let rowEl = null, pauseBtn = null, micLocked = false;

  // ── 麦克风波形：随引擎发来的实时音量(level)起伏，暂停/无声时归于平静 ──
  let waveEl = null, waveBars = [], waveCur = [], micLevel = 0, lastLevelTs = 0, waveRAF = null, waveT = 0;
  const WAVE_N = 5;
  function buildWave() {
    const w = document.createElement("div");
    w.className = "wave";
    waveBars = []; waveCur = [];
    for (let i = 0; i < WAVE_N; i++) {
      const b = document.createElement("span"); b.className = "wave-bar";
      w.appendChild(b); waveBars.push(b); waveCur.push(0.15);
    }
    return w;
  }
  function startWave() {
    if (waveRAF) return;
    const loop = () => {
      const stale = Date.now() - lastLevelTs > 350;        // 350ms 没新音量 → 当作没声音
      const target = (micLocked || stale) ? 0 : micLevel;  // 暂停 / 无声 → 归平
      waveT += 0.22;
      for (let i = 0; i < waveBars.length; i++) {
        const phase = Math.sin(waveT + i * 0.8) * 0.5 + 0.5;          // 0..1，每条相位错开成波浪
        const want = 0.15 + target * (0.30 + 0.70 * phase);           // 静止≈0.15，说话时起伏
        waveCur[i] += (want - waveCur[i]) * 0.28;                     // 平滑跟随
        if (waveBars[i]) waveBars[i].style.transform = `scaleY(${waveCur[i].toFixed(3)})`;
      }
      waveRAF = requestAnimationFrame(loop);
    };
    waveRAF = requestAnimationFrame(loop);
  }
  function stopWave() { if (waveRAF) { cancelAnimationFrame(waveRAF); waveRAF = null; } waveBars = []; waveEl = null; }

  function applyLock(locked) {
    micLocked = locked;
    if (rowEl) rowEl.classList.toggle("locked", locked);
    if (pauseBtn) { pauseBtn.textContent = locked ? "▶" : "⏸"; pauseBtn.title = locked ? "继续录音" : "暂停录音"; }
    // 暂停只是关麦：输入框保持【可打字】，只变灰，不 disable
    if (inputEl) inputEl.disabled = false;
    requestAnimationFrame(reportSize);
  }

  function ensureInput(value) {
    if (!inputEl) {
      rowEl = document.createElement("div");
      rowEl.className = "input-row";
      // 点输入框任意处（含左侧声波动画 / 空白）都聚焦输入框开始打字；只有点输入框本身/暂停键走各自默认
      rowEl.addEventListener("mousedown", (e) => {
        if (e.target === inputEl) return;                                   // 点文字框本身：正常放光标
        if (e.target.closest && e.target.closest(".pause-btn")) return;     // 点暂停键：正常切换
        e.preventDefault();                                                 // 点声波/空白：聚焦打字
        if (inputEl) inputEl.focus();
      });
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "user-input";
      inputEl.setAttribute("autocomplete", "off");
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const t = inputEl.value.trim();
          if (t && window.chatStackAPI) window.chatStackAPI.submit(t);
          inputEl.value = "";
        }
      });
      // 点输入框聚焦 = 打字模式：暂停键+波形消失、输入框缩短、引擎停麦（打字仍可发）
      inputEl.addEventListener("focus", () => {
        if (rowEl) rowEl.classList.add("typing");
        if (window.chatStackAPI && window.chatStackAPI.notifyTyping) window.chatStackAPI.notifyTyping(true);
      });
      inputEl.addEventListener("blur", () => {
        if (rowEl) rowEl.classList.remove("typing");   // 失焦（没发就走开）→ 复原语音模式
        if (window.chatStackAPI && window.chatStackAPI.notifyTyping) window.chatStackAPI.notifyTyping(false);
      });
      pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "pause-btn";
      pauseBtn.textContent = "⏸";
      pauseBtn.title = "暂停录音";
      pauseBtn.addEventListener("click", () => {
        // 不本地猜测：只通知引擎，视觉完全以引擎返回的 paused 为准（onLock）→ 不会出现
        // “显示 can't hear 但引擎其实没暂停” 的错位。
        if (window.chatStackAPI) window.chatStackAPI.toggleMic();
      });
      waveEl = buildWave();
      rowEl.appendChild(waveEl);     // 波形在输入框最左
      rowEl.appendChild(inputEl);
      rowEl.appendChild(pauseBtn);
      log.appendChild(rowEl);    // 输入框落最底 → 发送后消息从同一位置出现，不再错位
      cap();
      startWave();
      applyLock(micLocked); // 新建输入框时同步当前暂停态
    }
    if (typeof value === "string") inputEl.value = value;
  }
  function removeInput() {
    stopWave();
    if (rowEl) { rowEl.remove(); rowEl = null; }
    inputEl = null; pauseBtn = null;
  }

  // 工具状态小字（不是对话气泡）：钉在窗口底部、靠对话气泡那侧对齐，
  // mix-blend-mode: difference 让它在任意背景上都读得清（近似反色）。回复一来就清掉。
  let statusEl = null;
  function showStatus(text) {
    if (!text) { hideStatus(); return; }
    if (!statusEl) { statusEl = document.createElement("div"); statusEl.className = "status-line"; document.body.appendChild(statusEl); }
    statusEl.textContent = text;
  }
  function hideStatus() { if (statusEl) { statusEl.remove(); statusEl = null; } }

  if (window.chatStackAPI) {
    window.chatStackAPI.onSide((side) => {
      document.body.className = side === "left" ? "pet-left" : "pet-right";
    });
    window.chatStackAPI.onLock((locked) => applyLock(locked)); // 引擎回报暂停态 → 对齐
    window.chatStackAPI.onMsg((p) => {
     try {
      const { type, role, text } = p || {};
      if (type === "fade") { log.style.transition = "opacity 320ms ease"; log.style.opacity = "0"; return; }  // 渐隐当前对话
      if (type === "fadeprep") { log.style.transition = "none"; log.style.opacity = "0"; return; }            // 整体渐显前：先压到透明
      if (type === "fadein") { requestAnimationFrame(() => requestAnimationFrame(() => { log.style.transition = "opacity 3000ms ease"; log.style.opacity = "1"; })); return; } // 3 秒整体渐显
      if (type === "status") { showStatus(typeof text === "string" ? text : ""); return; }                    // 工具状态小字（非气泡）
      if (type === "lock") { applyLock(!!p.on); return; }                                                       // 暂停 → 禁输入（变灰）
      if (type === "typeready") {   // 上轮打字 → 直接进打字预备态：输入框就绪、聚焦、麦关
        hideStatus(); ensureInput("");
        if (rowEl) rowEl.classList.add("typing");
        if (window.chatStackAPI && window.chatStackAPI.notifyTyping) window.chatStackAPI.notifyTyping(true);
        if (inputEl) { try { inputEl.focus(); } catch (_) {} }
        userScrolledUp = false; requestAnimationFrame(stickBottom);
        return;
      }
      if (type === "clear") { log.style.transition = ""; log.style.opacity = "1"; hideStatus(); log.innerHTML = ""; inputEl = null; hintEl = null; persistentCoach = null; userScrolledUp = false; }
      else if (type === "input") { hideStatus(); ensureInput(typeof text === "string" ? text : ""); userScrolledUp = false; requestAnimationFrame(stickBottom); }  // 显示/你的回合 → 贴最新（看得到自己最新气泡）；不强设 opacity 免得打断渐显
      else if (type === "live") { if (inputEl) inputEl.value = String(text || ""); else ensureInput(String(text || "")); }
      else if (type === "endinput") { removeInput(); }
      else if (type === "add") {
        hideStatus(); if (role === "user") removeInput();
        if (p && p.instant) { addBubble(role, text, null, true); }                          // 静态堆叠，不动整栏透明度（配合 fadein 整体渐显）
        else { log.style.transition = ""; log.style.opacity = "1"; addBubble(role, text, p && p.anim); }
      }
      else if (type === "level") {                 // 麦克风实时音量 → 波形
        micLevel = Math.max(0, Math.min(1, Number(p.level) || 0));
        lastLevelTs = Date.now();
        return;                                    // 不重算窗口尺寸（高频）
      }
      else if (type === "uploading") {             // 语音上传中 → 暂停键变转圈
        if (pauseBtn) pauseBtn.classList.toggle("uploading", !!p.on);
        return;
      }
      else if (type === "hide") { /* 由 main 处理隐藏 */ }
      requestAnimationFrame(reportSize);
      setTimeout(reportSize, 60);
     } catch (err) { try { console.error("[chat-stack-renderer] onMsg error:", err && err.message, err && err.stack); } catch (_) {} }  // 单条消息出错不拖垮整条流
    });
  }
  window.addEventListener("resize", reportSize);
  // 把渲染器里的报错也吼出来，便于定位（Electron 会把 console 转发到主日志）
  window.addEventListener("error", (e) => { try { console.error("[chat-stack-renderer] error:", e.message, e.filename + ":" + e.lineno); } catch (_) {} });
  window.addEventListener("unhandledrejection", (e) => { try { console.error("[chat-stack-renderer] unhandledrejection:", e.reason && (e.reason.message || e.reason)); } catch (_) {} });

  // 鼠标在「输入框 或 对话气泡」上方时让窗口捕获鼠标（可点链接 / 可滚轮翻历史 / 可输入），
  // 在透明空白区则点穿（不挡后面的 App）。
  let _captured = false;
  document.addEventListener("mousemove", (e) => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const over = !!(t && t.closest && t.closest(".msg, .input-row"));
    if (over !== _captured) {
      _captured = over;
      if (window.chatStackAPI && window.chatStackAPI.setCapture) window.chatStackAPI.setCapture(over);
    }
  });
})();
