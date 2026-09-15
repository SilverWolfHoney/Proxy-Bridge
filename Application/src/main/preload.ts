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
  ConnRecord,
  DeepPartial,
  ProxyBridgeApi,
  SafeConfig,
  TestResult,
} from '../shared/types';

const api: ProxyBridgeApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<SafeConfig>,

  saveConfig: (patch: DeepPartial<AppConfig>) =>
    ipcRenderer.invoke(IPC.saveConfig, patch) as Promise<SafeConfig>,

  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<BridgeStatus>,

  startBridge: () => ipcRenderer.invoke(IPC.startBridge) as Promise<BridgeStatus>,

  stopBridge: () => ipcRenderer.invoke(IPC.stopBridge) as Promise<BridgeStatus>,

  testUpstream: (input) => ipcRenderer.invoke(IPC.testUpstream, input) as Promise<TestResult>,

  applySystemProxy: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.applySystemProxy, enabled) as Promise<BridgeStatus>,

  getConnections: () => ipcRenderer.invoke(IPC.getConnections) as Promise<ConnRecord[]>,

  clearConnections: () => ipcRenderer.invoke(IPC.clearConnections) as Promise<void>,

  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,

  openPath: (target: string) => ipcRenderer.invoke(IPC.openPath, target) as Promise<void>,

  getPluginPath: () => ipcRenderer.invoke(IPC.getPluginPath) as Promise<string>,

  getAppInfo: () =>
    ipcRenderer.invoke(IPC.appInfo) as Promise<{
      version: string;
      electron: string;
      node: string;
      userData: string;
    }>,

  onStatus: (listener: (status: BridgeStatus) => void) => {
    const handler = (_event: unknown, status: BridgeStatus) => listener(status);
    ipcRenderer.on(IPC.statusEvent, handler);
    return () => ipcRenderer.off(IPC.statusEvent, handler);
  },

  onConnection: (listener: (record: ConnRecord) => void) => {
    const handler = (_event: unknown, record: ConnRecord) => listener(record);
    ipcRenderer.on(IPC.connectionEvent, handler);
    return () => ipcRenderer.off(IPC.connectionEvent, handler);
  },
};

contextBridge.exposeInMainWorld('proxyBridge', api);

declare global {
  interface Window {
    proxyBridge: ProxyBridgeApi;
  }
}
