import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("paperclip", {
  updater: {
    onStatus: (cb: (data: { status: string; version?: string; percent?: number }) => void) => {
      ipcRenderer.on("update-status", (_e, data) => cb(data));
    },
  },
});
