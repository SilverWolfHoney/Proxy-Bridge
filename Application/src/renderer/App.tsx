import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, DeepPartial } from '../shared/types';
import { HomePage } from './components/HomePage';
import { useConfig } from './hooks/useConfig';
import type { GeneratedKeyInfo, GlobalProxyState, TestResult, TunnelTestResult } from '../shared/types';

const INITIAL_GLOBAL_STATE: GlobalProxyState = {
  enabled: false,
  phase: 'off',
  listen: null,
  error: null,
  tunnel: null,
};

export function App(): JSX.Element {
  const api = window.proxyBridge;
  const { config, patch, flush, reload } = useConfig(api);

  const [globalState, setGlobalState] = useState<GlobalProxyState>(INITIAL_GLOBAL_STATE);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 每次清空配置后自增，用作 HomePage 的 key 以重置其内部 state */
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    let alive = true;

    void (async () => {
      const state = await api.getGlobalProxyState();
      if (!alive) return;
      setGlobalState(state);
      setReady(true);
    })();

    // 主进程是状态的唯一来源，切换过程中会持续推送阶段变化
    const off = api.onGlobalProxyState((state) => {
      if (alive) setGlobalState(state);
    });

    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        // 先把界面上正在编辑的内容落盘，否则切换用的还是旧参数
        await flush();
        const result = await api.setGlobalProxy(enabled);
        setGlobalState(result.state);
      } finally {
        setBusy(false);
      }
    },
    [api, flush],
  );

  const handleTest = useCallback(
    async (input?: Record<string, unknown>): Promise<TestResult> => {
      await flush();
      return api.testUpstream(input);
    },
    [api, flush],
  );

  /** 隧道试连同样先把界面上的参数落盘，否则测的是旧参数 */
  const handleTestTunnel = useCallback(
    async (input?: Record<string, unknown>): Promise<TunnelTestResult> => {
      await flush();
      return api.testTunnel(input);
    },
    [api, flush],
  );

  /**
   * 清空本机配置。
   *
   * 主进程负责先把全局代理关掉再清数据；这里 reload 拿回权威的空配置，
   * 再递增 resetKey 让 HomePage 整体重新挂载——界面里散落着若干文本域与
   * 密码框的本地 state，重新挂载比逐个手动同步更不容易漏。
   */
  const handleClearConfig = useCallback(async () => {
    await api.clearConfig();
    await reload();
    setResetKey((k) => k + 1);
  }, [api, reload]);

  /**
   * 生成一对新的 SSH 密钥。
   *
   * 生成后把路径写进配置：调用方紧接着就会点「测试隧道」，
   * 配置不落盘的话测的仍是旧路径。
   */
  const handleGenerateKey = useCallback(async (): Promise<GeneratedKeyInfo> => {
    const key = await api.generateKey({});
    await api.saveConfig({ tunnel: { keyPath: key.privateKeyPath } });
    await reload();
    return key;
  }, [api, reload]);

  const handlePatch = useCallback((next: DeepPartial<AppConfig>) => patch(next), [patch]);

  if (!ready || !config) {
    return (
      <div className="app app--centered">
        <div className="loading">正在读取配置…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">PB</span>
          <span className="brand-text">
            <span className="brand-title">Proxy Bridge</span>
            <span className="brand-sub">全局代理</span>
          </span>
        </div>
        <span className={`badge ${globalState.enabled ? 'badge-running' : 'badge-stopped'}`}>
          <span className="dot" />
          {globalState.enabled ? '运行中' : '未开启'}
        </span>
      </header>

      <main className="content">
        <HomePage
          key={resetKey}
          config={config}
          globalState={globalState}
          patch={handlePatch}
          flush={flush}
          onToggle={handleToggle}
          busy={busy}
          testUpstream={handleTest}
          testTunnel={handleTestTunnel}
          onClearConfig={handleClearConfig}
          onGenerateKey={handleGenerateKey}
        />
      </main>
    </div>
  );
}
