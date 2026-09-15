import type { ProxyBridgeApi } from '../shared/types';

declare global {
  interface Window {
    proxyBridge: ProxyBridgeApi;
  }
}

export {};
