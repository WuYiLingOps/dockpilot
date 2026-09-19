#!/bin/bash
#
#********************************************************************
#Author:           YiLing Wu (hj)
#email:            huangjing510@126.com
#Date:             2026-09-19 12:00:00
#FileName:         build_deb.sh
#URL:              https://script.huangjingblog.cn
#Description:      DockPilot deb 打包/安装/卸载脚本
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
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/release/bundle/deb"

# 检查root权限
check_root() {
    if [ $EUID -ne 0 ]; then
        color "该操作需要 root 权限 (sudo ./build_deb.sh $1)" 1
        exit 1
    fi
}

# 定位最新打包出的 deb（文件名为 productName 命名，如 DockPilot_0.1.0_amd64.deb）
find_deb() {
    local deb
    deb=$(ls -t "${BUNDLE_DIR}"/*.deb 2>/dev/null | head -1)
    echo "${deb}"
}

# 打包 deb（版本号自动附加年月日时间戳，如 0.1.0+20260919；打包前清理旧产物）
build_deb() {
    cd "${PROJECT_DIR}" || exit 1
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
    trap 'rm -f "${MERGE_FILE}"' EXIT
    printf '{"version": "%s"}' "${BUILD_VERSION}" > "${MERGE_FILE}"
    color "构建版本: ${BUILD_VERSION}" 0

    color "开始打包 npm run tauri build（release 构建耗时较久）..." 0
    npm run tauri build -- --config "${MERGE_FILE}"
    check_result "打包"

    DEB_FILE=$(find_deb)
    if [ -z "${DEB_FILE}" ]; then
        color "打包完成但未找到 deb 产物，请检查 ${BUNDLE_DIR}" 1
        exit 1
    fi
    color "产物: ${DEB_FILE} ($(ls -lh "${DEB_FILE}" | awk '{print $5}'))" 0
}

# 安装 deb
install_deb() {
    check_root "install"

    DEB_FILE=$(find_deb)
    if [ -z "${DEB_FILE}" ]; then
        color "未找到 deb 安装包，请先打包: ./build_deb.sh build" 1
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
    check_root "uninstall"

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
    echo "用法: $0 [build|install|uninstall]"
    echo ""
    echo "说明: 不传参数时进入交互菜单"
    echo ""
    echo "选项:"
    echo "  build      打包 deb（npm run tauri build）"
    echo "  install    安装最新的 deb（需 sudo）"
    echo "  uninstall  卸载 ${APP_NAME}（需 sudo）"
    echo "  -h,--help  显示帮助"
}

# 交互菜单
show_menu() {
    echo "请选择操作:"
    echo "  1) 打包 deb"
    echo "  2) 安装 deb（需 sudo）"
    echo "  3) 卸载（需 sudo）"
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
        build|package)
            build_deb
            ;;
        install)
            install_deb
            ;;
        uninstall|remove)
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
