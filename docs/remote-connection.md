# 远程连接

[← 返回 README](../README.md)

DockPilot 支持管理多个 Docker 连接并随时切换：Linux 支持 **本地 socket / SSH / TLS / 明文 TCP**，Windows 支持 **SSH / TLS / 明文 TCP**。连接在独立的「Docker 连接管理」弹窗中统一管理（添加 / 编辑 / 测试 / 删除），由侧栏底部下拉的「管理连接…」或断连引导页的「连接设置」唤起；当前连接在侧栏底部快速切换，即时生效并自动刷新数据，无需重启应用。

## 使用方法

1. 打开「Docker 连接管理」弹窗（侧栏底部「管理连接…」或断连引导页的「连接设置」）→「添加连接」
2. 选择连接类型并填写地址，可先「测试连接」验证可达性（返回延迟与远程版本）
3. 保存后点击连接行，或用侧栏底部下拉切换
4. 切换后容器 / 镜像 / 存储等全部数据指向新连接；compose 编排操作也经同一连接执行（SSH 连接时直接在远程服务器上执行）

## SSH 连接（推荐）

无需在远程机开放任何 Docker TCP 端口，数据全程加密。连接由**内置 SSH 引擎（russh，纯 Rust）**建立，默认无需本机安装任何 ssh 客户端，**支持密码认证与密钥认证**。

**前置条件**

- 远程机已运行 Docker daemon，并允许登录用户访问对应的 Docker socket
- 远程机 sshd 需允许转发（`AllowTcpForwarding yes`，发行版默认开启；做过安全加固的服务器可能改为 `no`，症状见下方「故障排查」）
- 认证方式二选一：
  - **密码**：直接填远程用户的 SSH 登录密码（保存在本机系统钥匙串，无钥匙串环境回退机器绑定加密文件；不上传、不进配置文件）
  - **密钥**：显式私钥（可含口令）、ssh-agent（Linux/macOS；Windows 版暂不支持 agent，请指定私钥路径）或默认私钥 `~/.ssh/id_*`

**使用密码认证**

直接在连接配置中选择「密码」认证并填写密码即可，无需任何预配置。注意：

- 地址需含用户名（`user@host`）
- 服务器若禁用密码登录（sshd `PasswordAuthentication no`），请改用密钥
- 密码经密钥库加密存储；「清除已保存」按钮可删除

**配置免密登录（密钥认证，可选）**

Linux / macOS：

```bash
ssh-copy-id user@10.0.0.115                            # 输入一次密码，装本机公钥
ssh -o BatchMode=yes user@10.0.0.115 'docker version'  # 验证免密 + docker 权限
```

Windows（OpenSSH 不带 ssh-copy-id，无密钥先在 PowerShell 执行 `ssh-keygen -t ed25519`，一路回车）：

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@10.0.0.115 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
ssh -o BatchMode=yes user@10.0.0.115 "docker version"
```

**应用内配置**

| 字段 | 说明 |
|---|---|
| 地址 | `user@主机` 或 `user@主机:端口`（端口默认 22；密码认证同样需要用户名） |
| 认证方式 | 私钥（默认）或密码 |
| 密码 / 私钥口令 | 按认证方式填写；加密存储于本机，编辑时留空保持不变 |
| 私钥路径 | 密钥认证可选；留空依次尝试 ssh-agent 与默认私钥（`~/.ssh/id_*`） |
| 私钥口令 | 私钥有口令时可选填写，同样加密存储 |
| 跳板机地址 | 可选；目标主机仅可经跳板机访问时填 `user@跳板机[:端口]`（跳板机走密钥类认证） |
| 远程 Socket 路径 | 可选；rootless Docker 填 `/run/user/<uid>/docker.sock`，默认 `/var/run/docker.sock` |

**主机指纹安全**：首次连接自动记录主机指纹（OpenSSH SHA256 格式，可与 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 对照）；指纹变化时连接会被拒绝并弹窗展示新旧指纹，确认是服务器重装等正常原因后可接受新指纹，无法确认来源时应取消并核查网络环境。

**实现方式**：内置引擎在本地建立加密隧道，把远程 Docker socket 经 `direct-streamlocal` 通道转发为本机 Unix socket（Windows 为本机 TCP 端口）。bollard 经对应端点通信；SSH 连接的 compose 编排操作则经 SSH 会话直接在远程服务器上执行。隧道随连接切换、应用退出自动回收；连接断开后下次使用自动重建（内置 30s keepalive 探活）。

**兼容性说明**：连接地址按字面解析（`user@host[:端口]`），不会读取 `~/.ssh/config`——Host 别名、每主机 User/Port/IdentityFile 等配置不生效，请把完整地址与私钥路径直接填进连接配置。内置引擎的默认算法集覆盖 OpenSSH ≥ 7.4（2016-12 发布，支持 curve25519 与 rsa-sha2）；公钥认证对 RSA 密钥自动先试 rsa-sha2-256、被拒回退 SHA-1，更老的 sshd（OpenSSH ≤ 6.x）未经验证。

## TLS 连接

适合无法用 SSH 但可配置远程 daemon 的场景（双向证书认证）：

> 按 [Docker 官方文档](https://docs.docker.com/engine/security/protect-access/) 用 openssl 生成 CA、服务端与客户端证书（客户端需 `ca.pem` / `cert.pem` / `key.pem` 三个文件）

### 证书准备

> 仅供参考

```bash
# 1.创建证书目录并收紧权限
mkdir -p /data/docker/certs
chmod 700 /data/docker/certs
cd /data/docker/certs

# 2.生成 CA 根证书（无交互，无需手动填信息）
# CA根私钥（仅远程宿主机留存，严禁发给Dell-G15-5510）
openssl genrsa -out ca-key.pem 4096

# 一键写入完整证书信息
openssl req -new -x509 -days 3650 -key ca-key.pem -sha256 -out ca.pem \
-subj "/C=CN/ST=GuangXi/L=Nanning/O=HuangOps/OU=DevOps/CN=10.0.0.115/emailAddress=huangjing510@126.com"

# 3.生成 Docker 服务端证书（绑定本机 IP 10.0.0.115）
# 服务端私钥
openssl genrsa -out server-key.pem 4096
# 证书请求文件
openssl req -subj "/C=CN/ST=GuangXi/L=Nanning/O=HuangOps/OU=DevOps/CN=10.0.0.115" -sha256 -new -key server-key.pem -out server.csr
# 关键SAN配置：绑定远程宿主机IP，否则客户端握手失败
echo subjectAltName = IP:10.0.0.115 >> extfile.cnf
echo extendedKeyUsage = serverAuth >> extfile.cnf
# CA签发服务端证书
openssl x509 -req -days 3650 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -extfile extfile.cnf

# 4.生成客户端证书（给 Dell-G15-5510 本地主机使用）
# 客户端私钥，后续拷贝到Dell-G15-5510
openssl genrsa -out key.pem 4096
# 客户端证书请求
openssl req -subj "/C=CN/ST=GuangXi/L=Nanning/O=HuangOps/OU=DevOps/CN=client" -new -key key.pem -out client.csr
# 客户端鉴权标记
echo extendedKeyUsage = clientAuth > extfile-client.cnf
# 签发客户端证书
openssl x509 -req -days 3650 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAserial ca.srl -out cert.pem -extfile extfile-client.cnf
# 5. 清理临时文件 + 安全权限加固（Ubuntu2404 必执行）
rm -rf *.csr extfile*.cnf ca.srl
# 私钥仅root可读
chmod 600 *-key.pem key.pem
chown root:root /data/docker/certs/*
# 6.提取可下发给【Dell-G15-5510】的证书包
仅复制以下 3 个文件到你本地 Dell-G15-5510，ca-key.pem 留在远程宿主机，不要传输：
1. ca.pem 根证书
2. cert.pem 客户端证书
3. key.pem 客户端私钥
```

### 配置 Docker TLS 监听

远程机开启 TLS 监听（systemd 环境用 override，避免与 daemon.json 的 `hosts` 冲突）：

> 注意自行开放相关防火墙

```bash
[root@docker ~]# vim /lib/systemd/system/docker.service
# 修改以下ExecStart配置
ExecStart=/usr/local/bin/dockerd \
  -H unix:///var/run/docker.sock \
  -H tcp://0.0.0.0:2376 --tlsverify \
  --tlscacert=/data/docker/certs/ca.pem \
  --tlscert=/data/docker/certs/server-cert.pem \
  --tlskey=/data/docker/certs/server-key.pem

sudo systemctl daemon-reload
sudo systemctl restart docker
```

### 测试连接

应用内：类型选 **TLS**，填 `主机:2376`，选择客户端证书目录（需含 `ca.pem`、`cert.pem`、`key.pem`）

![image-20260930151406568](https://hj-typora-images-1319512400.cos.ap-guangzhou.myqcloud.com/2026-images/20260930151406image-20260930151406568.png)

## 明文 TCP

仅建议在可信内网使用（流量未加密且无认证，配置时会显示安全提示）：

```bash
[root@docker ~]# vim /usr/lib/systemd/system/docker.service
# 修改以下ExecStart配置
ExecStart=/usr/bin/dockerd -H tcp://0.0.0.0:2375 -H unix:///var/run/docker.sock

sudo systemctl daemon-reload
sudo systemctl restart docker
```

应用内：类型选 **TCP**，填 `主机:2375`。

![image-20260930151658637](https://hj-typora-images-1319512400.cos.ap-guangzhou.myqcloud.com/2026-images/20260930151658image-20260930151658637.png)

## 故障排查

| 现象 | 排查方向 |
|---|---|
| 测试连接超时 | 地址 / 端口 / 防火墙：`nc -zv 主机 端口` |
| SSH 报 Permission denied | 免密未配置或私钥不对：`ssh -o BatchMode=yes user@host docker version` 验证 |
| SSH 隧道建立超时 | 检查远程 Docker socket 路径与登录用户的 Docker 权限 |
| SSH 报 `连接不可达: Error in the hyper legacy client: client error (SendRequest)` | SSH 隧道正常，是请求 Docker API 时远端拒绝了 socket 转发通道，两种原因见下方「SSH 隧道报 client error (SendRequest)」：sshd 禁用了转发；或远程为 OpenSSH ≤ 7.4（如 CentOS 7）且以 root 登录 |
| TLS 报证书文件缺失 | 证书目录下需同时有 `ca.pem`、`cert.pem`、`key.pem` |
| 拉取 / 容器操作报权限错误 | 远程用户不在 docker 组：`sudo usermod -aG docker $USER` 后重新登录 |
| 远程机改了配置但不生效 | `systemd override` 配置后需 `sudo systemctl daemon-reload && sudo systemctl restart docker` |

### SSH 隧道报 client error (SendRequest)

`连接不可达: Error in the hyper legacy client: client error (SendRequest)` 表示 SSH 连接与隧道本身正常，失败发生在经隧道请求 Docker API 时：本地 ssh 向远端发起 `direct-streamlocal` 通道（连接 `/var/run/docker.sock`）被拒绝，连接随即关闭。两种原因：

**原因一：sshd 禁用了转发（隧道依赖它）**。编辑远程 `/etc/ssh/sshd_config` 把 `AllowTcpForwarding` 改为 `yes`，重启 sshd（`sudo systemctl restart sshd`，Debian/Ubuntu 服务名为 `ssh`）后重试。

**原因二：远程为 OpenSSH ≤ 7.4（典型如 CentOS 7）且以 root 登录**。7.4 及更早版本对 root 会话关闭特权分离（`privsep_postauth()` 将 `use_privsep` 置 0），而其 unix socket 转发实现要求 `use_privsep`，于是 root 的 unix socket 转发被无条件拒绝——与 sshd 任何配置无关，7.5（2017-03）起已修复（CentOS 7 官方源停留在 7.4）。任选其一绕开：

- 改用**非 root 账号**连接（非 root 会话特权分离保持开启），并保证该账号能访问 docker socket——完整命令见下方
- 让 dockerd 额外监听本机 TCP：远程 `docker.service` 的 `ExecStart` 追加 `-H tcp://127.0.0.1:2375`（写法参照上文 TLS 一节的 override），`daemon-reload` 并重启 docker 后，把连接配置的「远程 Socket 路径」填 `127.0.0.1:2375`——转发目标为 `host:port` 时走 TCP 转发通道（direct-tcpip），不受该 bug 影响。仅监听 127.0.0.1 且无 TLS，请勿改为 `0.0.0.0` 对外开放
- 升级远程 sshd 到 7.5+（CentOS 7 已 EOL，需自行编译或第三方包，一般不建议为此折腾）

改用专用账号的完整命令（以在远程机创建账号 `dockpilot`、地址 `10.0.0.117` 为例）：

```bash
# —— 远程机（10.0.0.117）上执行 ——
# 1. 创建专用账号并设置密码（密码仅用于下一步首次部署公钥）
sudo useradd -m dockpilot
sudo passwd dockpilot

# 2. 让 dockerd 改用 docker 组创建 socket
#    （该机 /var/run/docker.sock 属组为 root，普通账号无权访问）
sudo groupadd -f docker
#    编辑 /lib/systemd/system/docker.service，在 ExecStart 行追加 -G docker，例如：
#      ExecStart=/usr/local/bin/dockerd -H unix://var/run/docker.sock -G docker
sudo systemctl daemon-reload && sudo systemctl restart docker

# 3. 账号加入 docker 组（组成员等同 root 权限，仅添加可信账号）
sudo usermod -aG docker dockpilot

# —— 本机执行 ——
# 4. 部署公钥（输入上一步设置的密码），并验证免密登录与 docker 权限
ssh-copy-id dockpilot@10.0.0.117
ssh -o BatchMode=yes dockpilot@10.0.0.117 docker version

# 5. 在 DockPilot「连接管理」中把该连接的地址改为 dockpilot@10.0.0.117
```

验证方法：`ssh -v -N -L /tmp/t.sock:/var/run/docker.sock root@远程机`，另开终端执行 `curl --unix-socket /tmp/t.sock http://localhost/_ping`；若 ssh 输出 `open failed: administratively prohibited` 即命中上述两种原因之一。

## 远程连接集成测试

真实远程链路的回归测试（镜像拉取 → 容器创建 → exec / 日志 / 统计 → 删除，自清理），默认忽略、显式运行：

```bash
cd src-tauri
DOCKERPILOT_REMOTE_SSH=root@10.0.0.115 cargo test --lib -- --ignored remote_ssh --nocapture
```
