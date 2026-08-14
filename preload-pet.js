'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 宠物窗口桥：接收主进程状态推送 + 上报拖拽/点击（仅订阅与发送固定频道，最小权限）
contextBridge.exposeInMainWorld('pet', {
  // 订阅状态：'idle' | 'busy' | 'warn' | 'offline'
  onState(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
  },
  // 单击宠物 → 打开主窗口
  openMain() {
    ipcRenderer.send('pet:open-main');
  },
  // 拖拽：起点/移动/结束（屏幕坐标，主进程换算窗口位置）
  dragStart(x, y) {
    ipcRenderer.send('pet:drag-start', { x, y });
  },
  dragMove(x, y) {
    ipcRenderer.send('pet:drag-move', { x, y });
  },
  dragEnd() {
    ipcRenderer.send('pet:drag-end');
  },
});
