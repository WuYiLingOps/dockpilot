# 贡献指南

感谢关注 DockPilot！本文档说明开发环境搭建、常用命令与提交约定。

## 开发环境

| 依赖 | 要求 |
| :--- | :--- |
| Rust | ≥ 1.90（2021 edition） |
| Node.js | ≥ 24 |
| 系统 | Linux 需 Tauri 系统依赖（见下），Windows 需 WebView2 运行时（SSH 由内置 russh 引擎提供，无需 OpenSSH 客户端） |

Linux（Debian/Ubuntu）系统依赖：

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

```bash
git clone <仓库地址>
cd dockpilot
npm install --include=dev
```

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run tauri dev` | 开发模式运行 |
| `npm run tauri build` | 打包（Linux 出 deb，Windows 出 NSIS） |
| `npm test` | 前端 vitest 单测（纯函数，node 环境） |
| `npx tsc --noEmit` | 前端类型检查 |
| `cargo test --lib`（src-tauri/ 下） | Rust 单测 + 本机 daemon 集成测试 |
| `cargo clippy --all-targets -- -D warnings -A deprecated` | Rust 静态检查 |
| `cargo fmt` | Rust 格式化 |

说明：

- Rust 集成测试（`src-tauri/src/docker/mod.rs`）依赖本机 Docker daemon 且用户需在 `docker` 组；远程 SSH 回归用例已标 `#[ignore]`，需设 `DOCKERPILOT_REMOTE_SSH=root@host cargo test -- --ignored remote_ssh` 手动运行
- clippy 对 bollard 0.19 旧 API 的 deprecated 提示暂予豁免（待整体迁移到 `query_parameters` API），其余警告一律按错误处理，CI 同此口径

## 提交约定

- 使用中文约定式提交：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `ci:` / `chore:` / `build:`
- 一次提交聚焦一件事；UI 与后端联动的改动放同一提交
- 版本变更统一走 `management.sh version <版本号>` 或 `management.sh build <版本号>`，脚本会同步 `package.json`、`package-lock.json`、`Cargo.toml`、`Cargo.lock` 与 `tauri.conf.json` 三处版本号——**发版 tag 必须与三者一致**，release CI 会校验

## 质量门禁

推送与 PR 会触发 CI（`.github/workflows/ci.yml`）：前端 `tsc + vitest`，Rust `fmt --check + clippy + cargo test --lib`（ubuntu runner 自带 Docker，集成测试可直接跑）。提交前建议本地跑齐同款命令。

发版流程：打 `v*` tag 推送后由 `.github/workflows/release.yml` 构建 deb 与 NSIS 安装包并自动创建 GitHub Release（Release 说明按模板生成，含自上个 tag 以来的提交列表）。发版前请先把根目录 [CHANGELOG.md](../CHANGELOG.md) 的 Unreleased 段整理为该版本条目。

## 项目结构

```
docs/                 # 使用手册（远程连接 / 镜像推送 / 云同步 / FAQ）与贡献指南
src/                  # React 19 前端：pages/ 页面（大页面按目录拆分）、components/、hooks/、lib/（api.ts 为唯一 IPC 边界）
src-tauri/src/        # Rust 后端：docker/ 领域模块（conn/tunnel/containers/images/compose/...）、settings、secret_store 等
design/               # 应用图标源文件与设计哲学
management.sh         # 打包 / 安装 / 卸载 / 版本号同步的一键脚本
```

架构约定：前端只做展示与交互，全部 Docker 逻辑在 Rust Tokio 任务里；长驻流（日志/统计/终端/进度）经 Tauri `Channel` 推送，切页即取消。细节见 README「怎么工作」一节。
