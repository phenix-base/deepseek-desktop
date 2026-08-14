'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3080;
const APP_URL = `http://${HOST}:${PORT}/`;
const DSH_PACKAGE = '@deepseek-ai/dsh'; // https://github.com/deepseek-ai/deepseek-harness

let serverProc = null; // 仅当由本应用启动 dsh 时非空

// 从 Finder/Dock 启动时 PATH 通常不含 dsh/npm，追加常见安装位置（homebrew、nvm）
function augmentPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvmDir)) {
      extra.push(path.join(nvmDir, v, 'bin'));
    }
  } catch (_) {
    /* 无 nvm 目录则忽略 */
  }
  const parts = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of extra) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  process.env.PATH = parts.join(':');
}
augmentPath();

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

// 检测 dsh CLI 是否已安装可用
function isDshInstalled() {
  const r = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  return !r.error;
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

// 加载等待页；msg/hint 通过 query 传给 loading.html 用于显示当前状态
function loadLoadingPage(win, msg, hint) {
  const file = path.join(__dirname, 'renderer', 'loading.html');
  if (fs.existsSync(file)) {
    const options = msg ? { query: { msg, hint: hint || '' } } : undefined;
    return win.loadFile(file, options);
  }
  return win.loadURL(
    dataPage(
      `<div style="font-size:18px">${escapeHtml(msg || '正在启动 DeepSeek Harness…')}</div>` +
        `<div style="font-size:13px;color:#888;margin-top:12px">${escapeHtml(hint || '等待 http://127.0.0.1:3080/ 就绪')}</div>`
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

// 安装 deepseek-harness：npm install -g @deepseek-ai/dsh，返回是否成功
function installDsh(win) {
  loadLoadingPage(win, '正在安装 deepseek-harness…', `npm install -g ${DSH_PACKAGE}，可能需要几分钟`);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, errMsg) => {
      if (settled) return;
      settled = true;
      if (!ok && errMsg) showError(win, errMsg);
      resolve(ok);
    };
    const proc = spawn('npm', ['install', '-g', DSH_PACKAGE], { stdio: 'inherit' });
    proc.once('error', (err) => done(false, `无法执行 npm：${err.message}，请先安装 Node.js`));
    proc.once('close', (code) => {
      if (code === 0 && isDshInstalled()) return done(true);
      done(false, `deepseek-harness 安装失败（npm 退出码 ${code}），请手动执行：npm install -g ${DSH_PACKAGE}`);
    });
  });
}

// 确认 dsh 可用；未安装则弹窗询问用户是否安装。返回 'ok' | 'quit' | 'failed'
async function ensureDsh(win) {
  if (isDshInstalled()) return 'ok';
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['安装 deepseek-harness', '退出'],
    defaultId: 0,
    cancelId: 1,
    title: 'DeepSeek Harness',
    message: '未检测到 deepseek-harness（dsh）',
    detail: `启动 dsh web 服务需要 dsh CLI。\n是否现在安装？将执行：npm install -g ${DSH_PACKAGE}`,
  });
  if (response !== 0) return 'quit';
  return (await installDsh(win)) ? 'ok' : 'failed';
}

// 检测 3080：已运行则直接用；未运行则先确认 dsh 已安装，再 spawn `dsh web` 并等待就绪。
async function connectToServer(win) {
  try {
    await waitForServer(PORT, HOST, 3000); // 快速探测已在运行的服务
    return true;
  } catch (_) {
    /* 服务未运行，需要启动 */
  }

  const status = await ensureDsh(win);
  if (status === 'quit') {
    app.quit();
    return false;
  }
  if (status !== 'ok') return false; // 安装失败，错误页已展示

  console.log(`[main] ${APP_URL} 未就绪，spawn dsh web`);
  const proc = spawn('dsh', ['web'], { detached: false, stdio: 'inherit' });
  serverProc = proc;
  const spawnError = new Promise((_, reject) => proc.once('error', reject));
  try {
    await Promise.race([waitForServer(), spawnError]);
    return true;
  } catch (err) {
    showError(win, `启动 dsh web 失败或等待超时：${err.message}`);
    return false;
  }
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
