import { useEffect, useState } from 'react';
import type { SafeConfig } from '../../shared/types';
import { isUpstreamConfigured } from '../../shared/types';

export interface AboutPageProps {
  config: SafeConfig;
}

interface AppInfo {
  version: string;
  electron: string;
  node: string;
  userData: string;
}

export function AboutPage({ config }: AboutPageProps): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pluginPath, setPluginPath] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void window.proxyBridge.getAppInfo().then(setInfo);
    void window.proxyBridge.getPluginPath().then(setPluginPath);
  }, []);

  const copy = async (text: string, label: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  };

  const upstream = config.upstream;
  const configured = isUpstreamConfigured(upstream);

  /** 给插件的配置文本：刻意不含密码，密码由用户自己决定要不要存进浏览器 */
  const pluginConfigText = configured
    ? [
        `协议：${upstream.protocol}`,
        `服务器：${upstream.host}`,
        `端口：${upstream.port}`,
        upstream.authEnabled ? `用户名：${upstream.username || '(未填写)'}` : '认证：无需用户名密码',
        upstream.authEnabled ? '密码：请自行填写（不从这里复制）' : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return (
    <div>
      <h1 className="page-title">浏览器插件与关于</h1>
      <p className="page-desc">
        插件是与本应用<strong>平级</strong>的独立代理客户端——它自己连接代理服务器，不依赖本应用运行。
        两者填同一台服务器即可，用哪个、或两个都用，都行。
      </p>

      <div className="card">
        <h2 className="card-title">两者的关系</h2>
        <div className="kv-list">
          <div className="kv">
            <span className="kv-key">本应用</span>
            <span className="kv-val">
              在本机开一个代理端口，按分流规则直连或走远程服务器，可接管 Windows 系统代理，
              让所有程序（curl、Git、其它软件）都能用
            </span>
          </div>
          <div className="kv">
            <span className="kv-key">浏览器插件</span>
            <span className="kv-val">
              只改浏览器的代理设置，直接连远程服务器，不需要本应用运行
            </span>
          </div>
          <div className="kv">
            <span className="kv-key">共同点</span>
            <span className="kv-val">都连接同一台远程代理服务器；各自的配置互不影响</span>
          </div>
        </div>
        <p className="field-hint" style={{ marginTop: 12, marginBottom: 0 }}>
          两者互不依赖：关掉应用，插件照常工作；不装插件，应用也一样工作。
          本应用里配置的服务器信息<strong>不会被自动同步</strong>到插件——它们是两套独立配置。
        </p>
      </div>

      <div className="card">
        <h2 className="card-title">安装插件（只需做一次）</h2>
        <ol className="steps">
          <li>
            在 Chrome 或 Edge 地址栏打开 <span className="code-inline">chrome://extensions</span>（Edge 为{' '}
            <span className="code-inline">edge://extensions</span>）。
          </li>
          <li>
            打开右上角的 <strong>开发者模式</strong>。
          </li>
          <li>
            点击 <strong>加载已解压的扩展程序</strong>，选择下面这个目录：
            <div className="kv" style={{ marginTop: 8 }}>
              <span className="kv-val">{pluginPath || '读取中…'}</span>
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => void copy(pluginPath, 'path')} disabled={!pluginPath}>
                  {copied === 'path' ? '已复制' : '复制路径'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={!pluginPath}
                  onClick={() => void window.proxyBridge.openPath(pluginPath)}
                >
                  打开文件夹
                </button>
              </div>
            </div>
          </li>
          <li>
            在插件设置页填写<strong>同一台代理服务器</strong>的信息（协议、地址、端口、账号密码），保存。
          </li>
          <li>点击插件图标，打开开关即可。插件不需要本应用处于运行状态。</li>
        </ol>
      </div>

      <div className="card">
        <h2 className="card-title">免手打的配置</h2>
        <p className="field-hint" style={{ marginBottom: 12 }}>
          下面是从本应用配置里生成的插件配置文本，复制后按字段填进插件设置页即可。
          <strong>密码不会出现在这里</strong>——是否让浏览器保存密码由你自己决定。
        </p>
        {configured ? (
          <>
            <textarea className="textarea" readOnly value={pluginConfigText} rows={5} spellCheck={false} />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn btn-sm" onClick={() => void copy(pluginConfigText, 'plugin')}>
                {copied === 'plugin' ? '已复制' : '复制为插件配置'}
              </button>
            </div>
          </>
        ) : (
          <div className="alert alert-info" style={{ marginBottom: 0 }}>
            <span className="alert-icon">ℹ</span>
            <div>先在上面的「代理服务器」页填好服务器信息，这里就会生成对应的插件配置。</div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">运行信息</h2>
        {info ? (
          <div className="kv-list">
            <div className="kv">
              <span className="kv-key">应用版本</span>
              <span className="kv-val">{info.version}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Electron</span>
              <span className="kv-val">{info.electron}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Node</span>
              <span className="kv-val">{info.node}</span>
            </div>
            <div className="kv">
              <span className="kv-key">配置目录</span>
              <span className="kv-val">{info.userData}</span>
            </div>
          </div>
        ) : (
          <div className="field-hint">读取中…</div>
        )}
        <p className="field-hint" style={{ marginTop: 12, marginBottom: 0 }}>
          配置保存在上面这个目录的 <span className="code-inline">config.json</span>，其中密码经过系统加密
          （Windows DPAPI）。卸载时删除该目录即可彻底清除，不会遗留任何凭据。
        </p>
      </div>
    </div>
  );
}
