import { useEffect, useState } from 'react';
import type { SafeConfig } from '../../shared/types';
import type { ConfigUpdater } from './ConfigPage';
import { rulesToText, textToRules } from '../utils';

export interface RulesPageProps {
  config: SafeConfig;
  patch: ConfigUpdater;
}

/**
 * 分流规则页。
 * 文本域用本地状态承载，避免每次按键都触发一次磁盘写入与网桥热更新。
 */
export function RulesPage({ config, patch }: RulesPageProps): JSX.Element {
  const [directText, setDirectText] = useState(() => rulesToText(config.rules.direct));
  const [proxyText, setProxyText] = useState(() => rulesToText(config.rules.proxy));

  // 配置被外部改动时（例如重新加载）同步回文本域
  useEffect(() => {
    setDirectText(rulesToText(config.rules.direct));
  }, [config.rules.direct]);

  useEffect(() => {
    setProxyText(rulesToText(config.rules.proxy));
  }, [config.rules.proxy]);

  const commitDirect = () => patch({ rules: { direct: textToRules(directText) } });
  const commitProxy = () => patch({ rules: { proxy: textToRules(proxyText) } });

  return (
    <div>
      <h1 className="page-title">分流规则</h1>
      <p className="page-desc">
        决定哪些目标直连、哪些走代理。修改后立即生效，无需重启网关。
      </p>

      <div className="alert alert-info">
        <span className="alert-icon">ℹ</span>
        <div>
          匹配优先级：<strong>代理名单</strong> &gt; <strong>直连名单</strong> &gt; 默认走代理。
          一旦「代理名单」里填了内容，就变成白名单模式——只有命中的目标走代理，其余全部直连。
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">强制直连</h2>
        <textarea
          className="textarea"
          value={directText}
          spellCheck={false}
          placeholder={'每行一条，例如：\nlocalhost\n192.168.*\n*.internal.corp'}
          onChange={(e) => setDirectText(e.target.value)}
          onBlur={commitDirect}
        />
        <p className="field-hint" style={{ marginTop: 8, marginBottom: 0 }}>
          命中的目标不经过代理，直接由本机连接。适合内网地址、银行/政务类站点。
        </p>
      </div>

      <div className="card">
        <h2 className="card-title">强制走代理（留空 = 全部走代理）</h2>
        <textarea
          className="textarea"
          value={proxyText}
          spellCheck={false}
          placeholder={'留空表示所有目标都走代理。\n填了内容则只代理命中的目标，例如：\n*.google.com\nyoutube.com'}
          onChange={(e) => setProxyText(e.target.value)}
          onBlur={commitProxy}
        />
        <p className="field-hint" style={{ marginTop: 8, marginBottom: 0 }}>
          填写后进入白名单模式：只有列表内的目标走代理，其余直连。
        </p>
      </div>

      <div className="card">
        <h2 className="card-title">写法说明</h2>
        <div className="kv-list">
          <div className="kv">
            <span className="kv-key">example.com</span>
            <span className="kv-val">匹配 example.com 及其所有子域名</span>
          </div>
          <div className="kv">
            <span className="kv-key">*.example.com</span>
            <span className="kv-val">同上，显式通配写法</span>
          </div>
          <div className="kv">
            <span className="kv-key">192.168.*</span>
            <span className="kv-val">前缀通配，适合 IP 段</span>
          </div>
          <div className="kv">
            <span className="kv-key">example.com:8080</span>
            <span className="kv-val">限定端口，不写端口表示任意端口</span>
          </div>
          <div className="kv">
            <span className="kv-key"># 注释</span>
            <span className="kv-val">以 # 或 // 开头的行会被忽略</span>
          </div>
        </div>
      </div>
    </div>
  );
}
