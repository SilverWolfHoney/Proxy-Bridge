/**
 * 预加载脚本：在隔离环境中把一组精确的 API 暴露给渲染层。
 *
 * 只转发白名单内的通道，渲染层拿不到 ipcRenderer 本身，
 * 也永远拿不到明文密码（主进程只返回脱敏配置）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  AppConfig,
  BridgeStatus,
  DeepPartial,
  GlobalProxyResult,
  GlobalProxyState,
  ProxyBridgeApi,
  SafeConfig,
  TestResult,
} from '../shared/types';

const api: ProxyBridgeApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<SafeConfig>,

  saveConfig: (patch: DeepPartial<AppConfig>) =>
    ipcRenderer.invoke(IPC.saveConfig, patch) as Promise<SafeConfig>,

  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<BridgeStatus>,

  testUpstream: (input) => ipcRenderer.invoke(IPC.testUpstream, input) as Promise<TestResult>,

  getGlobalProxyState: () => ipcRenderer.invoke(IPC.getGlobalProxyState) as Promise<GlobalProxyState>,

  setGlobalProxy: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.setGlobalProxy, enabled) as Promise<GlobalProxyResult>,

  onGlobalProxyState: (listener: (state: GlobalProxyState) => void) => {
    const handler = (_event: unknown, state: GlobalProxyState) => listener(state);
    ipcRenderer.on(IPC.globalProxyEvent, handler);
    return () => ipcRenderer.off(IPC.globalProxyEvent, handler);
  },

  openPath: (target: string) => ipcRenderer.invoke(IPC.openPath, target) as Promise<void>,

  getAppInfo: () =>
    ipcRenderer.invoke(IPC.appInfo) as Promise<{
      version: string;
      electron: string;
      node: string;
      userData: string;
    }>,
};

contextBridge.exposeInMainWorld('proxyBridge', api);

declare global {
  interface Window {
    proxyBridge: ProxyBridgeApi;
  }
}
