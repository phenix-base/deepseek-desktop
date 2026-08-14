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
6. 关闭窗口后应用常驻系统托盘；托盘菜单直接展示账户余额与 DeepSeek 服务状态（每 5 分钟自动刷新），并可打开主窗口、升级 dsh、退出。退出时仅终止由本应用启动的 `dsh web` 进程，不影响外部已运行的服务。

> 说明：从 Finder/Dock 启动的 GUI 应用 `PATH` 通常不含 nvm/homebrew 目录，主进程会自动追加这些常见路径以便找到 `dsh` 和 `npm`。

## 项目结构

```
main.js                       # Electron 主进程（端口检测 / spawn dsh web / 窗口与托盘管理）
preload.js                    # 通过 contextBridge 暴露 window.dshDesktop（状态与安装日志推送）
renderer/loading.html         # 服务就绪前的加载页（含安装日志可视化）
.github/workflows/release.yml # 推送 v* tag 时自动构建并发布 dmg/zip 到 Release
```
