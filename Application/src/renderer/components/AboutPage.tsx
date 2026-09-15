import { useEffect, useState } from 'react';

export interface AboutPageProps {
  bridgePort: number;
}

interface AppInfo {
  version: string;
  electron: string;
  node: string;
  userData: string;
}

export function AboutPage({ bridgePort }: AboutPageProps): JSX.Element {
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

  return (
    <div>
      <h1 className="page-title">浏览器插件与关于</h1>
      <p className="page-desc">
        插件负责开关浏览器的代理；凭据始终留在本应用里，插件只认识本机的一个端口。
      </p>

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
            在插件设置里把<strong>本地端口</strong>填成 <span className="code-inline">{bridgePort}</span>{' '}
            （与本应用「本机网关」的端口一致），保存。
          </li>
          <li>点击插件图标，打开开关。使用前请确认本应用已启动网关。</li>
        </ol>
      </div>

      <div className="card">
        <h2 className="card-title">它是怎么工作的</h2>
        <div className="kv-list">
          <div className="kv">
            <span className="kv-key">浏览器</span>
            <span className="kv-val">插件把 HTTP/HTTPS 代理指向 127.0.0.1:{bridgePort}</span>
          </div>
          <div className="kv">
            <span className="kv-key">本应用</span>
            <span className="kv-val">
              接收浏览器流量，按分流规则直接转发、或经远程代理服务器转发（账号密码在这里附加）
            </span>
          </div>
          <div className="kv">
            <span className="kv-key">远程服务器</span>
            <span className="kv-val">真正的出口，目标网站看到的是它的 IP</span>
          </div>
        </div>
        <p className="field-hint" style={{ marginTop: 12, marginBottom: 0 }}>
          这样设计的好处：代理账号不必暴露给浏览器；换服务器只改应用里的配置，插件不用动；
          被规则判定为直连的网站（内网、网银等）不会绕道远程服务器。
        </p>
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
