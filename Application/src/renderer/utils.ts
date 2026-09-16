/** 渲染层通用小工具 */

/** 各协议的常见端口，仅用于输入框占位提示 */
export const DEFAULT_PORTS: Record<string, number> = {
  http: 8080,
  https: 8443,
  socks5: 1080,
  auto: 8080,
};

/** 协议的中文名 */
export function protocolLabel(protocol: string): string {
  if (protocol === 'socks5') return 'SOCKS5';
  if (protocol === 'https') return 'HTTPS 代理';
  if (protocol === 'http') return 'HTTP 代理';
  return protocol;
}

/** 字节数转可读文本 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** 延迟显示 */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 运行时长 */
export function formatDuration(startedAt: number | null): string {
  if (!startedAt) return '—';
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}
