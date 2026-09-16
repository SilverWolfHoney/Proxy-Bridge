/**
 * 上游代理连通性测试。
 *
 * 做两件事：
 *  1. 通过代理建立一次 CONNECT 隧道，验证协议与凭据是否正确；
 *  2. 顺手取一次出口 IP，让用户能直观确认「流量确实从代理出去了」。
 *
 * 测试本身不留存任何结果，出口 IP 只返回给界面显示。
 */

import net from 'node:net';
import { AUTO_PROTOCOL_ORDER, connectThroughUpstream, type UpstreamError } from './connector';
import type { ProtocolAttempt, TestResult, UpstreamConfig, UpstreamProtocol } from '../shared/types';

/** 用于验证隧道能否建立的目标（HTTPS，端口固定，不涉及用户隐私） */
const TUNNEL_TARGET = { host: 'www.gstatic.com', port: 443, label: 'www.gstatic.com:443' };

/** 备用验证目标：部分网络下 gstatic 不可达但 baidu 可达 */
const TUNNEL_FALLBACK = { host: 'www.baidu.com', port: 443, label: 'www.baidu.com:443' };

/** 用于查询出口 IP 的纯文本接口，按顺序尝试 */
const IP_ENDPOINTS = [
  { host: 'api.ipify.org', port: 80, path: '/', label: 'api.ipify.org' },
  { host: 'ifconfig.me', port: 80, path: '/ip', label: 'ifconfig.me' },
  { host: 'icanhazip.com', port: 80, path: '/', label: 'icanhazip.com' },
];

const IP_TIMEOUT_MS = 10_000;

/** 把底层错误翻译成用户能看懂的中文提示 */
function explainError(err: unknown, cfg: UpstreamConfig): string {
  const code = (err as UpstreamError)?.code;
  const raw = err instanceof Error ? err.message : String(err);

  switch (code) {
    case 'EAUTH':
      return `认证失败：请检查用户名和密码是否完全正确（注意大小写）。服务器返回：${raw}`;
    case 'ETIMEDOUT':
      return `连接超时：确认服务器地址、端口是否正确，以及本机网络能否访问该服务器。${raw}`;
    case 'ECONNREFUSED':
      return `连接被拒绝：服务器 ${cfg.host}:${cfg.port} 拒绝了连接，端口可能填错了。`;
    case 'ENOTFOUND':
      return `域名解析失败：找不到主机 ${cfg.host}，请检查地址拼写。`;
    case 'ENOCONFIG':
      return '尚未填写服务器地址和端口。';
    default:
      return raw;
  }
}

/** 在一条已建立的隧道里发一个 HTTP/1.0 请求并读回全部响应头 */
function httpGetOverTunnel(
  socket: net.Socket,
  host: string,
  path: string,
  timeoutMs: number,
  initialData: Buffer = Buffer.alloc(0),
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // 隧道建立时可能已经带回部分响应，先放进缓冲区
    let buffer = initialData;
    let settled = false;

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      clearTimeout(timer);
    };
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => done(() => reject(new Error('读取出口 IP 超时'))), timeoutMs);
    const onError = (err: Error) => done(() => reject(err));
    const onClose = () => done(() => reject(new Error('连接在读取响应前被关闭')));

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > 64 * 1024) done(() => reject(new Error('响应头过大')));
        return;
      }

      const headText = buffer.subarray(0, headerEnd).toString('latin1');
      const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(headText);
      const status = statusMatch ? Number(statusMatch[1]) : 0;

      const lenMatch = /content-length:\s*(\d+)/i.exec(headText);
      const declared = lenMatch ? Number(lenMatch[1]) : null;
      const bodyBuf = buffer.subarray(headerEnd + 4);

      if (declared !== null && bodyBuf.length < declared) return; // 继续等
      if (declared === null && !/\r\n0\r\n\r\n$/.test(buffer.toString('latin1')) && bodyBuf.length === 0) return;

      done(() => resolve({ status, body: bodyBuf.toString('utf8') }));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    const request =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      'Accept: text/plain,*/*\r\n' +
      'Accept-Encoding: identity\r\n' +
      'User-Agent: ProxyBridge/0.1\r\n' +
      'Connection: close\r\n\r\n';
    socket.write(request);
  });
}

/** 通过代理取出口 IP；失败返回 null（不影响主流程判定） */
async function fetchExitIp(
  cfg: UpstreamConfig,
  endpoints: { host: string; port: number; path: string }[] = IP_ENDPOINTS,
): Promise<string | null> {
  for (const endpoint of endpoints) {
    let socket: net.Socket | null = null;
    try {
      const tunnel = await connectThroughUpstream(cfg, endpoint.host, endpoint.port);
      socket = tunnel.socket;
      const { status, body } = await httpGetOverTunnel(
        socket,
        endpoint.host,
        endpoint.path,
        IP_TIMEOUT_MS,
        tunnel.init,
      );
      if (status !== 200) continue;

      const text = body.trim();
      // 只接受看起来像 IP 的返回，避免把 HTML 错误页当结果
      const v4 = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      if (v4) return v4[0];
      const v6 = text.match(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b/i);
      if (v6) return v6[0];
    } catch {
      /* 换下一个接口 */
    } finally {
      socket?.destroy();
    }
  }
  return null;
}

/**
 * 测试参数。
 *
 * 默认针对公网目标；测试里可以注入本机 mock 目标与空的出口 IP 端点，
 * 这样协议识别逻辑就能完全离线验证，不受网络环境影响。
 */
export interface TestOptions {
  targets?: { host: string; port: number }[];
  ipEndpoints?: { host: string; port: number; path: string }[];
}

const DEFAULT_TARGETS = [TUNNEL_TARGET, TUNNEL_FALLBACK];

/** 通过上游代理建立一次隧道，成功即说明协议与凭据都可用 */
async function probeTunnel(
  cfg: UpstreamConfig,
  target: { host: string; port: number },
  protocol: UpstreamProtocol,
): Promise<number> {
  const started = Date.now();
  const tunnel = await connectThroughUpstream(cfg, target.host, target.port, protocol);
  const latency = Date.now() - started;
  tunnel.socket.destroy();
  return latency;
}

/**
 * 在指定协议下完整测一次：先建隧道，再取出口 IP。
 * @returns 成功时返回延迟与出口 IP；失败时返回原因
 */
async function tryProtocol(
  cfg: UpstreamConfig,
  protocol: UpstreamProtocol,
  options: TestOptions,
): Promise<{ ok: boolean; latencyMs: number | null; exitIp: string | null; error: string | null }> {
  let latency: number | null = null;
  let lastError: unknown = null;

  for (const target of options.targets ?? DEFAULT_TARGETS) {
    try {
      latency = await probeTunnel(cfg, target, protocol);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError !== null) {
    return { ok: false, latencyMs: null, exitIp: null, error: explainError(lastError, cfg) };
  }

  const exitIp = await fetchExitIp({ ...cfg, protocol }, options.ipEndpoints);
  return { ok: true, latencyMs: latency, exitIp, error: null };
}

/** 协议的中文名，用于界面提示 */
export function protocolLabel(protocol: UpstreamProtocol): string {
  if (protocol === 'socks5') return 'SOCKS5';
  if (protocol === 'https') return 'HTTPS 代理';
  return 'HTTP 代理';
}

/**
 * 测试上游代理是否可用。
 *
 * 协议为 `auto` 时逐个尝试（HTTP → SOCKS5 → HTTPS），把第一个测通的记下来，
 * 并保留每个协议的尝试结果，便于排查「为什么连不上」。
 *
 * @param cfg 完整的上游配置（含明文密码，仅主进程内调用）
 * @param options 测试目标与出口 IP 端点的覆盖项，测试时用
 */
export async function testUpstream(cfg: UpstreamConfig, options: TestOptions = {}): Promise<TestResult> {
  const base: TestResult = {
    ok: false,
    protocol: cfg.protocol,
    testedProtocol: null,
    latencyMs: null,
    exitIp: null,
    error: null,
    detail: '',
  };

  if (!cfg.host || !cfg.port) {
    return {
      ...base,
      error: '尚未填写服务器地址或端口',
      detail: explainError({ code: 'ENOCONFIG' } as UpstreamError, cfg),
    };
  }

  const auto = cfg.protocol === 'auto';
  const candidates: UpstreamProtocol[] = auto ? AUTO_PROTOCOL_ORDER : [cfg.protocol as UpstreamProtocol];

  const attempts: ProtocolAttempt[] = [];
  const failures: string[] = [];

  for (const protocol of candidates) {
    const r = await tryProtocol(cfg, protocol, options);
    attempts.push({
      protocol,
      ok: r.ok,
      latencyMs: r.latencyMs,
      error: r.error,
    });

    if (r.ok) {
      return {
        ok: true,
        protocol: cfg.protocol,
        testedProtocol: protocol,
        latencyMs: r.latencyMs,
        exitIp: r.exitIp,
        error: null,
        detail: r.exitIp
          ? `${protocolLabel(protocol)} 隧道已建立，出口 IP：${r.exitIp}`
          : `${protocolLabel(protocol)} 隧道已建立（未能取到出口 IP，可能是查询接口被拦截，不影响使用）`,
        attempts: auto ? attempts : undefined,
      };
    }

    failures.push(`${protocolLabel(protocol)}：${r.error ?? '失败'}`);
  }

  // 全部协议都不通：把每种协议的原因都摆出来，省得用户反复试
  return {
    ...base,
    error: auto ? failures.join('；') : (attempts[0]?.error ?? '连接失败'),
    detail: auto ? `三种协议都无法连接：${failures.join('；')}` : '隧道未能建立',
    attempts: auto ? attempts : undefined,
  };
}
