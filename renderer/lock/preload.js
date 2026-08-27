'use strict';

// 锁屏窗 preload：contextBridge 暴露最小 API，不泄漏 Node/Electron 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lockScreen', {
  /** 当前模式：'locked'（输密码解锁）| 'setup'（尚未设密码） */
  mode: () => ipcRenderer.invoke('lock:mode'),
  /** 提交解锁尝试 → { ok } 或 { ok:false, reason:'wrong'|'cooldown', failsLeft?, remainingSec? } */
  submit: (pw) => ipcRenderer.invoke('lock:submit', pw),
  /** 首次设置密码 → { ok } 或 { ok:false, reason:'too-short' } */
  set: (pw) => ipcRenderer.invoke('lock:set', pw),
});