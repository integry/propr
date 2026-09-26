const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  void ipcRenderer.invoke('ready');
}, { once: true });
