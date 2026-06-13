// user-bubble-renderer.js — 跑在你的对话气泡窗里。
// 收到 {text, mode, side}：mode='prompt' 只显示光标+占位；mode='live' 显示实时文字+光标。
(function () {
  const speech = document.getElementById("speech");
  const textEl = document.getElementById("speechText");
  let locked = false;   // 录音暂停（双击切换）→ 灰色 "Claude can't hear"

  function reportSize() {
    const r = speech.getBoundingClientRect();
    const width = Math.ceil(Math.max(r.width, speech.scrollWidth));
    const height = Math.ceil(Math.max(r.height, speech.scrollHeight));
    if (window.userBubbleAPI) window.userBubbleAPI.reportSize({ width, height });
  }

  function applyLocked(isLocked) {
    locked = isLocked;
    speech.classList.toggle("locked", locked);
    speech.classList.remove("prompt");
    if (locked) {
      textEl.textContent = "Claude can't hear";
      requestAnimationFrame(() => {
        reportSize();
        requestAnimationFrame(() => speech.classList.add("show"));
      });
    } else {
      textEl.textContent = "";   // 解锁：清空，等引擎下一条实时文字
      requestAnimationFrame(reportSize);
    }
  }

  // 双击气泡 → 本地立刻翻转灰色锁定态（不等引擎），同时通知引擎真正暂停/恢复
  function onDblClick() {
    applyLocked(!locked);                                  // 本地优先：点中就立刻变灰/复原
    if (window.userBubbleAPI) window.userBubbleAPI.toggleMic();
  }
  document.addEventListener("dblclick", onDblClick);
  speech.addEventListener("dblclick", onDblClick);         // 双保险

  if (window.userBubbleAPI) {
    window.userBubbleAPI.onLock((isLocked) => applyLocked(isLocked)); // 引擎回报 → 对齐
    window.userBubbleAPI.onShow((payload) => {
      if (locked) return;   // 锁定中忽略实时文字，保持 "Claude can't hear"
      const { text, mode, side } = payload || {};
      // 每个新轮次（prompt = 轮到你说）从 opacity:0 重新淡入，避免复用窗口时不再渐显
      if (mode === "prompt") speech.classList.remove("show");
      speech.classList.toggle("from-left", side === "left"); // 默认 = 桌宠在右
      speech.classList.toggle("prompt", mode === "prompt");   // 提示态：占位字
      // 内联兜底圆角（防陈旧缓存样式把方角圆掉）
      const R = "16px";
      speech.style.borderBottomLeftRadius = R;
      speech.style.borderBottomRightRadius = R;
      if (side === "left") {
        speech.style.borderTopLeftRadius = "0px";
        speech.style.borderTopRightRadius = R;
        speech.style.transformOrigin = "top left";
      } else {
        speech.style.borderTopRightRadius = "0px";
        speech.style.borderTopLeftRadius = R;
        speech.style.transformOrigin = "top right";
      }
      textEl.textContent = mode === "prompt" ? "" : String(text == null ? "" : text);
      requestAnimationFrame(() => {
        reportSize();
        requestAnimationFrame(() => speech.classList.add("show"));
      });
      setTimeout(reportSize, 60);
    });
    window.userBubbleAPI.onHide(() => {
      speech.classList.remove("show");
    });
  }

  window.addEventListener("resize", reportSize);
})();
