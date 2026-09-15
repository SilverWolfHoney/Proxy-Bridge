import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig, DeepPartial, ProxyBridgeApi, SafeConfig } from '../../shared/types';

/** 界面组件用它提交配置改动 */
export type ConfigUpdater = (patch: DeepPartial<AppConfig>) => void;

export interface UseConfigResult {
  config: SafeConfig | null;
  patch: ConfigUpdater;
  /** 立即把待写入的改动落盘，返回后配置已生效 */
  flush: () => Promise<void>;
}

/**
 * 配置状态管理：界面改动先更新本地状态，随后防抖写入主进程，
 * 这样输入框不会每敲一个字符就写一次磁盘。
 * 通过 flush() 可以在「启动网关」「测试连接」前确保配置已经落盘。
 */
export function useConfig(api: ProxyBridgeApi): UseConfigResult {
  const [config, setConfig] = useState<SafeConfig | null>(null);
  const configRef = useRef<SafeConfig | null>(null);
  const pendingRef = useRef<DeepPartial<AppConfig> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setBoth = useCallback((next: SafeConfig) => {
    configRef.current = next;
    setConfig(next);
  }, []);

  useEffect(() => {
    let alive = true;
    void api.getConfig().then((loaded) => {
      if (alive) setBoth(loaded);
    });
    return () => {
      alive = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [api, setBoth]);

  /** 深合并补丁：对象递归合并，数组与标量直接覆盖 */
  const merge = (base: DeepPartial<AppConfig>, patch: DeepPartial<AppConfig>): DeepPartial<AppConfig> => {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === undefined) continue;
      const prev = result[key];
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        prev !== null &&
        typeof prev === 'object' &&
        !Array.isArray(prev)
      ) {
        result[key] = merge(prev as DeepPartial<AppConfig>, value as DeepPartial<AppConfig>);
      } else {
        result[key] = value;
      }
    }
    return result as DeepPartial<AppConfig>;
  };

  const doSave = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const patch = pendingRef.current;
    if (!patch) return;
    pendingRef.current = null;
    try {
      const saved = await api.saveConfig(patch);
      setBoth(saved);
    } catch (err) {
      console.error('[useConfig] 保存配置失败：', err);
    }
  }, [api, setBoth]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void doSave();
    }, 500);
  }, [doSave]);

  const patch = useCallback(
    (next: DeepPartial<AppConfig>) => {
      pendingRef.current = pendingRef.current ? merge(pendingRef.current, next) : next;
      const current = configRef.current;
      if (current) {
        // 乐观更新：界面立即反映输入，稍后由主进程返回的权威值校正
        const optimistic = merge(current as unknown as DeepPartial<AppConfig>, next) as unknown as SafeConfig;
        setBoth({ ...current, ...optimistic });
      }
      scheduleSave();
    },
    [scheduleSave, setBoth],
  );

  const flush = useCallback(async () => {
    await doSave();
  }, [doSave]);

  return { config, patch, flush };
}
