# dsh-kimi-ua

dsh（DeepSeek Harness）宿主插件：使用 Kimi 模型时，把发往 Kimi/Moonshot 端点的请求 `User-Agent` 改写为 `kimi-code-cli/0.38.0`（kimi-code CLI 的客户端身份）。

## 为什么需要

dsh 的 llm 层对每个 provider 请求**强制**发送自己的归属头
`User-Agent: deepseek-harness/<version> (+url)`——`user-agent` 是保留名，
provider 配置里的 `headers` 无法覆盖它
（见 `@deepseek-ai/dsh-llm` 的 `attributionHeaders`）。

而 Kimi 服务端按 User-Agent 识别调用方客户端
（[kimi-code](https://github.com/MoonshotAI/kimi-code) CLI 发送
`kimi-code-cli/<version>`）。

本插件在宿主进程内 patch 全局 `fetch`：仅对 `kimi.com` / `moonshot.cn` /
`moonshot.ai`（含子域）的请求改写 UA，其余请求原样放行。

## 安装

```bash
# 本地开发（file: 引用源码目录）
dsh plugin --profile web add /path/to/deepseek-desktop/kimi-ua

# 或从 npm（发布后）
dsh plugin --profile web add dsh-kimi-ua
```

安装后**重启 dsh** 生效（cordis 宿主在启动时加载插件层）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_KIMI_UA` | 启用 | 设 `0` 禁用插件 |
| `DSH_KIMI_UA_VALUE` | `kimi-code-cli/0.38.0` | 覆盖 UA 值 |
| `DSH_KIMI_UA_HOSTS` | `kimi.com,moonshot.cn,moonshot.ai` | 逗号分隔的目标 host 列表 |

## 行为保证

- 仅改写目标 host 的 `user-agent`；其他请求头（Authorization、X-Msh-* 等）原样保留
- 幂等：重复 apply 不叠加 patch
- 改写异常时原样放行，不阻断请求
- 纯 ESM、零依赖、无构建步骤
