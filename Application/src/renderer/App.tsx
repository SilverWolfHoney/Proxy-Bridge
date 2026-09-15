import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, DeepPartial } from '../shared/types';
import { HomePage } from './components/HomePage';
import { useConfig } from './hooks/useConfig';
import type { GlobalProxyState, TestResult } from '../shared/types';

const INITIAL_GLOBAL_STATE: GlobalProxyState = {
  enabled: false,
  phase: 'off',
  listen: null,
  error: null,
};

export function App(): JSX.Element {
  const api = window.proxyBridge;
  const { config, patch, flush } = useConfig(api);

  const [globalState, setGlobalState] = useState<GlobalProxyState>(INITIAL_GLOBAL_STATE);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

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
          config={config}
          globalState={globalState}
          patch={handlePatch}
          flush={flush}
          onToggle={handleToggle}
          busy={busy}
          testUpstream={handleTest}
        />
      </main>
    </div>
  );
}
