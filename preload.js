'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 订阅 ipcRenderer 频道并返回取消订阅函数
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// 暴露给渲染进程的 dsh 桌面 API（仅订阅、不发送，保持最小权限）
contextBridge.exposeInMainWorld('dshDesktop', {
  // 订阅安装/启动状态消息（字符串）
  onStatus(cb) {
    return subscribe('dsh:status', cb);
  },
  // 订阅安装日志行（字符串）
  onLog(cb) {
    return subscribe('dsh:log', cb);
  },
});
