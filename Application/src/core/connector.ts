/**
 * 上游连接器：负责与用户配置的远程代理服务器建立到目标的隧道。
 *
 * 支持 http / https / socks5 三种上游协议，全部实现为「CONNECT 隧道」语义，
 * 成功时返回一个已经连通的裸 socket，由调用方负责双向转发。
 *
 * 本文件不含任何内置服务器信息，一切来自传入的 UpstreamConfig。
 */

import net from 'node:net';
import tls from 'node:tls';
import type { UpstreamConfig, UpstreamProtocol } from '../shared/types';

export interface UpstreamError extends Error {
  code?: string;
}

function fail(message: string, code?: string): UpstreamError {
  const err = new Error(message) as UpstreamError;
  if (code) err.code = code;
  return err;
}

/** SOCKS5 应答码 → 中文说明 */
const SOCKS5_REPLY: Record<number, string> = {
  0x00: '成功',
  0x01: '服务器一般性失败',
  0x02: '规则不允许连接',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '连接被拒绝',
  0x06: 'TTL 超时',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型',
};

/** 从上游配置里取出可用的认证信息，未配置则返回 null */
function basicAuthHeader(cfg: UpstreamConfig): string | null {
  if (!cfg.authEnabled) return null;
  if (!cfg.username && !cfg.password) return null;
  const raw = `${cfg.username}:${cfg.password}`;
  return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
}

/** 建立到上游代理服务器本身的 TCP（或 TLS）连接 */
function dialUpstream(cfg: UpstreamConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      socket.destroy();
      reject(fail(`无法连接代理服务器 ${cfg.host}:${cfg.port} — ${err.message}`, (err as UpstreamError).code));
    };

    let socket: net.Socket;
    // allowHalfOpen：上游可能发完 FIN 就不再发数据，但我们仍要把剩余响应读回来。
    // 与 bridge 的客户端侧必须成对开启，只改一侧会导致连接不回收。
    if (cfg.protocol === 'https') {
      socket = tls.connect(
        {
          host: cfg.host,
          port: cfg.port,
          servername: net.isIP(cfg.host) ? undefined : cfg.host,
          // tls.connect 最终落在 net.Socket 上，运行时支持该选项，
          // 但 tls.ConnectionOptions 的类型定义没有暴露它，故此处断言
          allowHalfOpen: true,
        } as tls.ConnectionOptions,
        () => {
          socket.setTimeout(0);
          socket.off('error', onError);
          resolve(socket);
        },
      );
    } else {
      socket = net.connect({ host: cfg.host, port: cfg.port, allowHalfOpen: true }, () => {
        socket.setTimeout(0);
        socket.off('error', onError);
        resolve(socket);
      });
    }

    socket.setTimeout(Math.max(1000, cfg.timeoutMs));
    socket.once('timeout', () => onError(fail(`连接代理服务器超时（${cfg.timeoutMs}ms）`, 'ETIMEDOUT')));
    socket.once('error', onError);
  });
}

/**
 * 取走 socket 缓冲区里已经到达的数据。
 *
 * 用于隧道刚建立的那一刻：如果代理服务器把「握手成功」和目标服务器的首包
 * （或任何紧随其后的数据）写在同一个 TCP 段里，这些字节会留在缓冲区。
 * 若不清走，它们会被后续的 pipe 当成正常流量转发，污染数据流。
 *
 * 注意顺序：必须先 pause，否则 `read()` 结束暂停时会重入触发 readable，
 * 导致 drain 循环永远退不出来。拿到的数据要交还给调用方继续转发，不能丢。
 */
function drainBuffered(socket: net.Socket): Buffer {
  socket.pause();
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = socket.read();
    if (chunk === null) break;
    chunks.push(chunk as Buffer);
  }
  socket.resume();
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

/** HTTP / HTTPS 上游：发送 CONNECT 请求并解析应答 */
async function connectViaHttp(
  cfg: UpstreamConfig,
  host: string,
  port: number,
): Promise<{ socket: net.Socket; init: Buffer }> {
  const socket = await dialUpstream(cfg);

  const init = await new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    };

    const onError = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(fail(`与代理服务器通信失败 — ${err.message}`, (err as UpstreamError).code));
    };
    const onClose = () => {
      cleanup();
      reject(fail('代理服务器在隧道建立前关闭了连接'));
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(fail(`等待代理服务器应答超时（${cfg.timeoutMs}ms）`, 'ETIMEDOUT'));
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 64 * 1024) {
          cleanup();
          socket.destroy();
          reject(fail('代理服务器应答头过长'));
        }
        return;
      }

      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const statusLine = head.split('\r\n')[0] ?? '';
      const match = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine.trim());

      cleanup();

      if (!match) {
        socket.destroy();
        reject(fail(`代理服务器返回了无法解析的应答：${statusLine.slice(0, 120)}`));
        return;
      }

      const code = Number(match[1]);
      if (code === 200) {
        socket.setTimeout(0);
        // 应答头之后可能已经跟着目标数据（rest），再加上缓冲区里后续到达的字节
        const pending = Buffer.concat([rest, drainBuffered(socket)]);
        resolve(pending);
        return;
      }

      socket.destroy();
      if (code === 407) {
        reject(fail('认证失败（407）：用户名或密码不正确', 'EAUTH'));
      } else if (code === 403) {
        reject(fail('代理服务器拒绝该目标（403）', 'EFORBIDDEN'));
      } else {
        reject(fail(`代理服务器返回 ${code} ${match[2] ?? ''}`.trim(), `EHTTP${code}`));
      }
    };

    socket.setTimeout(Math.max(1000, cfg.timeoutMs));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);

    const target = net.isIPv6(host) ? `[${host}]` : host;
    const lines = [
      `CONNECT ${target}:${port} HTTP/1.1`,
      `Host: ${target}:${port}`,
      'Proxy-Connection: Keep-Alive',
      'User-Agent: ProxyBridge/0.1',
    ];
    const auth = basicAuthHeader(cfg);
    if (auth) lines.push(`Proxy-Authorization: ${auth}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
  });

  return { socket, init };
}

/**
 * 从一个 socket 里精确读取指定字节数。
 *
 * 用 paused 模式的 `readable` + `read(n)` 实现，而不是 `data` 事件 + `unshift()`：
 * 后者在「第一次读取只取走部分数据、剩余数据推回流缓冲」时，
 * 下一次读取会因为流仍处于 flowing 状态而拿不到那部分数据（实测会丢包），
 * 而 SOCKS5 握手恰恰需要这种「4 字节头 + N 字节地址」的分段读取。
 *
 * 注意：调用方必须保证此时该 socket 上没有其他读取者（pipe / data 监听）。
 */
function readExactly(socket: net.Socket, length: number, timeoutMs: number, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('readable', onReadable);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('end', onEnd);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(fail(`${label}超时（${timeoutMs}ms）`)));
    }, timeoutMs);

    function onReadable() {
      const chunk = socket.read(length);
      if (chunk === null) return; // 数据还不够，等下一次 readable
      finish(() => resolve(chunk as Buffer));
    }

    const onError = (err: Error) => finish(() => reject(fail(`${label}失败 — ${err.message}`)));
    const onClose = () => finish(() => reject(fail(`${label}失败 — 连接被代理服务器关闭`)));
    const onEnd = () => finish(() => reject(fail(`${label}失败 — 代理服务器提前结束了响应`)));

    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('end', onEnd);

    // 数据可能已经在缓冲区里了，主动试一次，避免只能等下一次 readable
    onReadable();
  });
}

/** SOCKS5 上游：握手 → 认证 → CONNECT */
async function connectViaSocks5(
  cfg: UpstreamConfig,
  host: string,
  port: number,
): Promise<{ socket: net.Socket; init: Buffer }> {
  const socket = await dialUpstream(cfg);
  const timeout = Math.max(1000, cfg.timeoutMs);

  try {
    socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    const method = await readExactly(socket, 2, timeout, 'SOCKS5 方法协商');

    if (method[0] !== 0x05) throw fail(`SOCKS5 响应版本异常：0x${method[0].toString(16)}`);
    if (method[1] === 0xff) throw fail('代理服务器不接受任何可用的认证方式');
    if (method[1] === 0x02) {
      const user = Buffer.from(cfg.username, 'utf8');
      const pass = Buffer.from(cfg.password, 'utf8');
      if (user.length > 255 || pass.length > 255) throw fail('SOCKS5 用户名或密码过长（上限 255 字节）');
      socket.write(
        Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]),
      );
      const authReply = await readExactly(socket, 2, timeout, 'SOCKS5 认证');
      if (authReply[1] !== 0x00) throw fail('SOCKS5 认证失败：用户名或密码不正确', 'EAUTH');
    } else if (method[1] !== 0x00) {
      throw fail(`代理服务器要求不支持的认证方式：0x${method[1].toString(16)}`);
    }

    // 目标地址编码
    let addr: Buffer;
    const ipVersion = net.isIP(host);
    if (ipVersion === 4) {
      addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
    } else if (ipVersion === 6) {
      const segments = expandIpv6(host);
      addr = Buffer.concat([Buffer.from([0x04]), segments]);
    } else {
      const domain = Buffer.from(host, 'utf8');
      if (domain.length > 255) throw fail('目标域名过长');
      addr = Buffer.concat([Buffer.from([0x03, domain.length]), domain]);
    }

    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

    const reply = await readExactly(socket, 4, timeout, 'SOCKS5 CONNECT');
    if (reply[1] !== 0x00) {
      throw fail(`SOCKS5 连接失败：${SOCKS5_REPLY[reply[1]] ?? `未知应答码 0x${reply[1].toString(16)}`}`);
    }

    // 跳过绑定地址，长度由地址类型决定
    const atyp = reply[3];
    let rest: number;
    if (atyp === 0x01) rest = 4 + 2;
    else if (atyp === 0x03) {
      const lenBuf = await readExactly(socket, 1, timeout, 'SOCKS5 应答地址');
      rest = lenBuf[0] + 2;
    } else if (atyp === 0x04) rest = 16 + 2;
    else throw fail(`SOCKS5 应答地址类型异常：0x${atyp.toString(16)}`);

    if (rest > 0) await readExactly(socket, rest, timeout, 'SOCKS5 应答地址');

    socket.setTimeout(0);
    // 应答之后同一批到达的字节属于目标服务器，必须原样交给调用方
    return { socket, init: drainBuffered(socket) };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/** 把 IPv6 字面量展开成 16 字节 */
function expandIpv6(host: string): Buffer {
  const buf = Buffer.alloc(16);
  let head = host;
  let tail = '';
  const doubleColon = host.indexOf('::');
  if (doubleColon !== -1) {
    head = host.slice(0, doubleColon);
    tail = host.slice(doubleColon + 2);
  }

  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail.length > 0 ? tail.split(':') : [];

  // 处理 IPv4-mapped 尾巴，如 ::ffff:1.2.3.4
  const last = tailParts[tailParts.length - 1];
  if (last && last.includes('.')) {
    const octets = last.split('.').map(Number);
    tailParts.pop();
    tailParts.push(((octets[0] << 8) | octets[1]).toString(16));
    tailParts.push(((octets[2] << 8) | octets[3]).toString(16));
  }

  const fillCount = 8 - headParts.length - tailParts.length;
  const groups = [...headParts, ...Array(Math.max(0, fillCount)).fill('0'), ...tailParts];

  for (let i = 0; i < 8; i += 1) {
    buf.writeUInt16BE(parseInt(groups[i] || '0', 16) & 0xffff, i * 2);
  }
  return buf;
}

/** 一条已建立的隧道：socket 加上握手期间一并到达、需要继续转发的数据 */
export interface UpstreamTunnel {
  socket: net.Socket;
  /** 隧道建立时就已经到达的目标数据，必须原样转发给客户端，否则会丢包 */
  init: Buffer;
}

/** 自动判断协议时逐个尝试的顺序：从最常见的开始 */
export const AUTO_PROTOCOL_ORDER: UpstreamProtocol[] = ['http', 'socks5', 'https'];

/**
 * 决定本次实际使用的协议。
 * @param cfg 上游配置
 * @param override 调用方指定的协议（例如自动检测正在试的那一种）
 */
export function resolveUpstreamProtocol(
  cfg: UpstreamConfig,
  override?: UpstreamProtocol,
): UpstreamProtocol | null {
  if (override) return override;
  if (cfg.protocol === 'auto') return cfg.detectedProtocol ?? null;
  return cfg.protocol;
}

/**
 * 通过上游代理连接到 host:port，成功后返回已连通的隧道。
 * 调用方负责在结束时销毁 socket，并把 `init` 转发给客户端。
 *
 * @param cfg 上游配置
 * @param host 目标主机
 * @param port 目标端口
 * @param protocolOverride 覆盖协议；不传时按配置决定。
 *                         配置为 `auto` 且尚未识别出协议时返回 ENOCONFIG 错误，
 *                         调用方应先做一次 detectUpstreamProtocol。
 */
export function connectThroughUpstream(
  cfg: UpstreamConfig,
  host: string,
  port: number,
  protocolOverride?: UpstreamProtocol,
): Promise<UpstreamTunnel> {
  if (!cfg.host || !cfg.port) {
    return Promise.reject(fail('尚未配置代理服务器地址', 'ENOCONFIG'));
  }

  const protocol = resolveUpstreamProtocol(cfg, protocolOverride);
  if (!protocol) {
    return Promise.reject(fail('协议尚未确定，请先测试连接以自动识别', 'ENOCONFIG'));
  }

  const effective: UpstreamConfig = { ...cfg, protocol };
  if (protocol === 'socks5') {
    return connectViaSocks5(effective, host, port);
  }
  return connectViaHttp(effective, host, port);
}

/** 直连目标（不走上游代理） */
export function connectDirect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, allowHalfOpen: true }, () => {
      socket.setTimeout(0);
      socket.off('error', onError);
      resolve(socket);
    });
    const onError = (err: Error) => {
      socket.destroy();
      reject(fail(`直连 ${host}:${port} 失败 — ${err.message}`, (err as UpstreamError).code));
    };
    socket.setTimeout(Math.max(1000, timeoutMs));
    socket.once('timeout', () => onError(fail(`直连 ${host}:${port} 超时`, 'ETIMEDOUT')));
    socket.once('error', onError);
  });
}
