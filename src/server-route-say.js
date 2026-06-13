// server-route-say.js — POST /say for the English-coach fork.
// Body: { text, state?, ttl?, theme? }
//   text  — the line the pet "speaks" (shown in the coach speech bubble)
//   state — optional animation state name (idle|thinking|working|attention|
//           notification|juggling|error|...) applied via ctx.setState
//   ttl   — optional ms to keep the bubble up (default: derived from length)
//   theme — "warm" | "dark" (matches the coach UI theme)
//
// Decoupled from /permission: no approval, no HTTP res held open. Returns 200
// immediately after dispatching to the renderer.

const MAX_TEXT = 2000;

function handleSayPost(req, res, options) {
  const { ctx } = options;
  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) { tooBig = true; req.destroy(); }
  });
  req.on("end", () => {
    if (tooBig) { res.writeHead(413); res.end(); return; }
    let data;
    try { data = JSON.parse(body || "{}"); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid json" }));
      return;
    }

    const text = typeof data.text === "string" ? data.text.slice(0, MAX_TEXT) : "";
    const state = typeof data.state === "string" ? data.state : null;
    const theme = data.theme === "warm" ? "warm" : "dark";
    const ttl = data.ttl;

    // English-coach fork: anim = 播一段具体动画（持续倾听 headphones-groove），animMs 默认很长、循环到状态切换为止
    const anim = typeof data.anim === "string" ? data.anim : null;
    const animMs = Number.isFinite(Number(data.animMs)) ? Number(data.animMs) : 600000;
    const sound = typeof data.sound === "string" ? data.sound : null; // confirm / complete
    const user = data.user && typeof data.user === "object" ? data.user : null; // 你的反向气泡
    const chat = data.chat && typeof data.chat === "object" ? data.chat : null; // 聊天记录栏

    try {
      if (chat && typeof ctx.chatStack === "function") {
        ctx.chatStack(chat);
      }
      if (user && typeof ctx.userBubble === "function") {
        ctx.userBubble(user);
      }
      if (sound && typeof ctx.playSound === "function") {
        ctx.playSound(sound);
      }
      if (state && typeof ctx.setState === "function") {
        ctx.setState(state);
      }
      if (anim && typeof ctx.playPetReaction === "function") {
        ctx.playPetReaction(anim, animMs); // 放在 setState 之后：状态切换不会把它取消
      }
      if (text && typeof ctx.showSpeechBubble === "function") {
        ctx.showSpeechBubble({ text, state, ttl, theme });
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  req.on("error", () => { try { res.writeHead(400); res.end(); } catch {} });
}

module.exports = { handleSayPost };
