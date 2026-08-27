# deepseek-desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh web`）的桌面客户端。作为本地 Web 服务 `http://127.0.0.1:3080/` 的桌面壳，提供独立窗口与加载体验。

## 功能特性

- **单实例锁**：重复启动时聚焦已有窗口，避免多开。
- **端口检测**：启动时探测 3080，确认是 dsh web 服务（首页含 `__DSH_BOOT__` 特征串）才直接加载；被其他服务占用时给出提示。
- **窗口状态记忆**：自动记住窗口位置与大小，下次启动恢复。
- **系统托盘常驻**：关闭窗口不退出应用，托盘菜单可打开主窗口、升级 dsh、退出。
- **托盘信息展示**：托盘菜单直接展示账户余额与 DeepSeek 服务状态，每 5 分钟自动刷新；余额取自 `~/.dsh/.credentials.yaml` 中的 API Key 调用[余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance)，服务状态解析自 [status.deepseek.com](https://status.deepseek.com/)（点击状态项可打开状态页查看详情）。
- **低余额预警**：余额低于 10 元时，主界面顶部显示红色预警横幅，窗口标题同步提示；余额恢复后自动消失。
- **dsh 一键升级**：启动时检测 dsh 新版本，可一键升级（托盘菜单亦可触发）。
- **安装可视化**：未安装 dsh 时自动执行 `npm install -g @deepseek-ai/dsh`，安装日志实时显示在加载页。
- **自动发布**：推送 `v*` tag 后由 GitHub Actions 自动构建并发布 dmg/zip 到 GitHub Release。
- **全局快捷键**：`⌃⇧D`（Ctrl+Shift+D）随时唤起/隐藏主窗口，可在托盘菜单开关。
- **开机自启动**：托盘菜单勾选后以 `--hidden` 静默启动（只驻托盘不弹窗）。
- **系统原生通知**：余额不足、服务异常、任务完成、新版本发布时弹出 macOS 通知（仅在状态切换瞬间触发，不刷屏）。
- **菜单栏余额直显**：macOS 托盘图标旁直接显示余额（如 `¥12.5`），不足时前缀 🔴；同时 Dock 图标显示红色角标并弹跳提醒。
- **服务看门狗**：进入主界面后每 30 秒健康检查，dsh web 挂掉时自动重启并恢复窗口，用户无感。
- **崩溃自愈**：渲染进程崩溃时自动重载（10 秒内连续崩溃 3 次以上则显示错误页，避免死循环）。
- **托盘新会话**：托盘菜单一键唤出窗口并直接创建新会话。
- **URL Scheme 深链**：注册 `deepseek-harness://` 协议，`deepseek-harness://session/xxx` 可唤起桌面端并定位到对应路径。
- **桌面端更新检查**：启动时自动比对 GitHub Releases 最新版本，有新版本时托盘菜单出现下载入口（未签名包无法使用 electron-updater 自动更新，故采用检测 + 跳转下载方式）。
- **锁屏插件**：托盘「🔒 锁屏」或 `⌘/Ctrl+Shift+L` 锁定——密码哈希存储（scrypt+盐，0600）、连续 5 次错误触发指数冷却（30s→10min）、锁窗为主窗口子窗口只覆盖本应用（不影响其他窗口）、托盘/快捷键/深链解锁全部拦截（唯一通道是密码）。详见[锁屏插件](#锁屏插件)。
- **宿主桥接插件**：dsh 宿主侧 `dsh-desktop-bridge` 暴露 loopback-only Bearer 鉴权的 `/state` 快照与 `/events` SSE（任务开始/结束、余额预警、心跳），壳端桥优先探测 + 传统模式回退。详见[桥接插件](#桥接插件-dsh-desktop-bridge)。
- **Kimi User-Agent 插件**：dsh 宿主插件 `dsh-kimi-ua`——使用 Kimi 模型时把请求 `User-Agent` 改写为 `kimi-code-cli/0.38.0`（dsh 归属头强制覆盖 provider 配置，只能运行时拦截）。详见[Kimi UA 插件](#kimi-user-agent-插件-dsh-kimi-ua)。

## 前置条件

- 安装 [dsh](https://github.com/deepseek-ai/deepseek-harness) CLI（`dsh` 需在 `PATH` 中）
- Node.js（建议 v18+，开发环境为 v24）

## 使用方式

```bash
npm install
npm start
```

## 打包安装包

```bash
npm run dist
```

使用 [electron-builder](https://www.electron.build/) 构建，产物输出到 `dist/`：

- `DeepSeek Harness-<version>-arm64.dmg` — macOS 安装包
- `DeepSeek Harness-<version>-arm64-mac.zip` — 免安装压缩包

默认按当前机器架构打包（Apple Silicon 为 arm64）；需要 Intel 包加 `--x64`，通用包加 `--universal`：

```bash
npx electron-builder --mac --universal
```

注意：

- 默认产物**未签名**，首次打开需在「系统设置 → 隐私与安全性」中允许，或右键 → 打开。
- 安装包不包含 `dsh` CLI，目标机器需单独安装。

### 通过 GitHub Actions 自动发布

推送 `v*` tag 会触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)：在 macOS runner 上执行 `npm ci && npm run dist` 构建 dmg/zip，并上传到对应 tag 的 GitHub Release（自动生成 release notes）：

```bash
git tag v0.2.0
git push origin v0.2.0
```

## 工作原理

1. 应用启动（单实例锁保证同时只有一个实例，重复启动只聚焦已有窗口），并恢复上次的窗口位置与大小。
2. 检测 `http://127.0.0.1:3080/` 是否已在运行：
   - 已运行且确认为 dsh web（首页含 `__DSH_BOOT__` 特征串）→ 直接加载渲染。
   - 已被其他服务占用 → 提示用户端口被占用。
   - 未运行 → 进入下一步。
3. 检测本机是否已安装 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI）：
   - 已安装但存在新版本 → 提示升级，可一键执行 `npm install -g @deepseek-ai/dsh`（托盘菜单亦可手动触发）。
   - 未安装 → 弹窗询问用户是否安装；确认后执行 `npm install -g @deepseek-ai/dsh`，安装过程日志实时显示在加载页。用户选择退出则直接退出应用。
4. dsh 可用后，通过 `child_process.spawn` 执行 `dsh web`，并轮询等待端口就绪。
5. 等待期间显示加载页（`renderer/loading.html`），服务就绪后渲染 `http://127.0.0.1:3080/`。
6. 关闭窗口后应用常驻系统托盘；托盘菜单直接展示账户余额与 DeepSeek 服务状态（每 5 分钟自动刷新），并可打开主窗口、升级 dsh、退出。退出应用时（托盘「退出」/ Cmd+Q）会先终止 dsh web 服务再退出：无论 `dsh web` 是由本应用启动还是外部独立启动，只要 3080 端口上仍确认是 dsh web（`__DSH_BOOT__` 特征串校验，避免误杀占用端口的其他程序）即会收到 SIGTERM（dsh 内部优雅退出，超时自动强杀）。

> 说明：从 Finder/Dock 启动的 GUI 应用 `PATH` 通常不含 nvm/homebrew 目录，主进程会自动追加这些常见路径以便找到 `dsh` 和 `npm`。

## 锁屏插件

应用内锁屏（`lock-screen.js` + `renderer/lock/`），锁定 DeepSeek Harness 主窗口：

- **触发**：托盘「🔒 锁屏」或快捷键 `⌘/Ctrl+Shift+L`；首次使用时锁窗引导设置密码（两次输入一致后落库并保持锁定）。
- **解锁唯一通道**：锁窗为主窗口的**子窗口**（`parent: mainWindow`）——只覆盖本应用内容，其他应用窗口完全不受影响；锁定期间托盘「打开主窗口」/快捷键/深链全部被拦截，托盘项变为「🔒 已锁定」禁用态。
- **安全存储**：密码只存 scrypt+随机盐哈希（`userData/lock-screen.json`，0600，无明文），校验用 `timingSafeEqual`。
- **防爆破冷却**：连续 5 次错误触发冷却，30s 起指数翻倍（上限 10 分钟），冷却期即使密码正确也拒绝。
- **UI**：SVG 锁图标 + 毛玻璃卡片 + 入场动画，密码可见性切换，错误时 shake 反馈。

## 桥接插件（dsh-desktop-bridge）

`bridge/` 目录是 dsh 宿主插件（cordis bundle），把宿主状态暴露给桌面壳：

| 端点（loopback-only + Bearer token） | 内容 |
|---|---|
| `GET /api/dsh-desktop-bridge/state` | bridgeVersion / dshVersion / 会话列表 / 运行中任务数 / 余额快照 |
| `GET /api/dsh-desktop-bridge/events` | SSE：`task.started` / `task.finished` / `balance.low` / `heartbeat` |

- Token 存于 `~/.dsh/.desktop-bridge-token`（0600，sha256 + timingSafeEqual 比对）。
- 壳端 `bridge-client.js` 桥优先：状态探测、任务活动（事件驱动替代 DOM 轮询）、托盘余额、看门狗、版本检查全部先走桥，桥不可用时自动回退传统模式（端口嗅探 + DOM 抓取）。
- 托盘「安装桥接插件」一键把 bridge 装进 web profile（本地源码 file: 或 npm 包名）。

## Kimi User-Agent 插件（dsh-kimi-ua）

`kimi-ua/` 目录是 dsh 宿主插件：使用 Kimi 模型时把请求 `User-Agent` 改写为 `kimi-code-cli/0.38.0`。

背景：dsh 的 llm 层对每个 provider 请求**强制**发送自己的归属头（`user-agent` 为保留名，provider 配置的 headers 无法覆盖）；而 Kimi 服务端按 UA 识别调用方（[kimi-code](https://github.com/MoonshotAI/kimi-code) CLI 发送 `kimi-code-cli/<version>`）。本插件在宿主进程内 patch 全局 `fetch`，仅对 `kimi.com` / `moonshot.cn` / `moonshot.ai`（含子域）改写 UA，其余请求原样放行。

```bash
# 安装（本地源码）
dsh plugin --profile web add /path/to/deepseek-desktop/kimi-ua
# 重启 dsh 生效
```

环境变量：`DSH_KIMI_UA=0` 禁用；`DSH_KIMI_UA_VALUE` 覆盖 UA；`DSH_KIMI_UA_HOSTS` 覆盖目标 host 列表。

## 项目结构

```
main.js                       # Electron 主进程（端口检测 / spawn dsh web / 窗口与托盘管理）
preload.js                    # 通过 contextBridge 暴露 window.dshDesktop（状态与安装日志推送）
bridge-client.js              # 壳端桥客户端：桥优先探测 + SSE 事件 + 传统模式回退
lock-screen.js                # 锁屏插件：密码哈希/冷却/锁窗管理（主窗口子窗口）
renderer/loading.html         # 服务就绪前的加载页（含安装日志可视化）
renderer/lock/                # 锁屏页面（HTML + preload）
bridge/                       # dsh 宿主插件 dsh-desktop-bridge（state 快照 + SSE 事件）
kimi-ua/                      # dsh 宿主插件 dsh-kimi-ua（Kimi 请求 UA 改写）
.github/workflows/release.yml # 推送 v* tag 时自动构建并发布 dmg/zip 到 Release
```

## 版本历史

| 版本 | 里程碑 |
|---|---|
| v0.2.4 | 锁窗改为主窗口子窗口（只锁本应用）+ 锁屏页面美化（SVG 图标 / 毛玻璃卡片 / 密码可见性 / shake 动画） |
| v0.2.3 | 修复：点击「解锁」无反应（submit 成功但未触发 unlock，锁窗不关闭） |
| v0.2.2 | 锁屏插件初版（密码哈希存储 / 防爆破冷却 / 唯一密码解锁通道） |
| v0.2.1 | M4：托盘「安装桥接插件」引导 + 桥接就绪状态行 |
| v0.2.0 | M2：壳端桥接通——桥优先探测 + 传统回退；M3：SSE 事件驱动（任务通知 / 余额预警实时化） |
| v0.1.x | 基础桌面壳：单实例 / 托盘 / 余额展示 / 看门狗 / 深链 / 自动发布 |
