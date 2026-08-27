/**
 * dsh-kimi-ua — Kimi 模型请求的 User-Agent 改写宿主插件。
 *
 * 背景：dsh 的 llm 层对每个 provider 请求强制发送自己的 attribution
 * `User-Agent: deepseek-harness/<ver> (+url)`（保留名，provider 配置里的
 * headers 无法覆盖，见 @deepseek-ai/dsh-llm attributionHeaders）。而 Kimi
 * 服务端按 User-Agent 识别调用方客户端（kimi-code-cli 发的是
 * `kimi-code-cli/<version>`）。本插件在宿主进程内 patch 全局 fetch，把发往
 * Kimi/Moonshot 端点的请求 UA 改写为 kimi-code-cli 身份，其他请求原样放行。
 *
 * 与 dsh-desktop-bridge 相同的两个硬约束：
 * - 纯 ESM、无构建步骤（本地 file: / git 安装直接可用）；
 * - 不依赖任何 @deepseek-ai/* 包——只碰全局 fetch，无宿主内部契约耦合。
 *
 * 环境变量：
 * - DSH_KIMI_UA=0            禁用（cordis.patch.yml 里同开关）
 * - DSH_KIMI_UA_VALUE=...    覆盖 UA（默认 kimi-code-cli/0.38.0）
 * - DSH_KIMI_UA_HOSTS=a,b    覆盖匹配的 host 列表（逗号分隔，默认见下）
 */

export const name = 'kimi-ua'

// 无 inject：不消费宿主服务，只做全局 fetch patch。

export const KIMI_UA_VERSION = '0.1.0'

const PATCH_KEY = Symbol.for('dsh-kimi-ua.fetch-patched')

const DEFAULT_UA = 'kimi-code-cli/0.38.0'
const DEFAULT_HOSTS = ['kimi.com', 'moonshot.cn', 'moonshot.ai']

/** host 是否命中目标（精确或子域后缀匹配）。 */
function hostMatches(host, list) {
  const h = host.toLowerCase()
  return list.some((base) => h === base || h.endsWith(`.${base}`))
}

/** 从 fetch input 提取 hostname；解析失败返回 null（不拦截）。 */
function hostOf(input) {
  try {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input.url === 'string'
            ? input.url // Request 对象
            : null
    if (!url) return null
    return new URL(url).hostname
  } catch {
    return null
  }
}

export function apply(ctx) {
  if (globalThis[PATCH_KEY]) {
    ctx?.logger?.debug?.('kimi-ua: fetch already patched, skipping')
    return
  }

  const ua = (process.env.DSH_KIMI_UA_VALUE || DEFAULT_UA).trim()
  const hosts = (process.env.DSH_KIMI_UA_HOSTS || DEFAULT_HOSTS.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  const original = globalThis.fetch
  if (typeof original !== 'function') {
    ctx?.logger?.warn?.('kimi-ua: globalThis.fetch unavailable, plugin inert')
    return
  }

  globalThis.fetch = function kimiUaFetch(input, init) {
    const host = hostOf(input)
    if (host === null || !hostMatches(host, hosts)) {
      return original.call(this, input, init)
    }
    try {
      // 合并顺序：Request 自带头 < init.headers < 改写后的 user-agent
      const headers = new Headers(
        typeof input === 'object' && input !== null && input.headers ? input.headers : undefined,
      )
      if (init && init.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v))
      headers.set('user-agent', ua)

      if (typeof input === 'string' || input instanceof URL) {
        return original.call(this, input, { ...(init ?? {}), headers })
      }
      // Request 对象：body 未被消费时可安全复制
      return original.call(this, new Request(input, { ...(init ?? {}), headers }))
    } catch {
      // 改写失败不阻断请求：原样发出
      return original.call(this, input, init)
    }
  }

  globalThis[PATCH_KEY] = { ua, hosts, original }
  ctx?.logger?.info?.(`kimi-ua: User-Agent for ${hosts.join(', ')} → ${ua}`)
}
