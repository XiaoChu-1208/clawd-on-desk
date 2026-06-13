// preload-coach-bubble.js — context bridge for the coach speech bubble.
// Mirrors preload-bubble.js but one-way: main → renderer pushes text to show,
// and the renderer reports its measured height back so main can size/anchor.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coachBubbleAPI", {
  onShow: (cb) => ipcRenderer.on("coach-speech-show", (_e, payload) => cb(payload)),
  onHide: (cb) => ipcRenderer.on("coach-speech-hide", () => cb()),
  reportSize: (size) => ipcRenderer.send("coach-bubble-size", size),
});
