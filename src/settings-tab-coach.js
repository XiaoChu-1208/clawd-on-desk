"use strict";

// Coach / Claude Baby settings tab.
// All controls talk to the local voice engine over its control port via the
// "settings:coach" IPC proxy (window.settingsAPI.coach). Booleans use the same
// .switch toggle as the rest of Settings; numeric values use .volume-slider.
// Style matches the existing panels (.section / .row / .soft-btn).

(function initSettingsTabCoach(root) {
  let core = null;
  let helpers = null;
  let cfg = {};

  function callEngine(path, method, body) {
    if (!window.settingsAPI || typeof window.settingsAPI.coach !== "function") {
      return Promise.resolve({ ok: false, error: "no bridge" });
    }
    return window.settingsAPI.coach(path, method, body).catch((e) => ({ ok: false, error: String(e) }));
  }

  async function setConfig(patch) {
    const r = await callEngine("/config", "POST", patch);
    if (r && r.ok && r.data && r.data.config) cfg = r.data.config;
    if (!r || !r.ok) helpers.showToast("Voice engine not reachable", { error: true });
    return !!(r && r.ok);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // A yes/no toggle row, visually identical to the rest of Settings (.switch).
  function switchRow(label, desc, getVal, onSet) {
    const row = el("div", "row");
    row.innerHTML =
      `<div class="row-text"><span class="row-label"></span><span class="row-desc"></span></div>` +
      `<div class="row-control"><div class="switch" role="switch" tabindex="0" aria-checked="false"></div></div>`;
    row.querySelector(".row-label").textContent = label;
    const d = row.querySelector(".row-desc");
    if (desc) d.textContent = desc; else d.remove();
    const sw = row.querySelector(".switch");
    const paint = () => { const on = !!getVal(); sw.classList.toggle("on", on); sw.setAttribute("aria-checked", on ? "true" : "false"); };
    paint();
    const run = async () => {
      if (sw.classList.contains("pending")) return;
      const next = !getVal();
      sw.classList.add("pending"); sw.classList.toggle("on", next);
      const ok = await onSet(next);
      sw.classList.remove("pending");
      paint();
    };
    sw.addEventListener("click", run);
    sw.addEventListener("keydown", (ev) => { if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); run(); } });
    return row;
  }

  // A slider row for a numeric value (.volume-slider, same as the volume control).
  function sliderRow(label, desc, opts, getVal, onSet) {
    const { min, max, step, fmt } = opts;
    const row = el("div", "row");
    row.innerHTML =
      `<div class="row-text"><span class="row-label"></span><span class="row-desc"></span></div>` +
      `<div class="row-control"></div>`;
    row.querySelector(".row-label").textContent = label;
    const d = row.querySelector(".row-desc");
    if (desc) d.textContent = desc; else d.remove();
    const ctrl = row.querySelector(".row-control");
    const valEl = el("span", null, "");
    valEl.style.cssText = "font-size:12px;color:var(--text-secondary);min-width:46px;text-align:right;";
    const sl = document.createElement("input");
    sl.type = "range"; sl.className = "volume-slider";
    sl.min = String(min); sl.max = String(max); sl.step = String(step);
    sl.value = String(getVal());
    sl.style.width = "150px"; sl.style.accentColor = "var(--accent)";
    const show = () => { valEl.textContent = fmt ? fmt(Number(sl.value)) : sl.value; };
    show();
    sl.addEventListener("input", show);
    sl.addEventListener("change", () => onSet(Number(sl.value)));
    ctrl.appendChild(valEl);
    ctrl.appendChild(sl);
    return row;
  }

  // A row whose control area holds one or more soft buttons.
  function buttonRow(label, desc, buttons) {
    const row = el("div", "row");
    row.innerHTML =
      `<div class="row-text"><span class="row-label"></span><span class="row-desc"></span></div>` +
      `<div class="row-control"></div>`;
    row.querySelector(".row-label").textContent = label;
    const d = row.querySelector(".row-desc");
    if (desc) d.textContent = desc; else d.remove();
    const ctrl = row.querySelector(".row-control");
    for (const b of buttons) ctrl.appendChild(b);
    return row;
  }

  function softBtn(label, onClick, { accent = false, danger = false, disabled = false, title = "" } = {}) {
    const btn = el("button", "soft-btn" + (accent ? " accent" : ""), label);
    btn.type = "button";
    if (title) btn.title = title;
    if (disabled) {
      btn.disabled = true;
      btn.style.opacity = "0.4"; btn.style.cursor = "default";
    } else {
      if (danger) btn.style.color = "#d11a2a";
      if (onClick) btn.addEventListener("click", onClick);
    }
    return btn;
  }

  // ---------- sections ----------

  function micSection(mics, curMic, rerender) {
    const rows = [];
    if (!mics.length) {
      const r = el("div", "row");
      r.innerHTML = `<div class="row-text"><span class="row-desc"></span></div>`;
      r.querySelector(".row-desc").textContent = "No microphones detected (or ffmpeg unavailable).";
      rows.push(r);
    }
    for (const m of mics) {
      const dev = ":" + m.index;
      const isCur = curMic === dev || curMic === ":" + m.name || curMic === m.name;
      const ctrl = isCur
        ? softBtn("In use", null, { accent: true })
        : softBtn("Use", async () => { const r = await callEngine("/mic", "POST", { device: dev }); if (r && r.ok) rerender(); else helpers.showToast("Voice engine not reachable", { error: true }); });
      if (isCur) { ctrl.disabled = true; ctrl.style.opacity = "0.7"; }
      rows.push(buttonRow(m.name, isCur ? "Current input" : "", [ctrl]));
    }
    return helpers.buildSection("Microphone", rows);
  }

  function voiceSection() {
    return helpers.buildSection("Voice & interruption", [
      sliderRow("Speaking volume", "How loud Claude Baby talks.",
        { min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + "%" },
        () => cfg.volume, (v) => setConfig({ volume: v })),
      switchRow("Voice effect", "Telephone / walkie-talkie filter on the voice.",
        () => cfg.voiceFx, (v) => setConfig({ voiceFx: v })),
      switchRow("Talk to interrupt", "Start speaking while it talks to cut it off and take the turn.",
        () => cfg.bargeVoice, (v) => setConfig({ bargeVoice: v })),
      sliderRow("Interrupt sensitivity", "Mic loudness needed to count as you talking. Higher = less likely to self-interrupt on speaker echo.",
        { min: 0.01, max: 0.3, step: 0.01, fmt: (v) => v.toFixed(2) },
        () => cfg.bargeRms, (v) => setConfig({ bargeRms: v })),
      sliderRow("Interrupt hold time", "How long your voice must sustain before it interrupts.",
        { min: 30, max: 1000, step: 10, fmt: (v) => v + " ms" },
        () => cfg.bargeSustainMs, (v) => setConfig({ bargeSustainMs: v })),
    ]);
  }

  function wakeSection() {
    return helpers.buildSection("Wake word & knock", [
      switchRow('Wake word "Claude"', "Say \"Claude\" to summon it (needs enrollment).",
        () => cfg.wake, (v) => setConfig({ wake: v })),
      sliderRow("Wake sensitivity", "Match threshold for the wake word. Lower wakes more easily; higher avoids false triggers.",
        { min: 0.3, max: 0.95, step: 0.01, fmt: (v) => v.toFixed(2) },
        () => cfg.wakeThreshold, (v) => setConfig({ wakeThreshold: v })),
      switchRow("Knock to wake", "Knock on the desk a few times to wake it (fallback when the wake word is off).",
        () => cfg.knock, (v) => setConfig({ knock: v })),
    ]);
  }

  function modelSection() {
    const mk = (id, label) => softBtn(label, async () => { await setConfig({ model: id }); rerenderModel(); }, { accent: cfg.model === id });
    let row;
    function rerenderModel() {
      const fresh = buttonRow("Model", "Haiku is fastest; Opus is most capable.", [mk("haiku", "Haiku"), mk("sonnet", "Sonnet"), mk("opus", "Opus")]);
      if (row && row.parentNode) { row.parentNode.replaceChild(fresh, row); }
      row = fresh;
    }
    row = buttonRow("Model", "Haiku is fastest; Opus is most capable.", [mk("haiku", "Haiku"), mk("sonnet", "Sonnet"), mk("opus", "Opus")]);
    return helpers.buildSection("Model", [row]);
  }

  // 音乐联动:选监听哪个音乐 App（在放歌时 Claude Baby 跳律动，暂停→idle）。值是 pgrep -if 模式。
  function musicSection() {
    const PRESETS = [
      { label: "关闭", pat: "" },
      { label: "网易云音乐", pat: "neteasemusic" },
      { label: "Apple Music", pat: "Music.app" },
      { label: "QQ音乐", pat: "QQMusic" },
      { label: "汽水音乐", pat: "SodaMusic" },
      { label: "Spotify", pat: "Spotify" },
    ];
    const cur = cfg.musicApp || "";
    const isPreset = PRESETS.some((p) => p.pat === cur);

    const inputStyle = "font:inherit;font-size:12.5px;padding:5px 8px;border-radius:7px;border:1px solid var(--border);background:var(--panel-bg);color:var(--text-primary);";
    const customInput = document.createElement("input");
    customInput.type = "text"; customInput.placeholder = "进程名 (pgrep -if)"; customInput.value = isPreset ? "" : cur;
    customInput.style.cssText = inputStyle + "width:180px;";
    customInput.addEventListener("change", () => setConfig({ musicApp: customInput.value.trim() }));

    const sel = document.createElement("select");
    sel.style.cssText = inputStyle;
    for (const p of PRESETS) { const o = document.createElement("option"); o.value = p.pat; o.textContent = p.label; sel.appendChild(o); }
    const co = document.createElement("option"); co.value = "__custom__"; co.textContent = "自定义…"; sel.appendChild(co);
    sel.value = isPreset ? cur : "__custom__";

    const customRow = buttonRow("自定义进程名", "用 pgrep -if 匹配（如 neteasemusic）", [customInput]);
    customRow.style.display = isPreset ? "none" : "flex";

    sel.addEventListener("change", () => {
      if (sel.value === "__custom__") { customRow.style.display = "flex"; customInput.focus(); }
      else { customRow.style.display = "none"; setConfig({ musicApp: sel.value }); }
    });

    const selRow = buttonRow("Music reactions", "选中的 App 在放歌时，Claude Baby 跳律动；暂停回 idle。准确判暂停需 nowplaying-cli。", [sel]);
    return helpers.buildSection("Music", [selRow, customRow]);
  }

  // ElevenLabs 音色切换：粘贴 API Key + Voice ID，点一下就切换 Claude Baby 的语音音色。
  // 写到引擎的 /config（elevenApiKey / elevenVoiceId），引擎端负责实际用它合成语音。
  function elevenSection() {
    const inputStyle = "font:inherit;font-size:12.5px;padding:6px 9px;border-radius:7px;border:1px solid var(--border);background:var(--panel-bg);color:var(--text-primary);width:230px;";

    // API Key（可隐藏明文）。#7：不回填明文、也不强迫重填——.env / 已存 key 时用 placeholder 提示「留空即沿用」。
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = cfg.hasElevenKey ? "已配置 · 留空即沿用现有 key" : "sk_… (ElevenLabs API Key)";
    keyInput.value = "";
    keyInput.autocomplete = "off"; keyInput.spellcheck = false;
    keyInput.style.cssText = inputStyle;

    // #6：眼睛改用内联 SVG（不再用 emoji）；点击在「睁眼 / 闭眼」两个图标间切换。
    const EYE_ON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    const reveal = softBtn("", () => {
      const showing = keyInput.type === "password";
      keyInput.type = showing ? "text" : "password";
      reveal.innerHTML = showing ? EYE_OFF : EYE_ON;
    }, { title: "显示 / 隐藏密钥" });
    reveal.innerHTML = EYE_ON;
    reveal.style.minWidth = "34px";
    reveal.style.display = "inline-flex"; reveal.style.alignItems = "center"; reveal.style.justifyContent = "center";

    // Voice ID
    const voiceInput = document.createElement("input");
    voiceInput.type = "text";
    voiceInput.placeholder = "Voice ID (如 21m00Tcm4TlvDq8ikWAM)";
    voiceInput.value = cfg.elevenVoiceId || "";
    voiceInput.autocomplete = "off"; voiceInput.spellcheck = false;
    voiceInput.style.cssText = inputStyle;

    // 切换音色按钮：保存 key + voiceId 到引擎，立即生效。
    const applyBtn = softBtn("切换音色", async () => {
      const apiKey = keyInput.value.trim();
      const voiceId = voiceInput.value.trim();
      if (!apiKey && !voiceId) { helpers.showToast("先粘贴 API Key 或 Voice ID", { error: true }); return; }
      applyBtn.disabled = true; applyBtn.textContent = "切换中…";
      const ok = await setConfig({ elevenApiKey: apiKey, elevenVoiceId: voiceId, voiceProvider: "eleven" });
      applyBtn.disabled = false; applyBtn.textContent = "切换音色";
      if (ok) helpers.showToast("音色已切换");
    }, { accent: true });

    return helpers.buildSection("ElevenLabs 音色", [
      buttonRow("API Key", cfg.hasElevenKey ? "已从 .env / 已保存读取，无需重填；要换 key 才粘新的。" : "在 ElevenLabs 后台 → Profile 复制，只需填一次。", [keyInput, reveal]),
      buttonRow("Voice ID", "ElevenLabs 语音库里每个音色的 ID，粘贴后点右边切换。", [voiceInput]),
      buttonRow("", "粘贴后点一下立即切换 Claude Baby 语音音色。", [applyBtn]),
    ]);
  }

  function sessionsSection(sessions, current, rerender) {
    const rows = [];
    rows.push(buttonRow("Conversations", "Each session keeps its own context.", [
      softBtn("New session", async () => { const r = await callEngine("/session/new", "POST", {}); if (r && r.ok) rerender(); else helpers.showToast("Voice engine not reachable", { error: true }); }, { accent: true }),
    ]));
    if (!sessions.length) {
      const r = el("div", "row");
      r.innerHTML = `<div class="row-text"><span class="row-desc"></span></div>`;
      r.querySelector(".row-desc").textContent = "No saved conversations yet.";
      rows.push(r);
    }
    for (const s of sessions) {
      const isCur = s.id === current;
      const row = el("div", "row");
      row.innerHTML = `<div class="row-text"></div><div class="row-control"></div>`;
      const textWrap = row.querySelector(".row-text");
      // Editable title (rename directly).
      const input = document.createElement("input");
      input.type = "text";
      input.value = s.title || "session";
      input.style.cssText = "font:inherit;font-size:13px;font-weight:500;color:var(--text-primary);background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 6px;width:100%;max-width:280px;";
      input.addEventListener("focus", () => { input.style.borderColor = "var(--border)"; input.style.background = "var(--panel-bg)"; });
      const commit = async () => {
        input.style.borderColor = "transparent"; input.style.background = "transparent";
        const title = input.value.trim();
        if (title && title !== (s.title || "")) {
          const r = await callEngine("/session/rename", "POST", { id: s.id, title });
          if (r && r.ok) { s.title = title; helpers.showToast("Renamed"); } else helpers.showToast("Rename failed", { error: true });
        }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); input.blur(); } });
      textWrap.appendChild(input);
      const meta = el("span", "row-desc", (isCur ? "Current · " : "") + (s.count || 0) + " messages");
      textWrap.appendChild(meta);
      const ctrl = row.querySelector(".row-control");
      if (!isCur) {
        ctrl.appendChild(softBtn("Switch", async () => { const r = await callEngine("/session/switch", "POST", { id: s.id }); if (r && r.ok) rerender(); else helpers.showToast("Switch failed", { error: true }); }));
      }
      ctrl.appendChild(softBtn("Delete", isCur ? null : async () => {
        const r = await callEngine("/session/delete", "POST", { id: s.id });
        if (r && r.ok) rerender(); else helpers.showToast("Delete failed", { error: true });
      }, { danger: true, disabled: isCur, title: isCur ? "当前会话不能删除（先切换或新建）" : "" }));
      rows.push(row);
    }
    return helpers.buildSection("Sessions", rows);
  }

  // ---------- render ----------

  // which: "voice"(麦克风/语音/唤醒/音乐) | "session"(模型 + 会话)
  async function load(mount, status, which) {
    const needMics = which === "voice";
    const [cfgRes, micRes] = await Promise.all([callEngine("/config", "GET"), needMics ? callEngine("/mics", "GET") : Promise.resolve(null)]);
    if (!cfgRes || !cfgRes.ok || !cfgRes.data || !cfgRes.data.config) {
      mount.innerHTML = "";
      status.textContent = "Voice engine isn't running. Start it (./start.sh) and reopen this tab.";
      status.style.display = "";
      return;
    }
    status.style.display = "none";
    cfg = cfgRes.data.config;
    const sessions = (cfgRes.data.sessions) || [];
    const current = cfgRes.data.current;
    const rerender = () => load(mount, status, which);
    mount.innerHTML = "";
    if (which === "session") {
      mount.appendChild(modelSection());
      mount.appendChild(sessionsSection(sessions, current, rerender));
    } else {
      const mics = (micRes && micRes.ok && micRes.data && micRes.data.mics) || [];
      const curMic = (micRes && micRes.ok && micRes.data && micRes.data.current) || cfg.mic;
      mount.appendChild(micSection(mics, curMic, rerender));
      mount.appendChild(voiceSection());
      mount.appendChild(wakeSection());
      mount.appendChild(musicSection());
      mount.appendChild(elevenSection());
    }
  }

  function makeRender(which, heading) {
    return function (parent, coreRef) {
      core = coreRef;
      helpers = core.helpers;
      const h1 = el("h1", null, heading);
      parent.appendChild(h1);
      const status = el("p", null, "Loading…");
      status.style.cssText = "font-size:12px;color:var(--text-secondary);margin:0 0 14px;";
      parent.appendChild(status);
      const mount = el("div");
      parent.appendChild(mount);
      load(mount, status, which);
    };
  }

  function init(coreRef) {
    coreRef.tabs.coach = { render: makeRender("voice", "Voice") };           // 麦克风 / 语音 / 唤醒 / 音乐
    coreRef.tabs.session = { render: makeRender("session", "Chat & Model") }; // 模型 + 会话(独立菜单页)
  }

  root.ClawdSettingsTabCoach = { init };
})(globalThis);
