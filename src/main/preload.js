'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['tc:snapshot', 'tc:event', 'tc:events', 'tc:status', 'tc:presence', 'tc:sync', 'tc:agentLog', 'tc:runtime', 'tc:toast', 'tc:needsLogin', 'tc:update'];

contextBridge.exposeInMainWorld('tc', {
  invoke: async (channel, args) => {
    const r = await ipcRenderer.invoke(channel, args);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  },
  on: (channel, fn) => {
    if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel ${channel}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
  platform: process.platform,
});
