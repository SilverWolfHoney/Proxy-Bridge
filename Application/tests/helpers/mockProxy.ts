/**
 * 本地模拟的上游代理服务器，仅用于自动化测试。
 *
 * 支持 HTTP CONNECT 与 SOCKS5 两种协议，并可选开启用户名密码认证，
 * 用来验证网关的转发、认证注入与失败处理是否正确。
 *
 * 它只监听 127.0.0.1，不含任何真实服务器信息。
 */

import net from 'node:net';

export interface MockProxyOptions {
  /** 要求 Basic 认证；为空表示不校验 */
  auth?: { username: string; password: string };
  /**
   * 在「握手成功应答」之后紧随其后追加的字节。
   * 用于模拟真实场景：代理服务器把应答和目标服务器的首包（如 TLS ServerHello）
   * 写在同一个 TCP 段里，考验网关会不会丢包或把字节串错位置。
   */
  trailingBytes?: string;
}

export interface MockProxy {
  port: number;
  /** 每个 CONNECT 目标被请求的次数 */
  targets: Map<string, number>;
  /** 收到的 Proxy-Authorization 头（HTTP 协议） */
  authHeaders: string[];
  close(): Promise<void>;
}

const SOCKS5_NO_ACCEPTABLE = Buffer.from([0x05, 0xff]);

/** 建立一个带认证校验的 HTTP 代理 */
function createHttpProxyServer(options: MockProxyOptions, record: MockProxy): net.Server {
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.off('data', onData);

      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const lines = head.split('\r\n');
      const requestLine = lines[0] ?? '';
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
      }

      if (options.auth) {
        const got = headers.get('proxy-authorization') ?? '';
        record.authHeaders.push(got);
        const expected =
          'Basic ' + Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64');
        if (got !== expected) {
          client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
          return;
        }
      }

      const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.1$/.exec(requestLine.trim());
      if (!match) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }

      const [host, portText] = splitHostPort(match[1]);
      record.targets.set(`${host}:${portText}`, (record.targets.get(`${host}:${portText}`) ?? 0) + 1);

      const upstream = net.connect({ host, port: portText }, () => {
        const reply = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
        // 应答与目标首包一次性写出，模拟同一 TCP 段
        client.write(
          options.trailingBytes ? Buffer.concat([reply, Buffer.from(options.trailingBytes)]) : reply,
        );
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });

      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    };

    client.on('data', onData);
    client.on('error', () => client.destroy());
  });

  return server;
}

/** 建立一个支持用户名密码认证的 SOCKS5 代理 */
function createSocks5ProxyServer(options: MockProxyOptions, record: MockProxy): net.Server {
  const server = net.createServer((client) => {
    let stage: 'greeting' | 'auth' | 'request' | 'pipe' = 'greeting';
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const count = buffer[1];
          if (buffer.length < 2 + count) return;
          const methods = buffer.subarray(2, 2 + count);
          buffer = buffer.subarray(2 + count);

          if (options.auth) {
            if (!methods.includes(0x02)) {
              client.end(SOCKS5_NO_ACCEPTABLE);
              return;
            }
            client.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            client.write(Buffer.from([0x05, 0x00]));
            stage = 'request';
          }
          continue;
        }

        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const userLen = buffer[1];
          if (buffer.length < 2 + userLen + 1) return;
          const user = buffer.subarray(2, 2 + userLen).toString('utf8');
          const passLen = buffer[2 + userLen];
          if (buffer.length < 3 + userLen + passLen) return;
          const pass = buffer.subarray(3 + userLen, 3 + userLen + passLen).toString('utf8');
          buffer = buffer.subarray(3 + userLen + passLen);

          const expected = options.auth;
          if (expected && (user !== expected.username || pass !== expected.password)) {
            client.end(Buffer.from([0x01, 0x01]));
            return;
          }
          client.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
          continue;
        }

        if (stage === 'request') {
          if (buffer.length < 4) return;
          const atyp = buffer[3];
          let need = 4;
          if (atyp === 0x01) need += 4;
          else if (atyp === 0x04) need += 16;
          else if (atyp === 0x03) {
            if (buffer.length < 5) return;
            need += 1 + buffer[4];
          }
          need += 2;
          if (buffer.length < need) return;

          const request = buffer.subarray(0, need);
          buffer = buffer.subarray(need);

          let host = '';
          let offset = 4;
          if (atyp === 0x01) {
            host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
            offset = 8;
          } else if (atyp === 0x04) {
            const groups: string[] = [];
            for (let i = 4; i < 20; i += 2) groups.push(request.readUInt16BE(i).toString(16));
            host = groups.join(':');
            offset = 20;
          } else {
            const len = request[4];
            host = request.subarray(5, 5 + len).toString('utf8');
            offset = 5 + len;
          }
          const port = request.readUInt16BE(offset);
          record.targets.set(`${host}:${port}`, (record.targets.get(`${host}:${port}`) ?? 0) + 1);

          const upstream = net.connect({ host, port }, () => {
            const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            // 应答与目标首包一次性写出，模拟同一 TCP 段
            client.write(
              options.trailingBytes ? Buffer.concat([reply, Buffer.from(options.trailingBytes)]) : reply,
            );
            if (buffer.length > 0) upstream.write(buffer);
            buffer = Buffer.alloc(0);
            stage = 'pipe';
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on('error', () => {
            client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          });
          client.on('error', () => upstream.destroy());
          client.on('close', () => upstream.destroy());
          return;
        }

        return; // pipe 阶段不再解析
      }
    };

    client.on('data', onData);
    client.on('error', () => client.destroy());
  });

  return server;
}

function splitHostPort(text: string): [string, number] {
  const idx = text.lastIndexOf(':');
  if (idx === -1) return [text, 80];
  return [text.slice(0, idx), Number(text.slice(idx + 1))];
}

/** 启动一个模拟代理，protocol 决定监听哪种协议 */
export function startMockProxy(
  protocol: 'http' | 'socks5',
  options: MockProxyOptions = {},
): Promise<MockProxy> {
  const record: MockProxy = {
    port: 0,
    targets: new Map(),
    authHeaders: [],
    close: async () => {},
  };

  const server =
    protocol === 'http'
      ? createHttpProxyServer(options, record)
      : createSocks5ProxyServer(options, record);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      record.port = typeof address === 'object' && address ? address.port : 0;
      record.close = () =>
        new Promise<void>((done) => {
          server.close(() => done());
        });
      resolve(record);
    });
  });
}

/**
 * 启动一个本地目标服务。
 * 收到请求后回 `echo:<请求行>` 并关闭连接，用来验证转发是否真的到达。
 *
 * @param pushOnConnect 连接建立后延迟主动推送的字节，模拟 TLS ServerHello 这类
 *                      「客户端还没说话，服务器就先发数据」的协议
 */
export function startEchoServer(pushOnConnect?: string): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = net.createServer((socket) => {
    if (pushOnConnect) {
      setTimeout(() => {
        if (!socket.destroyed) socket.write(pushOnConnect);
      }, 30);
    }

    socket.once('data', (chunk) => {
      const requestLine = chunk.toString('latin1').split('\r\n')[0] ?? '';
      const body = `echo:${requestLine}`;
      socket.end(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: text/plain\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n\r\n' +
          body,
      );
    });
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
