/**
 * IPC 通道名称常量。
 * 预加载脚本与主进程共用同一份定义，避免字符串拼写不一致。
 */
export const IPC = {
  getConfig: 'config:get',
  saveConfig: 'config:save',
  getStatus: 'bridge:status',
  testUpstream: 'upstream:test',

  /* 全局代理：界面上只有一个开关，背后是「启网关 + 接管系统代理」 */
  getGlobalProxyState: 'globalProxy:get',
  setGlobalProxy: 'globalProxy:set',
  globalProxyEvent: 'globalProxy:changed',

  openPath: 'shell:openPath',
  appInfo: 'app:info',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
