; DockPilot Windows NSIS 安装器钩子
;
; 背景：Windows Explorer 按 exe 路径缓存图标，而 Tauri 默认安装器模板在
; 升级安装（/UPDATE）时会跳过重建快捷方式，也没有任何图标缓存刷新调用，
; 导致覆盖安装后桌面/开始菜单快捷方式仍显示旧版本图标（运行中的窗口、
; 任务栏等使用运行时嵌入 PNG 的位置则不受影响）。
;
; 注意：本文件在模板中位于 PRODUCTNAME/MAINBINARYNAME 等宏定义之前被
; include，所有模板宏必须放在下面的宏体内使用，展开时才可见。

!macro NSIS_HOOK_POSTINSTALL
  ; 原位重写已存在的快捷方式（不新建，尊重用户删除/免装快捷方式的选择），
  ; 让快捷方式重新指向当前 exe 并触发重新解析
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}

  StrCpy $0 "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${If} "$AppStartMenuFolder" != ""
    StrCpy $0 "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} $0
    CreateShortcut $0 "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId $0
  ${EndIf}

  ; SHCNE_ASSOCCHANGED：通知 Shell 清空图标/文件关联缓存，
  ; 使按 exe 路径缓存的旧图标立即失效并重新提取
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
