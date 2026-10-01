import { useCallback, useEffect, useState } from 'react';
import type {
  AppConfig,
  GlobalProxyState,
  SafeConfig,
  TestResult,
  TunnelTestResult,
} from '../../shared/types';
import type { ConfigUpdater } from '../hooks/useConfig';
import { DEFAULT_PORTS, formatLatency, protocolLabel } from '../utils';
export interface HomePageProps {
  config: SafeConfig;
  globalState: GlobalProxyState;
  patch: ConfigUpdater;
  flush: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  busy: boolean;
  testUpstream: (input?: Record<string, unknown>) => Promise<TestResult>;
  testTunnel: (input?: Record<string, unknown>) => Promise<TunnelTestResult>;
  /** 清空本机保存的全部配置（服务器地址、凭据、规则、隧道） */
  onClearConfig: () => Promise<void>;
}

const PHASE_TEXT: Record<GlobalProxyState['phase'], string> = {
  off: '未开启',
  starting: '正在启动…',
  applying: '正在接管系统代理…',
  on: '已开启',
  stopping: '正在关闭…',
  error: '出错',
};

/** 隧道状态的中文说明；未启用隧道时返回 null */
function tunnelLabel(state: GlobalProxyState['tunnel']): string | null {
  if (!state) return null;
  switch (state.state) {
    case 'ready':
      return `隧道已连通（${state.listen ?? '—'}）`;
    case 'starting':
      return '隧道建立中…';
    case 'reconnecting':
      return `隧道断开，正在重连${state.reconnects > 1 ? `（第 ${state.reconnects} 次）` : ''}…`;
    case 'error':
      return `隧道异常：${state.error ?? '原因未知'}`;
    default:
      return '隧道未运行';
  }
}

export function HomePage(props: HomePageProps): JSX.Element {
  const { config, globalState, busy } = props;
  const { upstream, bridge, globalProxy, rules, tunnel } = config;

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [testingTunnel, setTestingTunnel] = useState(false);
  const [tunnelTest, setTunnelTest] = useState<TunnelTestResult | null>(null);

  /** 清除配置的二次确认与结果提示 */
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearDone, setClearDone] = useState(false);

  /**
   * 最近一次自动识别出的协议。
   *
   * 识别结果由主进程写进配置，而渲染层的配置缓存不会自动刷新，
   * 所以这里单独记一份：测试成功后立刻就能在界面上显示识别结果。
   */
  const [detected, setDetected] = useState<string | null>(upstream.detectedProtocol ?? null);

  // 配置里的识别结果变了（例如换了服务器被清空）就跟随更新
  useEffect(() => {
    setDetected(upstream.detectedProtocol ?? null);
  }, [upstream.detectedProtocol, upstream.host, upstream.port]);

  // 直连例外用文本域承载，避免每敲一个字符就写一次配置
  const [directText, setDirectText] = useState(() => rules.direct.join('\n'));
  useEffect(() => {
    setDirectText(rules.direct.join('\n'));
  }, [rules.direct]);

  const configured = Boolean(upstream.host.trim() && upstream.port > 0);
  const on = globalState.enabled;
  const transitioning = globalState.phase === 'starting' || globalState.phase === 'applying' || globalState.phase === 'stopping';

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
      // 识别成功就立刻在界面上标出来，不必等配置缓存刷新
      if (result.ok && result.testedProtocol) setDetected(result.testedProtocol);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [configured, props, upstream, password]);

  const commitDirect = () => {
    const list = directText
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith('#'));
    props.patch({ rules: { direct: list } });
  };

  /** 试建一次隧道，把结论显示在按钮下方 */
  const runTunnelTest = useCallback(async () => {
    setTestingTunnel(true);
    setTunnelTest(null);
    try {
      const result = await props.testTunnel({
        user: tunnel.user,
        host: tunnel.host,
        port: tunnel.port,
        keyPath: tunnel.keyPath,
        remotePort: tunnel.remotePort,
      });
      setTunnelTest(result);
    } catch (err) {
      setTunnelTest({
        ok: false,
        latencyMs: null,
        listen: null,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingTunnel(false);
    }
  }, [props, tunnel]);

  /** 清空本机保存的全部配置 */
  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      await props.onClearConfig();
      // 清除后组件会被重新挂载，这里的 setState 只是兜底
      setConfirmClear(false);
      setClearDone(true);
    } finally {
      setClearing(false);
    }
  }, [props]);

  return (
    <div>
      {globalState.error && (
        <div className="alert alert-error">
          <span className="alert-icon">⚠</span>
          <div>{globalState.error}</div>
        </div>
      )}

      {/* ---------------- 总开关 ---------------- */}
      <button
        type="button"
        className={`master ${on ? 'master--on' : ''} ${transitioning ? 'master--busy' : ''}`}
        onClick={() => void props.onToggle(!on)}
        disabled={busy || transitioning}
      >
        <span className="master__knob" aria-hidden="true">
          <span className="master__knob-track">
            <span className="master__knob-thumb" />
          </span>
        </span>
        <span className="master__text">
          <span className="master__title">
            {transitioning ? PHASE_TEXT[globalState.phase] : on ? '全局代理已开启' : '全局代理已关闭'}
          </span>
          <span className="master__hint">
            {on
              ? tunnel.enabled
                ? `经由内置隧道 → ${(tunnel.host || upstream.host) || '未配置'}`
                : `所有程序经由 ${upstream.host}:${upstream.port} 上网`
              : configured
                ? '点击开启，整台电脑的流量都会走代理'
                : '先在下面填写代理服务器'}
          </span>
        </span>
      </button>

      {/* ---------------- 当前状态 ---------------- */}
      {on && (
        <div className="status-strip">
          <span className="status-strip__item">
            系统代理 <b>已接管</b>
          </span>
          {globalState.listen && (
            <span className="status-strip__item">
              本机端口 <b>{globalState.listen}</b>
            </span>
          )}
          {tunnelLabel(globalState.tunnel) && (
            <span className="status-strip__item">
              隧道 <b>{tunnelLabel(globalState.tunnel)}</b>
            </span>
          )}
        </div>
      )}

      {/* ---------------- 代理服务器 ---------------- */}
      <div className="card">
        <h2 className="card-title">代理服务器</h2>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">
              协议
              {upstream.protocol === 'auto' && detected && (
                <span className="tag tag--ok">已识别：{protocolLabel(detected)}</span>
              )}
            </span>
            <select
              className="select"
              value={upstream.protocol}
              onChange={(e) =>
                props.patch({ upstream: { protocol: e.target.value as AppConfig['upstream']['protocol'] } })
              }
            >
              <option value="auto">自动识别（推荐）</option>
              <option value="http">HTTP 代理</option>
              <option value="https">HTTPS 代理</option>
              <option value="socks5">SOCKS5</option>
            </select>
            {upstream.protocol === 'auto' && (
              <span className="field-hint">
                {detected
                  ? '已记住识别结果，之后直接用这个协议'
                  : '点「测试连接」会依次尝试三种协议，把能用的一种记下来'}
              </span>
            )}
          </label>

          <label className="field">
            <span className="field-label">服务器地址</span>
            <input
              className="input input-mono"
              value={upstream.host}
              placeholder="203.0.113.10 或 proxy.example.com"
              spellCheck={false}
              onChange={(e) => props.patch({ upstream: { host: e.target.value } })}
            />
          </label>

          <label className="field field--narrow">
            <span className="field-label">端口</span>
            <input
              className="input input-mono"
              type="number"
              min={1}
              max={65535}
              value={upstream.port || ''}
              placeholder={String(DEFAULT_PORTS[upstream.protocol] ?? 8080)}
              onChange={(e) => props.patch({ upstream: { port: Number(e.target.value) } })}
            />
          </label>
        </div>

        <div className="divider" />

        <label className="switch switch--inline">
          <input
            type="checkbox"
            checked={upstream.authEnabled}
            onChange={(e) => props.patch({ upstream: { authEnabled: e.target.checked } })}
          />
          <span className="switch-track" />
          <span className="switch-label">服务器需要用户名密码</span>
        </label>

        {upstream.authEnabled && (
          <div className="form-grid form-grid--auth">
            <label className="field">
              <span className="field-label">用户名</span>
              <input
                className="input input-mono"
                value={upstream.username}
                autoComplete="off"
                spellCheck={false}
                placeholder="区分大小写"
                onChange={(e) => props.patch({ upstream: { username: e.target.value } })}
              />
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
                <button type="button" className="btn btn-sm" onClick={() => setShowPassword((v) => !v)}>
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </div>
              <span className="field-hint">
                {upstream.hasPassword ? '✓ 已在本机加密保存' : '尚未保存密码'}
              </span>
            </label>
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="btn btn-sm" onClick={() => void runTest()} disabled={testing || !configured}>
            {testing ? <span className="spinner" /> : '⚡'}
            {testing ? '测试中…' : '测试连接'}
          </button>
          <span className="field-hint">开启前先确认服务器能用，避免开完上不了网</span>
        </div>

        {testError && (
          <div className="alert alert-error" style={{ marginTop: 12, marginBottom: 0 }}>
            <span className="alert-icon">⚠</span>
            <div>{testError}</div>
          </div>
        )}

        {testResult && (
          <div
            className={`alert ${testResult.ok ? 'alert-success' : 'alert-error'}`}
            style={{ marginTop: 12, marginBottom: 0 }}
          >
            <span className="alert-icon">{testResult.ok ? '✓' : '⚠'}</span>
            <div>
              <div>
                {testResult.ok
                  ? `连接成功，握手耗时 ${formatLatency(testResult.latencyMs)}${
                      testResult.testedProtocol && testResult.protocol === 'auto'
                        ? `（自动识别为 ${protocolLabel(testResult.testedProtocol)}）`
                        : ''
                    }`
                  : '连接失败'}
              </div>
              <div style={{ marginTop: 2, opacity: 0.9 }}>
                {testResult.ok ? (
                  <>
                    出口 IP：<span className="code-inline">{testResult.exitIp ?? '未取到'}</span>
                  </>
                ) : (
                  testResult.error
                )}
              </div>

              {/* 自动模式失败时，列出每种协议各自的原因，省得反复试 */}
              {!testResult.ok && testResult.attempts && testResult.attempts.length > 1 && (
                <ul className="attempts">
                  {testResult.attempts.map((a) => (
                    <li key={a.protocol}>
                      <b>{protocolLabel(a.protocol)}</b>：{a.error ?? '失败'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ---------------- 高级设置 ---------------- */}
      <div className="card card--collapsible">
        <button
          type="button"
          className="collapse-head"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          <span className={`chevron ${showAdvanced ? 'chevron--open' : ''}`} aria-hidden="true">
            ▸
          </span>
          高级设置
          <span className="field-hint" style={{ marginLeft: 'auto' }}>
            一般不用改
          </span>
        </button>

        {showAdvanced && (
          <div className="collapse-body">
            <div className="form-grid">
              <label className="field">
                <span className="field-label">本机端口</span>
                <input
                  className="input input-mono"
                  type="number"
                  min={1}
                  max={65535}
                  value={bridge.port}
                  onChange={(e) => props.patch({ bridge: { port: Number(e.target.value) } })}
                />
                <span className="field-hint">
                  全局代理的工作端口，系统代理会指向它。被别的软件占用时改这里。
                </span>
              </label>

              <div className="field">
                <span className="field-label">开机自动开启</span>
                <label className="switch switch--inline">
                  <input
                    type="checkbox"
                    checked={globalProxy.enabled}
                    onChange={(e) => props.patch({ globalProxy: { enabled: e.target.checked } })}
                  />
                  <span className="switch-track" />
                  <span className="switch-label">下次启动应用时自动开启全局代理</span>
                </label>
              </div>
            </div>

            <div className="divider" />

            <label className="switch switch--inline">
              <input
                type="checkbox"
                checked={tunnel.enabled}
                onChange={(e) => {
                  props.patch({ tunnel: { enabled: e.target.checked } });
                  // 切换时清掉上一次的试连结论，避免显示过期结果
                  setTunnelTest(null);
                }}
              />
              <span className="switch-track" />
              <span className="switch-label">使用内置 SSH 隧道（推荐，可显著提升稳定性）</span>
            </label>
            <span className="field-hint">
              明文代理的 CONNECT 请求在跨境链路上会被随机丢弃（实测成功率仅
              17%~37%）。启用地道后流量在<strong>本机</strong>就被加密，
              中途看不到代理协议与目标域名，实测可稳定连通。
            </span>

            {tunnel.enabled && (
              <div style={{ marginTop: 12 }}>
                <div className="form-grid">
                  <label className="field">
                    <span className="field-label">SSH 用户名</span>
                    <input
                      className="input input-mono"
                      value={tunnel.user}
                      spellCheck={false}
                      placeholder="root"
                      onChange={(e) => props.patch({ tunnel: { user: e.target.value } })}
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">SSH 服务器</span>
                    <input
                      className="input input-mono"
                      value={tunnel.host}
                      spellCheck={false}
                      placeholder="留空则沿用上面的代理服务器地址"
                      onChange={(e) => props.patch({ tunnel: { host: e.target.value } })}
                    />
                  </label>

                  <label className="field field--narrow">
                    <span className="field-label">SSH 端口</span>
                    <input
                      className="input input-mono"
                      type="number"
                      min={1}
                      max={65535}
                      value={tunnel.port}
                      onChange={(e) => props.patch({ tunnel: { port: Number(e.target.value) } })}
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">私钥文件</span>
                    <input
                      className="input input-mono"
                      value={tunnel.keyPath}
                      spellCheck={false}
                      placeholder="~/.ssh/id_ed25519"
                      onChange={(e) => props.patch({ tunnel: { keyPath: e.target.value } })}
                    />
                    <span className="field-hint">
                      留空则用 ssh-agent 中的密钥。对应公钥需已加入服务器的 authorized_keys。
                    </span>
                  </label>

                  <label className="field field--narrow">
                    <span className="field-label">对端代理端口</span>
                    <input
                      className="input input-mono"
                      type="number"
                      min={1}
                      max={65535}
                      value={tunnel.remotePort}
                      onChange={(e) => props.patch({ tunnel: { remotePort: Number(e.target.value) } })}
                    />
                    <span className="field-hint">服务器上代理监听的端口</span>
                  </label>

                  <label className="field field--narrow">
                    <span className="field-label">本机隧道端口</span>
                    <input
                      className="input input-mono"
                      type="number"
                      min={0}
                      max={65535}
                      value={tunnel.localPort}
                      onChange={(e) => props.patch({ tunnel: { localPort: Number(e.target.value) } })}
                    />
                    <span className="field-hint">0 表示自动分配</span>
                  </label>
                </div>

                {tunnelLabel(globalState.tunnel) && (
                  <div className="field-hint" style={{ marginTop: 8 }}>
                    当前状态：<b>{tunnelLabel(globalState.tunnel)}</b>
                  </div>
                )}

                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => void runTunnelTest()}
                    disabled={testingTunnel}
                  >
                    {testingTunnel ? <span className="spinner" /> : '🔐'}
                    {testingTunnel ? '测试中…' : '测试隧道'}
                  </button>
                  <span className="field-hint">
                    试建一次隧道并验证对端代理是否可用，测完自动拆掉
                  </span>
                </div>

                {tunnelTest && (
                  <div
                    className={`alert ${tunnelTest.ok ? 'alert-success' : 'alert-error'}`}
                    style={{ marginTop: 10, marginBottom: 0 }}
                  >
                    <span className="alert-icon">{tunnelTest.ok ? '✓' : '⚠'}</span>
                    <div>
                      <div>
                        {tunnelTest.ok
                          ? `隧道测试通过，耗时 ${formatLatency(tunnelTest.latencyMs)}`
                          : '隧道测试未通过'}
                      </div>
                      <div style={{ marginTop: 2, opacity: 0.9 }}>{tunnelTest.detail}</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="divider" />

            <label className="field">
              <span className="field-label">不走代理的地址（每行一条）</span>
              <textarea
                className="textarea"
                rows={4}
                value={directText}
                spellCheck={false}
                placeholder={'localhost\n192.168.*\n*.internal.corp'}
                onChange={(e) => setDirectText(e.target.value)}
                onBlur={commitDirect}
              />
              <span className="field-hint">
                命中的地址直连，不经过代理服务器。适合内网、公司系统；留空表示全部走代理。
              </span>
            </label>

            <div className="divider" />

            {/* 清除本地配置：卸载或转手前抹掉服务器地址与凭据 */}
            <div className="field">
              <span className="field-label">清除本地配置</span>
              {!confirmClear && !clearDone && (
                <>
                  <div className="btn-row">
                    <button
                      className="btn btn-sm"
                      type="button"
                      style={{ borderColor: '#7f1d1d', color: '#fca5a5' }}
                      onClick={() => {
                        setClearDone(false);
                        setConfirmClear(true);
                      }}
                    >
                      🗑 清除本机保存的全部配置
                    </button>
                  </div>
                  <span className="field-hint">
                    抹掉服务器地址、账号密码、直连规则与隧道配置，恢复出厂状态。
                    卸载程序不会自动删这些数据，转手或送人前点一下更放心。
                  </span>
                </>
              )}

              {confirmClear && (
                <div className="alert alert-error" style={{ marginTop: 4, marginBottom: 0 }}>
                  <span className="alert-icon">⚠</span>
                  <div>
                    <div>确定要清除全部本机配置吗？</div>
                    <div style={{ marginTop: 2, opacity: 0.9 }}>
                      服务器地址、账号密码、直连规则和隧道配置都会被抹掉，且无法恢复。
                      若全局代理正在运行，会先自动关闭。
                    </div>
                    <div className="btn-row" style={{ marginTop: 10 }}>
                      <button
                        className="btn btn-sm"
                        type="button"
                        style={{ borderColor: '#7f1d1d', color: '#fca5a5' }}
                        onClick={() => void handleClear()}
                        disabled={clearing}
                      >
                        {clearing ? <span className="spinner" /> : null}
                        {clearing ? '清除中…' : '确认清除'}
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        onClick={() => setConfirmClear(false)}
                        disabled={clearing}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {clearDone && !confirmClear && (
                <div className="alert alert-success" style={{ marginTop: 4, marginBottom: 0 }}>
                  <span className="alert-icon">✓</span>
                  <div>配置已清空，界面显示的是出厂默认值。</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <p className="footnote">
        全局代理通过 <span className="code-inline">127.0.0.1:{bridge.port}</span>{' '}
        转发——Windows 的系统代理只能指向本机地址，所以中间必须有这个端口。
        退出应用时会自动还原你原来的系统代理设置。
      </p>
    </div>
  );
}
