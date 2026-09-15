import { useMemo, useState } from 'react';
import type { BridgeStatus, ConnRecord } from '../../shared/types';
import { formatBytes, formatLatency, formatTime } from '../utils';

export interface LogsPageProps {
  connections: ConnRecord[];
  status: BridgeStatus;
  onClear: () => void;
}

const OUTCOME_LABEL: Record<ConnRecord['outcome'], string> = {
  pending: '进行中',
  ok: '成功',
  failed: '失败',
  denied: '被拒绝',
};

const KIND_LABEL: Record<ConnRecord['kind'], string> = {
  connect: 'HTTPS',
  http: 'HTTP',
  socks5: 'SOCKS5',
};

export function LogsPage({ connections, status, onClear }: LogsPageProps): JSX.Element {
  const [filter, setFilter] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);

  const rows = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return connections.filter((item) => {
      if (onlyFailed && item.outcome !== 'failed' && item.outcome !== 'denied') return false;
      if (!keyword) return true;
      return `${item.host}:${item.port}`.toLowerCase().includes(keyword) || (item.note ?? '').toLowerCase().includes(keyword);
    });
  }, [connections, filter, onlyFailed]);

  return (
    <div>
      <h1 className="page-title">连接日志</h1>
      <p className="page-desc">
        最近 {connections.length} 条连接记录（内存中最多保留 300 条，退出应用后清空）。密码等凭据不会出现在这里。
      </p>

      <div className="log-toolbar">
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="搜索域名或错误信息"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="switch">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
          <span className="switch-track" />
          <span className="switch-label">只看失败</span>
        </label>
        <div className="header-spacer" style={{ flex: 1 }} />
        <span className="badge badge-stopped">
          <span className="dot" />
          活跃 {status.stats.activeConnections}
        </span>
        <button className="btn btn-sm" onClick={onClear} disabled={connections.length === 0}>
          清空
        </button>
      </div>

      <div className="log-list">
        {rows.length === 0 ? (
          <div className="empty-state">
            {connections.length === 0
              ? '还没有连接。启动网关并在浏览器里打开网页后，这里会实时显示每一条连接。'
              : '没有符合筛选条件的记录。'}
          </div>
        ) : (
          <table className="log-table">
            <thead>
              <tr>
                <th style={{ width: 78 }}>时间</th>
                <th>目标</th>
                <th style={{ width: 72 }}>类型</th>
                <th style={{ width: 68 }}>路由</th>
                <th style={{ width: 74 }}>结果</th>
                <th style={{ width: 78, textAlign: 'right' }}>延迟</th>
                <th style={{ width: 82, textAlign: 'right' }}>上行</th>
                <th style={{ width: 82, textAlign: 'right' }}>下行</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td className="cell-time">{formatTime(item.at)}</td>
                  <td className="cell-target" title={item.note ? `${item.host}:${item.port}\n${item.note}` : `${item.host}:${item.port}`}>
                    {item.host}:{item.port}
                  </td>
                  <td>
                    <span className="tag tag-direct">{KIND_LABEL[item.kind]}</span>
                  </td>
                  <td>
                    <span className={`tag ${item.route === 'proxy' ? 'tag-proxy' : 'tag-direct'}`}>
                      {item.route === 'proxy' ? '代理' : '直连'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`tag ${
                        item.outcome === 'ok' ? 'tag-ok' : item.outcome === 'pending' ? 'tag-pending' : 'tag-fail'
                      }`}
                    >
                      {OUTCOME_LABEL[item.outcome]}
                    </span>
                  </td>
                  <td className="cell-num">{formatLatency(item.latencyMs)}</td>
                  <td className="cell-num">{formatBytes(item.bytesUp)}</td>
                  <td className="cell-num">{formatBytes(item.bytesDown)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
