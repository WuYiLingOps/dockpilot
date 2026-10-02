# 常见问题与已知说明

[← 返回 README](../README.md)

**应用闪退 / 异常退出后如何排查？**
DockPilot 自带崩溃诊断：异常退出后的下次启动会显示顶部横幅（能归因时给出 panic 位置与原因，强制结束 / 断电等仅提示"未正常退出"），原因详情保留到下一次正常退出。使用日志可在「设置 → 故障诊断 → 查看日志」中浏览（级别过滤 / 关键字搜索 / 导出），日志文件位置：

- Linux：`~/.local/share/com.dockpilot.app/logs/`
- Windows：`%LOCALAPPDATA%\com.dockpilot.app\logs\`

日志按会话分文件（`dockpilot.log` 为当前会话，`dockpilot_时间.log` 为历史会话归档，最多保留 14 个），排查闪退优先看最近归档的尾部。也可以直接在「故障诊断 → 导出诊断包」打包最近日志与崩溃详情随 Issue 反馈（不含任何密码 / 私钥 / 令牌）。排查疑难问题时可临时开启「调试日志」（Debug 级别，立即生效）。

**Linux 上画面黑屏或花屏？**
WebKitGTK 在部分 NVIDIA 驱动上 DMABUF 渲染可能黑屏。应用启动时检测到 NVIDIA 环境会自动设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 兜底（Windows 走 WebView2，不执行该 workaround）；如仍遇异常，可手动设置该变量后启动。

**托盘图标不见了 / 最小化到托盘后找不到窗口？**
GNOME 桌面默认不显示托盘区，需安装 AppIndicator 扩展（Ubuntu 24.04 已内置 `gnome-shell-extension-appindicator`；KDE 及多数桌面原生支持）；Windows 在任务栏右下角托盘区（可能折叠于「^」中）。托盘菜单提供「显示 DockPilot / 退出」；关闭窗口行为可在「设置 → 应用 → 关闭窗口时」中修改。

**Alpine 容器打开终端没反应？**
默认 shell 为 bash，Alpine 系镜像请在终端页切换为 `sh` 或 `ash`（可在设置中改默认值）。

**容器详情的「文件」页签有什么限制？**
列表与删除通过在容器内执行 `ls` / `rm` 实现（不经 shell、命令参数直接传入），需要容器处于运行中；上传 / 下载走 Engine 的 archive API（等同 `docker cp`），单次传输上限 512MB（超大文件建议在终端中操作）。删除目录不可恢复，请谨慎操作。

**Windows 版能管本机 Docker Desktop / WSL 吗？**
不能。Windows 上安装 Docker Desktop 后通常由 WSL2 提供本地 daemon，本项目不会连接或管理该本地 daemon；请通过侧栏底部「管理连接…」打开「Docker 连接管理」配置远程主机。

**镜像加速 / daemon.json 编辑需要什么权限？**
应用通过 `pkexec` 提权整体写 `/etc/docker/daemon.json`（覆盖前自动备份为 `daemon.json.dockpilot.bak`）并可一键重启 Docker；应用前会先经 JSON 语法校验与 dockerd `--validate` 深度校验（Docker Engine 23.0+ 支持，旧版自动跳过）。无 polkit 的环境（如纯 SSH 会话）会自动回退为生成可复制的终端命令（命令内置同样的校验门禁）。重启 Docker 会中断运行中的容器（开启 live-restore 则不受影响），应用会在确认弹窗中提示。

**编排操作报找不到 compose 命令？**
Linux 上项目识别与查看仅依赖 Engine API；启动 / 停止等编排操作需要系统已安装 `docker compose` 插件（`docker-compose-plugin`）或 `docker-compose` 独立命令（SSH 连接时在远程服务器上执行，本机无需安装）。

**仓库密码存在哪里？换机会丢吗？**
优先系统钥匙串，无钥匙串时（无桌面的 Linux）存机器绑定加密文件，属混淆级防护；换机或重装系统后原密钥文件不可解密，需重新录入密码（应用会在测试连接时报错提示）。

**忘记同步密码怎么办？**
本机记住的同步密码可在同步卡片「锁定」清除；若密码本身遗忘，云端密文无法解密。处理：到 GitHub 删除同步 Gist（描述为 "DockPilot Encrypted Vault" 的私有 Gist），各设备在「设置 → 同步与云」断开重连、设置新密码后重新上传。

**云同步提示解密失败（同步密码可能不同）？**
两台设备设置过不同的同步密码。在冲突提示中选「使用云端」并输入云端数据的密码（本机同步密码将被重置为云端密码），或选「使用本地覆盖云端」以本机为准。

**「检查更新」失败或下载更新失败？**
检查与下载均直连 GitHub（`api.github.com` / `github.com`）。启动自动检查失败是完全静默的（仅记录日志，不打扰使用），手动检查在「设置 → 关于 → 软件更新」进行，失败时页面会显示具体原因：网络不稳定会自动重试后仍失败；若本机访问 GitHub 需要代理，请设置 `HTTPS_PROXY` 环境变量后重启应用（与云同步的网络要求一致）；提示 403 通常是匿名请求达到 GitHub 限流上限（约 1 小时自动恢复）。下载的安装包存放在应用缓存目录的 `updates` 子目录（Linux：`~/.cache/com.dockpilot.app/updates/`；Windows：`%LOCALAPPDATA%\com.dockpilot.app\cache\updates\`），每次下载前自动清理旧包。下载完成后自动安装并重启应用：Windows 以被动模式运行安装向导（自动关闭运行中的应用，完成后自动重启）；Linux 弹出系统授权框、经 `dpkg -i` 安装后自动重启（需 polkit 授权代理，取消授权即中断）。自动安装失败时可点「打开安装包」改由系统安装器接管。更新提醒可在「设置 → 应用 → 自动检查更新」关闭，最新版本也始终可直接到 [Releases 页](https://github.com/WuYiLingOps/dockpilot/releases) 查看。
