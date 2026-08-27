'use strict';

/**
 * lock-screen — 锁屏模块。
 *
 * - 密码：scrypt + 随机盐哈希（userData/lock-screen.json，0600），不存明文；
 *   校验用 timingSafeEqual，连续失败进入指数冷却（防暴力破解）。
 * - 锁定时：主窗口隐藏（内容不可见），无边框全屏遮罩窗口要求密码解锁；解锁唯一
 *   通道是输密码（托盘菜单/快捷键只触发锁定，不提供绕过）。
 * - 首次锁定且未设密码：锁窗进入「设置密码」模式，两次输入一致后落库并保持锁定。
 * - 纯增量：未锁定时零副作用；状态变化经 onStateChange 回调联动托盘菜单重建。
 */

const path = require('path');

// electron 依赖延迟到调用处 require，避免无头环境/纯逻辑测试时顶层崩溃
function electron() {
  return require('electron');
}

const MAX_FAILS = 5; // 连续错误次数上限（达到后进入冷却）
const BASE_COOLDOWN_MS = 30 * 1000; // 首次冷却 30s，之后翻倍
const MAX_COOLDOWN_MS = 10 * 60 * 1000; // 冷却上限 10 分钟

let store = null; // { salt, hash }
let failures = 0;
let cooldownUntil = 0;
let locked = false;
let quitting = false; // before-quit 放行锁窗关闭（避免 app.quit 卡死）
let lockWindow = null;
let getMainWindow = () => null;
let onStateChange = () => {};

// ---- 密码存储 ----

function storePath() {
  return path.join(electron().app.getPath('userData'), 'lock-screen.json');
}

function loadStore() {
  try {
    const s = JSON.parse(require('fs').readFileSync(storePath(), 'utf8'));
    if (s && typeof s.salt === 'string' && typeof s.hash === 'string') store = s;
    else store = null;
  } catch (_) {
    store = null; // 未有密码文件 → 首次锁定走设置模式
  }
}

function saveStore() {
  if (!store) return;
  try {
    require('fs').writeFileSync(storePath(), JSON.stringify(store), { mode: 0o600 });
  } catch (err) {
    console.error('[lock] 密码存储失败:', err.message);
  }
}

function scryptHash(pw, saltHex) {
  const crypto = require('crypto');
  return crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32).toString('hex');
}

function checkPassword(pw) {
  if (!store) return false;
  const crypto = require('crypto');
  const given = Buffer.from(scryptHash(pw, store.salt), 'hex');
  const want = Buffer.from(store.hash, 'hex');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function setPassword(pw) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  store = { salt, hash: scryptHash(pw, salt) };
  saveStore();
}

// ---- 校验（带冷却） ----

/**
 * 提交解锁尝试。
 * @returns {ok:true} 或 {ok:false, reason:'wrong'|'cooldown', failsLeft?, remainingSec?}
 */
function submit(pw) {
  const now = Date.now();
  if (cooldownUntil > now) {
    return { ok: false, reason: 'cooldown', remainingSec: Math.ceil((cooldownUntil - now) / 1000) };
  }
  if (!checkPassword(pw)) {
    failures += 1;
    if (failures >= MAX_FAILS) {
      const span = Math.min(BASE_COOLDOWN_MS * 2 ** (failures - MAX_FAILS), MAX_COOLDOWN_MS);
      cooldownUntil = now + span;
      failures = 0; // 冷却期由 cooldownUntil 管理
      return { ok: false, reason: 'cooldown', remainingSec: Math.ceil(span / 1000) };
    }
    return { ok: false, reason: 'wrong', failsLeft: MAX_FAILS - failures };
  }
  failures = 0;
  cooldownUntil = 0;
  return { ok: true };
}

// ---- 锁窗 ----

const LOCK_HTML = () => path.join(__dirname, 'renderer', 'lock', 'lock-screen.html');
const LOCK_PRELOAD = () => path.join(__dirname, 'renderer', 'lock', 'preload.js');

function createLockWindow(parent) {
  const { BrowserWindow } = electron();
  const bounds = parent ? parent.getBounds() : { x: 0, y: 0, width: 800, height: 600 };
  const win = new BrowserWindow({
    parent: parent || undefined, // 子窗口：始终在主窗口上方，不影响其他应用
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    // 不设置 alwaysOnTop —— 子窗口天然在 parent 之上，不会盖住其他应用
    webPreferences: {
      preload: LOCK_PRELOAD(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('close', (e) => {
    if (locked && !quitting) e.preventDefault();
  });
  win.on('closed', () => {
    lockWindow = null;
  });
  win.loadFile(LOCK_HTML());
  return win;
}

// 主窗口移动/缩放时同步锁窗 bounds（保持完全覆盖）
let boundSyncListeners = null;
function bindBoundsSync(parent, child) {
  if (!parent || !child) return;
  const sync = () => {
    if (child.isDestroyed() || parent.isDestroyed()) return;
    child.setBounds(parent.getContentBounds());
  };
  parent.on('resize', sync);
  parent.on('move', sync);
  // 锁定时禁止主窗口最小化（最小化会导致锁窗露出下层内容）
  const preventMin = (e) => { if (locked) e.preventDefault(); };
  parent.on('minimize', preventMin);
  boundSyncListeners = { sync, preventMin, parent };
}
function unbindBoundsSync() {
  if (!boundSyncListeners) return;
  const { sync, preventMin, parent } = boundSyncListeners;
  try {
    parent.removeListener('resize', sync);
    parent.removeListener('move', sync);
    parent.removeListener('minimize', preventMin);
  } catch (_) {}
  boundSyncListeners = null;
}

function ensureLockWindow(parent) {
  if (!lockWindow || lockWindow.isDestroyed()) lockWindow = createLockWindow(parent);
  return lockWindow;
}

// ---- 对外接口 ----

function isLocked() {
  return locked;
}

/** 锁定：用子窗口覆盖主窗口（主窗口保持可见但被锁窗盖住，不影响其他应用）。 */
function lock() {
  if (locked) return;
  loadStore();
  const main = getMainWindow();
  locked = true;
  const win = ensureLockWindow(main);
  if (main && !main.isDestroyed()) {
    // 锁窗覆盖主窗口内容区，跟随移动/缩放
    win.setBounds(main.getContentBounds());
    bindBoundsSync(main, win);
  }
  win.showInactive(); // 不抢焦点到锁窗本身——焦点在锁窗内的输入框（页面 autofocus）
  win.focus();
  onStateChange();
}

/** 解锁（仅校验成功路径调用）：销毁锁窗 + 恢复主窗口焦点。 */
function unlock() {
  if (!locked) return;
  locked = false;
  failures = 0;
  cooldownUntil = 0;
  unbindBoundsSync();
  if (lockWindow && !lockWindow.isDestroyed()) lockWindow.destroy();
  lockWindow = null;
  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.focus();
  }
  onStateChange();
}

/** 仅测试：重置冷却与失败计数（生产不调用）。 */
function setCooldownForTest(valueMs = 0) {
  cooldownUntil = valueMs;
  failures = 0;
}

/** 托盘/快捷键入口：只触发锁定；解锁必须输密码。 */
function toggleLock() {
  if (locked) return;
  lock();
}

/**
 * 初始化：注册 IPC 与退出放行。
 * @param {object} opts { onStateChange, getMainWindow }
 */
function initLockScreen({ onStateChange: osc = () => {}, getMainWindow: gmw = () => null } = {}) {
  onStateChange = osc;
  getMainWindow = gmw;
  loadStore();

  const { app, ipcMain } = electron();
  app.on('before-quit', () => {
    quitting = true;
  });

  ipcMain.handle('lock:mode', () => ({ mode: store ? 'locked' : 'setup' }));
  ipcMain.handle('lock:submit', (_e, pw) => {
    const result = submit(pw);
    // 解锁成功：异步触发 unlock（setImmediate 让 IPC 响应先返回，再销毁发送方窗口）
    if (result.ok) setImmediate(() => unlock());
    return result;
  });
  ipcMain.handle('lock:set', (_e, pw) => {
    if (store) return { ok: false };
    const s = String(pw);
    if (s.length < 4) return { ok: false, reason: 'too-short' };
    setPassword(s);
    return { ok: true };
  });
}

module.exports = {
  initLockScreen,
  loadStore, // 供测试/重置用
  setPassword, // 供测试/重置用
  checkPassword, // 供测试/重置用
  submit, // 解锁校验（带冷却）——托盘/快捷键不调用，只有锁窗密码通道
  setCooldownForTest, // 仅测试：重置冷却状态
  lock,
  unlock,
  toggleLock,
  isLocked,
};