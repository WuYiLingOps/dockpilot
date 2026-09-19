# DockPilot — Docker 桌面管理工具

面向 Ubuntu 的轻量级开源 Docker 桌面管理应用。市面上的 Docker 管理工具（Portainer、Dockge 等）几乎都是 Web 端，需要额外部署一个容器服务再用浏览器访问；DockPilot 是真正的桌面应用：单窗口、直连本机 Docker Engine，无需部署任何服务。

## 功能

界面采用 OrbStack 式布局：侧栏导航（容器 / 镜像 / 空间清理 / 设置）+ 点击容器进入详情，日志、终端、监控收敛为详情页内的 Tab；支持亮 / 暗双主题（跟随系统）与自定义一体化标题栏。

- **容器**：列表 / 搜索 / 启动 / 停止 / 重启 / 暂停 / 恢复 / 删除，Docker 事件驱动实时刷新
- **容器详情**：概览（CPU / 内存 / 网络 / 磁盘 I/O 实时曲线，约 1 秒刷新）、日志（流式输出、自动跟随、关键字过滤、时间戳、stderr 红色高亮）、终端（交互式 shell：bash / sh / ash，自适应窗口尺寸）
- **镜像**：列表 / 搜索 / 来源筛选（自动按镜像地址前缀归组）/ 删除（可强制）/ 拉取（实时进度）
- **空间清理**：统计悬空镜像 / 未使用镜像 / 已停止容器 / 未使用卷 / 构建缓存的大小与数量，勾选后一键清理并显示回收空间
- **设置**：主题、Docker socket 路径、列表刷新间隔、日志与终端默认值；配置持久化到 `~/.config/com.dockpilot.app/settings.json`
- **镜像加速**：读写 `/etc/docker/daemon.json` 的 `registry-mirrors`（pkexec 提权，写入前自动备份，保留其他配置字段）、内置国内预设源、一键测速、pkexec 不可用时回退为可复制的终端命令

后续规划见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | Tauri 2 | 系统原生 WebView（WebKitGTK），安装包与内存占用远小于 Electron |
| 后端 | Rust + bollard | bollard 是 Docker/Podman Engine API 的异步 Rust 客户端，直连 `/var/run/docker.sock` |
| 前端 | React 19 + TypeScript + Tailwind CSS 4 | 构建用 Vite |
| 终端 | @xterm/xterm | 与后端 exec 流通过 Tauri Channel 桥接 |
| 状态 | TanStack Query + Docker events | 列表数据由事件推送自动失效刷新 |

架构说明：所有长驻流（日志、统计、终端输出、拉取进度）在后端由 Tokio 任务驱动，通过 Tauri Channel 推送到前端，并注册统一的取消句柄（`cancel_stream`）——切页即停流，避免无主任务堆积。Docker 事件由后端单实例全局监听、广播转发。

### 浏览器预览（免编译走查 UI）

`public/tauri-mock.js` 在非 Tauri 环境（无 `__TAURI_INTERNALS__`）下自动生效，为前端提供假数据；真实桌面应用中完全惰性。只改前端时可以不起 Rust：

```bash
npm run dev   # 打开 http://localhost:1420 预览，主题切换按钮可试亮/暗两套
```

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

## 本地测试（不安装 deb）

**直接运行构建产物**（无需安装）：

```bash
npm run tauri build
./src-tauri/target/release/dockpilot
# 调试构建：src-tauri/target/debug/dockpilot（cargo build 产物）
```

**任务栏图标说明（Wayland 会话）**：Wayland 下任务栏图标靠窗口 app-id 与 `.desktop`
文件匹配，dev 模式默认没有桌面入口，任务栏会显示通用图标。把调试二进制注册为
用户级应用即可解决：

```bash
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/dockpilot-dev.desktop <<'EOF'
[Desktop Entry]
Categories=Development;Utility;
Comment=DockPilot 开发模式（调试二进制）
Exec=/home/hj/ProjectData/docker-desktop/src-tauri/target/debug/dockpilot
StartupWMClass=dockpilot
Icon=/home/hj/ProjectData/docker-desktop/design/app-icon.png
Name=DockPilot (Dev)
Terminal=false
Type=Application
EOF
update-desktop-database ~/.local/share/applications
```

说明：

- `Exec` 与 `Icon` 需按实际仓库路径修改；应用窗口的 app-id 为二进制名 `dockpilot`
- **安装正式 deb 后请删除该文件**（`rm ~/.local/share/applications/dockpilot-dev.desktop`），
  避免与安装版（`StartupWMClass=dockpilot`）产生匹配歧义

## 构建与安装

一键脚本（打包 / 打包并安装 / 安装 / 卸载）：

```bash
./build_deb.sh            # 交互菜单
./build_deb.sh build      # 打包 deb（npm run tauri build）
./build_deb.sh deploy     # 打包并自动安装（普通用户执行，安装时自动 sudo 提权；sudo 执行亦可，打包阶段自动降权）
sudo ./build_deb.sh install    # 安装最新的 deb（自动检查 docker 组）
sudo ./build_deb.sh uninstall  # 卸载 dock-pilot
```

手动方式：

```bash
npm run tauri build
# 产物：src-tauri/target/release/bundle/deb/DockPilot_<版本>_<架构>.deb（deb 包名为 dock-pilot）
sudo apt install ./src-tauri/target/release/bundle/deb/DockPilot_0.1.0+20260919_amd64.deb
```

说明：`./build_deb.sh build` 打包时会自动清理旧 deb，并给版本号附加当日日期（如 `0.1.0+20260919`），便于追溯与覆盖安装；`install`/`uninstall` 分别对应 `dpkg` 包 `dock-pilot` 的安装与卸载。

## 测试

```bash
cd src-tauri
cargo check          # 类型检查
cargo test           # 集成测试（需要本机 Docker daemon 运行）
npm run build        # 前端 tsc + vite 构建
```

## 项目结构

```
design/
├── app-icon.svg              # 图标矢量源文件（舵轮 + 集装箱）
├── app-icon.png              # 1024px 渲染源图
└── icon-design-philosophy.md # 图标设计哲学
docs/
└── ROADMAP.md                # 功能规划
src-tauri/
├── icons/                    # 由 `npx tauri icon design/app-icon.png` 生成
└── src/
    ├── lib.rs                # 应用入口：状态注册、全局事件监听、命令注册
    ├── main.rs
    ├── settings.rs           # 应用设置读写（app_config_dir/settings.json）
    ├── daemon_config.rs      # 镜像加速：daemon.json 读写 / pkexec 提权 / 测速
    ├── cleanup.rs            # 空间清理：磁盘占用统计与各类 prune
    └── docker/
        ├── conn.rs           # Docker 连接（缓存复用）与统一错误类型
        ├── dto.rs            # 发送给前端的序列化结构
        ├── state.rs          # 流取消句柄注册表 + 终端会话表
        ├── system.rs         # docker_info
        ├── containers.rs     # 容器列表 / 生命周期操作
        ├── images.rs         # 镜像列表 / 删除 / 拉取
        ├── logs.rs           # 日志流
        ├── stats.rs          # 资源统计流（CPU/内存/网络/块 I/O 换算）
        ├── exec.rs           # 交互式终端（exec + stdin + resize）
        └── events.rs         # Docker 事件全局监听与订阅转发
src/
├── components/               # Sidebar、TitleBar、通用 UI 组件、detail/ 详情页视图
├── components/settings/      # 镜像加速设置分组
├── pages/                    # 容器 / 镜像 / 容器详情 / 空间清理 / 设置
├── hooks/                    # 容器操作 mutation
├── lib/api.ts                # Tauri invoke 封装（流式命令返回取消函数）
├── lib/settings.ts           # 设置 query/mutation 与主题迁移
├── lib/theme.ts              # 主题三态 store（跟随系统 / 浅 / 深）
├── lib/format.ts             # 字节 / 时间 / 端口格式化
└── types/                    # 与 Rust DTO 一一对应的 TS 类型
```

## 已知说明

- **NVIDIA 显卡兼容**：WebKitGTK 在部分 NVIDIA 驱动上 DMABUF 渲染可能黑屏。应用启动时检测到 NVIDIA 环境会自动设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 兜底；如仍遇渲染异常，可手动设置该变量后启动。
- **Alpine 容器**：默认 shell 为 bash，Alpine 系镜像请在终端页切换为 `sh` 或 `ash`（可在设置中改默认值）。
- **Docker 连接**：默认连接 `/var/run/docker.sock`，可在设置中指定其他 socket 路径（修改需重启应用生效）；TCP 远程连接暂未支持，见 Roadmap。
- **镜像加速写入**：应用通过 `pkexec` 提权写 `/etc/docker/daemon.json` 并可一键重启 Docker；无 polkit 的环境（如纯 SSH 会话）会自动回退为生成可复制的终端命令。重启 Docker 会中断运行中的容器（开启 live-restore 则不受影响），应用会在确认弹窗中提示。

## License

MIT
