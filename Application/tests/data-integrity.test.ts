/**
 * 数据完整性与连接生命周期的回归测试。
 *
 * 这几条都是「静默出错」类型：不报错、不崩溃，只是数据没了或连接卡住，
 * 所以在真实使用中很难被察觉（表现为「偶发 TLS 失败」「POST 偶发挂死」）。
 * 每个用例都刻意构造出当初触发 bug 的时序。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { ProxyBridge } from '../src/core/bridge';
import { startEchoServer, startMockProxy } from './helpers/mockProxy.js';

interface Harness {
  bridge: InstanceType<typeof ProxyBridge>;
  port: number;
  close(): Promise<void>;
}

async function startBridge(upstream: {
  protocol: 'http' | 'socks5';
  host: string;
  port: number;
  authEnabled: boolean;
  username: string;
  password: string;
}): Promise<Harness> {
  const bridge = new ProxyBridge({
    host: '127.0.0.1',
    port: 0,
    upstream: { ...upstream, timeoutMs: 8000 },
    rules: { direct: [], proxy: [] },
  });
  const status = await bridge.start();
  assert.equal(status.state, 'running', `网关未启动：${status.error ?? ''}`);
  const listen = status.listen ?? '';
  const port = Number(listen.slice(listen.lastIndexOf(':') + 1));
  assert.ok(port > 0, '网关端口解析失败');
  return { bridge, port, close: () => bridge.stop().then(() => undefined) };
}

/**
 * 起一个会把「方法 + 路径 + 完整正文」回显出来的 HTTP 目标服务。
 *
 * 刻意不复用 startEchoServer：那个 helper 一收到首个数据块就回显请求行并关闭，
 * 它根本不读正文，所以无法用来验证 POST body 是否完整送达。
 */
function startEchoTarget(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const text = `METHOD=${req.method} PATH=${req.url} BODY=${body}`;
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': String(Buffer.byteLength(text)),
        });
        res.end(text);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/* ------------------------------------------------------------------ */
/* P0-1：建连窗口内到达的数据不能丢                                     */
/* ------------------------------------------------------------------ */

test('建连窗口内到达的数据不会被丢弃（CONNECT 之后紧接着发数据）', async () => {
  const echo = await startEchoServer();
  // 上游延迟 300ms 才回应答 —— 模拟境外代理的真实 RTT，撑开建连窗口
  const upstream = await startMockProxy('http', { delayReplyMs: 300 });
  const h = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: false,
    username: '',
    password: '',
  });

  try {
    const client = net.connect({ host: '127.0.0.1', port: h.port });
    await new Promise<void>((r) => client.once('connect', () => r()));

    // CONNECT 与数据分两段发出：第二段必然落在网关等待上游应答的窗口里
    client.write(
      `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 30));
    client.write('IN-WINDOW-DATA\n');

    const received = await new Promise<string>((resolve, reject) => {
      let acc = '';
      const timer = setTimeout(() => reject(new Error(`超时未收到回显，已收到：${JSON.stringify(acc)}`)), 6000);
      client.on('data', (chunk) => {
        acc += chunk.toString('latin1');
        if (acc.includes('echo:IN-WINDOW-DATA')) {
          clearTimeout(timer);
          resolve(acc);
        }
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.match(received, /echo:IN-WINDOW-DATA/, '建连窗口内发出的数据必须完整送达目标');
    client.destroy();
  } finally {
    await h.close();
    await upstream.close();
    await echo.close();
  }
});

test('建连窗口内到达的 POST 正文不会被丢弃', async () => {
  const echo = await startEchoTarget();
  const upstream = await startMockProxy('http', { delayReplyMs: 300 });
  const h = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: false,
    username: '',
    password: '',
  });

  try {
    const client = net.connect({ host: '127.0.0.1', port: h.port });
    await new Promise<void>((r) => client.once('connect', () => r()));

    // 普通 HTTP 请求（非 CONNECT）：头部先发，正文随后落在窗口内
    client.write(
      `POST http://127.0.0.1:${echo.port}/submit HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${echo.port}\r\n` +
      'Content-Length: 16\r\n\r\n',
    );
    await new Promise((r) => setTimeout(r, 30));
    client.write('POST-BODY-16byte');

    const received = await new Promise<string>((resolve, reject) => {
      let acc = '';
      const timer = setTimeout(() => reject(new Error(`超时未收到回显，已收到：${JSON.stringify(acc)}`)), 6000);
      client.on('data', (chunk) => {
        acc += chunk.toString('latin1');
        if (acc.includes('BODY=POST-BODY-16byte')) {
          clearTimeout(timer);
          resolve(acc);
        }
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.match(received, /METHOD=POST/, '应完整转发 POST 请求');
    assert.match(received, /BODY=POST-BODY-16byte/, 'POST 正文必须完整送达，否则目标会一直等 Content-Length');
    client.destroy();
  } finally {
    await h.close();
    await upstream.close();
    await echo.close();
  }
});

/* ------------------------------------------------------------------ */
/* P0-2：客户端半关闭之后仍要能收到响应                                 */
/* ------------------------------------------------------------------ */

test('客户端半关闭（发完就 shutdown 写端）之后仍能收到完整响应', async () => {
  const target = await startEchoTarget();
  const upstream = await startMockProxy('http', {});
  const h = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: false,
    username: '',
    password: '',
  });

  try {
    const client = net.connect({ host: '127.0.0.1', port: h.port });
    await new Promise<void>((r) => client.once('connect', () => r()));

    client.write(
      `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${target.port}\r\n` +
      'Connection: close\r\n\r\n',
    );
    // 请求发完就半关闭写端，但继续等待响应 —— HTTP/1.0 与部分 SDK 的习惯写法
    await new Promise((r) => setTimeout(r, 50));
    client.end();

    const received = await new Promise<string>((resolve, reject) => {
      let acc = '';
      const timer = setTimeout(
        () => reject(new Error(`超时未收到响应体，已收到：${JSON.stringify(acc)}`)),
        6000,
      );
      client.on('data', (chunk) => {
        acc += chunk.toString('latin1');
      });
      client.on('end', () => {
        clearTimeout(timer);
        resolve(acc);
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.match(received, /200 OK/, '应收到 HTTP 200 状态行');
    assert.match(received, /METHOD=GET/, '半关闭之后响应体仍必须完整送达');
  } finally {
    await h.close();
    await upstream.close();
    await target.close();
  }
});

/* ------------------------------------------------------------------ */
/* P0-3：stop() 不能被未完成握手的连接卡住                              */
/* ------------------------------------------------------------------ */

test('stop() 在存在「连上但不发数据」的连接时仍能及时返回', async () => {
  const upstream = await startMockProxy('http', {});
  const h = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: false,
    username: '',
    password: '',
  });

  const silent = net.connect({ host: '127.0.0.1', port: h.port });
  await new Promise<void>((r) => silent.once('connect', () => r()));
  // 刻意什么都不发：这正是浏览器预连接的样子，它不会进入 connStates

  try {
    const started = Date.now();
    await h.bridge.stop();
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2000, `stop() 应立刻返回，实际用了 ${elapsed}ms（被未握手的连接卡住了）`);
    assert.equal(h.bridge.getStatus().state, 'stopped', '停止后状态应为 stopped');
  } finally {
    silent.destroy();
    await upstream.close();
  }
});
