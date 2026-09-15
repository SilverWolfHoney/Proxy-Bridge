/**
 * 本地网关端到端测试。
 *
 * 全程只用 127.0.0.1 上的临时服务，不接触任何真实代理服务器：
 *   - 模拟一个带认证的上游代理（HTTP / SOCKS5）
 *   - 模拟一个被访问的目标服务
 *   - 让网关去转发，检查凭据注入、分流决策与错误处理
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ProxyBridge } from '../src/core/bridge';
import { startEchoServer, startMockProxy } from './helpers/mockProxy.js';

interface BridgeHarness {
  bridge: InstanceType<typeof ProxyBridge>;
  port: number;
  close(): Promise<void>;
}

/** 在随机端口上起一个网关实例 */
async function startBridge(upstream: {
  protocol: 'http' | 'socks5';
  host: string;
  port: number;
  authEnabled: boolean;
  username: string;
  password: string;
}): Promise<BridgeHarness> {
  const bridge = new ProxyBridge({
    host: '127.0.0.1',
    port: 0,
    upstream: { ...upstream, timeoutMs: 4000 },
    rules: { direct: [], proxy: [] },
  });

  const status = await bridge.start();
  assert.equal(status.state, 'running', `网关未启动：${status.error ?? ''}`);

  const listen = status.listen ?? '';
  const port = Number(listen.slice(listen.lastIndexOf(':') + 1));
  assert.ok(port > 0, '网关端口解析失败');

  return {
    bridge,
    port,
    close: async () => {
      await bridge.stop();
    },
  };
}

/** 通过网关建立 CONNECT 隧道，发一个请求并收集响应 */
function requestViaTunnel(
  bridgePort: number,
  targetHost: string,
  targetPort: number,
  path: string,
  waitFor = 'echo:',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: bridgePort }, () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });
    socket.setTimeout(5000);

    let buffer = Buffer.alloc(0);
    let tunnelReady = false;
    let done = false;

    const finish = (value: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!tunnelReady) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 200/.test(head)) {
          socket.destroy();
          reject(new Error(`隧道建立失败：${head.split('\r\n')[0]}`));
          return;
        }
        tunnelReady = true;
        buffer = buffer.subarray(end + 4);
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`,
        );
      }

      if (tunnelReady && buffer.includes(Buffer.from(waitFor))) {
        finish(buffer.toString('utf8'));
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('请求超时'));
    });
    socket.on('error', (err) => reject(err));
  });
}

/**
 * 打开隧道后立刻返回，不主动发任何数据。
 * 用来验证「客户端还没说话，目标服务器先发来的首包」是否被完整转发。
 */
function openTunnelAndCollect(
  bridgePort: number,
  targetHost: string,
  targetPort: number,
  expected: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: bridgePort }, () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });
    socket.setTimeout(5000);

    let buffer = Buffer.alloc(0);
    let tunnelReady = false;
    let done = false;

    const finish = (value: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!tunnelReady) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 200/.test(head)) {
          socket.destroy();
          reject(new Error(`隧道建立失败：${head.split('\r\n')[0]}`));
          return;
        }
        tunnelReady = true;
        buffer = buffer.subarray(end + 4);
      }
      if (tunnelReady && buffer.includes(Buffer.from(expected))) {
        finish(buffer.toString('latin1'));
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('等待目标首包超时'));
    });
    socket.on('error', (err) => reject(err));
  });
}

test('健康检查端点可供浏览器插件探测，并报出真实端口', async () => {
  const harness = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: 1,
    authEnabled: false,
    username: '',
    password: '',
  });

  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: harness.port }, () => {
        socket.write('GET /__proxybridge__/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /"app":"proxy-bridge"/);
    assert.match(response, /Access-Control-Allow-Origin: \*/);

    // 插件靠这些字段判断「这是配套的桌面应用」并自动跟随端口
    const body = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as {
      app: string;
      ok: boolean;
      port: number;
      listen: string;
    };
    assert.equal(body.app, 'proxy-bridge');
    assert.equal(body.ok, true);
    assert.equal(body.port, harness.port, 'port 必须是真实监听的端口，插件用它自动跟随');
    assert.equal(body.listen, `127.0.0.1:${harness.port}`);
  } finally {
    await harness.close();
  }
});

test('命中直连规则时不经过上游代理', async () => {
  const upstream = await startMockProxy('http');
  const echo = await startEchoServer();
  const harness = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: false,
    username: '',
    password: '',
  });
  harness.bridge.updateOptions({ rules: { direct: ['127.0.0.1'], proxy: [] } });

  try {
    const response = await requestViaTunnel(harness.port, '127.0.0.1', echo.port, '/hello');
    assert.match(response, /echo:GET \/hello/);
    assert.equal(upstream.targets.size, 0, '直连流量不应出现在上游代理里');
  } finally {
    await harness.close();
    await echo.close();
    await upstream.close();
  }
});

test('走代理时由网关注入 Basic 认证，客户端无需知道凭据', async () => {
  const upstream = await startMockProxy('http', { auth: { username: 'tester', password: 's3cret' } });
  const echo = await startEchoServer();
  const harness = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: true,
    username: 'tester',
    password: 's3cret',
  });

  try {
    const response = await requestViaTunnel(harness.port, '127.0.0.1', echo.port, '/via-proxy');
    assert.match(response, /echo:GET \/via-proxy/);
    assert.equal(upstream.targets.get(`127.0.0.1:${echo.port}`), 1);

    const expected = 'Basic ' + Buffer.from('tester:s3cret').toString('base64');
    assert.ok(upstream.authHeaders.includes(expected), '上游未收到正确的认证头');
  } finally {
    await harness.close();
    await echo.close();
    await upstream.close();
  }
});

test('凭据错误时上游返回 407，网关如实上报失败并计入统计', async () => {
  const upstream = await startMockProxy('http', { auth: { username: 'tester', password: 'right' } });
  const echo = await startEchoServer();
  const harness = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: true,
    username: 'tester',
    password: 'wrong',
  });

  try {
    await assert.rejects(
      () => requestViaTunnel(harness.port, '127.0.0.1', echo.port, '/nope'),
      /隧道建立失败：HTTP\/1\.1 502/,
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    const status = harness.bridge.getStatus();
    assert.equal(status.stats.totalConnections, 1);
    assert.equal(status.stats.failedConnections, 1);

    const records = harness.bridge.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'failed');
    assert.match(records[0].note ?? '', /认证失败|407/);
  } finally {
    await harness.close();
    await echo.close();
    await upstream.close();
  }
});

test('SOCKS5 上游可用', async () => {
  const upstream = await startMockProxy('socks5', { auth: { username: 'tester', password: 's3cret' } });
  const echo = await startEchoServer();
  const harness = await startBridge({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: true,
    username: 'tester',
    password: 's3cret',
  });

  try {
    const response = await requestViaTunnel(harness.port, '127.0.0.1', echo.port, '/socks');
    assert.match(response, /echo:GET \/socks/);
    assert.equal(upstream.targets.get(`127.0.0.1:${echo.port}`), 1);
  } finally {
    await harness.close();
    await echo.close();
    await upstream.close();
  }
});

/*
 * 下面两个用例针对的是最容易出错、又最难在真实环境复现的地方：
 * 隧道刚建立的那一瞬间，如果目标服务器的首包（真实场景里就是 TLS ServerHello）
 * 与握手应答挤在同一个 TCP 段里到达，网关既不能丢字节，也不能把字节串错位置。
 */

test('CONNECT 应答与目标首包同段到达时，首包被完整转发且不重不漏（HTTP 上游）', async () => {
  // 模拟代理把「应答 + 目标首包」写在同一个 TCP 段里
  const firstPacket = 'TARGET-FIRST-PACKET\n';
  const upstream = await startMockProxy('http', { trailingBytes: firstPacket });
  // 目标服务不主动推送，保证收到的首包只能来自模拟代理的串包，便于判定
  const echo = await startEchoServer();
  const harness = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: false,
    username: '',
    password: '',
  });

  try {
    const received = await openTunnelAndCollect(harness.port, '127.0.0.1', echo.port, firstPacket);
    assert.equal(received, firstPacket, '首包内容与顺序必须完全一致');
    assert.equal(received.split(firstPacket).length - 1, 1, '首包不应被重复转发');
  } finally {
    await harness.close();
    await echo.close();
    await upstream.close();
  }
});

test('CONNECT 应答与目标首包同段到达时，首包被完整转发且不重不漏（SOCKS5 上游）', async () => {
  const firstPacket = 'SOCKS-TARGET-HELLO\n';
  const upstream = await startMockProxy('socks5', {
    auth: { username: 'tester', password: 's3cret' },
    trailingBytes: firstPacket,
  });
  const echo = await startEchoServer();
  const harness = await startBridge({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: upstream.port,
    authEnabled: true,
    username: 'tester',
    password: 's3cret',
  });

  try {
    const received = await openTunnelAndCollect(harness.port, '127.0.0.1', echo.port, firstPacket);
    assert.equal(received, firstPacket, '首包内容与顺序必须完全一致');
    assert.equal(received.split(firstPacket).length - 1, 1, '首包不应被重复转发');
  } finally {
    await harness.close();
    await echo.close();
    await upstream.close();
  }
});

test('未配置服务器时报错清晰，且不产生假成功', async () => {
  const echo = await startEchoServer();
  const harness = await startBridge({
    protocol: 'http',
    host: '',
    port: 0,
    authEnabled: false,
    username: '',
    password: '',
  });

  try {
    await assert.rejects(
      () => requestViaTunnel(harness.port, '127.0.0.1', echo.port, '/x'),
      /隧道建立失败：HTTP\/1\.1 502/,
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    const records = harness.bridge.getRecords();
    assert.equal(records.length, 1);
    assert.match(records[0].note ?? '', /尚未配置代理服务器/);
  } finally {
    await harness.close();
    await echo.close();
  }
});

test('停止网关后端口立即释放', async () => {
  const harness = await startBridge({
    protocol: 'http',
    host: '127.0.0.1',
    port: 1,
    authEnabled: false,
    username: '',
    password: '',
  });
  const port = harness.port;
  await harness.close();

  const status = harness.bridge.getStatus();
  assert.equal(status.state, 'stopped');
  assert.equal(status.listen, null);

  // 端口应可被重新占用
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
