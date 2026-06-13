// coach-bubble-renderer.js — runs in the speech-bubble window.
// Receives {text, theme} from main, renders it, fades in, and reports its
// natural height back so main can resize + re-anchor the window above the pet.
(function () {
  const speech = document.getElementById("speech");
  const textEl = document.getElementById("speechText");

  function reportSize() {
    // report the CARD box only (getBoundingClientRect excludes margin); main
    // adds the uniform CARD_MARGIN on every side to get the window size.
    // Use the max of bounding-rect and scroll size so a not-yet-settled layout
    // can never under-report and clip the last line.
    const r = speech.getBoundingClientRect();
    const width = Math.ceil(Math.max(r.width, speech.scrollWidth));
    const height = Math.ceil(Math.max(r.height, speech.scrollHeight));
    if (window.coachBubbleAPI) window.coachBubbleAPI.reportSize({ width, height });
  }

  // Split a leading/trailing "Tip: ..." sentence onto its own accented line.
  function render(text) {
    textEl.textContent = "";
    const raw = String(text == null ? "" : text).trim();
    const m = raw.match(/(^|[\n\r])\s*(Tip:[^\n\r]*)$/);
    if (m) {
      const main = raw.slice(0, m.index).trim();
      const main2 = document.createElement("span");
      main2.textContent = main;
      const tip = document.createElement("span");
      tip.className = "tip";
      tip.textContent = m[2].trim();
      textEl.appendChild(main2);
      textEl.appendChild(tip);
    } else {
      textEl.textContent = raw;
    }
  }

  if (window.coachBubbleAPI) {
    window.coachBubbleAPI.onShow((payload) => {
      const { text, theme, side } = payload || {};
      speech.classList.toggle("warm", theme === "warm");
      speech.classList.toggle("from-left", side === "left");  // default = from right
      // belt-and-suspenders: set the radii inline too, so a stale cached
      // stylesheet can never round the corner that must stay square.
      const R = "16px";
      speech.style.borderTopLeftRadius = R;
      speech.style.borderTopRightRadius = R;
      if (side === "left") {
        speech.style.borderBottomLeftRadius = "0px";   // square corner at the pet
        speech.style.borderBottomRightRadius = R;
        speech.style.transformOrigin = "bottom left";
      } else {
        speech.style.borderBottomRightRadius = "0px";  // square corner at the pet
        speech.style.borderBottomLeftRadius = R;
        speech.style.transformOrigin = "bottom right";
      }
      render(text);
      // measure after layout settles, then fade in
      requestAnimationFrame(() => {
        reportSize();
        requestAnimationFrame(() => speech.classList.add("show"));
      });
      // re-measure once fonts have loaded and once more shortly after, so a
      // late web-font reflow (which adds a line) can't leave the last line
      // clipped by a window sized to the pre-font height.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => reportSize()).catch(() => {});
      }
      setTimeout(reportSize, 120);
    });
    window.coachBubbleAPI.onHide(() => {
      speech.classList.remove("show");
    });
  }

  window.addEventListener("resize", reportSize);
})();
