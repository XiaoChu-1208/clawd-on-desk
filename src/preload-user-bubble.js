// preload-user-bubble.js — 你（用户）对话气泡的 context bridge。main → renderer 推文字，
// renderer 把测得的高度回报给 main 用于贴位。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("userBubbleAPI", {
  onShow: (cb) => ipcRenderer.on("user-speech-show", (_e, payload) => cb(payload)),
  onHide: (cb) => ipcRenderer.on("user-speech-hide", () => cb()),
  onLock: (cb) => ipcRenderer.on("user-speech-lock", (_e, locked) => cb(!!locked)), // 暂停态
  reportSize: (size) => ipcRenderer.send("user-bubble-size", size),
  toggleMic: () => ipcRenderer.send("user-toggle-mic"),  // 双击 → 切换录音暂停
});
