'use strict';

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3080;
const APP_URL = `http://${HOST}:${PORT}/`;

let serverProc = null; // 仅当由本应用启动 dsh 时非空

// 轮询 HTTP GET /，服务就绪则 resolve，超时则 reject。
function waitForServer(port = PORT, host = HOST, timeout = 30000, interval = 500) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const timer = setInterval(check, interval);
    function check() {
      const req = http.get({ host, port, path: '/' }, (res) => {
        res.resume(); // 释放连接
        clearInterval(timer);
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(`http://${host}:${port}/ 在 ${timeout}ms 内未就绪`));
        }
      });
      req.setTimeout(1000, () => req.destroy());
    }
    check();
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 内嵌等待/错误页（loading.html 缺失时的降级方案）
function dataPage(bodyHtml) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek Harness</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e6e6;font-family:system-ui,sans-serif;">
<div style="text-align:center;max-width:560px;padding:24px">${bodyHtml}</div>
</body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function loadLoadingPage(win) {
  const file = path.join(__dirname, 'renderer', 'loading.html');
  if (fs.existsSync(file)) {
    return win.loadFile(file);
  }
  // 独立冒烟测试降级：无 loading.html 时显示内置等待页
  return win.loadURL(
    dataPage(
      '<div style="font-size:18px">正在启动 DeepSeek Harness…</div>' +
        '<div style="font-size:13px;color:#888;margin-top:12px">等待 http://127.0.0.1:3080/ 就绪</div>'
    )
  );
}

function showError(win, message) {
  if (win.isDestroyed()) return;
  win.loadURL(
    dataPage(
      '<div style="font-size:18px">连接失败</div>' +
        `<div style="font-size:13px;color:#888;margin-top:12px">${escapeHtml(message)}</div>`
    )
  );
}

// 检测 3080；未就绪则 spawn `dsh web` 并再等一次。返回是否可用。
function connectToServer(win) {
  return waitForServer()
    .then(() => true)
    .catch(() => {
      console.log(`[main] ${APP_URL} 未就绪，spawn dsh web`);
      const proc = spawn('dsh', ['web'], { detached: false, stdio: 'inherit' });
      serverProc = proc;
      const spawnError = new Promise((_, reject) => proc.once('error', reject));
      return Promise.race([waitForServer(), spawnError]).then(
        () => true,
        (err) => {
          showError(win, `启动 dsh web 失败或等待超时：${err.message}`);
          return false;
        }
      );
    });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DeepSeek Harness',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[main] loaded:', win.webContents.getURL());
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[main] load failed:', code, desc);
  });

  loadLoadingPage(win)
    .then(async () => {
      const ready = await connectToServer(win);
      if (ready && !win.isDestroyed()) {
        console.log('[main] server ready, loading', APP_URL);
        win.loadURL(APP_URL);
      }
    })
    .catch((err) => console.error('[main] loading page error:', err));

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (serverProc && !serverProc.killed) serverProc.kill();
});
