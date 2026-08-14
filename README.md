# deepseek-desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh web`）的桌面客户端。作为本地 Web 服务 `http://127.0.0.1:3080/` 的桌面壳，提供独立窗口与加载体验。

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

## 工作原理

1. 启动时先检测 `http://127.0.0.1:3080/` 是否已在运行；若已运行，直接在窗口中加载渲染该页面。
2. 若未运行，检测本机是否已安装 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI）：
   - 未安装时弹窗询问用户是否安装，确认后执行 `npm install -g @deepseek-ai/dsh`。
   - 用户选择退出则直接退出应用。
3. dsh 可用后，通过 `child_process.spawn` 执行 `dsh web`，并轮询等待端口就绪。
4. 等待期间显示加载页（`renderer/loading.html`），服务就绪后渲染 `http://127.0.0.1:3080/`。
5. 退出时仅终止由本应用启动的 `dsh web` 进程，不影响外部已运行的服务。

> 说明：从 Finder/Dock 启动的 GUI 应用 `PATH` 通常不含 nvm/homebrew 目录，主进程会自动追加这些常见路径以便找到 `dsh` 和 `npm`。

## 项目结构

```
main.js                # Electron 主进程（端口检测 / spawn dsh web / 窗口管理）
renderer/loading.html  # 服务就绪前的加载页
```
