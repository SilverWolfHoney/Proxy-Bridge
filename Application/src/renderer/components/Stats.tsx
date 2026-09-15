import type { BridgeStatus } from '../../shared/types';
import { formatBytes, formatDuration } from '../utils';

/**
 * 状态徽章：把网关状态映射成带颜色和呼吸动画的标签。
 */
export function StatusBadge({ status }: { status: BridgeStatus }): JSX.Element {
  if (status.state === 'running') {
    return (
      <span className="badge badge-running">
        <span className="dot" />
        网关运行中
      </span>
    );
  }
  if (status.state === 'error') {
    return (
      <span className="badge badge-error" title={status.error ?? undefined}>
        <span className="dot" />
        启动失败
      </span>
    );
  }
  if (status.state === 'starting') {
    return (
      <span className="badge badge-warn">
        <span className="dot" />
        正在启动…
      </span>
    );
  }
  return (
    <span className="badge badge-stopped">
      <span className="dot" />
      已停止
    </span>
  );
}

/**
 * 紧凑的统计信息，放在侧边栏底部。
 * 侧边栏很窄，所以只列关键项，详细数据在连接日志页。
 */
export function Stats({ status }: { status: BridgeStatus }): JSX.Element {
  const { stats } = status;
  const failureRate =
    stats.totalConnections > 0 ? `${Math.round((stats.failedConnections / stats.totalConnections) * 100)}%` : '—';

  return (
    <div className="side-stats">
      <div className="side-stat">
        <span className="side-stat-key">连接</span>
        <span className="side-stat-val">{stats.totalConnections}</span>
      </div>
      <div className="side-stat">
        <span className="side-stat-key">活跃</span>
        <span className="side-stat-val">{stats.activeConnections}</span>
      </div>
      <div className="side-stat">
        <span className="side-stat-key">流量</span>
        <span className="side-stat-val">{formatBytes(stats.bytesUp + stats.bytesDown)}</span>
      </div>
      <div className="side-stat">
        <span className="side-stat-key">失败率</span>
        <span className="side-stat-val">{failureRate}</span>
      </div>
      <div className="side-stat">
        <span className="side-stat-key">运行</span>
        <span className="side-stat-val">{formatDuration(stats.startedAt)}</span>
      </div>
    </div>
  );
}
