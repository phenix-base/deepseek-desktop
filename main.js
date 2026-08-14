'use strict';

const { app, BrowserWindow, dialog, Menu, Tray, nativeImage, net, screen, shell } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3080;
const APP_URL = `http://${HOST}:${PORT}/`;
const DSH_PACKAGE = '@deepseek-ai/dsh'; // https://github.com/deepseek-ai/deepseek-harness
const DSH_BOOT_MARKER = '__DSH_BOOT__'; // dsh web 首页内嵌的启动标记，用于识别 3080 上是否是 dsh web
const MAX_BODY_BYTES = 8192; // 首页抓取上限（特征串校验用）
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'trayTemplate.png');
const CREDENTIALS_FILE = path.join(os.homedir(), '.dsh', '.credentials.yaml'); // dsh 保存的 DeepSeek API Key
const DEFAULT_WINDOW = { width: 1280, height: 800 };

let serverProc = null; // 仅当由本应用启动 dsh 时非空
let dshTerminated = false; // 退出流程中只终止一次 dsh（before-quit 拦截重入保护）
let mainWindow = null; // 主窗口引用（关闭时隐藏到托盘）
let isQuitting = false; // 真正退出标志：托盘「退出」/ Cmd+Q 时置 true
let tray = null; // 系统托盘
let trayMenu = null; // 托盘菜单（版本状态/升级项变化时重建）
let dshLocalVersion = null; // 本地 dsh 版本
let dshLatestVersion = null; // npm 最新 dsh 版本
let balanceText = null; // 最近一次查询到的余额摘要（托盘菜单显示）
let balanceValue = null; // 最近一次查询到的 CNY 余额数值（预警判断用）
const BALANCE_WARN_THRESHOLD = 10; // 余额低于该值（元）时窗口显示红色预警
let statusText = null; // 最近一次获取的 DeepSeek 服务状态（托盘菜单显示）
let trayInfoTimer = null; // 托盘信息定时刷新
const TRAY_INFO_INTERVAL = 5 * 60 * 1000; // 余额/服务状态刷新间隔（5 分钟）
const STATUS_PAGE_URL = 'https://status.deepseek.com/';

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

// 单实例锁：已有实例则退出，second-instance 由已有实例聚焦窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.on('activate', () => showMainWindow()); // Dock 图标点击恢复窗口
  app.on('before-quit', (e) => {
    isQuitting = true; // Cmd+Q 等系统级退出不被 close 隐藏拦截
    if (!dshTerminated) {
      dshTerminated = true;
      e.preventDefault(); // 退出前先终止 dsh web，完成后再重新发起退出
      terminateDsh().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => {
    // 托盘常驻：窗口关闭仅隐藏，不退出（除非 isQuitting）
    if (isQuitting) app.quit();
  });
  app.on('will-quit', () => {
    if (serverProc && !serverProc.killed) serverProc.kill();
  });
  app.whenReady().then(() => {
    createWindow();
    createTray();
    startTrayInfoRefresh(); // 定时刷新托盘展示的余额与服务状态
  });
}

// 轮询 HTTP GET / 并抓取首页前几 KB：含 __DSH_BOOT__ 标记 → { type: 'dsh' }；
// 有 HTTP 响应但非 dsh web → { type: 'other' }；超时无响应 → null。
function waitForServer(port = PORT, host = HOST, timeout = 30000, interval = 500) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const timer = setInterval(check, interval);
    let settled = false;
    let inFlight = false;

    function settle(result) {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(result);
    }

    function check() {
      if (settled || inFlight) return;
      inFlight = true;
      const req = http.get({ host, port, path: '/' }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes(DSH_BOOT_MARKER)) {
            settle({ type: 'dsh' });
            req.destroy();
          } else if (body.length >= MAX_BODY_BYTES) {
            settle({ type: 'other' });
            req.destroy();
          }
        });
        res.on('end', () => {
          inFlight = false;
          settle(body.includes(DSH_BOOT_MARKER) ? { type: 'dsh' } : { type: 'other' });
        });
        res.on('error', () => {
          inFlight = false; // 连接中断视为未就绪，继续轮询
        });
      });
      req.on('error', () => {
        inFlight = false;
        if (Date.now() >= deadline) settle(null);
      });
      req.setTimeout(1000, () => req.destroy());
    }
    check();
  });
}

// 等待 3080 上出现 dsh web（同样校验特征串）；端口被占或超时则抛错
async function waitDshWeb(timeout = 30000, interval = 500) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const probe = await waitForServer(PORT, HOST, Math.max(deadline - Date.now(), 100), interval);
    if (probe && probe.type === 'dsh') return true;
    if (probe && probe.type === 'other') {
      throw new Error(`端口 ${PORT} 被其他程序占用，请释放后重试`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`http://${HOST}:${PORT}/ 在 ${timeout}ms 内未就绪`);
    }
  }
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

// 发送安装/启动状态消息（preload 暴露的 onStatus 订阅 'dsh:status'）
function sendStatus(win, msg) {
  if (win && !win.isDestroyed()) win.webContents.send('dsh:status', String(msg));
}

// 转发安装日志行到渲染进程（preload 暴露的 onLog 订阅 'dsh:log'）
function forwardLog(win, text) {
  if (!win || win.isDestroyed()) return;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (t) win.webContents.send('dsh:log', t);
  }
}

// 安装 deepseek-harness：npm install -g @deepseek-ai/dsh，返回是否成功
function installDsh(win) {
  loadLoadingPage(win, '正在安装 deepseek-harness…', `npm install -g ${DSH_PACKAGE}，可能需要几分钟`);
  sendStatus(win, '开始安装 deepseek-harness…');
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, errMsg) => {
      if (settled) return;
      settled = true;
      if (!ok && errMsg) showError(win, errMsg);
      resolve(ok);
    };
    const proc = spawn('npm', ['install', '-g', DSH_PACKAGE], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (c) => forwardLog(win, c.toString()));
    proc.stderr.on('data', (c) => forwardLog(win, c.toString()));
    proc.once('error', (err) => done(false, `无法执行 npm：${err.message}，请先安装 Node.js`));
    proc.once('close', (code) => {
      if (code === 0 && isDshInstalled()) {
        sendStatus(win, 'deepseek-harness 安装完成');
        return done(true);
      }
      done(false, `deepseek-harness 安装失败（npm 退出码 ${code}），请手动执行：npm install -g ${DSH_PACKAGE}`);
    });
  });
}

// 确认 dsh 可用；未安装则弹窗询问用户是否安装。返回 'ok' | 'quit' | 'failed'
async function ensureDsh(win) {
  if (isDshInstalled()) return 'ok';
  sendStatus(win, '未检测到 dsh CLI，等待用户选择');
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

// 检测 3080：已运行 dsh web 则直接用；端口被占则报错；
// 未运行则先确认 dsh 已安装，再 spawn `dsh web` 并等待就绪。
async function connectToServer(win) {
  // 1) 快速探测已在运行的服务（3s 超时，每 500ms 轮询）
  const probe = await waitForServer(PORT, HOST, 3000);
  if (probe) {
    if (probe.type === 'dsh') {
      sendStatus(win, '3080 上已有 dsh web 在运行');
      return true;
    }
    // 有 HTTP 响应但不是 dsh web：端口被其他程序占用
    showError(win, `端口 ${PORT} 被其他程序占用，请释放后重试`);
    sendStatus(win, `端口 ${PORT} 被其他程序占用`);
    return false;
  }

  // 2) 服务未运行，确认/安装 dsh
  sendStatus(win, '未检测到 dsh web 服务，准备启动…');
  const status = await ensureDsh(win);
  if (status === 'quit') {
    app.quit();
    return false;
  }
  if (status !== 'ok') return false; // 安装失败，错误页已展示

  // 3) spawn `dsh web` 并等待就绪（同样校验特征串）
  console.log(`[main] ${APP_URL} 未就绪，spawn dsh web`);
  sendStatus(win, '正在启动 dsh web…');
  const proc = spawn('dsh', ['web'], { detached: false, stdio: 'inherit' });
  serverProc = proc;
  const spawnError = new Promise((_, reject) => proc.once('error', reject));
  try {
    await Promise.race([waitDshWeb(), spawnError]);
    sendStatus(win, 'dsh web 服务已就绪');
    return true;
  } catch (err) {
    showError(win, err.message || String(err));
    return false;
  }
}

// 退出时终止 dsh web：
// 1) 本应用 spawn 的 dsh 进程：SIGTERM（dsh 内部优雅退出，5s 超时后强制退出）
// 2) 独立启动、仍在 3080 监听的 dsh web：先用 __DSH_BOOT__ 特征串确认身份，
//    再通过 lsof 按端口找到监听进程并终止（避免误杀占用该端口的其他程序）
async function terminateDsh() {
  if (serverProc && !serverProc.killed) {
    console.log(`[main] 终止本应用启动的 dsh web（pid ${serverProc.pid}）`);
    try {
      serverProc.kill('SIGTERM');
    } catch (_) {
      /* 进程已退出则忽略 */
    }
  }
  const spawnedPid = serverProc ? serverProc.pid : -1;
  const probe = await waitForServer(PORT, HOST, 1500);
  if (!probe || probe.type !== 'dsh') return; // 3080 上已不是 dsh web（或已退出），不动它
  try {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    for (const line of (r.stdout || '').split('\n')) {
      const pid = parseInt(line, 10);
      if (pid > 0 && pid !== process.pid && pid !== spawnedPid) {
        console.log(`[main] 终止 3080 上独立运行的 dsh web（pid ${pid}）`);
        try {
          process.kill(pid, 'SIGTERM');
        } catch (_) {
          /* 进程已退出则忽略 */
        }
      }
    }
  } catch (_) {
    /* lsof 不可用则跳过 */
  }
}

// 保存窗口位置/大小（关闭时写入 userData/window-state.json）
function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(win.getBounds()), 'utf8');
  } catch (_) {
    /* 写入失败忽略 */
  }
}

// 读取上次窗口状态；不在任何屏幕可视范围内则回退默认 1280x800 居中
function loadWindowState() {
  try {
    const b = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    if (
      typeof b.width !== 'number' ||
      typeof b.height !== 'number' ||
      typeof b.x !== 'number' ||
      typeof b.y !== 'number'
    ) {
      return DEFAULT_WINDOW;
    }
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      const ox = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
      const oy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
      return ox > 50 && oy > 50; // 与某屏幕存在可见交集
    });
    return onScreen ? b : DEFAULT_WINDOW;
  } catch (_) {
    return DEFAULT_WINDOW;
  }
}

// 显示主窗口；隐藏中则恢复，未创建/已销毁则重建
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    title: 'DeepSeek Harness',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;

  win.on('close', (e) => {
    saveWindowState(win);
    if (!isQuitting) {
      e.preventDefault(); // 关闭仅隐藏到托盘
      win.hide();
    }
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[main] loaded:', win.webContents.getURL());
    applyBalanceWarning(); // 页面刷新/导航后重新注入余额预警横幅
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
        checkDshVersion(); // 异步版本检查，不阻塞启动
      }
    })
    .catch((err) => console.error('[main] loading page error:', err));

  return win;
}

// 统一版本号显示/比较（去掉 'v' 前缀等噪音）
function normalizeVersion(s) {
  const m = String(s || '').match(/v?\d+\.\d+\.\d+[^\s]*/);
  return m ? m[0] : String(s || '').trim();
}

// npm view @deepseek-ai/dsh version（10s 超时），失败返回 null
function npmViewLatestVersion() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const proc = spawn('npm', ['view', DSH_PACKAGE, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => {
      out += c;
    });
    proc.once('error', () => done(null));
    proc.once('close', (code) => done(code === 0 && out.trim() ? normalizeVersion(out) : null));
    setTimeout(() => {
      done(null);
      proc.kill();
    }, 10000);
  });
}

// 异步检查 dsh 版本：本地 vs npm 最新，不一致时托盘菜单出现升级项；失败静默忽略
async function checkDshVersion() {
  const local = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  if (local.error) return; // dsh 不可用，跳过
  dshLocalVersion = normalizeVersion((local.stdout || local.stderr || '').trim());
  if (!dshLocalVersion) return;
  dshLatestVersion = await npmViewLatestVersion();
  console.log(`[main] dsh 版本：本地 ${dshLocalVersion}，最新 ${dshLatestVersion || '未知'}`);
  buildTrayMenu();
}

// 托盘「升级 dsh」：复用安装函数，完成后提示重启应用生效
async function upgradeDsh() {
  showMainWindow(); // 升级期间展示安装进度页
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ok = await installDsh(mainWindow); // 内部会切换到安装进度页
  if (!ok) return; // 失败已展示错误页
  dshLocalVersion = dshLatestVersion;
  buildTrayMenu();
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    message: 'deepseek-harness 升级完成',
    detail: `已升级到 ${dshLatestVersion}，重启应用后生效。`,
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(APP_URL); // 旧服务仍在运行，直接回到主界面
  }
}

// 读取 DeepSeek API Key：优先 ~/.dsh/.credentials.yaml，其次环境变量
function readApiKey() {
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)["']?\s*$/m);
    if (m) return m[1];
  } catch (_) {
    /* 文件不存在则走环境变量 */
  }
  return process.env.DEEPSEEK_API_KEY || null;
}

// GET https://api.deepseek.com/user/balance（10s 超时）
// 文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance
function fetchBalance(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'api.deepseek.com',
        path: '/user/balance',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`API 返回 ${res.statusCode}：${body.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            reject(new Error('余额接口响应解析失败'));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error(`网络错误：${e.message}`)));
    req.setTimeout(10000, () => req.destroy(new Error('请求超时（10s）')));
  });
}

// 静默查询余额并更新托盘菜单（成功显示金额，失败显示原因）
async function updateBalance() {
  const apiKey = readApiKey();
  if (!apiKey) {
    balanceText = '未配置 API Key';
    buildTrayMenu();
    return;
  }
  try {
    const data = await fetchBalance(apiKey);
    const infos = data.balance_infos || [];
    const cny = infos.find((i) => i.currency === 'CNY') || infos[0];
    balanceValue = cny ? parseFloat(cny.total_balance) : null;
    balanceText = infos.map((i) => `${i.total_balance} ${i.currency}`).join(' / ') || '未知';
  } catch (err) {
    balanceText = `查询失败（${err.message.slice(0, 30)}）`;
  }
  console.log('[main] 余额：', balanceText);
  buildTrayMenu();
  applyBalanceWarning();
}

// 余额低于阈值时在主界面顶部注入红色预警横幅（并同步窗口标题）；恢复后自动移除
function applyBalanceWarning() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.getURL().startsWith(APP_URL)) return; // 仅在主界面上显示
  const low = balanceValue !== null && balanceValue < BALANCE_WARN_THRESHOLD;
  const js = low
    ? `(()=>{if(document.getElementById('dsh-balance-warning'))return;
       const d=document.createElement('div');d.id='dsh-balance-warning';
       d.textContent='账户余额不足 ¥${balanceValue.toFixed(2)}，请及时充值';
       d.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#d32f2f;color:#fff;text-align:center;padding:8px 12px;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
       document.body.appendChild(d);})()`
    : `(()=>{const d=document.getElementById('dsh-balance-warning');if(d)d.remove();})()`;
  win.webContents.executeJavaScript(js).catch(() => {});
  win.setTitle(low ? `DeepSeek Harness — 余额不足 ¥${balanceValue.toFixed(2)}` : 'DeepSeek Harness');
}

// 组件状态中文映射（status.deepseek.com 使用的状态值）
const STATUS_ZH = {
  operational: '正常',
  degraded: '性能下降',
  partial_outage: '部分中断',
  full_outage: '完全中断',
  maintenance: '维护中',
  investigating: '排查中',
  identified: '已定位',
  monitoring: '观察中',
  resolved: '已恢复',
};

// 从 status.deepseek.com 页面内嵌数据解析各组件当前状态
// 页面为 Next.js SSR，组件当前状态以 {"component_id":"ID",...,"status":"xxx"} 形式内嵌在 HTML 中
function parseStatusHtml(html) {
  const names = new Map();
  // 组件 ID → 名称（允许 section_id 等字段夹在中间，但不跨越其他 component_id）
  const nameRe =
    /\\"component_id\\":\\"([A-Z0-9]+)\\",(?:.(?!\\"component_id\\")){0,200}?\\"name\\":\\"([^\\"]+?)\\"/gs;
  let m;
  while ((m = nameRe.exec(html))) {
    if (!names.has(m[1])) names.set(m[1], m[2]);
  }
  const current = new Map();
  const stRe =
    /\\"component_id\\":\\"([A-Z0-9]+)\\",(?:.(?!\\"component_id\\")){0,800}?\\"status\\":\\"([a-z_]+)\\"/gs;
  while ((m = stRe.exec(html))) {
    if (!current.has(m[1])) current.set(m[1], m[2]);
  }
  if (current.size === 0) return null; // 页面结构变化，解析失败
  const abnormal = [];
  for (const [id, st] of current) {
    if (st !== 'operational') {
      abnormal.push(`${names.get(id) || id}（${STATUS_ZH[st] || st}）`);
    }
  }
  return abnormal.length === 0 ? '全部正常' : `异常：${abnormal.join('、')}`;
}

// 抓取 DeepSeek 服务状态页并解析（10s 超时）
// 注意：必须用 Electron net（Chromium 网络栈）；Node https 的 TLS 指纹会被状态页 CDN 拦截（ECONNRESET）
async function fetchDeepseekStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await net.fetch(STATUS_PAGE_URL, { signal: controller.signal });
    if (!res.ok) return null;
    return parseStatusHtml(await res.text());
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 静默刷新服务状态并更新托盘菜单
async function updateStatus() {
  const text = await fetchDeepseekStatus();
  statusText = text || '获取失败';
  console.log('[main] 服务状态：', statusText);
  buildTrayMenu();
}

// 定时刷新托盘展示的余额与服务状态
function startTrayInfoRefresh() {
  const refresh = () => {
    updateBalance();
    updateStatus();
  };
  refresh(); // 启动时立即查一次
  if (trayInfoTimer) clearInterval(trayInfoTimer);
  trayInfoTimer = setInterval(refresh, TRAY_INFO_INTERVAL);
}

// 创建系统托盘（图标缺失时跳过托盘，避免崩溃）
function createTray() {
  let icon = null;
  try {
    if (fs.existsSync(TRAY_ICON_PATH)) icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  } catch (_) {
    icon = null;
  }
  if (!icon || icon.isEmpty()) {
    console.warn('[main] 托盘图标缺失（assets/trayTemplate.png），跳过系统托盘');
    return;
  }
  tray = new Tray(icon);
  tray.setToolTip('DeepSeek Harness');
  tray.on('click', showMainWindow);
  buildTrayMenu();
}

// 重建托盘菜单（dsh 版本状态/升级项随版本检查结果变化）
function buildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: '打开主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: `余额：${balanceText || '查询中…'}`, enabled: false },
    {
      // 直接展示当前服务状态；点击打开状态页查看详情
      label: `服务状态：${statusText || '查询中…'}`,
      click: () => shell.openExternal(STATUS_PAGE_URL),
    },
  ];
  items.push(
    { type: 'separator' },
    {
      label: dshLocalVersion ? `dsh 版本：${dshLocalVersion}` : 'dsh 版本：检测中…',
      enabled: false,
    }
  );
  if (dshLocalVersion && dshLatestVersion && dshLocalVersion !== dshLatestVersion) {
    items.push({
      label: `升级 dsh（当前 ${dshLocalVersion} → 最新 ${dshLatestVersion}）`,
      click: upgradeDsh,
    });
  }
  items.push({ type: 'separator' }, { label: '退出', click: quitApp });
  trayMenu = Menu.buildFromTemplate(items);
  tray.setContextMenu(trayMenu);
}

// 托盘「退出」：置标志后真正退出
function quitApp() {
  isQuitting = true;
  app.quit();
}
