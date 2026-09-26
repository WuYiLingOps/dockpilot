#!/bin/bash
#
#********************************************************************
#Author:           YiLing Wu (hj)
#email:            huangjing510@126.com
#Date:             2026-09-19 12:00:00
#FileName:         management.sh
#URL:              https://script.huangjingblog.cn
#Description:      DockPilot 打包/安装/卸载脚本
#Copyright (C):    2026 All rights reserved
#********************************************************************

# 颜色定义
GREEN="echo -e \E[32;1m"
RED="echo -e \E[31;1m"
YELLOW="echo -e \E[33;1m"
CYAN="echo -e \E[36;1m"
END="\E[0m"

# 日志函数（自动对齐到第 60 列）
color () {
    RES_COL=60
    MOVE_TO_COL="echo -en \\033[${RES_COL}G"
    SETCOLOR_SUCCESS="echo -en \\033[1;32m"
    SETCOLOR_FAILURE="echo -en \\033[1;31m"
    SETCOLOR_WARNING="echo -en \\033[1;33m"
    SETCOLOR_NORMAL="echo -en \E[0m"
    echo -n "$1" && $MOVE_TO_COL
    echo -n "["
    if [ $2 = "success" -o $2 = "0" ] ;then
        ${SETCOLOR_SUCCESS}
        echo -n $" OK "
    elif [ $2 = "failure" -o $2 = "1" ] ;then
        ${SETCOLOR_FAILURE}
        echo -n $"FAILED"
    else
        ${SETCOLOR_WARNING}
        echo -n $"WARNING"
    fi
    ${SETCOLOR_NORMAL}
    echo -n "]"
    echo
}

# 检查执行结果
check_result() {
    if [ $? -eq 0 ]; then
        color "$1 完成" 0
    else
        color "$1 失败" 1
        exit 1
    fi
}

APP_NAME="dock-pilot"   # deb 包名（Tauri 由 productName 生成，dpkg 查询/卸载均用它）
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="${PROJECT_DIR}/$(basename "$0")"
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/release/bundle/deb"
VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'
CARGO_WRAPPER_DIR=''
MERGE_FILE=''

# 清理构建过程生成的临时文件
cleanup_build_files() {
    [ -n "${MERGE_FILE:-}" ] && rm -f "${MERGE_FILE}"
    [ -n "${CARGO_WRAPPER_DIR:-}" ] && rm -rf "${CARGO_WRAPPER_DIR}"
}

# 注入 Cargo 镜像参数
# --config 的优先级高于项目本地和用户全局 Cargo 配置。
# 切换镜像时，成组取消注释目标镜像的三行（镜像名称 + 两行参数），并注释当前启用的三行。
# npm run tauri build 会自行调用 cargo / cargo metadata，不会带上脚本里的 --config，
# 因此需要把同名包装命令放到 PATH 前面，给每一次 cargo 调用补上镜像参数。
setup_cargo_mirror() {
    local real_cargo
    real_cargo=$(type -P cargo)
    if [ -z "${real_cargo}" ]; then
        color "无法定位 cargo 可执行文件" 1
        exit 1
    fi

    # Nexus 内网源（当前启用）
    CARGO_MIRROR_NAME='Nexus 内网源'
    CARGO_REPLACE_ARG='source.crates-io.replace-with="nexus"'
    CARGO_REGISTRY_ARG='source.nexus.registry="sparse+http://nexus.huang.org/repository/cargo-proxy/"'

    # 阿里云源
    # CARGO_MIRROR_NAME='阿里云源'
    # CARGO_REPLACE_ARG='source.crates-io.replace-with="aliyun"'
    # CARGO_REGISTRY_ARG='source.aliyun.registry="sparse+https://mirrors.aliyun.com/crates.io-index/"'

    # 清华源
    # CARGO_MIRROR_NAME='清华源'
    # CARGO_REPLACE_ARG='source.crates-io.replace-with="tuna"'
    # CARGO_REGISTRY_ARG='source.tuna.registry="sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"'

    # 中科大源
    # CARGO_MIRROR_NAME='中科大源'
    # CARGO_REPLACE_ARG='source.crates-io.replace-with="ustc"'
    # CARGO_REGISTRY_ARG='source.ustc.registry="sparse+https://mirrors.ustc.edu.cn/crates.io-index/"'

    if [ -z "${CARGO_MIRROR_NAME}" -o -z "${CARGO_REPLACE_ARG}" -o -z "${CARGO_REGISTRY_ARG}" ]; then
        color "未启用任何 Cargo 镜像源，请取消注释 setup_cargo_mirror 中的目标镜像" 1
        exit 1
    fi

    CARGO_WRAPPER_DIR=$(mktemp -d /tmp/dockpilot-cargo-wrapper-XXXX)
    cat > "${CARGO_WRAPPER_DIR}/cargo" <<EOF
#!/bin/sh
exec "${real_cargo}" \\
    --config '${CARGO_REPLACE_ARG}' \\
    --config '${CARGO_REGISTRY_ARG}' \\
    "\$@"
EOF
    chmod +x "${CARGO_WRAPPER_DIR}/cargo"
    export PATH="${CARGO_WRAPPER_DIR}:${PATH}"
    trap cleanup_build_files EXIT
    color "已注入 Cargo 镜像参数（${CARGO_MIRROR_NAME}）" 0
}

# 需要 root 权限的命令自动通过 sudo 重新执行
ensure_root() {
    if [ "$(id -u)" -eq 0 ]; then
        return 0
    fi
    if ! command -v sudo &> /dev/null; then
        color "该操作需要 root 权限，且未检测到 sudo" 1
        exit 1
    fi
    color "该操作需要 root 权限，正在通过 sudo 重新执行" 0
    exec sudo "${SCRIPT_PATH}" "$@"
}

# 读取当前应用版本（package.json、Cargo.toml、tauri.conf.json 必须保持一致）
read_app_version() {
    local version
    version=$(grep -m1 -oP '"version"\s*:\s*"\K[^"]+' "${PROJECT_DIR}/src-tauri/tauri.conf.json")
    if [ -z "${version}" ]; then
        color "无法从 tauri.conf.json 读取版本号" 1
        exit 1
    fi
    echo "${version}"
}

# 更新应用版本号（同步 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json）
update_version() {
    local version="${1:-}"
    if [ -z "${version}" ] || [[ ! "${version}" =~ ${VERSION_PATTERN} ]]; then
        color "版本号格式无效: ${version:-<空>}（示例: 0.3.1）" 1
        exit 1
    fi

    local package_lock_version
    package_lock_version=$(grep -m1 -oP '"version"\s*:\s*"\K[^"]+' "${PROJECT_DIR}/package-lock.json")
    if [ -z "${package_lock_version}" ]; then
        color "无法从 package-lock.json 读取版本号" 1
        exit 1
    fi

    local current_version
    current_version=$(read_app_version)

    VERSION="${version}" CURRENT_VERSION="${current_version}" PROJECT_DIR="${PROJECT_DIR}" python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ["PROJECT_DIR"])
version = os.environ["VERSION"]
current_version = os.environ["CURRENT_VERSION"]

json_files = [
    root / "package.json",
    root / "package-lock.json",
    root / "src-tauri" / "tauri.conf.json",
]
for path in json_files:
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    if path.name == "package-lock.json":
        data["packages"][""]["version"] = version
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

cargo_toml = root / "src-tauri" / "Cargo.toml"
text = cargo_toml.read_text(encoding="utf-8")
old = f'version = "{current_version}"'
if old not in text:
    raise SystemExit(f"Cargo.toml 当前版本不是 {current_version}")
cargo_toml.write_text(text.replace(old, f'version = "{version}"', 1), encoding="utf-8")

cargo_lock = root / "src-tauri" / "Cargo.lock"
text = cargo_lock.read_text(encoding="utf-8")
marker = 'name = "dockpilot"\nversion = "'
start = text.find(marker)
if start < 0:
    raise SystemExit("Cargo.lock 中未找到 dockpilot 包")
version_start = start + len(marker)
version_end = text.find('"', version_start)
text = text[:version_start] + version + text[version_end:]
cargo_lock.write_text(text, encoding="utf-8")
PY

    color "应用版本已更新为 ${version}" 0
}

# 定位最新打包出的 deb（文件名为 productName 命名，如 DockPilot_0.1.0_amd64.deb）
find_deb() {
    local deb
    deb=$(ls -t "${BUNDLE_DIR}"/*.deb 2>/dev/null | head -1)
    echo "${deb}"
}

# 补充工具链 PATH：sudo/非交互环境下用户级安装的 node(nvm)、cargo(rustup) 不在默认 PATH
prepare_path() {
    local homes=("${HOME}")
    if [ -n "${SUDO_USER:-}" ]; then
        local uh
        uh=$(getent passwd "${SUDO_USER}" 2>/dev/null | cut -d: -f6)
        [ -n "${uh}" ] && homes+=("${uh}")
    fi
    local h p
    for h in "${homes[@]}"; do
        for p in "${h}/.cargo/bin" "${h}/.local/bin" "${h}"/.nvm/versions/node/*/bin; do
            [ -d "${p}" ] || continue
            case ":${PATH}:" in
                *":${p}:"*) ;;
                *) PATH="${p}:${PATH}" ;;
            esac
        done
    done
    export PATH
}

# 打包 deb（版本号自动附加年月日时间戳，如 0.1.0+20260919；打包前清理旧产物）
build_deb() {
    local requested_version="${1:-}"
    # sudo 下打包自动降权：rustup/cargo/npm 依赖原用户的家目录环境（RUSTUP_HOME 等），
    # root 直接跑会因找不到工具链失败，还会把缓存文件以 root 属主写进用户目录
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
        color "检测到 root 环境，打包阶段降权为 ${SUDO_USER} 执行" 0
        if [ -n "${requested_version}" ]; then
            sudo -u "${SUDO_USER}" "${SCRIPT_PATH}" build "${requested_version}"
        else
            sudo -u "${SUDO_USER}" "${SCRIPT_PATH}" build
        fi
        if [ $? -ne 0 ]; then
            color "打包失败" 1
            exit 1
        fi
        return
    fi

    cd "${PROJECT_DIR}" || exit 1
    prepare_path
    color "项目目录: ${PROJECT_DIR}" 0

    # 构建环境检查
    for cmd in node npm cargo rustc; do
        if ! command -v $cmd &> /dev/null; then
            color "缺少依赖命令: $cmd" 1
            if [ "$cmd" = "cargo" -o "$cmd" = "rustc" ]; then
                echo "      安装 Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
            fi
            exit 1
        fi
    done
    if ! dpkg -s libwebkit2gtk-4.1-dev &> /dev/null; then
        color "未检测到 libwebkit2gtk-4.1-dev，Tauri 构建可能失败" 2
        echo "      安装: sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev"
    fi
    setup_cargo_mirror
    color "构建环境检查通过 (node $(node -v) / cargo $(cargo -V | awk '{print $2}'))" 0

    # 前端依赖
    if [ ! -d node_modules ]; then
        color "安装前端依赖 (npm install)..." 0
        npm install
        check_result "前端依赖安装"
    fi

    # 打包：注入带日期的版本号（--config 以 JSON merge 覆盖 tauri.conf.json 的 version）
    if [ -d "${BUNDLE_DIR}" ]; then
        rm -f "${BUNDLE_DIR}"/*.deb
        color "已清理旧安装包" 0
    fi

    BASE_VERSION=$(grep -m1 -oP '"version"\s*:\s*"\K[^"]+' "${PROJECT_DIR}/src-tauri/tauri.conf.json")
    if [ -z "${BASE_VERSION}" ]; then
        color "无法从 tauri.conf.json 读取版本号" 1
        exit 1
    fi
    BUILD_VERSION="${BASE_VERSION}+$(date +%Y%m%d)"
    MERGE_FILE=$(mktemp /tmp/tauri-version-XXXX.json)
    trap cleanup_build_files EXIT
    printf '{"version": "%s"}' "${BUILD_VERSION}" > "${MERGE_FILE}"
    color "构建版本: ${BUILD_VERSION}" 0

    color "开始打包 npm run tauri build（release 构建耗时较久）..." 0
    npm run tauri build -- --config "${MERGE_FILE}"
    check_result "打包"

    DEB_FILE=$(find_deb)
    if [ -z "${DEB_FILE}" ]; then
        color "打包完成但未找到 deb 产物，请检查 ${BUNDLE_DIR#${PROJECT_DIR}/}" 1
        exit 1
    fi
    local deb_rel deb_size
    deb_rel="${DEB_FILE#${PROJECT_DIR}/}"
    deb_size=$(ls -lh "${DEB_FILE}" | awk '{print $5}')
    color "安装包已生成 (${deb_size})" 0
    ${GREEN}${deb_rel}${END}
}

# 安装 deb
install_deb() {
    ensure_root install

    DEB_FILE=$(find_deb)
    if [ -z "${DEB_FILE}" ]; then
        color "未找到 deb 安装包，请先打包: ./management.sh build" 1
        exit 1
    fi
    DEB_FILE=$(realpath "${DEB_FILE}")

    # 已安装则确认覆盖
    if dpkg -s ${APP_NAME} &> /dev/null; then
        local installed_ver
        installed_ver=$(dpkg-query -W -f='${Version}' ${APP_NAME})
        local deb_ver
        deb_ver=$(dpkg-deb -f "${DEB_FILE}" Version)
        color "已安装 ${APP_NAME} ${installed_ver}，安装包版本 ${deb_ver}" 0
        if [ "${installed_ver}" = "${deb_ver}" ]; then
            read -rp "版本相同，是否覆盖重装? [y/N]: " confirm
        else
            read -rp "是否升级/更换到安装包版本? [y/N]: " confirm
        fi
        if [ "$confirm" != "y" -a "$confirm" != "Y" ]; then
            color "已取消安装" 2
            exit 0
        fi
    fi

    color "安装 ${DEB_FILE} ..." 0
    if command -v apt-get &> /dev/null; then
        apt-get install -y "${DEB_FILE}"
    else
        dpkg -i "${DEB_FILE}"
    fi
    check_result "安装 ${APP_NAME} $(dpkg-query -W -f='${Version}' ${APP_NAME} 2>/dev/null)"

    # 应用需要访问 docker.sock，检查当前用户是否在 docker 组
    REAL_USER="${SUDO_USER:-$USER}"
    if ! id -nG "${REAL_USER}" | grep -qw docker; then
        color "用户 ${REAL_USER} 不在 docker 组，应用启动后无法连接 Docker 引擎" 2
        echo "      执行: sudo usermod -aG docker ${REAL_USER} 并重新登录"
    fi
    color "安装完成，可在应用菜单启动 DockPilot" 0
}

# 卸载
uninstall_deb() {
    ensure_root uninstall

    if ! dpkg -s ${APP_NAME} &> /dev/null; then
        color "${APP_NAME} 未安装，无需卸载" 2
        exit 0
    fi

    read -rp "确认卸载 ${APP_NAME} $(dpkg-query -W -f='${Version}' ${APP_NAME})? [y/N]: " confirm
    if [ "$confirm" != "y" -a "$confirm" != "Y" ]; then
        color "已取消卸载" 2
        exit 0
    fi

    apt-get remove -y ${APP_NAME}
    check_result "卸载 ${APP_NAME}"
}

# 显示帮助
show_help() {
    echo "用法: $0 [build [版本号] | version <版本号> | install | uninstall]"
    echo ""
    echo "命令:"
    echo "  build [版本号]      打包 deb；传版本号时先同步更新项目版本"
    echo "  version <版本号>    同步更新版本号，不执行构建"
    echo "  install             安装最新的 deb（自动通过 sudo 提权）"
    echo "  uninstall           卸载 ${APP_NAME}（自动通过 sudo 提权）"
    echo "  -h,--help           显示帮助"
    echo ""
    echo "示例:"
    echo "  $0 build"
    echo "  $0 build 0.3.2"
    echo "  $0 version 0.3.2"
    echo "  $0 install"
    echo "  $0 uninstall"
}

# 交互菜单
show_menu() {
    echo "请选择操作:"
    echo "  1) 打包 deb"
    echo "  2) 安装 deb（自动通过 sudo 提权）"
    echo "  3) 卸载（自动通过 sudo 提权）"
    echo "  h) 帮助  q) 退出"
    local choice
    read -rp "输入选项 [1-3/h/q]: " choice
    case "$choice" in
        1) build_deb ;;
        2) install_deb ;;
        3) uninstall_deb ;;
        h|H) show_help ;;
        q|Q|"") exit 0 ;;
        *) color "无效选项: ${choice}" 1 ; exit 1 ;;
    esac
}

# 主函数
main() {
    echo "================================================================"
    echo "          DockPilot deb 打包/安装/卸载工具"
    echo "================================================================"
    echo ""

    case "${1:-}" in
        build)
            if [ -n "${2:-}" ]; then
                update_version "$2"
            fi
            build_deb "${2:-}"
            ;;
        version)
            if [ -z "${2:-}" ]; then
                color "请传入版本号，例如: $0 version 0.3.2" 1
                exit 1
            fi
            update_version "$2"
            ;;
        install)
            install_deb
            ;;
        uninstall)
            uninstall_deb
            ;;
        -h|--help|help)
            show_help
            ;;
        "")
            show_menu
            ;;
        *)
            color "未知选项: $1" 1
            show_help
            exit 1
            ;;
    esac

    echo ""
    echo "================================================================"
    color "脚本执行完成" 0
    echo "================================================================"
}

main "$@"
