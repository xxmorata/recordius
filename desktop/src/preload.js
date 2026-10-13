const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED = /^(panel|media|camera|controls|rec|account|update):/;

function check(channel) {
  if (!ALLOWED.test(channel)) throw new Error(`blocked channel ${channel}`);
  return channel;
}

contextBridge.exposeInMainWorld("recordius", {
  invoke: (channel, ...args) => ipcRenderer.invoke(check(channel), ...args),
  send: (channel, ...args) => ipcRenderer.send(check(channel), ...args),
  on: (channel, listener) => {
    const wrapped = (_e, ...args) => listener(...args);
    ipcRenderer.on(check(channel), wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
