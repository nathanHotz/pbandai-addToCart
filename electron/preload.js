'use strict'

const {contextBridge, ipcRenderer} = require('electron')

contextBridge.exposeInMainWorld('api', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: cfg => ipcRenderer.invoke('config:save', cfg),
  setMode: mode => ipcRenderer.send('set-mode', mode),
  arm: cfg => ipcRenderer.send('arm', cfg),
  stop: () => ipcRenderer.send('stop'),
  lookupItem: url => ipcRenderer.invoke('lookup-item', url),
  navBack: () => ipcRenderer.send('nav:back'),
  navForward: () => ipcRenderer.send('nav:forward'),
  navReload: () => ipcRenderer.send('nav:reload'),
  navHome: () => ipcRenderer.send('nav:home'),
  navGo: url => ipcRenderer.send('nav:go', url),
  getUrl: () => ipcRenderer.invoke('get-url'),
  onNavState: cb => ipcRenderer.on('nav-state', (_e, s) => cb(s)),
  onLog: cb => ipcRenderer.on('log', (_e, m) => cb(m)),
  onStatus: cb => ipcRenderer.on('status', (_e, s) => cb(s)),
})
