'use strict';

/**
 * BridgeClient — deepseek-desktop 的桥接客户端（M2）。
 *
 * 与 dsh-desktop-bridge 插件（宿主侧）对接：
 *   GET /api/dsh-desktop-bridge/state   → 宿主状态快照（版本/会话/任务/余额）
 *   GET /api/dsh-desktop-bridge/events  → SSE 事件流（task.started/finished 等）
 *
 * 设计原则：桥是纯增量。任何失败（token 缺失/401/超时/断连）都返回 null
 * 或触发重连，绝不抛错——调用方（main.js）无缝回退到传统探测模式。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 允许环境变量覆盖（隔离测试 / 未来多实例）：DSH_DESKTOP_BRIDGE_PORT / _TOKEN_FILE
const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = Number(process.env.DSH_DESKTOP_BRIDGE_PORT || 3080);
const BRIDGE_PATH = '/api/dsh-desktop-bridge';
const TOKEN_FILE =
  process.env.DSH_DESKTOP_BRIDGE_TOKEN_FILE ||
  path.join(os.homedir(), '.dsh', '.desktop-bridge-token');

class BridgeClient {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.token = null;
    this.active = false; // 最近一次探测成功（桥可用）
    this.state = null; // 最近一次 /state 快照
    this.eventsConnected = false;
    this._sseReq = null;
    this._retryTimer = null;
    this._onEvent = null;
    this._disposed = false;
  }

  /** 读取桥 token（0600 文件，插件自动生成；与本插件同属本机用户）。 */
  readToken() {
    if (this.token) return this.token;
    try {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t.length >= 16) this.token = t;
    } catch (_) {
      /* token 缺失 → 桥未安装/未重启，回退探测模式 */
    }
    return this.token;
  }

  /**
   * GET /state。成功（200 + ok:true）→ 记录 active 并返回快照；
   * 任何失败 → 返回 null（调用方回退传统逻辑）。
   */
  probeState(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const token = this.readToken();
      if (!token) return resolve(null);
      const req = http.get(
        {
          host: BRIDGE_HOST,
          port: BRIDGE_PORT,
          path: `${BRIDGE_PATH}/state`,
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => {
            if (res.statusCode !== 200) return resolve(null);
            try {
              const data = JSON.parse(body);
              if (!data || data.ok !== true) return resolve(null);
              this.active = true;
              this.state = data;
              resolve(data);
            } catch (_) {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs, () => req.destroy());
    });
  }

  /**
   * 订阅 SSE /events。断连后指数退避重连（3s → 30s）。
   * @param onEvent (event, data) 事件回调
   */
  connectEvents({ onEvent, minInterval = 3000, maxInterval = 30000 } = {}) {
    this._onEvent = onEvent;
    this._connectEventsLoop(minInterval, maxInterval);
  }

  _connectEventsLoop(min, max) {
    if (this._disposed) return;
    const token = this.readToken();
    if (!token) return this._retry(Math.min(min, max), min, max);
    const req = http.get(
      {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        path: `${BRIDGE_PATH}/events`,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        if (res.statusCode !== 200) {
          if (this._onEvent) this.log(`events 拒绝（${res.statusCode}），稍后重连`);
          res.resume();
          return this._retry(min * 2, min, max);
        }
        this.eventsConnected = true;
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          // SSE 事件以空行分隔；一次 chunk 可能含多个事件，也可能跨 chunk
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = this._parseSse(block);
            if (ev && this._onEvent) {
              try {
                this._onEvent(ev.event, ev.data);
              } catch (_) {
                /* 事件回调内部错误不影响事件流 */
              }
            }
          }
        });
        res.on('end', () => {
          this.eventsConnected = false;
          if (this._onEvent) this.log('events 流断开，重连');
          this._retry(Math.max(min * 2, 5000), min, max);
        });
        res.on('error', () => {
          this.eventsConnected = false;
          this._retry(Math.max(min * 2, 5000), min, max);
        });
      },
    );
    req.on('error', () => {
      this.eventsConnected = false;
      this._retry(Math.max(min * 2, 5000), min, max);
    });
    req.setTimeout(60000, () => {
      try {
        req.destroy();
      } catch (_) {
        /* 已结束则忽略 */
      }
    });
    this._sseReq = req;
  }

  _retry(interval, min, max) {
    if (this._disposed) return;
    const delay = Math.min(Math.max(interval, min), max);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._connectEventsLoop(delay, min, max), delay);
  }

  /** 解析一块 SSE 文本 → { event, data }；data 尽力 JSON.parse。 */
  _parseSse(block) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
    }
    if (!data) return null;
    try {
      return { event, data: JSON.parse(data) };
    } catch (_) {
      return { event, data };
    }
  }

  close() {
    this._disposed = true;
    if (this._sseReq) {
      try {
        this._sseReq.destroy();
      } catch (_) {
        /* 忽略 */
      }
    }
    if (this._retryTimer) clearTimeout(this._retryTimer);
  }
}

module.exports = { BridgeClient, BRIDGE_HOST, BRIDGE_PORT, BRIDGE_PATH, TOKEN_FILE };