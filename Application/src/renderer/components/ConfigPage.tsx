import { useCallback, useState } from 'react';
import type { AppConfig, BridgeStatus, DeepPartial, SafeConfig, TestResult } from '../../shared/types';
import { isUpstreamConfigured } from '../../shared/types';
import { formatLatency } from '../utils';

export type ConfigUpdater = (patch: DeepPartial<AppConfig>) => void;

export interface ConfigPageProps {
  config: SafeConfig;
  status: BridgeStatus;
  patch: ConfigUpdater;
  testUpstream: (input?: Record<string, unknown>) => Promise<TestResult>;
  onStart: () => void;
  onStop: () => void;
  onToggleSystemProxy: (enabled: boolean) => void;
  busy: boolean;
}

export function ConfigPage(props: ConfigPageProps): JSX.Element {
  const { config, status, busy } = props;
  const { upstream, bridge, systemProxy } = config;

  // 密码单独维护：留空表示「不修改已保存的密码」
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const configured = isUpstreamConfigured(upstream);
  const running = status.state === 'running';

  const runTest = useCallback(async () => {
    if (!configured) {
      setTestError('请先填写服务器地址和端口');
      setTestResult(null);
      return;
    }
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await props.testUpstream({
        protocol: upstream.protocol,
        host: upstream.host,
        port: upstream.port,
        authEnabled: upstream.authEnabled,
        username: upstream.username,
        password,
      });
      setTestResult(result);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [configured, props, upstream, password]);

  return (
    <div>
      <h1 className="page-title">代理服务器</h1>
      <p className="page-desc">
        填写你自己的远程代理服务器信息。凭据只保存在本机（系统加密存储），不会写进代码、日志，也不会下发给浏览器插件。
      </p>

      {!configured && (
        <div className="alert alert-info">
          <span className="alert-icon">ℹ</span>
          <div>
            <strong>还没有配置服务器。</strong>
            填好下面的地址、端口和账号，点「测试连接」验证通过后，再点「启动网关」。
          </div>
        </div>
      )}

      {status.error && (
        <div className="alert alert-error">
          <span className="alert-icon">⚠</span>
          <div>{status.error}</div>
        </div>
      )}

      <div className="card">
        <h2 className="card-title">远程服务器</h2>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">协议</span>
            <select
              className="select"
              value={upstream.protocol}
              onChange={(e) =>
                props.patch({ upstream: { protocol: e.target.value as AppConfig['upstream']['protocol'] } })
              }
            >
              <option value="http">HTTP 代理</option>
              <option value="https">HTTPS 代理</option>
              <option value="socks5">SOCKS5</option>
            </select>
            <span className="field-hint">按服务商提供的协议选择，两种都支持时建议 SOCKS5</span>
          </label>

          <label className="field">
            <span className="field-label">服务器地址</span>
            <input
              className="input input-mono"
              value={upstream.host}
              placeholder="例如 203.0.113.10 或 proxy.example.com"
              spellCheck={false}
              onChange={(e) => props.patch({ upstream: { host: e.target.value } })}
            />
            <span className="field-hint">不要带 http:// 前缀</span>
          </label>

          <label className="field">
            <span className="field-label">端口</span>
            <input
              className="input input-mono"
              type="number"
              min={1}
              max={65535}
              value={upstream.port || ''}
              placeholder="例如 1080"
              onChange={(e) => props.patch({ upstream: { port: Number(e.target.value) } })}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">认证信息</h2>

        <label className="switch" style={{ marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={upstream.authEnabled}
            onChange={(e) => props.patch({ upstream: { authEnabled: e.target.checked } })}
          />
          <span className="switch-track" />
          <span className="switch-label">服务器需要用户名密码认证</span>
        </label>

        {upstream.authEnabled && (
          <div className="form-grid">
            <label className="field">
              <span className="field-label">用户名</span>
              <input
                className="input input-mono"
                value={upstream.username}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => props.patch({ upstream: { username: e.target.value } })}
              />
              <span className="field-hint">区分大小写，请与服务商提供的一致</span>
            </label>

            <label className="field">
              <span className="field-label">密码</span>
              <div className="input-group">
                <input
                  className="input input-mono"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={upstream.hasPassword ? '已保存（留空表示不修改）' : '请输入密码'}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => {
                    if (password !== '') {
                      props.patch({ upstream: { password } });
                      setPassword('');
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowPassword((v) => !v)}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </div>
              <span className="field-hint">
                {upstream.hasPassword ? '✓ 已在本机加密保存' : '尚未保存密码'}
              </span>
            </label>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">本机网关</h2>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">监听端口</span>
            <input
              className="input input-mono"
              type="number"
              min={1}
              max={65535}
              value={bridge.port}
              disabled={running}
              onChange={(e) => props.patch({ bridge: { port: Number(e.target.value) } })}
            />
            <span className="field-hint">{running ? '修改端口需先停止网关' : '浏览器插件要填同一个端口'}</span>
          </label>

          <label className="field">
            <span className="field-label">监听地址</span>
            <input className="input input-mono" value={bridge.host} disabled />
            <span className="field-hint">仅监听本机回环，局域网其他设备无法访问</span>
          </label>

          <div className="field">
            <span className="field-label">启动时自动开启</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={bridge.autoStart}
                onChange={(e) => props.patch({ bridge: { autoStart: e.target.checked } })}
              />
              <span className="switch-track" />
              <span className="switch-label">打开应用即启动网关</span>
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">操作</h2>

        <div className="btn-row" style={{ marginBottom: 14 }}>
          <button className="btn btn-primary" onClick={runTest} disabled={testing || !configured}>
            {testing ? <span className="spinner" /> : '⚡'}
            {testing ? '测试中…' : '测试连接'}
          </button>

          {running ? (
            <button className="btn btn-danger" onClick={props.onStop} disabled={busy}>
              停止网关
            </button>
          ) : (
            <button className="btn btn-primary" onClick={props.onStart} disabled={busy || !configured}>
              启动网关
            </button>
          )}

          <span className="field-hint">
            {running
              ? `网关正在 ${status.listen ?? ''} 上等待浏览器连接`
              : '启动后浏览器插件或系统代理才能把流量交给它'}
          </span>
        </div>

        {testError && (
          <div className="alert alert-error" style={{ marginBottom: 0 }}>
            <span className="alert-icon">⚠</span>
            <div>{testError}</div>
          </div>
        )}

        {testResult && (
          <div
            className={`alert ${testResult.ok ? 'alert-success' : 'alert-error'}`}
            style={{ marginBottom: 0 }}
          >
            <span className="alert-icon">{testResult.ok ? '✓' : '⚠'}</span>
            <div>
              <div>{testResult.ok ? `连接成功，握手耗时 ${formatLatency(testResult.latencyMs)}` : '连接失败'}</div>
              <div style={{ marginTop: 2, opacity: 0.9 }}>
                {testResult.ok ? (
                  <>
                    出口 IP：<span className="code-inline">{testResult.exitIp ?? '未取到'}</span>
                    {testResult.exitIp && ' —— 这就是目标网站看到的来源地址'}
                  </>
                ) : (
                  testResult.error
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">系统代理</h2>
        <label className="switch">
          <input
            type="checkbox"
            checked={systemProxy.enabled}
            disabled={!running || busy}
            onChange={(e) => props.onToggleSystemProxy(e.target.checked)}
          />
          <span className="switch-track" />
          <span className="switch-label">
            让整个 Windows 的流量走本机网关
            {!running && '（需先启动网关）'}
          </span>
        </label>
        <p className="field-hint" style={{ marginTop: 10, marginBottom: 0 }}>
          开启后会写入系统代理设置，关闭开关或退出应用时自动还原成你原来的设置。
          只影响读取系统代理的程序。如果只想让浏览器走代理，用仓库里的浏览器插件更轻量——
          它是独立的客户端，不需要本应用运行。
        </p>
      </div>
    </div>
  );
}
