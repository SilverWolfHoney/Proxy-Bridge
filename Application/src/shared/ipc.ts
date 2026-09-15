/**
 * IPC 通道名称常量。
 * 预加载脚本与主进程共用同一份定义，避免字符串拼写不一致。
 */
export const IPC = {
  getConfig: 'config:get',
  saveConfig: 'config:save',
  getStatus: 'bridge:status',
  startBridge: 'bridge:start',
  stopBridge: 'bridge:stop',
  testUpstream: 'upstream:test',
  applySystemProxy: 'systemProxy:apply',
  getConnections: 'connections:get',
  clearConnections: 'connections:clear',
  openExternal: 'shell:openExternal',
  openPath: 'shell:openPath',
  getPluginPath: 'app:pluginPath',
  appInfo: 'app:info',
  /** 主进程 → 渲染进程：状态推送 */
  statusEvent: 'bridge:status:changed',
  /** 主进程 → 渲染进程：新连接记录 */
  connectionEvent: 'bridge:connection',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
