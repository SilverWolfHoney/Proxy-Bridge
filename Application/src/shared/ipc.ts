/**
 * IPC 通道名称常量。
 * 预加载脚本与主进程共用同一份定义，避免字符串拼写不一致。
 */
export const IPC = {
  getConfig: 'config:get',
  saveConfig: 'config:save',
  /** 清空本机保存的全部配置（含加密的凭据），用于卸载前主动抹掉痕迹 */
  clearConfig: 'config:clear',
  getStatus: 'bridge:status',
  testUpstream: 'upstream:test',

  /* 全局代理：界面上只有一个开关，背后是「启网关 + 接管系统代理」 */
  getGlobalProxyState: 'globalProxy:get',
  setGlobalProxy: 'globalProxy:set',
  globalProxyEvent: 'globalProxy:changed',

  /* 内置 SSH 隧道 */
  testTunnel: 'tunnel:test',
  getTunnelStatus: 'tunnel:status',

  openPath: 'shell:openPath',
  appInfo: 'app:info',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
