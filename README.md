# DockPilot — Docker 桌面管理工具

面向 Ubuntu 的轻量级开源 Docker 桌面管理应用。市面上的 Docker 管理工具（Portainer、Dockge 等）几乎都是 Web 端，需要额外部署一个容器服务再用浏览器访问；DockPilot 是真正的桌面应用：单窗口、直连本机 Docker Engine，无需部署任何服务。

![image-20260921145720338](https://hj-typora-images-1319512400.cos.ap-guangzhou.myqcloud.com/2026-images/20260921145720image-20260921145720338.png)



## 功能

界面采用 OrbStack 式布局：侧栏导航（系统概览 / 容器 / 镜像 / 编排 / 存储和网络 / 空间清理 / 设置）+ 点击进入详情，日志、终端、监控收敛为详情页内的 Tab；支持亮 / 暗双主题（跟随系统）与自定义一体化标题栏。

- **容器**：列表 / 搜索 / 启动 / 停止 / 重启 / 暂停 / 恢复 / 删除，Docker 事件驱动实时刷新；compose 容器带项目徽标，点击直达编排详情
- **容器创建**（容器页「创建容器」/ 镜像页行内「运行」入口）：镜像选择（本地不存在时自动拉取，进度实时显示）、容器名（可留空自动生成）、端口映射（多行、tcp/udp）、卷挂载（多行、只读）、环境变量、标签、资源限制（内存 MB/GB、CPU 核数可小数）、命令覆盖（按 shell 词法解析）、工作目录、网络选择、主机名、重启策略、自动移除 / 特权模式 / TTY / 标准输入；与 Docker Desktop 的 Run 能力对齐
- **容器详情**：概览（CPU / 内存 / 网络 / 磁盘 I/O 实时曲线，约 1 秒刷新）、日志（流式输出、自动跟随、关键字过滤、时间戳、stderr 红色高亮）、终端（交互式 shell：bash / sh / ash，自适应窗口尺寸）
- **镜像**：列表 / 搜索 / 来源筛选（自动按镜像地址前缀归组）/ 删除（可强制）/ 拉取（实时进度）
- **编排（docker compose）**：自动识别引擎上的 compose 项目并按项目聚合服务（基于容器标准标签，无需重新读取文件）；项目级启动 / 停止 / 重启 / 暂停 / 下线（可选删卷删镜像）/ 构建 / 拉取，服务级启停与重启，操作输出流式展示可中途取消；「部署新项目」选择 compose 文件一键 `up -d`；compose 配置在线编辑（保存前自动语法预检、原文件备份为 `.bak`，保存后可一键「重新应用」变更）。编排操作调用系统 `docker compose` CLI（自动探测插件版与独立版，未安装时仍可查看并提示）；自定义 socket 会同步注入 `DOCKER_HOST`，保证 CLI 与界面连接同一 daemon
- **存储和网络**：三个子页签——存储卷（列表 / 搜索 / 详情含挂载点与使用容器 / 创建 / 删除，占用大小与引用计数来自 `docker system df`，在用卷删除被后端拒绝）、网络（列表 / 详情含 IPAM 与已连接容器 / 创建（驱动、子网 / 网关、内部网络、可连接、IPv6）/ 删除，bridge / host / none 内置网络禁止删除，详情内可连接 / 断开容器）、磁盘用量（分类占比树图、构建缓存逐条明细、直达空间清理入口）；卷 / 网络数据由 Docker 事件驱动自动刷新
- **系统概览**：Docker 引擎与宿主资源总览（基础信息、容器 CPU / 内存占用、网络与磁盘实时曲线、用量统计树图），「存储卷 / 网络」统计卡片可点击直达存储和网络页对应子页签
- **空间清理**：统计悬空镜像 / 未使用镜像 / 已停止容器 / 未使用卷 / 构建缓存的大小与数量，勾选后一键清理并显示回收空间
- **多连接管理与远程连接**：设置页统一管理多个 Docker 连接（本地 socket / SSH / TLS / 明文 TCP），支持连通性测试（延迟与版本）、添加 / 编辑 / 删除、一键切换并自动刷新数据；侧栏底部可快速切换当前连接。SSH 连接由应用自动建立加密隧道（支持指定私钥与 rootless socket 路径），TLS 走客户端证书双向认证，compose CLI 会通过 `DOCKER_HOST` / `DOCKER_CERT_PATH` 指向同一连接；配置方法与故障排查见「远程连接」章节
- **设置**：主题、连接管理、列表刷新间隔、日志与终端默认值；配置持久化到 `~/.config/com.dockpilot.app/settings.json`
- **镜像加速**：读写 `/etc/docker/daemon.json` 的 `registry-mirrors`（pkexec 提权，写入前自动备份，保留其他配置字段）、内置国内预设源、一键测速、pkexec 不可用时回退为可复制的终端命令

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | Tauri 2 | 系统原生 WebView（WebKitGTK），安装包与内存占用远小于 Electron |
| 后端 | Rust + bollard | Docker/Podman Engine API 的异步 Rust 客户端；本地 socket 直连，远程经 TCP / TLS / SSH 隧道 |
| 前端 | React 19 + TypeScript + Tailwind CSS 4 | 构建用 Vite |
| 终端 | @xterm/xterm | 与后端 exec 流通过 Tauri Channel 桥接 |
| 状态 | TanStack Query + Docker events | 列表数据由事件推送自动失效刷新 |

架构说明：所有长驻流（日志、统计、终端输出、拉取进度）在后端由 Tokio 任务驱动，通过 Tauri Channel 推送到前端，并注册统一的取消句柄（`cancel_stream`）——切页即停流，避免无主任务堆积。Docker 事件由后端单实例全局监听、广播转发。连接层支持多连接配置与运行时即时切换（切换时自动取消旧连接上的流并重建事件监听）。

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

## 远程连接

DockPilot 支持管理多个 Docker 连接并随时切换：**本地 socket / SSH / TLS / 明文 TCP**。连接在「设置 → Docker 连接」统一管理（添加 / 编辑 / 测试 / 删除），侧栏底部可快速切换当前连接；切换即时生效并自动刷新数据，无需重启应用。

### 使用方法

1. 进入「设置 → Docker 连接」→「添加连接」
2. 选择连接类型并填写地址，可先「测试连接」验证可达性（返回延迟与远程版本）
3. 保存后点击连接行，或用侧栏底部下拉切换
4. 切换后容器 / 镜像 / 编排 / 存储等全部数据指向新连接；compose 编排操作也经同一连接执行

### SSH 连接（推荐）

无需在远程机开放任何端口，数据全程加密：

**前置条件**

- 本机已安装 ssh 客户端
- 远程机已安装 docker CLI（隧道通过其 `docker system dial-stdio` 通道工作，Docker 20.10+ 自带）
- 远程登录用户需有 docker 权限（root，或已加入 docker 组）
- 认证仅支持**密钥免密或 ssh-agent**，不支持交互式密码

**配置免密登录**

```bash
ssh-copy-id user@10.0.0.115                            # 输入一次密码，装本机公钥
ssh -o BatchMode=yes user@10.0.0.115 'docker version'  # 验证免密 + docker 权限
```

**应用内配置**

| 字段 | 说明 |
|---|---|
| 地址 | `user@主机` 或 `user@主机:端口`（端口默认 22） |
| 私钥路径 | 可选；留空使用 ssh-agent 或 `~/.ssh/config` |
| 远程 Socket 路径 | 可选；rootless Docker 填 `/run/user/<uid>/docker.sock`，默认 `/var/run/docker.sock` |

**实现方式**：应用在本地建立 `ssh -N -L` 加密隧道，把远程 docker socket 转发为本机 unix socket，bollard 与 compose CLI 均经由该隧道通信；隧道随连接切换、应用退出自动回收，进程意外退出会在下次使用时自动重建。

### TLS 连接

适合无法用 SSH 但可配置远程 daemon 的场景（双向证书认证）：

1. 按 [Docker 官方文档](https://docs.docker.com/engine/security/protect-access/) 用 openssl 生成 CA、服务端与客户端证书（客户端需 `ca.pem` / `cert.pem` / `key.pem` 三个文件）
2. 远程机开启 TLS 监听（systemd 环境用 override，避免与 daemon.json 的 `hosts` 冲突）：

```bash
sudo systemctl edit docker
#   [Service]
#   ExecStart=
#   ExecStart=/usr/bin/dockerd \
#     -H tcp://0.0.0.0:2376 --tlsverify \
#     --tlscacert=/etc/docker/certs/ca.pem \
#     --tlscert=/etc/docker/certs/server-cert.pem \
#     --tlskey=/etc/docker/certs/server-key.pem
sudo systemctl restart docker
```

3. 应用内：类型选 **TLS**，填 `主机:2376`，选择客户端证书目录（需含 `ca.pem`、`cert.pem`、`key.pem`）

### 明文 TCP

仅建议在可信内网使用（流量未加密且无认证，配置时会显示安全提示）：

```bash
sudo systemctl edit docker
#   [Service]
#   ExecStart=
#   ExecStart=/usr/bin/dockerd -H tcp://0.0.0.0:2375 -H unix:///var/run/docker.sock
sudo systemctl restart docker
```

应用内：类型选 **TCP**，填 `主机:2375`。

### 故障排查

| 现象 | 排查方向 |
|---|---|
| 测试连接超时 | 地址 / 端口 / 防火墙：`nc -zv 主机 端口` |
| SSH 报 Permission denied | 免密未配置或私钥不对：`ssh -o BatchMode=yes user@host docker version` 验证 |
| SSH 隧道建立超时 | 远程机未装 docker CLI，或登录用户无 docker 权限 |
| TLS 报证书文件缺失 | 证书目录下需同时有 `ca.pem`、`cert.pem`、`key.pem` |
| 拉取 / 容器操作报权限错误 | 远程用户不在 docker 组：`sudo usermod -aG docker $USER` 后重新登录 |
| 远程机改了配置但不生效 | `systemd override` 配置后需 `sudo systemctl daemon-reload && sudo systemctl restart docker` |

### 远程连接集成测试

真实远程链路的回归测试（镜像拉取 → 容器创建 → exec / 日志 / 统计 → 删除，自清理），默认忽略、显式运行：

```bash
cd src-tauri
DOCKERPILOT_REMOTE_SSH=root@10.0.0.115 cargo test --lib -- --ignored remote_ssh --nocapture
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

远程连接的真实链路回归测试默认忽略，运行方式见「远程连接 → 远程连接集成测试」。

## 项目结构

```
design/
├── app-icon.svg              # 图标矢量源文件（舵轮 + 集装箱）
├── app-icon.png              # 1024px 渲染源图
└── icon-design-philosophy.md # 图标设计哲学
src-tauri/
├── icons/                    # 由 `npx tauri icon design/app-icon.png` 生成
└── src/
    ├── lib.rs                # 应用入口：状态注册、全局事件监听、命令注册
    ├── main.rs
    ├── settings.rs           # 应用设置读写（含连接配置模型、旧配置迁移与清洗）
    ├── daemon_config.rs      # 镜像加速：daemon.json 读写 / pkexec 提权 / 测速
    ├── cleanup.rs            # 空间清理：磁盘占用统计与各类 prune
    └── docker/
        ├── conn.rs           # 多连接管理与运行时切换、连接缓存、四种传输分发
        ├── tunnel.rs         # SSH 隧道：本地 socket 转发、进程生命周期管理
        ├── dto.rs            # 发送给前端的序列化结构
        ├── state.rs          # 流取消句柄注册表 + 终端会话表
        ├── system.rs         # docker_info / host_stats / system_df（含构建缓存明细）
        ├── containers.rs     # 容器列表 / 生命周期操作 / 创建并启动（Docker Desktop Run 对齐）
        ├── networks.rs       # 网络列表（含连接明细与 IPAM）/ 创建 / 删除 / 连接断开容器
        ├── volumes.rs        # 卷列表（合并 df 占用与容器挂载）/ 创建 / 删除
        ├── compose.rs        # 编排：标签分组识别项目 + 调用 docker compose CLI（流式输出）
        ├── images.rs         # 镜像列表 / 删除 / 拉取
        ├── logs.rs           # 日志流
        ├── stats.rs          # 资源统计流（CPU/内存/网络/块 I/O 换算）
        ├── exec.rs           # 交互式终端（exec + stdin + resize）
        └── events.rs         # Docker 事件全局监听与订阅转发（切换连接时重建）
src/
├── components/               # Sidebar（含连接切换器）、TitleBar、通用 UI 组件、compose/ 输出面板、containers/ 创建容器弹窗、detail/ 详情页视图
├── components/overview/      # 系统概览的纯 SVG 图表（环形 / 折线 / 树图）
├── components/settings/      # 连接管理（多连接增删改测/切换）与镜像加速设置分组
├── pages/                    # 系统概览 / 容器 / 镜像 / 容器详情 / 编排 / 编排详情 / 存储和网络 / 空间清理 / 设置
├── hooks/                    # 容器操作 mutation、compose 输出流
├── lib/api.ts                # Tauri invoke 封装（流式命令返回取消函数）
├── lib/settings.ts           # 设置 query/mutation、连接切换 mutation 与主题迁移
├── lib/theme.ts              # 主题三态 store（跟随系统 / 浅 / 深）
├── lib/format.ts             # 字节 / 时间 / 端口格式化
└── types/                    # 与 Rust DTO 一一对应的 TS 类型
```

## 已知说明

- **NVIDIA 显卡兼容**：WebKitGTK 在部分 NVIDIA 驱动上 DMABUF 渲染可能黑屏。应用启动时检测到 NVIDIA 环境会自动设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 兜底；如仍遇渲染异常，可手动设置该变量后启动。
- **Alpine 容器**：默认 shell 为 bash，Alpine 系镜像请在终端页切换为 `sh` 或 `ash`（可在设置中改默认值）。
- **远程连接**：支持本地 socket / SSH / TLS / 明文 TCP 四种连接，多连接管理与切换即时生效，配置方法与故障排查详见「远程连接」章节。注意 SSH 仅支持密钥免密或 ssh-agent（不支持交互式密码）。
- **镜像加速写入**：应用通过 `pkexec` 提权写 `/etc/docker/daemon.json` 并可一键重启 Docker；无 polkit 的环境（如纯 SSH 会话）会自动回退为生成可复制的终端命令。重启 Docker 会中断运行中的容器（开启 live-restore 则不受影响），应用会在确认弹窗中提示。
- **编排操作依赖 compose CLI**：项目识别与查看仅依赖 Engine API；启动/停止等编排操作需要系统已安装 `docker compose` 插件（`docker-compose-plugin`）或 `docker-compose` 独立命令，未安装时编排页会提示并提供安装命令。

## License

MIT
