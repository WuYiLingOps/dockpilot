# 更新日志

本项目所有显著变更记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.4] - 2026-10-01

### 新增

- SSH 连接支持**密码认证**：密码经系统钥匙串加密存储（无钥匙串环境回退机器绑定加密文件），并支持 keyboard-interactive（PAM）回退
- SSH 层改用内置 **russh 引擎**（纯 Rust），**全面替代系统 ssh 命令**：密码认证 + 端口转发 + 远程命令执行（compose 探测/操作、compose 文件读写）不再依赖系统 ssh 客户端，Windows 免装 OpenSSH
- 主机指纹 TOFU 安全机制：首次连接自动记录（OpenSSH SHA256 格式），指纹变更时拒绝连接并弹窗确认新旧指纹
- 密钥认证增强：支持加密私钥口令（加密存储）、rsa-sha2-256 优先并回退 SHA-1 兼容老服务器、ssh-agent 不可用时自动回退默认私钥
- CI 新增 SSH 冒烟 job：openssh-server 容器自动验证 russh 密码认证全链路

### 变更

- SSH 隧道本地端点 Windows 侧改为内核分配随机端口，消除探测-释放竞态；会话增加 keepalive 探活，断线自动重建
- 连接错误按原因分类（认证失败 / 网络不可达 / 转发被拒 / 指纹变更），提示直达原因
- SSH 连接的 compose 操作输出流改为经内置引擎会话通道回传，与本机执行共用同一取消语义

### 修复

- Windows 未安装 OpenSSH 客户端时无法使用 SSH 连接的问题

### 已知限制

- 连接地址按字面解析，不读取 `~/.ssh/config`：Host 别名、每主机 User/Port/IdentityFile 等配置不生效（请把完整地址与私钥路径直接填入连接配置）
- 内置引擎默认算法集覆盖 OpenSSH ≥ 7.4（2016-12）；更老版本 sshd（OpenSSH ≤ 6.x）未经验证
- Windows 版暂不支持 ssh-agent，请指定私钥路径

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

[Unreleased]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/WuYiLingOps/dockpilot/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/WuYiLingOps/dockpilot/releases/tag/v1.0.0
