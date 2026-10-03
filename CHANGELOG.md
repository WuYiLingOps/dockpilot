# 更新日志

本项目所有显著变更记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.5] - 2026-10-03

### 新增

- **Windows 便携版**：单个 exe 免安装（`DockPilot_<版本>_x64_portable.exe`），下载后放到任意目录双击即用、删除文件即卸载，与安装版共享同一份配置数据
- **应用内更新支持自动替换自身**：便携版改名替换后拉起新版本（替换失败自动回滚，旧文件由下次启动清理）；deb / NSIS 安装版流程不变；无法识别的发行形态回落「前往下载」
- Release 产物扩展：Windows 便携版 exe 随 GitHub Release 发布（由构建产物直接改名附加）

### 变更

- 软件更新文案按发行形态中性化（「安装包」→「更新包」、「安装更新」→「应用更新」等），三种发行形态下语义一致
- Release 说明模板与贡献指南不再要求 Windows 安装 OpenSSH 客户端（1.0.4 起内置 russh 引擎全面替代系统 ssh，旧文案遗漏已清理）

## [1.0.4] - 2026-10-02

### 新增

- SSH 连接支持**密码认证**：密码经系统钥匙串加密存储（无钥匙串环境回退机器绑定加密文件），并支持 keyboard-interactive（PAM）回退
- SSH 层改用内置 **russh 引擎**（纯 Rust），**全面替代系统 ssh 命令**：密码认证 + 端口转发 + 远程命令执行（compose 探测/操作、compose 文件读写）不再依赖系统 ssh 客户端，Windows 免装 OpenSSH
- 主机指纹 TOFU 安全机制：首次连接自动记录（OpenSSH SHA256 格式），指纹变更时拒绝连接并弹窗确认新旧指纹
- 密钥认证增强：支持加密私钥口令（加密存储）、rsa-sha2-256 优先并回退 SHA-1 兼容老服务器、ssh-agent 不可用时自动回退默认私钥
- CI 新增 SSH 冒烟 job：openssh-server 容器自动验证 russh 密码认证全链路
- **编排独立管理**：未运行的 compose 项目不再"消失"——曾运行过的项目自动记忆保留（`down` 后仍可见、可一键重启），支持手动注册 compose 文件（本地文件选择器或 SSH 输入远端路径）与扫描目录自动发现（深度 3 层，本地与远端一致），来源徽标区分「已记录 / 手动添加 / 扫描」
- **拉取自动匹配仓库凭据**：按镜像引用的 registry 域名自动匹配已保存凭据（阿里云 ACR / Harbor 等私有仓库镜像不再依赖 daemon 自身的 `docker login`；通用仓库地址可填 `docker.io`、`ghcr.io`、`quay.io` 等官方 v2 源，别名 `docker.io` 自动路由到 registry-1 端点）
- 拉取失败提示增强：额度用尽（toomanyrequests）、需要认证等场景给出可操作建议
- **应用内检查与下载更新**：启动后静默检查 GitHub 最新 release（默认开启，24h 节流，可在「设置 → 应用」关闭），不打扰使用；「设置 → 关于 → 软件更新」展示检查结果与发布说明，支持手动「检查更新」并**一键下载当前平台安装包**（Linux `.deb` / Windows NSIS，带进度展示），下载完成后**自动安装并重启应用**（Linux 经系统授权后 dpkg 安装；Windows 被动运行安装器，自动关闭应用并在完成后重启）；每次下载前自动清理旧安装包，自动安装失败（如取消授权）可改用「打开安装包」由系统安装器接管，未匹配到平台附件时回落跳转 GitHub Releases 页

### 变更

- SSH 隧道本地端点 Windows 侧改为内核分配随机端口，消除探测-释放竞态；会话增加 keepalive 探活，断线自动重建
- 连接错误按原因分类（认证失败 / 网络不可达 / 转发被拒 / 指纹变更），提示直达原因
- SSH 连接的 compose 操作输出流改为经内置引擎会话通道回传，与本机执行共用同一取消语义

### 修复

- Windows 未安装 OpenSSH 客户端时无法使用 SSH 连接的问题
- 概览页不显示已配置的 CPU 限额（`--cpus` / 绑核）：订阅统计时 inspect 容器取 `NanoCpus`/`CpusetCpus` 折算限额核数，CPU 卡显示「限额 x 核 · 占 x%」；CPU 图表纵轴有限额时对齐限额口径，无限额时自适应峰值，同时修复多核用量超过 100% 被图表裁剪的问题
- 更新安装完成后未自动清理下载的安装包：Linux 安装完成即删；Windows 因安装器运行期间锁定文件，改为应用启动时兜底清空更新目录（顺带清理中断下载的临时残片）

### 已知限制

- 连接地址按字面解析，不读取 `~/.ssh/config`：Host 别名、每主机 User/Port/IdentityFile 等配置不生效（请把完整地址与私钥路径直接填入连接配置）
- 内置引擎默认算法集覆盖 OpenSSH ≥ 7.4（2016-12）；更老版本 sshd（OpenSSH ≤ 6.x）未经验证
- Windows 版暂不支持 ssh-agent，请指定私钥路径
- 编排跟踪记录与扫描目录按连接绑定存储（路径为该连接视角），不参与云同步；目录扫描仅手动触发、深度 3 层，扫描发现的编排以主 compose 文件注册，不自动叠加 override 文件

### 文档

- `docs/remote-connection.md` 重写 SSH 章节：密码认证、主机指纹安全与兼容性说明

## [1.0.3] - 2026-10-01

### 新增

- CI 质量门禁（`.github/workflows/ci.yml`）：前端类型检查 + vitest，Rust 格式 / clippy / 单测与集成测试，随提交与 PR 自动运行

### 变更

- README 拆分为「门面 + 手册」：远程连接 / 镜像推送 / 云同步 / 常见问题四个操作手册移入 `docs/`，README 保留项目介绍与对应摘要链接；贡献指南随迁 `docs/CONTRIBUTING.md`
- 统一 Mutex/RwLock 毒锁处理为 `unwrap_or_else(|e| e.into_inner())`（`docker/state.rs`、`docker/conn.rs`，对齐 `tunnel.rs` 既有做法）
- 前端事件订阅、流取消、终端输入/尺寸调整等 best-effort 调用失败时记录应用日志，不再静默吞错
- 清零全部非 deprecated 的 clippy 警告，CI 以 `-D warnings`（deprecated 豁免对应 bollard query_parameters 迁移欠账）卡口
- 前端页面 `Storage.tsx`、`Images.tsx` 按组件拆分为 `pages/storage/`、`pages/images/` 目录
- vitest 覆盖面从云同步扩展到格式化工具与镜像页纯函数（26 个新用例）

### 修复

- README Wayland 小节的桌面入口示例残留旧仓库路径，改为按克隆目录展开

## [1.0.2] - 2026-09-30

### 变更

- 默认提示文案优化

### 修复

- 断连引导文案改为指向 Docker 连接管理弹窗

### 文档

- README 连接入口改为独立弹窗、补充 AllowTcpForwarding 排查与 TLS 实操

## [1.0.1] - 2026-09-30

### 新增

- 应用使用日志查看器、前端错误捕获与故障诊断卡片
- 运行日志落盘、崩溃诊断与操作日志全量埋点
- 云同步记住同步密码，启动自动解锁
- 设置改为分类弹窗，连接管理独立弹窗，关于页重排
- 补记仓库连通性测试与凭据增删日志

### 修复

- TLS 连接闪退问题
- SSH 地址带端口时拆分注入 `-p`，认证失败按平台提示部署公钥命令

### 变更

- SSH 连接说明按平台适配，Windows 给出公钥部署指引
- `management.sh` 打包完成输出构建耗时

## [1.0.0] - 2026-09-29

### 新增

- 首个发布版本：容器 / 镜像 / 编排 / 存储网络 / 远程连接的 Docker 桌面管理器
- 本机 socket、SSH 隧道、TLS 双向证书、明文 TCP 四种连接方式，多配置一键切换
- 容器全生命周期管理、实时资源曲线、流式日志、交互终端、文件管理
- 镜像拉取 / 推送 / 批量导出导入，Compose 项目识别与操作，磁盘用量与空间清理
- 镜像仓库凭据管理（系统钥匙串存储），GitHub Gist 端到端加密云同步

[Unreleased]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/WuYiLingOps/dockpilot/releases/tag/v1.0.0
