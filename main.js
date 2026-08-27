'use strict';

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, screen, shell, Tray } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { BridgeClient } = require('./bridge-client'); // M2：宿主桥客户端（dsh-desktop-bridge 插件）

const HOST = '127.0.0.1';
const PORT = 3080;
const APP_URL = `http://${HOST}:${PORT}/`;
const DSH_PACKAGE = '@deepseek-ai/dsh'; // https://github.com/deepseek-ai/deepseek-harness
const DSH_BOOT_MARKER = '__DSH_BOOT__'; // dsh web 首页内嵌的启动标记，用于识别 3080 上是否是 dsh web
const MAX_BODY_BYTES = 8192; // 首页抓取上限（特征串校验用）
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');
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
const GITHUB_REPO = 'phenix-base/deepseek-desktop';
const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const WATCHDOG_INTERVAL = 30 * 1000; // dsh web 健康检查间隔
const ACTIVITY_INTERVAL = 15 * 1000; // 任务活动探测间隔
const START_HIDDEN = process.argv.includes('--hidden'); // 静默启动：只驻托盘不弹窗（配合开机自启）

// ---- 全局状态 ----
let taskRunning = null; // 是否有任务进行中（null=尚未探测过）
let serverReachable = null; // dsh web 可达性（null=尚未探测过）
let appConnected = false; // 主窗口已进入主界面（看门狗/活动探测的前提）
let reconnecting = false; // 看门狗自动重连进行中
let hotkeyRegistered = false; // 全局快捷键是否已注册
let lastBalanceLow = null; // 上次余额是否不足（通知去重用）
let lastStatusAbnormal = null; // 上次服务状态是否异常（通知去重用）
let updateInfo = null; // 桌面端新版本信息 { latest, url }
let lastRendererCrash = 0; // 上次渲染进程崩溃时间
let rendererCrashCount = 0; // 短时间内的连续崩溃次数

// ---- M2：宿主桥（dsh-desktop-bridge）状态 ----
let bridge = null; // BridgeClient 实例（惰性创建）
let bridgeActive = false; // 最近一次桥探测成功
let bridgeState = null; // 最近一次 /state 快照
let bridgeEventsAlive = false; // SSE 事件流已连接

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

// 主进程日志同时写入 userData/logs/main.log（打包后无终端可看，便于排查问题）；
// 文件超过 5MB 时清空重写，避免无限增长
function initLogger() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.writeFileSync(LOG_FILE, '');
    } catch (_) {
      /* 文件不存在则忽略 */
    }
    const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const format = (args) =>
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const wrap = (orig, level) => (...args) => {
      orig.apply(console, args);
      try {
        stream.write(`[${new Date().toISOString()}] [${level}] ${format(args)}\n`);
      } catch (_) {
        /* 写入失败忽略 */
      }
    };
    console.log = wrap(console.log, 'info');
    console.warn = wrap(console.warn, 'warn');
    console.error = wrap(console.error, 'error');
  } catch (_) {
    /* 日志初始化失败不影响主流程 */
  }
}
initLogger();

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
    globalShortcut.unregisterAll();
    if (serverProc && !serverProc.killed) serverProc.kill();
  });
  // URL Scheme：deepseek-harness://<path> → 唤起窗口并让 dsh web 处理该路径
  // （dev 模式需显式传入可执行路径与参数）
  if (process.platform === 'darwin') {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient('deepseek-harness');
    } else {
      app.setAsDefaultProtocolClient('deepseek-harness', process.execPath, [path.resolve(__dirname)]);
    }
    app.on('open-url', (event, url) => {
      event.preventDefault();
      handleDeepLink(url);
    });
  }
  app.whenReady().then(() => {
    // dev 模式（npm start）下 Dock 显示 Electron 默认图标，替换为应用图标
    if (process.platform === 'darwin' && !app.isPackaged) {
      try {
        const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
        if (!icon.isEmpty()) app.dock.setIcon(icon);
      } catch (_) {
        /* 图标缺失则忽略 */
      }
    }
    if (!START_HIDDEN) createWindow(); // --hidden：只驻托盘（配合开机自启）
    createTray();
    startTrayInfoRefresh(); // 定时刷新托盘展示的余额与服务状态
    initBridge(); // M2：桥接初始化（失败自动回退传统探测模式）
    registerHotkey(); // 全局快捷键唤起窗口
    startWatchdog(); // dsh web 看门狗：挂掉自动重启
    startActivityPolling(); // 任务活动探测（任务完成通知）
    checkAppUpdate(); // 桌面端新版本检查
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
    // M2：桥优先——/state 200 即证明 3080 上是 dsh web；桥不可用回退特征串
    const probe = await probeDshWeb(Math.max(deadline - Date.now(), 1500), interval);
    if (probe && probe.type === 'dsh') return true;
    if (probe && probe.type === 'other') {
      throw new Error(`端口 ${PORT} 被其他程序占用，请释放后重试`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`http://${HOST}:${PORT}/ 在 ${timeout}ms 内未就绪`);
    }
  }
}

// 异步获取 dsh 版本号；未安装/超时返回 null（不阻塞主进程事件循环）
function queryDshVersion(timeout = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const proc = spawn('dsh', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => {
      out += c;
    });
    proc.stderr.on('data', (c) => {
      out += c;
    });
    proc.once('error', () => done(null));
    proc.once('close', (code) => done(code === 0 ? normalizeVersion(out) || null : null));
    setTimeout(() => {
      try {
        proc.kill();
      } catch (_) {
        /* 已退出则忽略 */
      }
      done(null);
    }, timeout);
  });
}

// 检测 dsh CLI 是否已安装可用
async function isDshInstalled() {
  return (await queryDshVersion()) !== null;
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
    proc.once('close', async (code) => {
      if (code === 0 && (await isDshInstalled())) {
        sendStatus(win, 'deepseek-harness 安装完成');
        return done(true);
      }
      done(false, `deepseek-harness 安装失败（npm 退出码 ${code}），请手动执行：npm install -g ${DSH_PACKAGE}`);
    });
  });
}

// 确认 dsh 可用；未安装则弹窗询问用户是否安装。返回 'ok' | 'quit' | 'failed'
async function ensureDsh(win) {
  if (await isDshInstalled()) return 'ok';
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
  // --no-open：桌面壳自身加载页面，禁止 dsh 再拉起系统浏览器
  const proc = spawn('dsh', ['web', '--no-open'], { detached: false, stdio: 'inherit' });
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
  const probe = await probeDshWeb(1500);
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

// ---- 系统通知（macOS 原生） ----
function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (_) {
    /* 通知失败不影响主流程 */
  }
}

// ---- M2 桥接：宿主侧一手数据/事件，替代端口探测与 DOM 抓取 ----
// 桥可用 → 快照/事件驱动；桥不可用 → 全部回退传统探测，桥是纯增量。
// M3：结束原因文案映射（task.finished 的 reason 值来自宿主 TurnEndReason）
const TURN_REASON_ZH = {
  success: '已完成',
  cancelled: '已取消',
  canceled: '已取消',
  error: '异常结束',
  failed: '失败',
  aborted: '已中断',
  'max-tokens': '已达上下文上限',
};

function getBridge() {
  if (!bridge) bridge = new BridgeClient({ log: (m) => console.log('[bridge]', m) });
  return bridge;
}

// M3：把 /state 快照应用到版本/余额/任务，任一变化即重建托盘菜单（实时展示）
function applyBridgeSnapshot(state) {
  if (!state) return;
  let changed = false;
  if (state.dshVersion) {
    const v = normalizeVersion(state.dshVersion);
    if (v && v !== dshLocalVersion) {
      dshLocalVersion = v;
      changed = true;
    }
  }
  if (state.balance) {
    const t = state.balance.text;
    const v = state.balance.valueCny;
    if (t && t !== balanceText) {
      balanceText = t;
      changed = true;
    }
    if (v !== undefined && v !== null && v !== balanceValue) {
      balanceValue = v;
      changed = true;
    }
    applyBalanceWarning?.(); // 快照余额可能触发/清除窗口预警
  }
  if (typeof state.runningTasks === 'number') {
    const running = state.runningTasks > 0;
    if (running !== taskRunning) changed = true;
    setTaskRunning(running); // 内部负责 0→1 反转时的「任务完成」通知去重
  }
  if (changed) buildTrayMenu(); // 托盘「版本/余额/任务」行实时刷新
}

// 桥优先探测：桥 /state 成功 → { type:'dsh', state }；失败 → 回退 waitForServer
async function probeDshWeb(timeout = 3000, interval = 500) {
  if (bridgeActive) {
    const state = await getBridge().probeState(Math.max(timeout / 2, 1500));
    if (state) {
      bridgeState = state;
      applyBridgeSnapshot(state);
      return { type: 'dsh', state };
    }
  }
  const probe = await waitForServer(PORT, HOST, timeout, interval);
  return probe; // { type:'dsh'|'other' } 或 null
}

// 桥事件路由：任务/会话/余额低 事件 → 通知 + 状态
function handleBridgeEvent(event, data) {
  try {
    switch (event) {
      case 'hello':
        bridgeState = data;
        applyBridgeSnapshot(data);
        break;
      case 'task.started':
        console.log('[bridge] 任务开始', data && data.sessionId);
        setTaskRunning(true);
        break;
      case 'task.finished': {
        // M3：结束原因映射为可读文案；SSE 实时 → 通知延迟从 ≤15s（轮询）降到 ~1s
        console.log('[bridge] 任务结束', data && data.sessionId, data && data.reason);
        const reason = data && data.reason;
        const zh = TURN_REASON_ZH[reason] || '';
        const abnormal = !!reason && reason !== 'success';
        notify(abnormal ? '任务结束（异常）' : '任务完成', zh ? `会话任务${zh}` : '进行中的会话已结束');
        taskRunning = false; // 先置位：下面 setTaskRunning 发现无变化，避免重复通知
        setTaskRunning(false);
        break;
      }
      case 'session.started':
      case 'session.ended':
        // 会话生命周期：暂只记录（后续托盘可展示活跃会话）
        console.log('[bridge]', event, data && data.sessionId);
        break;
      case 'balance.low':
        notify('账户余额不足', `剩余 ¥${Number(data && data.valueCny).toFixed(2)}，请及时充值`);
        break;
      case 'heartbeat':
        break;
      default:
        console.log('[bridge] 未识别事件', event, data);
    }
  } catch (_) {
    /* 事件处理失败不影响桥 */
  }
}

// 安装引导（M4）：开发树存在桥包 → file: 本地源即装即验；否则用 npm 包名（发布后）
function installBridgePlugin() {
  const target = fs.existsSync(path.join(__dirname, 'bridge', 'package.json'))
    ? path.join(__dirname, 'bridge') // 开发态：本地 file: 源（不等 npm 发布）
    : 'dsh-desktop-bridge'; // 发布态：npm 源
  console.log(`[main] 安装桥接插件：dsh plugin --profile web add ${target}`);
  notify('安装桥接插件', '正在执行 dsh plugin add…（需 dsh CLI 可用）');
  const child = spawn('dsh', ['plugin', '--profile', 'web', 'add', target], {
    stdio: 'ignore',
  });
  child.on('error', (err) => {
    console.error('[main] 桥安装失败（spawn）:', err.message);
    notify('桥接插件安装失败', `无法启动 dsh CLI：${err.message.slice(0, 40)}`);
  });
  child.on('exit', (code) => {
    if (code === 0) {
      notify('桥接插件已安装', '请完全退出并重新打开本应用，桥即生效（任务通知转实时）');
    } else {
      notify('桥接插件安装失败', `dsh 退出码 ${code}，日志见主日志文件`);
    }
  });
}

// 初始化桥：探测 /state，成功则订阅 SSE 事件；失败静默回退（不打断启动）
async function initBridge() {
  const state = await getBridge().probeState(3000);
  if (!state) {
    console.log('[bridge] 未发现 dsh-desktop-bridge（未装插件或未重启生效），使用传统探测模式');
    return;
  }
  bridgeActive = true;
  bridgeState = state;
  applyBridgeSnapshot(state);
  console.log(`[bridge] 已接通：桥 ${state.bridgeVersion} · dsh ${state.dshVersion} · 任务 ${state.runningTasks}`);
  getBridge().connectEvents({
    onEvent: (event, data) => handleBridgeEvent(event, data),
    // M3：状态翻转驱动模式切换——SSE 通→事件实时；断→15s 轮询快照兜底
    onStateChange: (alive) => {
      bridgeEventsAlive = alive;
      console.log(alive ? '[bridge] SSE 已连通，任务状态实时事件驱动' : '[bridge] SSE 断开，活动探测回退快照轮询');
    },
  });
  bridgeEventsAlive = true;
}

// ---- URL Scheme 深链：deepseek-harness://session/xxx → 主界面定位 ----
function handleDeepLink(url) {
  showMainWindow();
  const p = url.replace(/^deepseek-harness:\/\//, '/').replace(/\/+/g, '/');
  const win = mainWindow;
  if (p.length > 1 && win && !win.isDestroyed() && win.webContents.getURL().startsWith(APP_URL)) {
    win.loadURL(APP_URL.replace(/\/$/, '') + p).catch(() => {});
  }
}

// ---- 全局快捷键：⌃⇧D（Ctrl+Shift+D）唤起/隐藏主窗口 ----
function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

function registerHotkey() {
  if (hotkeyRegistered) return;
  hotkeyRegistered = globalShortcut.register('CmdOrCtrl+Shift+D', toggleMainWindow);
  if (!hotkeyRegistered) console.warn('[main] 全局快捷键注册失败（可能被其他应用占用）');
}

function toggleHotkey() {
  if (hotkeyRegistered) {
    globalShortcut.unregisterAll();
    hotkeyRegistered = false;
  } else {
    registerHotkey();
  }
  buildTrayMenu();
}

// ---- 托盘「新会话」：唤出窗口并点击新会话按钮 ----
function newSession() {
  showMainWindow();
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.getURL().startsWith(APP_URL)) return; // 还在加载页/错误页
  win.webContents
    .executeJavaScript(`(() => {
      const btn = document.querySelector('button.hHd-Xa_newSession')
        || Array.from(document.querySelectorAll('button')).find((b) => /新会话|New Session/i.test(b.textContent || ''));
      if (btn) btn.click();
    })()`)
    .catch(() => {});
}

// ---- dsh web 看门狗：进入主界面后定期健康检查，挂了自动重启并恢复窗口 ----
function startWatchdog() {
  setInterval(async () => {
    if (!appConnected || isQuitting || dshTerminated || reconnecting) return;
    const probe = await probeDshWeb(3000);
    const reachable = !!probe && probe.type === 'dsh';
    if (serverReachable === true && !reachable) {
      console.warn('[main] dsh web 失去响应，尝试自动重启');
      notify('dsh web 服务中断', '正在自动重启…');
    }
    serverReachable = reachable;
    if (reachable) return;

    reconnecting = true;
    try {
      if (serverProc && !serverProc.killed) {
        try {
          serverProc.kill();
        } catch (_) {
          /* 已退出则忽略 */
        }
        serverProc = null;
      }
      if (!mainWindow || mainWindow.isDestroyed()) {
        showMainWindow(); // createWindow 自带「加载页 → 连接服务」流程
        return;
      }
      loadLoadingPage(mainWindow, '服务中断，正在重启 dsh web…');
      const ready = await connectToServer(mainWindow);
      if (ready && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(APP_URL);
        serverReachable = true;
        console.log('[main] dsh web 已自动恢复');
        notify('dsh web 已恢复', '服务已自动重启并重新连接');
      }
    } finally {
      reconnecting = false;
    }
  }, WATCHDOG_INTERVAL);
}

// ---- 任务活动探测：读取主窗口侧栏「进行中」标识（启发式），任务结束时弹系统通知 ----
function startActivityPolling() {
  setInterval(async () => {
    if (!appConnected || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.webContents.getURL().startsWith(APP_URL)) return;
    if (bridgeActive) {
      // M2 桥模式：/state 的 runningTasks 是宿主一手判定，不再抓 DOM
      const state = await getBridge().probeState(1500);
      if (state) {
        bridgeState = state;
        applyBridgeSnapshot(state);
        return;
      }
      // 桥临时不可达 → 落回 DOM 启发式（传统模式）
    }
    try {
      const running = await mainWindow.webContents.executeJavaScript(
        `document.body.innerText.includes('进行中') || document.body.innerText.includes('In progress')`
      );
      setTaskRunning(!!running);
    } catch (_) {
      /* 页面导航中，忽略本轮 */
    }
  }, ACTIVITY_INTERVAL);
}

function setTaskRunning(v) {
  if (taskRunning === null) {
    taskRunning = v;
    return;
  }
  if (v === taskRunning) return;
  taskRunning = v;
  if (!v) notify('任务完成', '进行中的会话已结束');
}

// ---- 桌面端更新检查（未签名包无法用 electron-updater 自动更新：检测新版本 + 跳转下载页）----
async function checkAppUpdate() {
  try {
    const res = await net.fetch(GITHUB_LATEST_RELEASE_API, {
      headers: { 'User-Agent': 'deepseek-desktop' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const latest = normalizeVersion(data.tag_name || '');
    if (latest && latest !== normalizeVersion(app.getVersion())) {
      updateInfo = { latest, url: data.html_url || GITHUB_RELEASES_URL };
      console.log(`[main] 桌面端新版本：v${latest}`);
      notify('桌面端新版本', `v${latest} 已发布，可在托盘菜单中下载`);
      buildTrayMenu();
    }
  } catch (_) {
    /* 网络失败静默 */
  }
}

async function manualCheckUpdate() {
  await checkAppUpdate();
  if (updateInfo) {
    shell.openExternal(updateInfo.url);
  } else {
    dialog.showMessageBox({
      type: 'info',
      message: '已是最新版本',
      detail: `当前版本 v${app.getVersion()}`,
    });
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
    show: false, // ready-to-show 后再显示，避免先闪默认白屏
    backgroundColor: '#050914', // 与加载页背景一致
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // 渲染进程沙箱化（preload 仅用 contextBridge/ipcRenderer，兼容）
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());

  // 外链一律交给系统浏览器打开，不在应用内弹新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // 渲染进程发起的导航只允许停留在本机 dsh web（loadFile/loadURL 属编程式加载，不受影响）
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL)) e.preventDefault();
  });

  win.on('close', (e) => {
    saveWindowState(win);
    if (!isQuitting) {
      e.preventDefault(); // 关闭仅隐藏到托盘
      if (win.isFullScreen()) {
        // macOS 全屏状态下直接 hide 会留下一块黑屏的全屏 Space，必须先退出全屏再隐藏
        win.once('leave-full-screen', () => {
          if (!win.isDestroyed()) win.hide();
        });
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    }
  });
  // 移动/缩放时也防抖保存窗口状态，崩溃/强杀不丢位置
  let stateTimer = null;
  const debouncedSaveState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => saveWindowState(win), 500);
  };
  win.on('resize', debouncedSaveState);
  win.on('move', debouncedSaveState);

  win.webContents.on('did-finish-load', () => {
    console.log('[main] loaded:', win.webContents.getURL());
    applyBalanceWarning(); // 页面刷新/导航后重新注入余额预警横幅
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[main] load failed:', code, desc);
    // -3 为 ERR_ABORTED（新加载打断旧加载），属正常流程；真正的失败也要把窗口显示出来
    if (code !== -3 && !win.isDestroyed() && !win.isVisible()) win.show();
  });
  // 渲染进程崩溃自愈：自动重载；10s 内连续崩溃 3 次以上则改显示错误页，避免崩溃循环
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render process gone:', details.reason);
    const now = Date.now();
    rendererCrashCount = now - lastRendererCrash < 10000 ? rendererCrashCount + 1 : 1;
    lastRendererCrash = now;
    if (win.isDestroyed()) return;
    if (rendererCrashCount <= 3) {
      console.log('[main] 渲染进程崩溃，自动重载');
      win.reload();
    } else {
      showError(win, '页面多次崩溃，请尝试重启应用');
    }
  });

  // 品牌加载页至少展示 1.2s（logo 淡入动画完整呈现）；
  // 慢路径（需等待服务启动）下该计时与服务等待重叠，不额外拖慢启动
  const minLoadingShow = new Promise((r) => setTimeout(r, 1200));
  loadLoadingPage(win)
    .then(async () => {
      const ready = await connectToServer(win);
      await minLoadingShow;
      if (ready && !win.isDestroyed()) {
        console.log('[main] server ready, loading', APP_URL);
        win.loadURL(APP_URL);
        appConnected = true; // 已进入主界面：看门狗/任务探测开始生效
        serverReachable = true;
        checkDshVersion(); // 异步版本检查，不阻塞启动
      }
    })
    .catch((err) => {
      console.error('[main] loading page error:', err);
      if (!win.isDestroyed() && !win.isVisible()) win.show(); // 加载页失败也要把窗口显示出来
    });

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
  if (bridgeActive && bridgeState && bridgeState.dshVersion) {
    // M2 桥模式：本地版本走宿主一手数据；最新版仍查 npm（升级入口需要）
    dshLocalVersion = normalizeVersion(bridgeState.dshVersion);
    dshLatestVersion = await npmViewLatestVersion();
    console.log(`[main] dsh 版本（桥）：本地 ${dshLocalVersion}，最新 ${dshLatestVersion || '未知'}`);
    buildTrayMenu();
    return;
  }
  const local = await queryDshVersion();
  if (!local) return; // dsh 不可用，跳过
  dshLocalVersion = local;
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
  if (bridgeActive && bridgeState && bridgeState.balance) {
    // M2 桥模式：宿主侧已聚合（credentials + 官方接口 + 缓存），直接取快照
    const b = bridgeState.balance;
    balanceText = b.text || balanceText;
    balanceValue = b.valueCny !== undefined && b.valueCny !== null ? b.valueCny : balanceValue;
    console.log('[main] 余额（桥）：', balanceText);
  } else {
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
  }

  // 余额不足的状态变化联动：系统通知 + Dock 弹跳（仅"正常→不足"切换时触发一次）
  const low = balanceValue !== null && balanceValue < BALANCE_WARN_THRESHOLD;
  if (low && lastBalanceLow === false) {
    notify('账户余额不足', `剩余 ¥${balanceValue.toFixed(2)}，请及时充值`);
    if (process.platform === 'darwin') app.dock.bounce('informational');
  }
  lastBalanceLow = low;
  // Dock 图标红色角标 + 菜单栏图标旁直接显示余额（macOS）
  if (process.platform === 'darwin') {
    app.dock.setBadge(low ? '!' : '');
    if (tray) {
      const cny = (balanceText || '').match(/([\d.]+)\s*CNY/);
      tray.setTitle(cny ? (low ? `🔴¥${cny[1]}` : `¥${cny[1]}`) : '');
    }
  }

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
  // 服务异常的状态变化联动：系统通知（仅"正常→异常"切换时触发一次）
  const abnormal = !!statusText && statusText !== '全部正常' && statusText !== '获取失败';
  if (abnormal && lastStatusAbnormal === false) {
    notify('DeepSeek 服务异常', statusText);
  }
  lastStatusAbnormal = abnormal;
  buildTrayMenu();
}

// 定时刷新托盘展示的余额与服务状态。
// M3：桥模式下余额改由 SSE 事件 + 15s 快照实时驱动（applyBridgeSnapshot 重建菜单），
// 不再走 5 分钟轮询；服务状态页（status.deepseek.com）与桥无关，两种模式都保留。
function startTrayInfoRefresh() {
  const refresh = () => {
    if (!bridgeActive) updateBalance(); // 非桥才轮询余额（credentials + 官方接口）
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
    { label: '新会话', click: newSession },
    { type: 'separator' },
    // M3：任务状态行——桥模式下由 SSE 事件 + 快照实时更新（以前靠 15s DOM 猜测）
    { label: taskRunning ? '任务：进行中' : '任务：空闲', enabled: false },
    // M4：桥状态/安装引导——桥激活显示状态；未激活提供一键安装（实时任务通知的开关）
    ...(bridgeActive
      ? [{ label: bridgeEventsAlive ? '桥接：实时模式已启用' : '桥接：轮询兜底（SSE 断）', enabled: false }]
      : [{ label: '安装桥接插件（实时任务通知）', click: installBridgePlugin }]),
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
  // 桌面端自身版本：有新版本时提供下载入口，否则点击手动检查
  if (updateInfo) {
    items.push({
      label: `桌面端新版本 v${updateInfo.latest}（点击下载）`,
      click: () => shell.openExternal(updateInfo.url),
    });
  } else {
    items.push({
      label: `桌面端版本：v${app.getVersion()}（点击检查更新）`,
      click: manualCheckUpdate,
    });
  }
  items.push(
    { type: 'separator' },
    {
      label: '全局快捷键（⌃⇧D 唤起窗口）',
      type: 'checkbox',
      checked: hotkeyRegistered,
      click: toggleHotkey,
    },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    }
  );
  items.push(
    { type: 'separator' },
    { label: '打开日志目录', click: () => shell.openPath(LOG_DIR) },
    { label: '退出', click: quitApp }
  );
  trayMenu = Menu.buildFromTemplate(items);
  tray.setContextMenu(trayMenu);
}

// 托盘「退出」：置标志后真正退出
function quitApp() {
  isQuitting = true;
  app.quit();
}
