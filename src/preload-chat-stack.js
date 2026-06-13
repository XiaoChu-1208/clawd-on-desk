// preload-chat-stack.js — 桌宠头顶聊天栏的 context bridge。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatStackAPI", {
  onMsg: (cb) => ipcRenderer.on("chat-msg", (_e, payload) => cb(payload)),
  onSide: (cb) => ipcRenderer.on("chat-side", (_e, side) => cb(side)), // 桌宠在左/右屏
  reportSize: (size) => ipcRenderer.send("chat-stack-size", size),
  submit: (text) => ipcRenderer.send("chat-submit", text), // 回车发送（打字）
  toggleMic: () => ipcRenderer.send("chat-toggle-mic"),     // 暂停按钮 → 开/关录音
  onLock: (cb) => ipcRenderer.on("chat-lock", (_e, locked) => cb(!!locked)),
  setCapture: (on) => ipcRenderer.send("chat-capture", !!on), // 鼠标在可交互区上→捕获，否则点穿
  notifyTyping: (on) => ipcRenderer.send("chat-typing", !!on), // 进入打字模式→引擎停麦
  openLink: (href) => ipcRenderer.send("chat-open-link", href), // 点对话里的超链接→外部浏览器打开
});
