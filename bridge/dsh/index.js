/**
 * dsh-desktop-bridge — deepseek-desktop 外壳的宿主侧桥。
 *
 * 在 dsh webServer 上挂载 loopback-only、Bearer token 鉴权的两个端点：
 *
 *   GET /api/dsh-desktop-bridge/state   → 版本 / 会话 / 运行中任务 / 余额快照
 *   GET /api/dsh-desktop-bridge/events  → SSE：task.started / task.finished /
 *                                         session.started / session.ended /
 *                                         balance.low / heartbeat
 *
 * 让本地 Electron 壳用宿主一手数据替换端口嗅探、DOM 抓取与轮询猜测。
 * 壳没装或桥缺失时，壳自行回退到探测模式——桥是纯增量，不是硬依赖。
 *
 * 与 treg-dsh 相同的两个硬约束：
 * - 纯 ESM、无构建步骤（本地 file: / git 安装直接可用）；
 * - 不依赖任何 @deepseek-ai/* 包——webServer/systemPrompt 的契约形状直接
 *   在本文件实现（参照 dsh-desktop-launcher 的编译产物与 dsh-host-webserver
 *   的类型定义）。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'desktop-bridge'

/** webServer 挂路由、systemPrompt 发公告；sessions 用 ctx.get 软探测。 */
export const inject = ['webServer', 'systemPrompt']

export const BRIDGE_VERSION = '0.1.0'
const API_PREFIX = '/api/dsh-desktop-bridge'
const SECTION_ORDER = 211 // desktop-launcher 用 210；同属插件公告带

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const TOKEN_FILE = join(DSH_HOME, '.desktop-bridge-token')
const CREDENTIALS_FILE = join(DSH_HOME, '.credentials.yaml')

const BALANCE_CACHE_MS = 5 * 60 * 1000
const BALANCE_WARN_CNY = 10
const HEARTBEAT_MS = 25 * 1000

/** 重复挂载守卫（热重载/二次组合时避免重复注册同名路由）。 */
const MOUNT_KEY = Symbol.for('dsh-desktop-bridge.mounted')

/** Model 侧公告：桥的存在、端点、token 位置与安全边界。 */
const GUIDANCE =
  '本机已安装 dsh-desktop-bridge 插件（deepseek-desktop 桌面壳桥接）：在 loopback 上暴露 ' +
  'GET /api/dsh-desktop-bridge/state（宿主版本/会话/运行中任务/余额快照）与 ' +
  'GET /api/dsh-desktop-bridge/events（SSE 任务事件流）。两端点仅监听本机回环，' +
  '需 Bearer token 鉴权，token 存于 ~/.dsh/.desktop-bridge-token（0600）。' +
  '这两个端点是给本机 Electron 外壳用的只读接口：请不要代用户读取、外发或修改 token，' +
  '也不要把这些端点暴露给非本机调用。'

// ── token ────────────────────────────────────────────────────────────────

/** 读取或生成桥 token（0600）。同步实现，保持 apply 同步。 */
function ensureToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    /* 不存在则生成 */
  }
  const token = randomBytes(24).toString('base64url')
  fs.mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  try { fs.chmodSync(TOKEN_FILE, 0o600) } catch { /* Windows 无 chmod 语义 */ }
  return token
}

/** 常量时间比较（先 hash 消除长度侧信道）。 */
function tokenOk(presented, token) {
  if (typeof presented !== 'string' || presented.length === 0) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

// ── 请求防护 ─────────────────────────────────────────────────────────────

/** loopback 栅栏：socket 地址与 Host 头都必须是回环（参照 dsh-desktop-launcher）。 */
function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress
  if (!(addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1')) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
}

function authorized(req, token) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  return tokenOk(header.slice(7).trim(), token)
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

// ── dsh 版本（从宿主入口向上找 package.json，不依赖模块解析路径）──────────

function resolveDshVersion() {
  try {
    let entry = process.argv[1]
    if (!entry) return null
    try { entry = fs.realpathSync(entry) } catch { /* 用原路径 */ }
    let dir = dirname(entry)
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(fs.readFileSync(join(dir, 'package.json'), 'utf8'))
        if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
      } catch { /* 继续向上 */ }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* fall through */ }
  return null
}

// ── 余额（逻辑移植自外壳 main.js，宿主侧直读 credentials + 官方接口）──────

function readApiKey() {
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8')
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return m[1]
  } catch { /* 走环境变量 */ }
  return process.env.DEEPSEEK_API_KEY || null
}

function fetchBalance(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'api.deepseek.com',
        path: '/user/balance',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`API ${res.statusCode}`))
          try { resolve(JSON.parse(body)) } catch { reject(new Error('bad json')) }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('timeout')))
  })
}

// ── 会话跟踪（turn/start ↔ turn/end 即任务边界）──────────────────────────

function sessionIdOf(session) {
  const id = session && session.id
  return typeof id === 'string' && id ? id : null
}

function sessionTitleOf(session) {
  const t = session && (session.title ?? (session.meta && session.meta.title))
  return typeof t === 'string' && t ? t : null
}

// ── 插件主体 ─────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  if (globalThis[MOUNT_KEY]) return // 已挂载：第二次 apply 是重组合，no-op
  globalThis[MOUNT_KEY] = true

  const token = ensureToken()
  const dshVersion = resolveDshVersion()
  const disposers = []
  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set()
  /** @type {Map<string, { id: string, title: string|null, openTurns: number, lastEventAt: number, lastEventType: string|null }>} */
  const sessions = new Map()
  let balanceCache = null // { text, valueCny, at } | null
  let balanceLow = null   // 上次是否低于阈值（balance.low 去重）

  const sendEvent = (res, event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* 客户端已断开 */ }
  }
  const broadcast = (event, data) => { for (const c of sseClients) sendEvent(c, event, data) }

  function snapshot() {
    const list = [...sessions.values()].map((s) => ({
      id: s.id,
      title: s.title,
      status: s.openTurns > 0 ? 'running' : 'idle',
      lastEventAt: s.lastEventAt,
    }))
    return {
      ok: true,
      bridgeVersion: BRIDGE_VERSION,
      dshVersion,
      sessions: list,
      runningTasks: list.filter((s) => s.status === 'running').length,
      balance: balanceCache,
    }
  }

  async function refreshBalance() {
    const key = readApiKey()
    if (!key) { balanceCache = null; return }
    try {
      const data = await fetchBalance(key)
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
      const cny = infos.find((i) => i && i.currency === 'CNY')
      balanceCache = {
        text: infos.map((i) => `${i.total_balance} ${i.currency}`).join(' / ') || '未知',
        valueCny: cny ? parseFloat(cny.total_balance) : null,
        at: Date.now(),
      }
      const low = balanceCache.valueCny !== null && balanceCache.valueCny < BALANCE_WARN_CNY
      if (low && balanceLow !== true) {
        broadcast('balance.low', { valueCny: balanceCache.valueCny })
      }
      balanceLow = low
    } catch { /* 查询失败保留旧缓存 */ }
  }

  // 启动即拉一次余额（不阻塞挂载）；/state 命中过期缓存时异步刷新
  refreshBalance().catch(() => {})

  // ── 路由 ─────────────────────────────────────────────────────────────

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback-only' })
      if (!authorized(req, token)) return writeJson(res, 401, { ok: false, error: 'unauthorized' })
      if ((req.method || 'GET') !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' })
      if (!balanceCache || Date.now() - balanceCache.at > BALANCE_CACHE_MS) {
        refreshBalance().catch(() => {})
      }
      writeJson(res, 200, snapshot())
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/events`,
    handler: (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback-only' })
      if (!authorized(req, token)) return writeJson(res, 401, { ok: false, error: 'unauthorized' })
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'referrer-policy': 'no-referrer',
      })
      sseClients.add(res)
      sendEvent(res, 'hello', snapshot())
      const hb = setInterval(() => sendEvent(res, 'heartbeat', { at: Date.now() }), HEARTBEAT_MS)
      req.on('close', () => { clearInterval(hb); sseClients.delete(res) })
    },
  }))

  // ── 会话事件 → 任务状态 ─────────────────────────────────────────────

  const onCreated = (session) => {
    const id = sessionIdOf(session)
    if (!id || sessions.has(id)) return
    const title = sessionTitleOf(session)
    sessions.set(id, { id, title, openTurns: 0, lastEventAt: Date.now(), lastEventType: null })
    broadcast('session.started', { sessionId: id, title })
  }

  const onDisposed = (session) => {
    const id = sessionIdOf(session)
    if (!id || !sessions.delete(id)) return
    broadcast('session.ended', { sessionId: id })
  }

  const onEvent = (session, event) => {
    const id = sessionIdOf(session)
    const type = event && typeof event.type === 'string' ? event.type : null
    if (!id || !type) return
    if (!sessions.has(id)) onCreated(session)
    const s = sessions.get(id)
    if (!s) return
    s.lastEventAt = Date.now()
    s.lastEventType = type
    if (type === 'session/title') {
      const t = event.title ?? event.text ?? event.value
      if (typeof t === 'string' && t) s.title = t
      return
    }
    if (type === 'turn/start') {
      s.openTurns++
      if (s.openTurns === 1) broadcast('task.started', { sessionId: id, title: s.title })
    } else if (type === 'turn/end') {
      s.openTurns = Math.max(0, s.openTurns - 1)
      if (s.openTurns === 0) {
        const reason = typeof event.reason === 'string' ? event.reason : null
        broadcast('task.finished', { sessionId: id, title: s.title, reason })
      }
    }
  }

  // 事件订阅失败（老版本 dsh 无该事件名）不致命：state 仍可用，只是没有实时事件
  try { disposers.push(ctx.on('session/created', onCreated)) } catch { /* 老版本无此事件 */ }
  try { disposers.push(ctx.on('session/disposed', onDisposed)) } catch { /* 同上 */ }
  try { disposers.push(ctx.on('session/event', onEvent)) } catch { /* 同上 */ }

  // ── systemPrompt 公告 ────────────────────────────────────────────────

  if ((config.announceToAgent ?? true) !== false) {
    try {
      disposers.push(ctx.systemPrompt.section({ name: 'plugin:dsh-desktop-bridge', order: SECTION_ORDER, text: GUIDANCE }))
    } catch { /* 公告失败不影响桥本身 */ }
  }

  ctx.on('dispose', () => {
    globalThis[MOUNT_KEY] = false
    for (const res of sseClients) { try { res.end() } catch { /* 忽略 */ } }
    sseClients.clear()
    for (const d of disposers) { try { d() } catch { /* 忽略 */ } }
  })
}
