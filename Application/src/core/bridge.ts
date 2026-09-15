/**
 * 本地网关：在本机开一个 HTTP 代理端口（兼容 SOCKS5），把进来的流量
 * 按分流规则转发到远程代理服务器或直连。
 *
 * - HTTP 代理：在同一端口上按首字节自动区分 HTTP 请求与 SOCKS5 握手
 * - 健康检查：GET /__proxybridge__/health 供浏览器插件探测应用是否在线
 * - 隐私：日志里对认证信息一律脱敏，只在内存中保留最近若干条记录
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { connectDirect, connectThroughUpstream } from './connector';
import { compileRule, decideRoute, type CompiledRule } from './rules';
import type {
  BridgeStatus,
  ConnKind,
  ConnRecord,
  ConnOutcome,
  UpstreamConfig,
  RulesConfig,
} from '../shared/types';

const MAX_HEAD_BYTES = 32 * 1024;
const MAX_RECORDS = 300;
const MAX_CONCURRENCY = 512;
const HEALTH_PATH = '/__proxybridge__/health';

export interface BridgeOptions {
  host: string;
  port: number;
  upstream: UpstreamConfig;
  rules: RulesConfig;
  /** 应用版本，用于健康检查响应，供浏览器插件识别 */
  appVersion?: string;
}

interface ConnState {
  id: number;
  at: number;
  host: string;
  port: number;
  kind: ConnKind;
  route: 'direct' | 'proxy';
  outcome: ConnOutcome;
  note?: string;
  latencyMs: number | null;
  bytesUp: number;
  bytesDown: number;
  counted: boolean;
  clientSocket: net.Socket;
  upstreamSocket: net.Socket | null;
}

/** 极简 HTTP 头部解析：只取请求行与头字段，不解析 body */
interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: Map<string, string>;
}

function parseHead(text: string): ParsedHead | null {
  const lines = text.split('\r\n');
  const requestLine = lines.shift();
  if (!requestLine) return null;
  const match = /^([A-Za-z]+)\s+(\S+)\s+(HTTP\/\d\.\d)$/.exec(requestLine.trim());
  if (!match) return null;

  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (headers.has(key)) headers.set(key, headers.get(key) + ', ' + value);
    else headers.set(key, value);
  }

  return { method: match[1].toUpperCase(), target: match[2], version: match[3], headers };
}

export class ProxyBridge extends EventEmitter {
  private options: BridgeOptions;
  private server: net.Server | null = null;
  private state: BridgeStatus['state'] = 'stopped';
  private lastError: string | null = null;
  private listenAddress: string | null = null;

  private connStates = new Map<number, ConnState>();
  private records: ConnRecord[] = [];
  private nextId = 1;
  private totalConnections = 0;
  private failedConnections = 0;
  private bytesUp = 0;
  private bytesDown = 0;
  private startedAt: number | null = null;

  constructor(options: BridgeOptions) {
    super();
    this.options = options;
  }

  /* ---------------------------------------------------------------- */
  /* 生命周期                                                          */
  /* ---------------------------------------------------------------- */

  getStatus(): BridgeStatus {
    return {
      state: this.state,
      listen: this.listenAddress,
      error: this.lastError,
      stats: {
        totalConnections: this.totalConnections,
        activeConnections: this.connStates.size,
        failedConnections: this.failedConnections,
        bytesUp: this.bytesUp,
        bytesDown: this.bytesDown,
        startedAt: this.startedAt,
      },
      systemProxyApplied: false, // 由主进程填充
    };
  }

  getRecords(): ConnRecord[] {
    return this.records.slice();
  }

  clearRecords(): void {
    this.records = [];
  }

  /** 运行时热更新配置（上游或规则），无需重启监听 */
  updateOptions(patch: Partial<BridgeOptions>): void {
    this.options = {
      ...this.options,
      ...patch,
      upstream: patch.upstream ?? this.options.upstream,
      rules: patch.rules ?? this.options.rules,
    };
  }

  private compiledRules(): { direct: CompiledRule[]; proxy: CompiledRule[] } {
    const toRules = (list: string[]) =>
      list.map((line) => compileRule(line)).filter((r): r is CompiledRule => r !== null);
    return {
      direct: toRules(this.options.rules.direct),
      proxy: toRules(this.options.rules.proxy),
    };
  }

  start(): Promise<BridgeStatus> {
    if (this.state === 'running') return Promise.resolve(this.getStatus());
    if (this.server) return Promise.resolve(this.getStatus());

    this.state = 'starting';
    this.lastError = null;
    this.emit('status', this.getStatus());

    return new Promise<BridgeStatus>((resolve) => {
      const server = net.createServer((socket) => this.handleClient(socket));
      this.server = server;

      const onStartupError = (err: NodeJS.ErrnoException) => {
        this.server = null;
        this.state = 'error';
        this.listenAddress = null;
        this.lastError =
          err.code === 'EADDRINUSE'
            ? `端口 ${this.options.port} 已被占用，请换一个端口或关闭占用它的程序`
            : err.code === 'EACCES'
              ? `没有权限监听端口 ${this.options.port}（低于 1024 的端口需要管理员权限）`
              : `启动失败：${err.message}`;
        this.emit('status', this.getStatus());
        resolve(this.getStatus());
      };

      server.once('error', onStartupError);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', onStartupError);
        // 运行期错误不能让进程崩溃
        server.on('error', (err) => {
          this.lastError = `网关错误：${err.message}`;
          this.emit('status', this.getStatus());
        });

        // 端口配 0 时由系统分配，这里必须回读真实端口，否则状态里显示的是 0
        const address = server.address();
        const actualPort =
          typeof address === 'object' && address !== null ? address.port : this.options.port;

        this.state = 'running';
        this.listenAddress = `${this.options.host}:${actualPort}`;
        this.startedAt = Date.now();
        this.emit('status', this.getStatus());
        resolve(this.getStatus());
      });
    });
  }

  stop(): Promise<BridgeStatus> {
    const server = this.server;
    if (!server) {
      this.state = 'stopped';
      this.listenAddress = null;
      this.emit('status', this.getStatus());
      return Promise.resolve(this.getStatus());
    }

    // 先结算并断开所有活跃连接，否则这些连接既不会进入日志，流量也不会被统计。
    // 流量结算交给 finishConn 统一用 socket 的累计计数完成，避免两处算法不一致。
    for (const conn of [...this.connStates.values()]) {
      const socket = conn.clientSocket;
      const upstreamSocket = conn.upstreamSocket;
      socket.destroy();
      upstreamSocket?.destroy();
      this.finishConn(conn, conn.outcome === 'ok' ? 'ok' : 'failed', '网关停止，连接被中断');
    }

    return new Promise<BridgeStatus>((resolve) => {
      server.close(() => {
        this.server = null;
        this.state = 'stopped';
        this.listenAddress = null;
        this.startedAt = null;
        this.emit('status', this.getStatus());
        resolve(this.getStatus());
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* 连接处理                                                          */
  /* ---------------------------------------------------------------- */

  private handleClient(socket: net.Socket): void {
    socket.setNoDelay(true);
    // 握手阶段只给 30 秒；隧道建立后会改为 120 秒空闲超时，避免长连接被误杀
    socket.setTimeout(30_000);
    socket.on('error', () => socket.destroy());
    socket.on('timeout', () => socket.destroy());

    if (this.connStates.size >= MAX_CONCURRENCY) {
      socket.destroy();
      return;
    }

    let buffer = Buffer.alloc(0);
    let decided = false;

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length === 0) return;

      // 按首字节区分协议：0x05 = SOCKS5，其余按 HTTP 处理
      if (buffer[0] === 0x05) {
        decided = true;
        socket.off('data', onData);
        if (buffer.length > 0) socket.unshift(buffer);
        this.handleSocks5(socket);
        return;
      }

      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > MAX_HEAD_BYTES) {
          socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
          decided = true;
          socket.off('data', onData);
        }
        return;
      }

      decided = true;
      socket.off('data', onData);
      const headText = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      this.handleHttpHead(socket, headText, rest);
    };

    socket.on('data', onData);
    socket.on('close', () => {
      if (!decided) socket.off('data', onData);
    });
  }

  /** 注册一条连接记录 */
  private newConn(socket: net.Socket, host: string, port: number, kind: ConnKind, route: 'direct' | 'proxy'): ConnState {
    const id = this.nextId++;
    this.totalConnections += 1;
    const conn: ConnState = {
      id,
      at: Date.now(),
      host,
      port,
      kind,
      route,
      outcome: 'pending',
      latencyMs: null,
      bytesUp: 0,
      bytesDown: 0,
      counted: false,
      clientSocket: socket,
      upstreamSocket: null,
    };
    this.connStates.set(id, conn);
    this.scheduleStatus();
    return conn;
  }

  /**
   * 把一条连接标记为结束，结算流量并落库。
   * 流量使用两端 socket 的累计计数差值，避免漏掉管道里已经流过的数据。
   */
  private finishConn(conn: ConnState, outcome: ConnOutcome, note?: string): void {
    conn.outcome = outcome;
    if (note) conn.note = note;
    if (conn.latencyMs === null && outcome === 'ok') conn.latencyMs = Date.now() - conn.at;

    if (!conn.counted) {
      conn.counted = true;
      const clientDown = conn.clientSocket.bytesWritten;
      const clientUp = conn.clientSocket.bytesRead;
      conn.bytesUp = Math.max(0, clientUp);
      conn.bytesDown = Math.max(0, clientDown);
      this.bytesUp += conn.bytesUp;
      this.bytesDown += conn.bytesDown;
      if (outcome === 'failed' || outcome === 'denied') this.failedConnections += 1;
    }

    if (this.connStates.delete(conn.id)) {
      const record: ConnRecord = {
        id: conn.id,
        at: conn.at,
        host: conn.host,
        port: conn.port,
        kind: conn.kind,
        outcome: conn.outcome,
        route: conn.route,
        note: conn.note,
        latencyMs: conn.latencyMs,
        bytesUp: conn.bytesUp,
        bytesDown: conn.bytesDown,
      };
      this.records.push(record);
      if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
      this.emit('connection', record);
    }
    this.scheduleStatus();
  }

  private statusTimer: NodeJS.Timeout | null = null;
  /** 状态推送节流：最多每 400ms 一次，避免高频连接把 UI 冲爆 */
  private scheduleStatus(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.emit('status', this.getStatus());
    }, 400);
  }

  /** 建立到目标的可用 socket（根据规则决定直连或走上游） */
  private async openUpstream(
    conn: ConnState,
  ): Promise<{ socket: net.Socket; route: 'direct' | 'proxy'; init: Buffer }> {
    const { direct, proxy } = this.compiledRules();
    const decision = decideRoute(conn.host, conn.port, direct, proxy);
    conn.route = decision;

    const upstreamCfg = this.options.upstream;
    if (decision === 'proxy') {
      if (!upstreamCfg.host || !upstreamCfg.port) {
        throw new Error('尚未配置代理服务器，无法转发（可在应用中填写服务器地址，或把目标域名加入直连规则）');
      }
      const tunnel = await connectThroughUpstream(upstreamCfg, conn.host, conn.port);
      conn.latencyMs = Date.now() - conn.at;
      return { socket: tunnel.socket, route: 'proxy', init: tunnel.init };
    }

    const socket = await connectDirect(conn.host, conn.port, upstreamCfg.timeoutMs || 10_000);
    conn.latencyMs = Date.now() - conn.at;
    return { socket, route: 'direct', init: Buffer.alloc(0) };
  }

  /**
   * 双向转发 + 生命周期结算。
   * @param initialToUpstream 客户端在请求头之后已经发出的字节
   * @param initialToClient 隧道建立时上游就已经带回的字节（必须原样交给客户端）
   */
  private pipeBoth(
    conn: ConnState,
    upstream: net.Socket,
    initialToUpstream?: Buffer,
    initialToClient?: Buffer,
  ): void {
    conn.upstreamSocket = upstream;
    // 进入隧道模式后放宽超时，空闲 2 分钟才回收
    conn.clientSocket.setTimeout(120_000);
    upstream.setNoDelay(true);
    upstream.on('error', () => {
      upstream.destroy();
      conn.clientSocket.destroy();
    });
    conn.clientSocket.on('error', () => {
      conn.clientSocket.destroy();
      upstream.destroy();
    });

    conn.clientSocket.pipe(upstream);
    upstream.pipe(conn.clientSocket);

    if (initialToUpstream && initialToUpstream.length > 0) {
      upstream.write(initialToUpstream);
    }
    if (initialToClient && initialToClient.length > 0) {
      conn.clientSocket.write(initialToClient);
    }

    // 到这里隧道已经建成：无论之后是正常关闭还是中途断开，对用户而言这次连接都是成功的，
    // 只有建连阶段的失败才算 failed（在调用方处理）。
    conn.outcome = 'ok';
    if (conn.latencyMs === null) conn.latencyMs = Date.now() - conn.at;

    let settled = false;
    const settle = (note?: string) => {
      if (settled) return;
      settled = true;
      this.finishConn(conn, 'ok', note);
    };

    upstream.on('close', () => {
      conn.clientSocket.end();
      settle();
    });
    conn.clientSocket.on('close', () => {
      upstream.destroy();
      settle();
    });
  }

  /* ---------------------------------------------------------------- */
  /* HTTP 代理                                                         */
  /* ---------------------------------------------------------------- */

  private async handleHttpHead(client: net.Socket, headText: string, rest: Buffer): Promise<void> {
    const head = parseHead(headText);
    if (!head) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    // 健康检查：供浏览器插件判断应用是否在线
    if (head.target === HEALTH_PATH || head.target.startsWith(HEALTH_PATH + '?')) {
      const body = JSON.stringify({
        app: 'proxy-bridge',
        ok: true,
        version: this.options.appVersion ?? '0.0.0',
        listen: this.listenAddress,
      });
      client.end(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/json; charset=utf-8\r\n' +
          'Access-Control-Allow-Origin: *\r\n' +
          'Cache-Control: no-store\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n\r\n' +
          body,
      );
      return;
    }

    let host: string;
    let port: number;
    let absoluteForm = false;
    let pathPart = head.target;

    if (head.method === 'CONNECT') {
      const parsed = splitHostPort(head.target, 443);
      if (!parsed) {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      host = parsed.host;
      port = parsed.port;
    } else {
      const parsed = parseAbsoluteOrRelative(head.target, head.headers.get('host'));
      if (!parsed) {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      host = parsed.host;
      port = parsed.port;
      absoluteForm = parsed.absolute;
      pathPart = parsed.path;
    }

    const kind: ConnKind = head.method === 'CONNECT' ? 'connect' : 'http';
    const conn = this.newConn(client, host, port, kind, 'proxy');

    let upstream: net.Socket;
    let initFromUpstream: Buffer;
    try {
      const opened = await this.openUpstream(conn);
      upstream = opened.socket;
      // 直连时 init 为空；走上游时可能已经带回目标数据（例如 TLS 首包）
      initFromUpstream = opened.init;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!client.destroyed) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
      this.finishConn(conn, 'failed', message);
      return;
    }

    if (client.destroyed) {
      upstream.destroy();
      this.finishConn(conn, 'failed', '客户端提前断开');
      return;
    }

    if (head.method === 'CONNECT') {
      conn.latencyMs = Date.now() - conn.at;
      client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: ProxyBridge/0.1\r\n\r\n');
      this.pipeBoth(conn, upstream, rest.length > 0 ? rest : undefined, initFromUpstream);
      return;
    }

    // 普通 HTTP：重写请求行后转发，认证信息只在上游侧注入
    const lines: string[] = [];
    const target = absoluteForm ? head.target : `http://${formatHost(host)}:${port}${pathPart}`;
    lines.push(`${head.method} ${target} ${head.version}`);

    for (const [key, value] of head.headers) {
      // 剥离逐跳头与客户端可能自带的代理认证
      if (key === 'proxy-authorization' || key === 'proxy-connection' || key === 'connection') continue;
      if (key === 'keep-alive' || key === 'upgrade' || key === 'te') continue;
      lines.push(`${canonicalHeader(key)}: ${value}`);
    }
    lines.push('Proxy-Connection: Keep-Alive');

    if (conn.route === 'proxy' && this.options.upstream.authEnabled) {
      const { username, password } = this.options.upstream;
      if (username || password) {
        const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
    }

    const headOut = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
    const hasBody = head.headers.has('content-length') || head.headers.has('transfer-encoding');

    if (hasBody) {
      this.pipeBoth(conn, upstream, Buffer.concat([headOut, rest]), initFromUpstream);
    } else {
      upstream.write(headOut);
      this.pipeBoth(conn, upstream, rest.length > 0 ? rest : undefined, initFromUpstream);
    }
  }

  /* ---------------------------------------------------------------- */
  /* SOCKS5（供 curl / 插件等直接使用同一端口）                          */
  /* ---------------------------------------------------------------- */

  private async handleSocks5(client: net.Socket): Promise<void> {
    const read = (length: number, label: string) => this.readExactly(client, length, 15_000, label);
    // 提升到 try 外部，便于异常时正确结算这条连接
    let conn: ConnState | null = null;

    try {
      const greeting = await read(2, 'SOCKS5 握手');
      if (greeting[0] !== 0x05) throw new Error(`不是 SOCKS5 协议（版本 0x${greeting[0].toString(16)}）`);
      const methodCount = greeting[1];
      const methods = await read(methodCount, 'SOCKS5 方法列表');
      // 本机网关不校验凭据，仅接受「无认证」
      if (!methods.includes(0x00)) {
        client.end(Buffer.from([0x05, 0xff]));
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));

      const request = await read(4, 'SOCKS5 请求');
      if (request[0] !== 0x05) throw new Error('SOCKS5 请求版本异常');
      if (request[1] !== 0x01) {
        client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }

      const atyp = request[3];
      let host: string;
      if (atyp === 0x01) {
        const raw = await read(4, 'SOCKS5 IPv4 地址');
        host = `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`;
      } else if (atyp === 0x04) {
        const raw = await read(16, 'SOCKS5 IPv6 地址');
        const groups: string[] = [];
        for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
        host = groups.join(':');
      } else if (atyp === 0x03) {
        const lenBuf = await read(1, 'SOCKS5 域名长度');
        host = (await read(lenBuf[0], 'SOCKS5 域名')).toString('utf8');
      } else {
        client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }

      const portBuf = await read(2, 'SOCKS5 端口');
      const port = portBuf.readUInt16BE(0);

      conn = this.newConn(client, host, port, 'socks5', 'proxy');

      let upstream: net.Socket;
      let initFromUpstream: Buffer;
      try {
        const opened = await this.openUpstream(conn);
        upstream = opened.socket;
        initFromUpstream = opened.init;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!client.destroyed) {
          client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
        this.finishConn(conn, 'failed', message);
        return;
      }

      if (client.destroyed) {
        upstream.destroy();
        this.finishConn(conn, 'failed', '客户端提前断开');
        return;
      }

      conn.latencyMs = Date.now() - conn.at;
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      this.pipeBoth(conn, upstream, undefined, initFromUpstream);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!client.destroyed) client.destroy();
      // 握手阶段失败时还没有 ConnState，只有已登记过的连接才需要结算
      if (conn && this.connStates.has(conn.id)) this.finishConn(conn, 'failed', message);
    }
  }

  /**
   * 从客户端 socket 精确读取指定字节数。
   *
   * 用 paused 模式的 `readable` + `read(n)`，而不是 `data` 事件 + `unshift()`：
   * 后者在 SOCKS5 这种「先读 4 字节头、再读 N 字节地址」的分段读取里会丢数据。
   * 调用方需保证握手期间没有其他读取者。
   */
  private readExactly(socket: net.Socket, length: number, timeoutMs: number, label: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
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
        finish(() => reject(new Error(`${label}超时`)));
      }, timeoutMs);
      timer.unref?.();

      function onReadable() {
        const chunk = socket.read(length);
        if (chunk === null) return; // 数据还不够，等下一次 readable
        finish(() => resolve(chunk as Buffer));
      }

      const onError = (err: Error) => finish(() => reject(new Error(`${label}失败：${err.message}`)));
      const onClose = () => finish(() => reject(new Error(`${label}失败：连接已关闭`)));
      const onEnd = () => finish(() => reject(new Error(`${label}失败：客户端提前结束了请求`)));

      socket.on('readable', onReadable);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.once('end', onEnd);

      // 数据可能已经在缓冲区里，主动试一次
      onReadable();
    });
  }
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                             */
/* ------------------------------------------------------------------ */

function splitHostPort(input: string, defaultPort: number): { host: string; port: number } | null {
  const text = input.trim();
  if (!text) return null;

  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) return null;
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  }

  const colon = text.lastIndexOf(':');
  if (colon === -1) return { host: text, port: defaultPort };
  const host = text.slice(0, colon);
  const portText = text.slice(colon + 1);
  if (!/^\d+$/.test(portText)) return { host: text, port: defaultPort };
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function formatHost(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** 解析普通 HTTP 请求的目标；支持绝对形式与相对形式（配合 Host 头） */
function parseAbsoluteOrRelative(
  target: string,
  hostHeader: string | undefined,
): { host: string; port: number; path: string; absolute: boolean } | null {
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
        path: url.pathname + url.search,
        absolute: true,
      };
    } catch {
      return null;
    }
  }

  if (!hostHeader) return null;
  const parsed = splitHostPort(hostHeader, 80);
  if (!parsed) return null;
  return { host: parsed.host, port: parsed.port, path: target || '/', absolute: false };
}

/** 把全小写的头名还原成常见的书写形式 */
function canonicalHeader(key: string): string {
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}
