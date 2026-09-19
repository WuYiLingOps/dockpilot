# DockPilot — Docker 桌面管理工具

面向 Ubuntu 的轻量级开源 Docker 桌面管理应用。市面上的 Docker 管理工具（Portainer、Dockge 等）几乎都是 Web 端，需要额外部署一个容器服务再用浏览器访问；DockPilot 是真正的桌面应用：单窗口、直连本机 Docker Engine，无需部署任何服务。

## 功能

- **容器**：列表 / 搜索 / 启动 / 停止 / 重启 / 暂停 / 恢复 / 删除，Docker 事件驱动实时刷新
- **镜像**：列表 / 搜索 / 删除（可强制）/ 拉取（实时进度）
- **日志**：流式输出、自动跟随、关键字过滤、时间戳、stderr 红色高亮
- **终端**：进入容器交互式 shell（bash / sh / ash），自适应窗口尺寸
- **监控**：CPU、内存、网络速率、磁盘 I/O 实时曲线（约 1 秒刷新）

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | Tauri 2 | 系统原生 WebView（WebKitGTK），安装包与内存占用远小于 Electron |
| 后端 | Rust + bollard | bollard 是 Docker/Podman Engine API 的异步 Rust 客户端，直连 `/var/run/docker.sock` |
| 前端 | React 19 + TypeScript + Tailwind CSS 4 | 构建用 Vite |
| 终端 | @xterm/xterm | 与后端 exec 流通过 Tauri Channel 桥接 |
| 状态 | TanStack Query + Docker events | 列表数据由事件推送自动失效刷新 |

架构说明：所有长驻流（日志、统计、终端输出、拉取进度）在后端由 Tokio 任务驱动，通过 Tauri Channel 推送到前端，并注册统一的取消句柄（`cancel_stream`）——切页即停流，避免无主任务堆积。Docker 事件由后端单实例全局监听、广播转发。

## 环境要求

- Ubuntu 22.04 / 24.04（其他发行版理论可用，未验证）
- [Rust](https://rustup.rs) ≥ 1.77、Node.js ≥ 20
- Tauri Linux 依赖：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

- 当前用户需能访问 Docker socket（通常加入 docker 组后重新登录）：

```bash
sudo usermod -aG docker $USER
```

## 开发

```bash
npm install
npm run tauri dev
```

## 构建与安装

```bash
npm run tauri build
# 产物：src-tauri/target/release/bundle/deb/dockpilot_0.1.0_amd64.deb
sudo apt install ./src-tauri/target/release/bundle/deb/dockpilot_0.1.0_amd64.deb
```

## 测试

```bash
cd src-tauri
cargo check          # 类型检查
cargo test           # 集成测试（需要本机 Docker daemon 运行）
npm run build        # 前端 tsc + vite 构建
```

## 项目结构

```
src-tauri/src/
├── lib.rs               # 应用入口：状态注册、全局事件监听、命令注册
├── main.rs
└── docker/
    ├── conn.rs          # Docker 连接与统一错误类型
    ├── dto.rs           # 发送给前端的序列化结构
    ├── state.rs         # 流取消句柄注册表 + 终端会话表
    ├── system.rs        # docker_info
    ├── containers.rs    # 容器列表 / 生命周期操作
    ├── images.rs        # 镜像列表 / 删除 / 拉取
    ├── logs.rs          # 日志流
    ├── stats.rs         # 资源统计流（CPU/内存/网络/块 I/O 换算）
    ├── exec.rs          # 交互式终端（exec + stdin + resize）
    └── events.rs        # Docker 事件全局监听与订阅转发
src/
├── components/          # Sidebar、通用 UI 组件
├── pages/               # 容器 / 镜像 / 日志 / 终端 / 监控五个页面
├── lib/api.ts           # Tauri invoke 封装（流式命令返回取消函数）
├── lib/format.ts        # 字节 / 时间 / 端口格式化
└── types/docker.ts      # 与 Rust DTO 一一对应的 TS 类型
```

## 已知说明

- **NVIDIA 显卡兼容**：WebKitGTK 在部分 NVIDIA 驱动上 DMABUF 渲染可能黑屏。应用启动时检测到 NVIDIA 环境会自动设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 兜底；如仍遇渲染异常，可手动设置该变量后启动。
- **Alpine 容器**：默认 shell 为 bash，Alpine 系镜像请在终端页切换为 `sh` 或 `ash`。
- **远程 Docker**：目前仅支持本机 socket；`DOCKER_HOST` 环境变量会被 bollard 读取，TCP 远程连接未做界面配置。

## License

MIT
