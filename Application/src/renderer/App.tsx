import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppConfig,
  BridgeStatus,
  ConnRecord,
  DeepPartial,
  SafeConfig,
  TestResult,
} from '../shared/types';
import { ConfigPage } from './components/ConfigPage';
import { RulesPage } from './components/RulesPage';
import { LogsPage } from './components/LogsPage';
import { AboutPage } from './components/AboutPage';
import { Stats, StatusBadge } from './components/Stats';
import { useConfig } from './hooks/useConfig';

type TabKey = 'config' | 'rules' | 'logs' | 'about';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'config', label: '代理服务器', icon: '⚙' },
  { key: 'rules', label: '分流规则', icon: '⇄' },
  { key: 'logs', label: '连接日志', icon: '≡' },
  { key: 'about', label: '插件 / 关于', icon: '⌘' },
];

const EMPTY_STATUS: BridgeStatus = {
  state: 'stopped',
  listen: null,
  error: null,
  stats: {
    totalConnections: 0,
    activeConnections: 0,
    failedConnections: 0,
    bytesUp: 0,
    bytesDown: 0,
    startedAt: null,
  },
  systemProxyApplied: false,
};

export function App(): JSX.Element {
  const [tab, setTab] = useState<TabKey>('config');
  const [status, setStatus] = useState<BridgeStatus>(EMPTY_STATUS);
  const [connections, setConnections] = useState<ConnRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const api = window.proxyBridge;
  const { config, patch, flush } = useConfig(api);

  // 事件订阅只建立一次；用 ref 持有最新的记录写入逻辑避免重复订阅
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const [initialStatus, initialConnections] = await Promise.all([
        api.getStatus(),
        api.getConnections(),
      ]);
      if (!mounted.current) return;
      setStatus(initialStatus);
      setConnections(initialConnections.slice().reverse());
      setReady(true);
    })();

    const offStatus = api.onStatus((next) => {
      if (mounted.current) setStatus(next);
    });
    const offConn = api.onConnection((record) => {
      if (!mounted.current) return;
      setConnections((prev) => [record, ...prev].slice(0, 300));
    });

    return () => {
      offStatus();
      offConn();
    };
  }, [api]);

  /** 统一处理「先落盘再执行」，避免用未保存的配置去启动网关 */
  const withFlush = useCallback(
    async (action: () => Promise<BridgeStatus | void>) => {
      setBusy(true);
      try {
        await flush();
        const result = await action();
        if (result) setStatus(result);
      } finally {
        setBusy(false);
      }
    },
    [flush],
  );

  const handleStart = useCallback(() => {
    void withFlush(async () => api.startBridge());
  }, [withFlush, api]);

  const handleStop = useCallback(() => {
    void withFlush(async () => api.stopBridge());
  }, [withFlush, api]);

  const handleToggleSystemProxy = useCallback(
    (enabled: boolean) => {
      void withFlush(async () => api.applySystemProxy(enabled));
    },
    [withFlush, api],
  );

  const handleTest = useCallback(
    async (input?: Record<string, unknown>): Promise<TestResult> => {
      await flush();
      return api.testUpstream(input);
    },
    [flush, api],
  );

  const handleClearConnections = useCallback(() => {
    void api.clearConnections().then(() => setConnections([]));
  }, [api]);

  const handlePatch = useCallback(
    (next: DeepPartial<AppConfig>) => patch(next),
    [patch],
  );

  if (!ready || !config) {
    return (
      <div className="app">
        <div className="empty-state">正在初始化…</div>
      </div>
    );
  }

  const safeConfig: SafeConfig = config;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">PB</span>
          <span>Proxy Bridge</span>
        </div>

        <StatusBadge status={status} />

        {status.listen && (
          <span className="field-hint">
            监听 <span className="code-inline">{status.listen}</span>
          </span>
        )}

        {status.systemProxyApplied && (
          <span className="badge badge-warn">
            <span className="dot" />
            系统代理已接管
          </span>
        )}

        <div className="header-spacer" />

        {status.state === 'running' ? (
          <button className="btn btn-danger" onClick={handleStop} disabled={busy}>
            停止网关
          </button>
        ) : (
          <button className="btn btn-primary" onClick={handleStart} disabled={busy}>
            启动网关
          </button>
        )}
      </header>

      <div className="app-body">
        <nav className="sidebar">
          {TABS.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${tab === item.key ? 'active' : ''}`}
              onClick={() => setTab(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
              {item.key === 'logs' && connections.length > 0 && (
                <span className="field-hint" style={{ marginLeft: 'auto' }}>
                  {connections.length}
                </span>
              )}
            </button>
          ))}

          <div className="sidebar-footer">
            <div style={{ marginBottom: 6 }}>
              <Stats status={status} />
            </div>
            仅监听本机回环
          </div>
        </nav>

        <main className="content">
          {tab === 'config' && (
            <ConfigPage
              config={safeConfig}
              status={status}
              patch={handlePatch}
              testUpstream={handleTest}
              onStart={handleStart}
              onStop={handleStop}
              onToggleSystemProxy={handleToggleSystemProxy}
              busy={busy}
            />
          )}

          {tab === 'rules' && <RulesPage config={safeConfig} patch={handlePatch} />}

          {tab === 'logs' && (
            <LogsPage connections={connections} status={status} onClear={handleClearConnections} />
          )}

          {tab === 'about' && <AboutPage bridgePort={safeConfig.bridge.port} />}
        </main>
      </div>
    </div>
  );
}
