# 更新日志

本项目所有显著变更记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
