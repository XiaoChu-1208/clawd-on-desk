#!/usr/bin/env node
// music-watch.js — 网易云音乐在运行时，让 clawd 桌宠进入「听歌」状态（juggling =
// headphones-groove 摇摆动画）；退出时回到 idle。
//
// 完全解耦：只调用 clawd 现成的 POST /say 接口（端口取自 ~/.clawd/runtime.json，
// 默认 23333），不改 main.js / server.js / 陪练。用 Node 原生 http 直连本地，绕开
// 任何全局代理。
//
//   node music-watch.js            # 默认监听 NeteaseMusic
//   APP=NeteaseMusic node music-watch.js
//   POLL_MS=4000 KEEPALIVE_MS=12000 node music-watch.js
//
// 说明：网易云「打开即视为在听歌」（用户口径）。对话回复会短暂切到别的动画，
// keepalive 会在 ~12s 内把它带回听歌态。

const http = require("node:http");
const { execFile } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const AUDIO_PROBE = join(__dirname, "audio-playing.py"); // CoreAudio 出声检测

const APP_PATTERN = process.env.APP || "neteasemusic"; // pgrep -if 匹配（大小写不敏感）
const POLL_MS = Number(process.env.POLL_MS) || 4000;
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS) || 12000;
const LISTEN_STATE = process.env.LISTEN_STATE || "juggling"; // 戴耳机摇摆
const IDLE_STATE = process.env.IDLE_STATE || "idle";

function clawdPort() {
  if (process.env.CLAWD_PORT) return Number(process.env.CLAWD_PORT);
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".clawd", "runtime.json"), "utf8"));
    if (Number.isInteger(j.port)) return j.port;
  } catch (_) {}
  return 23333;
}

function setState(state) {
  const body = JSON.stringify({ state, text: "" }); // 空 text → 只切动画，不弹气泡
  const req = http.request(
    { host: "127.0.0.1", port: clawdPort(), path: "/say", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 800 },
    (res) => res.resume()
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(body);
  req.end();
}

function isMusicRunning() {
  return new Promise((resolve) => {
    // -i 大小写不敏感；-f 匹配完整命令行（覆盖 NeteaseMusic 主进程及辅助进程）
    execFile("pgrep", ["-if", APP_PATTERN], { timeout: 1500 }, (err, stdout) => {
      resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

function isAudioPlaying() {
  return new Promise((resolve) => {
    // CoreAudio kAudioDevicePropertyDeviceIsRunningSomewhere：设备被占用出声=1。
    // 坑：网易云暂停常仍占着音频流 → 暂停也报 1（不可靠）。只在 now-playing 给不出答案时兜底。
    execFile("python3", [AUDIO_PROBE], { timeout: 1500 }, (err, stdout) => {
      resolve(!err && String(stdout).trim() === "1");
    });
  });
}

// 读系统「正在播放」状态的 playbackRate（媒体控制中心同款）：>0=播放→true、0=暂停→false、
// 拿不到(未装/当前无 now-playing 源)=null。实测网易云对此字段准（播放=1、暂停=0）。
function nowPlaying() {
  return new Promise((resolve) => {
    execFile("nowplaying-cli", ["get", "playbackRate"], { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null);
      const v = String(stdout).trim();
      if (v === "" || v === "null") return resolve(null);
      const n = parseFloat(v);
      resolve(Number.isFinite(n) ? n > 0 : null);
    });
  });
}

let wasRunning = null;       // null = 尚未确定
let lastAssert = 0;

async function tick() {
  // 听歌态 = 网易云在跑 且 真在播放。判据优先级:
  //   playbackRate>0 → 在播；playbackRate=0 → 暂停(明确停,修复"暂停还在听歌")；
  //   拿不到(没装 nowplaying-cli / 当前无 now-playing 源) → 退回设备出声检测。
  const appOpen = await isMusicRunning();
  let running = false;
  if (appOpen) {
    const np = await nowPlaying();
    if (np === true) running = true;
    else if (np === false) running = false;
    else running = await isAudioPlaying();
  }
  const now = Date.now();
  if (running) {
    if (wasRunning !== true) {
      setState(LISTEN_STATE);
      lastAssert = now;
      console.log(`[music-watch] ▶ ${APP_PATTERN} 在放歌（有声）→ ${LISTEN_STATE}`);
    } else if (now - lastAssert >= KEEPALIVE_MS) {
      setState(LISTEN_STATE);     // keepalive：对话切走后带回听歌态
      lastAssert = now;
    }
    wasRunning = true;
  } else {
    if (wasRunning === true) {
      setState(IDLE_STATE);
      console.log(`[music-watch] ⏹ 暂停/无声/退出 → ${IDLE_STATE}`);
    }
    wasRunning = false;
  }
}

console.log(`[music-watch] 监听 "${APP_PATTERN}"，每 ${POLL_MS}ms 轮询，clawd 端口 ${clawdPort()}`);
tick();
setInterval(tick, POLL_MS);
