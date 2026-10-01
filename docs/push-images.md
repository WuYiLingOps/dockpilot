# 镜像推送

[← 返回 README](../README.md)

支持把本地镜像推送到 Docker Registry v2 兼容仓库，优先适配**阿里云容器镜像服务（ACR）**与**自建 Harbor**，也支持 Nexus、Quay、Distribution 等通用仓库。凭据在「设置 → 镜像仓库」统一管理（添加 / 编辑 / 测试连接 / 删除），镜像页行内「推送」入口也可就地快捷新建凭据。

## 使用方法

1. 「设置 → 镜像仓库」→「添加仓库凭据」，选择类型（阿里云 ACR / Harbor / 通用）并填写地址、用户名与密码；「测试连接」验证连通性与凭据
2. 镜像页点击镜像行的「推送」按钮，选择仓库凭据、填写目标仓库名与标签（默认值从镜像引用推导）；勾选多个镜像后可「推送所选」批量推送——统一选凭据、逐行自动推导目标引用（可编辑）、按顺序推送，单镜像失败不阻塞后续，可随时取消
3. 目标引用与本地引用不同时自动打标签（指向同一镜像，无额外存储），推送进度按层实时显示，可中途取消

阿里云 ACR（个人版免费）：用户名即阿里云登录账号，密码建议在镜像服务控制台「访问凭证管理」中设置固定密码；命名空间需提前创建，内置常用地域地址预设。Harbor：支持普通账号与机器人账户（`robot$项目+名称`），项目需提前存在且账号有推送权限；自签名证书可勾选「测试连接时跳过 TLS 证书校验」。

## 安全说明

- 密码保存在本机：优先写入**系统钥匙串**（Linux Secret Service / macOS 钥匙串 / Windows 凭据管理器）；无钥匙串的环境（无桌面的 Linux）自动回退为**机器绑定加密文件**（`~/.config/com.dockpilot.app/secrets.bin`，AES-256-GCM，密钥由 machine-id 派生）——该回退属混淆级防护，换机或重装系统后需重新录入密码
- 推送时密码经 Docker Engine API 的请求头传给 daemon 执行推送，不写入 `~/.docker/config.json`，不落远端磁盘
- 推送由**当前连接的 Docker daemon** 执行：SSH 远程连接时在远端主机推送，需远端可访问仓库地址

## 推送报错对照

| 推送报错 | 原因与处理 |
|---|---|
| authentication required / unauthorized | 凭据无效：检查用户名密码；Harbor 机器人账户需已启用且未过期；阿里云需使用登录账号或固定密码 |
| denied: requested access … | 无推送权限：Harbor 项目需已存在且账号有写权限；阿里云命名空间需已创建 |
| server gave HTTP response to HTTPS client | 仓库为 HTTP 服务：需在该 daemon 的 `daemon.json` 中将仓库地址加入 `insecure-registries` 后重启 Docker |
| x509: certificate signed by unknown authority | 自签名证书：同样加入 `insecure-registries`，或向系统导入 CA 证书 |
| connection refused / timeout | 网络不通：远程连接时需远端 Docker 宿主机可访问该仓库地址 |
