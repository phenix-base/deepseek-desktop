# dsh-desktop-bridge

[deepseek-desktop](https://github.com/phenix-base/deepseek-desktop)（Electron 桌面壳）的 dsh 宿主侧桥接插件。

让外壳用**宿主一手数据**（版本、会话、任务事件、余额）替换黑盒探测（端口嗅探、DOM 抓取、轮询猜测）。桥是纯增量：壳检测不到桥时自动回退到探测模式。

## 安装

```sh
# npm 发布后
dsh plugin --profile web add dsh-desktop-bridge

# 本地开发（本项目仓库内）
ln -sfn "$PWD/bridge" ~/.dsh/profiles/web/node_modules/dsh-desktop-bridge
# 然后在 ~/.dsh/profiles/web/cordis.patch.yml 中插入：
#   - insert:
#       - id: desktop-bridge
#         name: dsh-desktop-bridge
```

安装后**重启 dsh** 生效。设 `DSH_DESKTOP_BRIDGE=0` 可禁用。

## 接口

两个端点均 **loopback-only** 且需 **Bearer token** 鉴权。
token 首次启动自动生成于 `~/.dsh/.desktop-bridge-token`（0600 权限），外壳与插件同属本机用户，直接读取即可。

### `GET /api/dsh-desktop-bridge/state`

```json
{
  "ok": true,
  "bridgeVersion": "0.1.0",
  "dshVersion": "0.1.0-rc.8",
  "sessions": [{ "id": "session-…", "title": "…", "status": "running|idle", "lastEventAt": 1755… }],
  "runningTasks": 1,
  "balance": { "text": "12.34 CNY", "valueCny": 12.34, "at": 1755… }
}
```

### `GET /api/dsh-desktop-bridge/events`（SSE）

| 事件 | 数据 | 说明 |
|---|---|---|
| `hello` | state 快照 | 连接即得 |
| `session.started` / `session.ended` | `{ sessionId, title? }` | 会话创建/销毁 |
| `task.started` | `{ sessionId, title }` | 会话进入任务（`turn/start`，0→1） |
| `task.finished` | `{ sessionId, title, reason }` | 任务结束（`turn/end`，→0） |
| `balance.low` | `{ valueCny }` | CNY 余额跌破 ¥10（去重） |
| `heartbeat` | `{ at }` | 25s 保活 |

## 设计约束

- 纯 ESM、无构建步骤、零依赖（`@deepseek-ai/*` 一律不引入，契约形状直接实现）。
- 只读接口：不提供任何写操作；token 不进入日志，不响应非回环请求。
- 所有宿主事件订阅失败时静默降级（`/state` 仍可用，仅无实时事件），插件绝不拖垮宿主。
