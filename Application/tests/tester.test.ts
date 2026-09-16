/**
 * 协议自动识别测试。
 *
 * 全部使用本机 mock 代理与 mock 目标，不连接任何外部服务器：
 * 让 mock 只支持某一种协议，看「自动」模式能否识别出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { testUpstream } from '../src/core/tester';
import { startMockProxy } from './helpers/mockProxy';
import type { UpstreamConfig } from '../src/shared/types';

/** 一个什么都不接受的 TCP 服务：任何协议都会立刻失败 */
function startBlackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    // 收到任何数据都直接断开，让所有握手都失败
    socket.on('data', () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** 一个只回固定内容的 TCP 目标，隧道建立成功后 tester 会去读它 */
function startFakeTarget(body: string): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('data', () => {
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
      const addr = server.address();
      resolve({
        host: '127.0.0.1',
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function cfgFor(port: number): UpstreamConfig {
  return {
    protocol: 'auto',
    host: '127.0.0.1',
    port,
    authEnabled: false,
    username: '',
    password: '',
    timeoutMs: 4000,
  };
}

test('自动识别：只有 HTTP 代理可用时识别为 http', async () => {
  const proxy = await startMockProxy('http');
  const target = await startFakeTarget('198.51.100.7');
  try {
    const result = await testUpstream(cfgFor(proxy.port), {
      targets: [{ host: target.host, port: target.port }],
      ipEndpoints: [{ host: target.host, port: target.port, path: '/' }],
    });

    assert.equal(result.ok, true, `应识别成功，实际错误：${result.error ?? ''}`);
    assert.equal(result.testedProtocol, 'http');
    assert.equal(result.protocol, 'auto', 'protocol 保留用户的选择');
    assert.equal(result.exitIp, '198.51.100.7', '应读出目标返回的出口 IP');
    assert.ok(result.attempts && result.attempts.length === 1, '第一次尝试就应成功');
  } finally {
    await target.close();
    await proxy.close();
  }
});

test('自动识别：只有 SOCKS5 可用时会跳过 HTTP 识别为 socks5', async () => {
  const proxy = await startMockProxy('socks5');
  const target = await startFakeTarget('203.0.113.9');
  try {
    const result = await testUpstream(cfgFor(proxy.port), {
      targets: [{ host: target.host, port: target.port }],
      ipEndpoints: [{ host: target.host, port: target.port, path: '/' }],
    });

    assert.equal(result.ok, true, `应识别成功，实际错误：${result.error ?? ''}`);
    assert.equal(result.testedProtocol, 'socks5');
    assert.equal(result.exitIp, '203.0.113.9');

    // 第一个尝试（http）应当失败，第二个（socks5）成功
    assert.equal(result.attempts?.length, 2);
    assert.equal(result.attempts?.[0].protocol, 'http');
    assert.equal(result.attempts?.[0].ok, false);
    assert.equal(result.attempts?.[1].protocol, 'socks5');
    assert.equal(result.attempts?.[1].ok, true);
  } finally {
    await target.close();
    await proxy.close();
  }
});

test('自动识别：三种协议都不可用时，逐个给出失败原因', async () => {
  const blackHole = await startBlackHole();
  try {
    const result = await testUpstream(cfgFor(blackHole.port), {
      targets: [{ host: '127.0.0.1', port: blackHole.port }],
      ipEndpoints: [],
    });

    assert.equal(result.ok, false, '不应误报成功');
    assert.ok(result.attempts, '自动模式下应带回每种协议的尝试结果');
    assert.equal(result.attempts?.length, 3, '三种协议都应试过');
    assert.deepEqual(
      result.attempts?.map((a) => a.protocol),
      ['http', 'socks5', 'https'],
      '尝试顺序应为 http → socks5 → https',
    );
    for (const attempt of result.attempts ?? []) {
      assert.equal(attempt.ok, false);
      assert.ok(attempt.error, `${attempt.protocol} 应给出失败原因`);
    }
    assert.ok(result.error, '整体应有错误说明');
  } finally {
    await blackHole.close();
  }
});

test('指定具体协议时不走自动识别，只试那一种', async () => {
  const proxy = await startMockProxy('http');
  const target = await startFakeTarget('198.51.100.11');
  try {
    const cfg: UpstreamConfig = { ...cfgFor(proxy.port), protocol: 'http' };
    const result = await testUpstream(cfg, {
      targets: [{ host: target.host, port: target.port }],
      ipEndpoints: [{ host: target.host, port: target.port, path: '/' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.testedProtocol, 'http');
    assert.equal(result.attempts, undefined, '非自动模式不需要带回尝试列表');
  } finally {
    await target.close();
    await proxy.close();
  }
});

test('协议为自动但还没识别出结果时，网关转发会给出明确提示', async () => {
  const { ProxyBridge } = await import('../src/core/bridge');
  const bridge = new ProxyBridge({
    host: '127.0.0.1',
    port: 0,
    upstream: {
      protocol: 'auto',
      host: '127.0.0.1',
      port: 9,
      authEnabled: false,
      username: '',
      password: '',
      timeoutMs: 2000,
      // 刻意不设 detectedProtocol
    },
    rules: { direct: [], proxy: [] },
  });

  const status = await bridge.start();
  const port = Number(String(status.listen).split(':')[1]);

  try {
    // 经网关发一个 CONNECT，应得到 502，且日志里说明协议未确定
    await new Promise<void>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n');
      });
      socket.on('data', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => resolve());
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 4000);
    });

    await new Promise((r) => setTimeout(r, 150));
    const records = bridge.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'failed');
    assert.match(records[0].note ?? '', /协议尚未确定/, '应提示先测试连接以识别协议');
  } finally {
    await bridge.stop();
  }
});
