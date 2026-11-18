const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  getPrivate: (room) => ipcRenderer.invoke('private:get', room),
  savePrivate: (room, data) => ipcRenderer.invoke('private:save', room, data),
  // 関数（途中経過の受け取り）はプロセス間で渡せないので外す
  llm: (req) => {
    const { onText, ...rest } = req || {};
    return ipcRenderer.invoke('llm', rest);
  },
  diagnose: () => ipcRenderer.invoke('diag:run'),
  voiceStart: () => ipcRenderer.invoke('voice:start'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  wipeLocal: () => ipcRenderer.invoke('app:wipe'),
  testDb: (url, key) => ipcRenderer.invoke('store:test', url, key),
  peekRoom: (room) => ipcRenderer.invoke('store:peek', room),
  store: {
    all: () => ipcRenderer.invoke('store:all'),
    put: (kind, id, data) => ipcRenderer.invoke('store:put', kind, id, data),
    del: (kind, id) => ipcRenderer.invoke('store:del', kind, id),
  },
});
