#Requires -Version 5.1
#********************************************************************
#FileName:      management.ps1
#Description:   DockPilot 打包/安装/卸载/编译测试脚本（management.sh 的 Windows 版）
#Usage:         .\management.ps1 [build [版本号] | version <版本号> | install | uninstall |
#               dev | test | cargo-test | check | clippy | -h|--help]
#Note:          首次运行被执行策略拦截时：
#               powershell -ExecutionPolicy Bypass -File .\management.ps1 <命令>
#********************************************************************

param(
    [Parameter(Position = 0)][string]$Command = '',
    [Parameter(Position = 1)][string]$VersionArg = '',
    [switch]$Yes
)

$ProjectDir     = $PSScriptRoot
$NsisBundleDir  = Join-Path $ProjectDir 'src-tauri\target\release\bundle\nsis'
$VersionPattern = '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'
$Utf8NoBom      = New-Object System.Text.UTF8Encoding($false)

# 状态输出（自动对齐到第 60 列，中文按 2 列宽计算）
function Get-DisplayWidth([string]$Text) {
    $width = 0
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if (($code -ge 0x2E80 -and $code -le 0x9FFF) -or
            ($code -ge 0xF900 -and $code -le 0xFAFF) -or
            ($code -ge 0xFF01 -and $code -le 0xFF60) -or
            ($code -ge 0xFFE0 -and $code -le 0xFFE6)) { $width += 2 } else { $width += 1 }
    }
    $width
}

function Write-Status {
    param([string]$Message, $State)
    $pad = [Math]::Max(1, 60 - (Get-DisplayWidth $Message))
    Write-Host -NoNewline ($Message + (' ' * $pad) + '[')
    if ($State -eq 'success' -or $State -eq 0) {
        Write-Host -NoNewline ' OK ' -ForegroundColor Green
    } elseif ($State -eq 'failure' -or $State -eq 1) {
        Write-Host -NoNewline 'FAILED' -ForegroundColor Red
    } else {
        Write-Host -NoNewline 'WARNING' -ForegroundColor Yellow
    }
    Write-Host ']'
}

# 检查上一条原生命令的执行结果
function Assert-LastExitCode {
    param([string]$Message)
    if ($LASTEXITCODE -eq 0) {
        Write-Status "$Message 完成" 0
    } else {
        Write-Status "$Message 失败" 1
        exit 1
    }
}

# 时长格式化：秒 → "X 分 Y 秒" / "Y 秒"
function Format-Duration([double]$Seconds) {
    $total = [int][Math]::Round($Seconds)
    if ($total -ge 60) {
        "{0} 分 {1} 秒" -f ([int][Math]::Floor($total / 60)), ($total % 60)
    } else {
        "$total 秒"
    }
}

# 补充工具链 PATH / 环境变量：新开终端本可用，但部分会话（如从旧进程派生）
# 继承的是设置环境变量之前的旧 PATH，这里从注册表补齐缺失的目录
function Initialize-BuildEnvironment {
    $known = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') } | Where-Object { $_ })
    foreach ($scope in 'Machine', 'User') {
        $value = [Environment]::GetEnvironmentVariable('Path', $scope)
        if (-not $value) { continue }
        foreach ($dir in ($value -split ';')) {
            $dir = $dir.Trim().TrimEnd('\')
            if (-not $dir -or $known -contains $dir) { continue }
            if (Test-Path -LiteralPath $dir) {
                $env:Path = "$env:Path;$dir"
                $known += $dir
            }
        }
    }
    foreach ($name in 'CARGO_HOME', 'RUSTUP_HOME') {
        if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue)) {
            $v = [Environment]::GetEnvironmentVariable($name, 'User')
            if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'Machine') }
            if ($v) { Set-Item -Path "Env:$name" -Value $v }
        }
    }

    foreach ($cmd in 'node', 'npm', 'cargo', 'rustc') {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Write-Status "缺少依赖命令: $cmd" 1
            if ($cmd -in 'cargo', 'rustc') {
                Write-Host "      安装 Rust: https://rustup.rs （或 winget install Rustlang.Rustup）"
            } else {
                Write-Host "      安装 Node.js: https://nodejs.org （或 nvm-windows）"
            }
            exit 1
        }
    }

    # WebView2 Runtime：Tauri 窗口渲染依赖
    $wv2Keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    if (-not ($wv2Keys | Where-Object { (Get-ItemProperty $_ -ErrorAction SilentlyContinue).pv })) {
        Write-Status "未检测到 WebView2 Runtime，应用无法启动" 2
        Write-Host "      安装: https://developer.microsoft.com/microsoft-edge/webview2/"
    }

    # MSVC C++ 生成工具：Rust MSVC 工具链链接依赖
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if (-not $vsPath) {
            Write-Status "未检测到 MSVC C++ 生成工具，Rust 构建会失败" 2
            Write-Host "      安装: Visual Studio Installer 勾选 '使用 C++ 的桌面开发'"
        }
    } else {
        Write-Status "未检测到 vswhere，无法确认 MSVC 工具链" 2
    }

    Set-CargoMirrorEnv
    $nodeV  = & node -v
    $cargoV = (& cargo -V) -replace '^cargo\s+', ''
    Write-Status "构建环境检查通过 (node $nodeV / cargo $cargoV)" 0
}

# 注入 Cargo 镜像参数（环境变量方式）
# Windows 下无法照搬 management.sh 的 cargo 包装器方案：tauri CLI 通过 CreateProcess
# 直接查找 cargo.exe，不会经 cmd 解析 .cmd 包装脚本。改用 Cargo 的环境变量配置：
# 配置键的 . 和 - 都转成 _（如 source.crates-io.replace-with → CARGO_SOURCE_CRATES_IO_REPLACE_WITH），
# 优先级高于 CARGO_HOME 配置文件，且随进程传给 npm → tauri CLI → cargo 的整条调用链。
# 切换镜像时，注释当前启用的三行，并取消注释目标镜像的三行。
function Set-CargoMirrorEnv {
    # rsproxy 字节源（当前启用，与本机 CARGO_HOME config.toml 一致）
    $MirrorName  = 'rsproxy 字节源'
    $ReplaceWith = 'rsproxy'
    $RegistryUrl = 'sparse+https://rsproxy.cn/index/'

    # Nexus 内网源（Linux 构建机使用）
    # $MirrorName  = 'Nexus 内网源'
    # $ReplaceWith = 'nexus'
    # $RegistryUrl = 'sparse+http://nexus.huang.org/repository/cargo-proxy/'

    # 阿里云源
    # $MirrorName  = '阿里云源'
    # $ReplaceWith = 'aliyun'
    # $RegistryUrl = 'sparse+https://mirrors.aliyun.com/crates.io-index/'

    # 清华源
    # $MirrorName  = '清华源'
    # $ReplaceWith = 'tuna'
    # $RegistryUrl = 'sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/'

    # 中科大源
    # $MirrorName  = '中科大源'
    # $ReplaceWith = 'ustc'
    # $RegistryUrl = 'sparse+https://mirrors.ustc.edu.cn/crates.io-index/'

    if (-not $ReplaceWith -or -not $RegistryUrl) {
        Write-Status "未启用任何 Cargo 镜像源，请取消注释 Set-CargoMirrorEnv 中的目标镜像" 1
        exit 1
    }

    $env:CARGO_SOURCE_CRATES_IO_REPLACE_WITH = $ReplaceWith
    Set-Item -Path ("Env:\CARGO_SOURCE_" + $ReplaceWith.ToUpper() + "_REGISTRY") -Value $RegistryUrl
    Write-Status "已注入 Cargo 镜像参数（$MirrorName）" 0
}

# 读取当前应用版本（package.json、Cargo.toml、tauri.conf.json 必须保持一致）
function Get-AppVersion {
    $text = [IO.File]::ReadAllText((Join-Path $ProjectDir 'src-tauri\tauri.conf.json'))
    $m = [regex]::Match($text, '"version"\s*:\s*"([^"]+)"')
    if (-not $m.Success) {
        Write-Status "无法从 tauri.conf.json 读取版本号" 1
        exit 1
    }
    $m.Groups[1].Value
}

# 更新应用版本号（同步 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json）
# 只对目标键做精准替换，保留各文件原有格式，避免 JSON 整文件重排产生无关 diff
function Update-AppVersion([string]$NewVersion) {
    if ($NewVersion -notmatch $VersionPattern) {
        Write-Status "版本号格式无效: $NewVersion（示例: 0.3.1）" 1
        exit 1
    }
    $currentVersion = Get-AppVersion
    $versionRx = '("version"\s*:\s*")[^"]+(")'

    # package.json / tauri.conf.json：首个 "version" 键即应用版本
    foreach ($rel in 'package.json', 'src-tauri\tauri.conf.json') {
        $path = Join-Path $ProjectDir $rel
        $text = [IO.File]::ReadAllText($path)
        $m = [regex]::Match($text, $versionRx)
        if (-not $m.Success) {
            Write-Status "无法在 $rel 中定位版本号" 1
            exit 1
        }
        $text = $text.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + $NewVersion + $m.Groups[2].Value)
        [IO.File]::WriteAllText($path, $text, $Utf8NoBom)
    }

    # package-lock.json：顶层 "version" + packages."" 内的 "version" 两处
    $lockPath = Join-Path $ProjectDir 'package-lock.json'
    $text = [IO.File]::ReadAllText($lockPath)
    $m = [regex]::Match($text, $versionRx)
    if (-not $m.Success) {
        Write-Status "无法从 package-lock.json 读取版本号" 1
        exit 1
    }
    $text = $text.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + $NewVersion + $m.Groups[2].Value)
    $pkgIdx = $text.IndexOf('"packages"')
    if ($pkgIdx -ge 0) {
        $m2 = [regex]::Match($text.Substring($pkgIdx), $versionRx)
        if ($m2.Success) {
            $abs = $pkgIdx + $m2.Index
            $text = $text.Remove($abs, $m2.Length).Insert($abs, $m2.Groups[1].Value + $NewVersion + $m2.Groups[2].Value)
        }
    }
    [IO.File]::WriteAllText($lockPath, $text, $Utf8NoBom)

    # Cargo.toml：首个 version = "当前版本"（package 段）
    $tomlPath = Join-Path $ProjectDir 'src-tauri\Cargo.toml'
    $text = [IO.File]::ReadAllText($tomlPath)
    $old = 'version = "' + $currentVersion + '"'
    $m = [regex]::Match($text, [regex]::Escape($old))
    if (-not $m.Success) {
        Write-Status "Cargo.toml 当前版本不是 $currentVersion" 1
        exit 1
    }
    $text = $text.Remove($m.Index, $m.Length).Insert($m.Index, 'version = "' + $NewVersion + '"')
    [IO.File]::WriteAllText($tomlPath, $text, $Utf8NoBom)

    # Cargo.lock：dockpilot 包条目
    $rustLockPath = Join-Path $ProjectDir 'src-tauri\Cargo.lock'
    $text = [IO.File]::ReadAllText($rustLockPath)
    $m = [regex]::Match($text, 'name = "dockpilot"\r?\nversion = "')
    if (-not $m.Success) {
        Write-Status "Cargo.lock 中未找到 dockpilot 包" 1
        exit 1
    }
    $verStart = $m.Index + $m.Length
    $verEnd   = $text.IndexOf('"', $verStart)
    $text = $text.Remove($verStart, $verEnd - $verStart).Insert($verStart, $NewVersion)
    [IO.File]::WriteAllText($rustLockPath, $text, $Utf8NoBom)

    Write-Status "应用版本已更新为 $NewVersion" 0
}

# 打包 NSIS 安装包。版本号自动附加年月日时间戳，如 1.0.5+20261007；打包前清理旧产物
function Invoke-Build([string]$RequestedVersion) {
    if ($RequestedVersion) { Update-AppVersion $RequestedVersion }

    Set-Location $ProjectDir
    Initialize-BuildEnvironment
    Write-Status "项目目录: $ProjectDir" 0

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'node_modules'))) {
        Write-Status "安装前端依赖 (npm install)..." 0
        & npm install
        Assert-LastExitCode "前端依赖安装"
    }

    if (Test-Path -LiteralPath $NsisBundleDir) {
        Get-ChildItem -LiteralPath $NsisBundleDir -Filter *.exe -ErrorAction SilentlyContinue | Remove-Item -Force
        Write-Status "已清理旧 nsis 产物" 0
    }

    $baseVersion  = Get-AppVersion
    $buildVersion = "$baseVersion+$(Get-Date -Format yyyyMMdd)"
    $mergeFile    = Join-Path ([IO.Path]::GetTempPath()) ("tauri-version-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + ".json")
    Write-Status "构建版本: $buildVersion" 0

    try {
        # --config 以 JSON merge 覆盖 tauri.conf.json 的 version（无 BOM，避免 serde 解析失败）
        [IO.File]::WriteAllText($mergeFile, '{"version": "' + $buildVersion + '"}')
        Write-Status "开始打包 npm run tauri build --bundles nsis（release 构建耗时较久）..." 0
        $buildStart = Get-Date
        & npm run tauri build -- --bundles nsis --config $mergeFile
        if ($LASTEXITCODE -ne 0) {
            Write-Status "打包 失败" 1
            exit 1
        }
        Write-Status ("构建耗时: " + (Format-Duration ((Get-Date) - $buildStart).TotalSeconds)) 0
    } finally {
        Remove-Item -LiteralPath $mergeFile -Force -ErrorAction SilentlyContinue
    }

    $artifact = Get-ChildItem -LiteralPath $NsisBundleDir -Filter *.exe -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $artifact) {
        Write-Status "打包完成但未找到 nsis 产物，请检查 $NsisBundleDir" 1
        exit 1
    }
    Write-Status ("产物已生成 ({0:N1} MB)" -f ($artifact.Length / 1MB)) 0
    Write-Host $artifact.FullName -ForegroundColor Green
}

# 从注册表卸载项中定位已安装的 DockPilot（NSIS 安装器写入）
function Get-InstalledPackage {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            $props = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
            if ($props -and $props.DisplayName -like 'DockPilot*') { return $props }
        }
    }
    return $null
}

# 启动安装/卸载程序；若目标为 per-machine 安装需要管理员权限，自动触发 UAC
function Start-InstallerProcess([string]$FilePath, [string]$Arguments) {
    try {
        return Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru
    } catch {
        if ($_.Exception.Message -match 'elevation|提升') {
            Write-Status "该操作需要管理员权限，请在 UAC 弹窗中确认" 2
            return Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru -Verb RunAs
        }
        throw
    }
}

# 安装最新的 NSIS 安装包（/S 静默）
function Invoke-Install {
    $installer = Get-ChildItem -LiteralPath $NsisBundleDir -Filter *.exe -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) {
        Write-Status "未找到 NSIS 安装包，请先打包: .\management.ps1 build" 1
        exit 1
    }

    $debVersion = ''
    $m = [regex]::Match($installer.Name, '_(\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?)_x64-setup\.exe$')
    if ($m.Success) { $debVersion = $m.Groups[1].Value }

    $installed = Get-InstalledPackage
    if ($installed) {
        Write-Status "已安装 $($installed.DisplayName) $($installed.DisplayVersion)，安装包版本 $debVersion" 0
        if (-not $Yes) {
            if ("$($installed.DisplayVersion)" -eq $debVersion) {
                $confirm = Read-Host "版本相同，是否覆盖重装? [y/N]"
            } else {
                $confirm = Read-Host "是否升级/更换到安装包版本? [y/N]"
            }
            if ($confirm -notmatch '^[yY]$') {
                Write-Status "已取消安装" 2
                exit 0
            }
        }
    }

    Write-Status "安装 $($installer.FullName) ..." 0
    $proc = Start-InstallerProcess $installer.FullName '/S'
    if ($proc.ExitCode -ne 0) {
        Write-Status "安装 失败 (退出码 $($proc.ExitCode))" 1
        exit 1
    }
    $after = Get-InstalledPackage
    if ($after) {
        Write-Status "安装 $($after.DisplayName) $($after.DisplayVersion) 完成" 0
    } else {
        Write-Status "安装 完成" 0
    }
    Write-Host "安装完成，可从开始菜单启动 DockPilot"
}

# 卸载已安装的 DockPilot（/S 静默）
function Invoke-Uninstall {
    $installed = Get-InstalledPackage
    if (-not $installed) {
        Write-Status "DockPilot 未安装，无需卸载" 2
        exit 0
    }
    if (-not $installed.UninstallString) {
        Write-Status "未找到卸载程序（注册表 UninstallString 为空）" 1
        exit 1
    }

    Write-Status "卸载 $($installed.DisplayName) $($installed.DisplayVersion) ..." 0
    $uninstPath = $installed.UninstallString.Trim().Trim('"')
    Start-InstallerProcess $uninstPath '/S' | Out-Null

    # NSIS 卸载器会自复制到临时目录执行，-Wait 返回时可能尚未清理完，轮询注册表确认
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-InstalledPackage) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (Get-InstalledPackage) {
        Write-Status "卸载程序已执行，但注册表卸载项仍存在，请稍后手动确认" 2
    } else {
        Write-Status "卸载 完成" 0
    }
}

# 启动开发调试
function Invoke-Dev {
    Set-Location $ProjectDir
    Initialize-BuildEnvironment
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'node_modules'))) {
        Write-Status "安装前端依赖 (npm install)..." 0
        & npm install
        Assert-LastExitCode "前端依赖安装"
    }
    & npm run tauri dev
}

# 前端测试（vitest run）
function Invoke-FrontendTest {
    Set-Location $ProjectDir
    Initialize-BuildEnvironment
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'node_modules'))) {
        Write-Status "安装前端依赖 (npm install)..." 0
        & npm install
        Assert-LastExitCode "前端依赖安装"
    }
    & npm test
    Assert-LastExitCode "前端测试"
}

# Rust 命令统一入口
function Invoke-RustCommand {
    param([string]$Title, [string[]]$CargoArgs)
    Set-Location (Join-Path $ProjectDir 'src-tauri')
    Initialize-BuildEnvironment
    Write-Status "执行 cargo $($CargoArgs -join ' ') ..." 0
    & cargo @CargoArgs
    Assert-LastExitCode $Title
}

function Invoke-RustTest   { Invoke-RustCommand 'Rust 测试'     @('test') }
function Invoke-RustCheck  { Invoke-RustCommand 'Rust 类型检查' @('check') }
function Invoke-RustClippy { Invoke-RustCommand 'Rust 静态检查' @('clippy', '--', '-D', 'warnings') }

# 显示帮助
function Show-Help {
    Write-Host "用法: .\management.ps1 [build [版本号] | version <版本号> | install | uninstall | dev | test | cargo-test | check | clippy | -h|--help]"
    Write-Host ""
    Write-Host "命令:"
    Write-Host "  build [版本号]      打包 NSIS 安装包；传版本号时先同步更新项目版本，"
    Write-Host "                      打包版本自动附加日期（如 1.0.5+20261007），完成输出构建耗时"
    Write-Host "  version <版本号>    同步更新版本号（package.json / package-lock.json /"
    Write-Host "                      Cargo.toml / Cargo.lock / tauri.conf.json），不执行构建"
    Write-Host "  install [-Yes]      静默安装最新的 NSIS 安装包（-Yes 跳过覆盖/升级确认）"
    Write-Host "  uninstall           静默卸载已安装的 DockPilot"
    Write-Host "  dev                 启动开发调试（npm run tauri dev）"
    Write-Host "  test                前端测试（vitest run）"
    Write-Host "  cargo-test          Rust 测试（cargo test）"
    Write-Host "  check               Rust 类型检查（cargo check）"
    Write-Host "  clippy              Rust 静态检查（cargo clippy -- -D warnings）"
    Write-Host "  -h,--help           显示帮助"
    Write-Host ""
    Write-Host "示例:"
    Write-Host "  .\management.ps1 build"
    Write-Host "  .\management.ps1 build 0.3.2"
    Write-Host "  .\management.ps1 version 0.3.2"
    Write-Host "  .\management.ps1 install"
    Write-Host "  .\management.ps1 uninstall"
    Write-Host "  .\management.ps1 test"
}

# 交互菜单
function Show-Menu {
    Write-Host "请选择操作:"
    Write-Host "  1) 打包 NSIS 安装包"
    Write-Host "  2) 安装安装包"
    Write-Host "  3) 卸载"
    Write-Host "  4) 开发调试 (tauri dev)"
    Write-Host "  5) 前端测试 (vitest)"
    Write-Host "  h) 帮助  q) 退出"
    $choice = Read-Host "输入选项"
    switch -regex ($choice) {
        '^1$'    { Invoke-Build }
        '^2$'    { Invoke-Install }
        '^3$'    { Invoke-Uninstall }
        '^4$'    { Invoke-Dev }
        '^5$'    { Invoke-FrontendTest }
        '^[hH]$' { Show-Help }
        '^[qQ]$' { exit 0 }
        '^$'     { exit 0 }
        default  { Write-Status "无效选项: $choice" 1; exit 1 }
    }
}

Write-Host "================================================================"
Write-Host "          DockPilot 打包/安装/卸载工具 (Windows)"
Write-Host "================================================================"
Write-Host ""

switch ($Command) {
    'build'      { Invoke-Build $VersionArg }
    'version'    {
        if (-not $VersionArg) {
            Write-Status "请传入版本号，例如: .\management.ps1 version 0.3.2" 1
            exit 1
        }
        Update-AppVersion $VersionArg
    }
    'install'    { Invoke-Install }
    'uninstall'  { Invoke-Uninstall }
    'dev'        { Invoke-Dev }
    'test'       { Invoke-FrontendTest }
    'cargo-test' { Invoke-RustTest }
    'check'      { Invoke-RustCheck }
    'clippy'     { Invoke-RustClippy }
    'help'       { Show-Help }
    '-h'         { Show-Help }
    '--help'     { Show-Help }
    ''           { Show-Menu }
    default      { Write-Status "未知选项: $Command" 1; Show-Help; exit 1 }
}

Write-Host ""
Write-Host "================================================================"
Write-Status "脚本执行完成" 0
Write-Host "================================================================"
