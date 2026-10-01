; ============================================================
;  installer.nsh —— 卸载时的自定义逻辑
;
;  为什么需要它：
;    electron-builder 的默认行为是**卸载时保留**用户数据目录
;    （%APPDATA%\proxy-bridge\），目的是让重装后不用重新配置。
;    但那个目录里存着服务器地址、账号与 DPAPI 加密后的密码，
;    转手电脑或把安装包给别人用时，卸载后这些数据会留在机器上。
;
;  所以在这里加一次询问，把决定权交给卸载的人：
;    选「是」→ 连同配置与缓存一起删除（彻底清干净）
;    选「否」→ 保留配置，下次重装可直接用（默认）
;
;  删除范围：仅本应用自己的两个目录，不动系统或其它软件的任何数据。
; ============================================================

!macro customUnInit

  ; silent 安装（/S）时不弹窗，直接保留数据 —— 静默卸载却清掉配置是最糟的结果
  IfSilent lbl_skip_uninstall_choice

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除本机保存的配置与缓存？$\r$\n$\r$\n\
     包含：代理服务器地址、账号与密码（已加密）、直连规则、隧道设置。$\r$\n$\r$\n\
     · 选「是」：彻底清除，不留任何痕迹$\r$\n\
     · 选「否」：保留配置，下次安装可直接使用（推荐）" \
    /SD IDNO \
    IDYES lbl_purge_data IDNO lbl_skip_uninstall_choice

  lbl_purge_data:
    DetailPrint "正在清除本机配置与缓存…"
    ; 配置与浏览器缓存（含 config.json）
    RMDir /r "$APPDATA\proxy-bridge"
    ; electron-builder 更新器留下的解压缓存，可能占数十 MB
    RMDir /r "$LOCALAPPDATA\proxy-bridge-updater"

  lbl_skip_uninstall_choice:

!macroend
