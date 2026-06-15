// chat-stack-renderer.js — Claude Baby 头顶聊天栏。coach=暖色靠左，user=蓝色靠右。
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

  document.body.classList.add("pet-right"); // 默认 Claude Baby 在右；onSide 会纠正

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

  // 固定大小的对话框：正常消息【不】驱动窗口尺寸 → 不 resize、不闪（内容从底往上流，超出顶部被蒙版吃掉）。
  // 唯一例外：你粘了图正在【合成】时，把「缩略图区需要的额外高度」报给主进程，让窗口在基础高度上【向下】长出来、
  // 把预览图包住（输入气泡顶部不动）。发出 / 清空 / 没图时报 0 → 窗口缩回固定高度。
  function reportSize() {
    if (!window.chatStackAPI || !window.chatStackAPI.reportSize) return;
    let extra = 0;
    if (thumbsEl && thumbsEl.style.display !== "none") {
      const h = thumbsEl.getBoundingClientRect().height;
      if (h > 0) extra = Math.ceil(h);
    }
    window.chatStackAPI.reportSize(extra);
  }
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

  function addBubble(role, text, anim, instant, variant, images) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "coach");
    if (variant === "cmd") el.classList.add("cmd");      // 斜杠命令:黑色气泡(终端风)
    el._born = Date.now();   // 记出生时间，用于按 30s 准点渐隐
    const t = String(text == null ? "" : text);
    let textSpan = null;
    const isCmd = variant === "cmd";
    const hasImgs = Array.isArray(images) && images.length > 0;
    if (hasImgs) { el.classList.add("has-img"); el.appendChild(buildImageStack(images, { big: true })); }   // 粘贴的图片 → 气泡里方形(叠放)预览
    if (instant) {
      // 切换会话整体渐显：每条都不要自己的入场动画（coach 的 rise / user 的瞬现），
      // 统一只靠 #log 的整体 3 秒透明度渐显，节奏一致。
      el.style.animation = "none"; el.style.opacity = "1"; el.style.transform = "none";
      if (t) { if (role === "coach" && !isCmd) renderCoach(el, t); else appendLinkified(el, t); }
    } else if (role === "coach" && !isCmd) {
      typeCoach(el, t);                                    // 逐字流式(命令回复不逐字,直接显)
    } else if (anim === "grow" && t) {
      textSpan = document.createElement("span");           // 一次性语音：展开 + 文字渐显
      appendLinkified(textSpan, t);
      el.appendChild(textSpan);
    } else if (t) {
      appendLinkified(el, t);                              // 打字/流式/命令：直接顶上去
    }
    // 复制:单击气泡空白处 → 复制整条到剪贴板(有选中文字时不抢,让原生 Cmd+C 复制选区)。
    el.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest("a.lnk")) return;   // 点链接 → 打开,不复制
      const sel = (window.getSelection && window.getSelection().toString()) || "";
      if (sel.trim()) return;                                                   // 有选中 → 交给原生复制
      const txt = (el.innerText || el.textContent || "").trim();
      if (!txt || !(window.chatStackAPI && window.chatStackAPI.copy)) return;
      window.chatStackAPI.copy(txt);
      try { showStatus("已复制"); setTimeout(() => { try { hideStatus(); } catch (_) {} }, 1100); } catch (_) {}
    });
    log.appendChild(el); cap();
    if (instant || !userScrolledUp) stickBottom();   // 新消息/恢复 → 贴最新；除非用户正翻历史
    // 带图的用户气泡:从底边基线"长出来"——底边不动、高度往上展开(因为整列贴底锚定)。
    if (hasImgs && role === "user" && !instant) {
      el.style.overflow = "hidden"; el.style.maxHeight = "0px";
      requestAnimationFrame(() => {
        const target = el.scrollHeight;
        el.style.transition = "max-height 400ms cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.maxHeight = target + "px";
        if (!userScrolledUp) stickBottom();
        setTimeout(() => { el.style.maxHeight = ""; el.style.overflow = ""; el.style.transition = ""; }, 440);
      });
    }
    if (role === "coach") persistentCoach = el;
    else if (!instant && anim === "grow" && textSpan) growIn(el, textSpan);
  }

  let rowEl = null, pauseBtn = null, micLocked = false, thumbsEl = null;
  let pendingPasteImages = [];   // 粘贴进输入框、等待随回车一起发的剪贴板图片(data URL,可多张)
  let pasteLoading = 0;          // 正在解码的粘贴图数量(>0 显示慢闪镭射扫光占位框)
  // 叠放缩略图(底图 + 最后一张错落叠上面,≥2 张右上角标 ❷/❸/+N);× 移除最后一张。
  function buildImageStack(srcs, opts) {
    opts = opts || {};
    const stack = document.createElement("div");
    stack.className = "img-stack" + (opts.big ? " big" : "");
    const show = Math.min(srcs.length, 2);
    for (let i = 0; i < show; i++) {
      const im = document.createElement("img");
      im.className = "stack-img " + (i === show - 1 ? "top" : "under");
      im.src = srcs[srcs.length - show + i]; im.alt = "image";
      stack.appendChild(im);
    }
    if (srcs.length >= 2) {
      const badge = document.createElement("span");
      badge.className = "stack-badge";
      badge.textContent = srcs.length === 2 ? "❷" : (srcs.length === 3 ? "❸" : "+" + srcs.length);
      stack.appendChild(badge);
    }
    if (opts.removable) {
      const x = document.createElement("button");
      x.type = "button"; x.className = "stack-x"; x.textContent = "×"; x.title = "Remove";
      x.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); pendingPasteImages.pop(); renderThumbs(); });
      stack.appendChild(x);
    }
    return stack;
  }
  function renderThumbs() {
    if (!thumbsEl) return;
    thumbsEl.innerHTML = "";
    const has = pendingPasteImages.length > 0 || pasteLoading > 0;
    thumbsEl.style.display = has ? "" : "none";
    if (rowEl) rowEl.classList.toggle("has-thumbs", has);
    if (pendingPasteImages.length) thumbsEl.appendChild(buildImageStack(pendingPasteImages, { removable: true }));
    if (pasteLoading > 0) {                       // 慢闪镭射扫光方框:表示图片正在解码
      const ph = el("div", "thumb-loading");
      thumbsEl.appendChild(ph);
    }
    requestAnimationFrame(reportSize);
  }
  // 粘贴剪贴板图片:立刻显示扫光占位 → 解码完换成缩略图。输入框 paste 与文档级 paste 共用。
  function handlePaste(e) {
    if (!thumbsEl) return;   // 没有输入框(不在你的回合)就不处理
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let found = false;
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const blob = it.getAsFile(); if (!blob) continue;
        found = true;
        pasteLoading++; renderThumbs();   // 立刻出现「慢闪镭射扫光」占位框
        const reader = new FileReader();
        reader.onload = () => { pasteLoading = Math.max(0, pasteLoading - 1); pendingPasteImages.push(String(reader.result || "")); renderThumbs(); };
        reader.onerror = () => { pasteLoading = Math.max(0, pasteLoading - 1); renderThumbs(); };
        reader.readAsDataURL(blob);
      }
    }
    // 处理了图就拦下来:既阻默认粘贴,又阻冒泡 → 避免 input + document 两个监听各跑一遍把图粘成两张
    if (found) { e.preventDefault(); e.stopPropagation(); }
  }

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
        // 兼容:点到的是文字节点时取其父元素,否则 closest 会失效导致漏判暂停键 → 误进打字模式
        const node = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
        if (node === inputEl) return;                                       // 点文字框本身：正常放光标
        if (node && node.closest && node.closest(".pause-btn")) return;     // 点暂停键(或其内部/文字)：不抢焦点,走它自己的切换
        // 兜底:按【几何坐标】判是否点在 ⏸ 上(绕开层级/过渡/命中错位的一切歧义,你点中心也算)→ 不抢焦点进打字模式
        if (pauseBtn) {
          const r = pauseBtn.getBoundingClientRect();
          if (r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
        }
        e.preventDefault();                                                 // 点声波/空白：聚焦打字
        if (inputEl) inputEl.focus();
      });
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "user-input";
      inputEl.setAttribute("autocomplete", "off");
      const doSend = (t) => {
        if (!(t || pendingPasteImages.length) || !window.chatStackAPI) return;
        const imgs = pendingPasteImages.slice();
        Promise.resolve(window.chatStackAPI.submit(t, imgs)).then((r) => {
          if (r && r.accepted) {
            if (inputEl) inputEl.value = "";          // 确认受理 → 清空(引擎随后会回灌成气泡)
            pendingPasteImages = []; renderThumbs();
          } else if (rowEl) {                          // 没被受理(引擎忙/没在听)→ 保留你的字和图,抖一下提示
            rowEl.classList.remove("nudge"); void rowEl.offsetWidth; rowEl.classList.add("nudge");
          }
        }).catch(() => {});
      };
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const t = inputEl.value.trim();
          // 还有图片在异步解码(刚粘贴大图就回车)→ 等它们进数组再发,别发出空的
          if (pasteLoading > 0) {
            let tries = 0;
            const wait = () => {
              if (pasteLoading > 0 && tries++ < 60) { setTimeout(wait, 25); return; }
              doSend(t);
            };
            wait();
          } else { doSend(t); }
        }
      });
      // 粘贴剪贴板图片 → 立刻显示「慢闪镭射扫光」占位,解码完换成缩略图(连同文字一起回车发)
      inputEl.addEventListener("paste", handlePaste);
      // 第一个字符是 "/" → 这是斜杠命令:输入气泡用 2.3s 渐变从白变黑;删掉 "/" 再渐变变回。
      inputEl.addEventListener("input", () => {
        if (rowEl) rowEl.classList.toggle("cmd", inputEl.value.charAt(0) === "/");
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
      // 控制行(波形+输入+暂停)横排,包进 .input-main;粘贴的缩略图在它【下方】(气泡顶部不动、向下拉伸)
      const main = document.createElement("div");
      main.className = "input-main";
      main.appendChild(waveEl);
      main.appendChild(inputEl);
      main.appendChild(pauseBtn);
      rowEl.appendChild(main);
      thumbsEl = document.createElement("div");
      thumbsEl.className = "input-thumbs";
      thumbsEl.style.display = "none";
      rowEl.appendChild(thumbsEl);
      log.appendChild(rowEl);    // 输入框落最底 → 发送后消息从同一位置出现，不再错位
      cap();
      startWave();
      renderThumbs();       // 复原可能残留的待发图(一般为空)
      applyLock(micLocked); // 新建输入框时同步当前暂停态
    }
    if (typeof value === "string") inputEl.value = value;
  }
  function removeInput() {
    stopWave();
    if (rowEl) { rowEl.remove(); rowEl = null; }
    inputEl = null; pauseBtn = null; thumbsEl = null; pendingPasteImages = []; pasteLoading = 0;
    reportSize();   // 输入框/缩略图都没了 → 报 0,窗口缩回固定高度
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
        const variant = p && p.variant, images = (p && (p.images || (p.image ? [p.image] : null))) || null;
        if (p && p.instant) { addBubble(role, text, null, true, variant, images); }            // 静态堆叠，不动整栏透明度（配合 fadein 整体渐显）
        else { log.style.transition = ""; log.style.opacity = "1"; addBubble(role, text, p && p.anim, false, variant, images); }
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
  // 文档级粘贴兜底:焦点没精确落在输入框、但在聊天窗里时也能接住图片粘贴
  document.addEventListener("paste", handlePaste);
  let _captured = false;
  document.addEventListener("mousemove", (e) => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    let over = !!(t && t.closest && t.closest(".msg, .input-row"));
    // 输入行存在时,用它的包围盒【外扩 16px】提前进入捕获 —— 否则你移到那个才 30px 的 ⏸ 上点下去时,
    // 「检测 over → IPC 切 setIgnoreMouseEvents(false)」还没完成,点击就穿过去了(光标也还是箭头),时灵时不灵。
    // 提前一截开捕获 → 留足 IPC 往返时间,碰到 ⏸ 时窗口已经可点。
    if (!over && rowEl) {
      const r = rowEl.getBoundingClientRect();
      const M = 16;
      if (e.clientX >= r.left - M && e.clientX <= r.right + M && e.clientY >= r.top - M && e.clientY <= r.bottom + M) over = true;
    }
    if (over !== _captured) {
      _captured = over;
      if (window.chatStackAPI && window.chatStackAPI.setCapture) window.chatStackAPI.setCapture(over);
    }
  });
})();
