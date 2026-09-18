#!/usr/bin/env node
/**
 * 需要认证的本地代理服务器 —— 插件的排查工具。
 *
 * 用途：插件连不上时，用它把「插件的问题」和「代理服务器的问题」分开。
 * 它会在本机模拟一个「必须账号密码才能用」的 HTTP 代理，并把收到的一切打印出来：
 * 握手内容、有没有带 Proxy-Authorization、账号密码对不对。
 *
 *   node mock-auth-proxy.mjs
 *   node mock-auth-proxy.mjs --user alice --pass s3cret --port 18080
 *
 * 然后把插件里的服务器填成： 协议 http / 地址 127.0.0.1 / 端口 18080
 * 账号密码填成上面那两个。开插件开关，浏览器随便打开一个 http 网站。
 *
 * 这个窗口会打印出判定结果：
 *   ✓ 认证成功        —— 说明插件把账号密码正确送出来了，插件没问题
 *   ✗ 认证失败(407)   —— 收到请求但凭据不对，多半是插件里填错了
 *   (没有任何输出)    —— 浏览器压根没把请求发过来，那是 chrome.proxy 那层没生效
 *
 * 三种结果对应三个完全不同的病因，所以这个工具能把范围一次缩到底。
 */

import http from 'node:http';
import net from 'node:net';
import process from 'node:process';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(argOf('--port', '18080'));
const HOST = argOf('--bind', '127.0.0.1');
const EXPECT_USER = argOf('--user', 'alice');
const EXPECT_PASS = argOf('--pass', 's3cret');

let seq = 0;
const stamp = () => {
  seq += 1;
  return `[${String(seq).padStart(3, '0')}] ${new Date().toLocaleTimeString('zh-CN')}`;
};

/** 解析 Proxy-Authorization: Basic xxx */
function parseAuth(header) {
  if (!header) return null;
  const m = /^Basic\s+(.+)$/i.exec(String(header).trim());
  if (!m) return null;
  try {
    const raw = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx === -1) return null;
    return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

const server = http.createServer();

/*
 * 关键点：必须监听 'connect' 事件。
 *
 * HTTPS 网站走的是 CONNECT 隧道，而认证恰恰发生在这个阶段 ——
 * 它不属于普通的 request 事件。只在 request 里做认证检查，
 * 会漏掉绝大多数真实流量（浏览器现在几乎全站 HTTPS）。
 */
/** 需要认证时统一回复 407；用 end 让对端读完响应，destroy 会让 curl/浏览器拿不到状态码 */
function denyWith407(socket) {
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
    'Proxy-Authenticate: Basic realm="mock"\r\n' +
    'Content-Length: 0\r\n' +
    'Connection: close\r\n\r\n',
  );
}

server.on('connect', (req, clientSocket, head) => {
  // 客户端可能随时断开（浏览器取消请求就会这样），没有这个处理会让整个 mock 崩掉
  clientSocket.on('error', () => clientSocket.destroy());

  const auth = parseAuth(req.headers['proxy-authorization']);
  const target = req.url;

  if (!auth) {
    console.log(`${stamp()} ✗ 没有凭据  CONNECT ${target}  → 回复 407`);
    denyWith407(clientSocket);
    return;
  }

  if (auth.username !== EXPECT_USER || auth.password !== EXPECT_PASS) {
    console.log(`${stamp()} ✗ 凭据不匹配  CONNECT ${target}`);
    console.log(`        收到用户名: ${JSON.stringify(auth.username)}`);
    console.log(`        收到密码  : ${JSON.stringify(auth.password)}`);
    console.log(`        期望用户名: ${JSON.stringify(EXPECT_USER)}`);
    console.log(`        期望密码  : ${JSON.stringify(EXPECT_PASS)}`);
    denyWith407(clientSocket);
    return;
  }

  console.log(`${stamp()} ✓ 认证成功  CONNECT ${target}  (用户 ${auth.username})`);

  // 认证通过：真的把流量转出去，这样浏览器里的网页能正常打开
  const [host, portText] = target.split(':');
  const port = Number(portText) || 443;

  const upstream = net.connect({ host, port }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const fail = (err) => {
    console.log(`        转发到 ${host}:${port} 失败：${err.message}`);
    clientSocket.destroy();
    upstream.destroy();
  };
  upstream.on('error', fail);
  clientSocket.on('error', () => upstream.destroy());
});

/**
 * 普通 HTTP 请求（非 CONNECT）。
 *
 * 这里必须真的转发到目标站点，不能自己编一个响应 ——
 * 否则访问 http 网站时看到的是 mock 自己造的内容，
 * 会让人误以为「代理生效了」，把排查方向带偏。
 */
server.on('request', (req, res) => {
  const auth = parseAuth(req.headers['proxy-authorization']);
  const target = req.url;   // 代理请求里是完整 URL

  if (!auth || auth.username !== EXPECT_USER || auth.password !== EXPECT_PASS) {
    const why = auth ? '凭据不匹配' : '没有凭据';
    console.log(`${stamp()} ✗ ${why}  ${req.method} ${target}  → 回复 407`);
    if (auth) {
      console.log(`        收到: ${JSON.stringify(auth.username)} / ${JSON.stringify(auth.password)}`);
    }
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="mock"', 'Content-Length': '0' });
    res.end();
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    console.log(`${stamp()} ✗ 无法解析目标地址：${target}`);
    res.writeHead(400, { 'Content-Length': '0' });
    res.end();
    return;
  }

  console.log(`${stamp()} ✓ 认证成功  ${req.method} ${target}`);

  // 用 node:http 直连目标；它不吃 http_proxy 环境变量，不会绕回自己形成环
  const upstreamReq = http.request(
    {
      host: parsed.hostname,
      port: Number(parsed.port) || 80,
      method: req.method,
      path: parsed.pathname + parsed.search,
      headers: { ...req.headers, host: parsed.host },
      timeout: 15000,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('连接目标站点超时')));
  upstreamReq.on('error', (err) => {
    console.log(`        转发到 ${parsed.host} 失败：${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`mock proxy: 转发失败 - ${err.message}\n`);
  });

  req.pipe(upstreamReq);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换一个：node mock-auth-proxy.mjs --port 18081\n`);
  } else {
    console.error(`\n启动失败：${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('需要认证的测试代理已启动');
  console.log(`  监听：    ${HOST}:${PORT}`);
  console.log(`  期望账号：${EXPECT_USER}`);
  console.log(`  期望密码：${EXPECT_PASS}`);
  console.log('');
  console.log('在插件里这样填：');
  console.log(`  协议：http    地址：127.0.0.1    端口：${PORT}`);
  console.log(`  打开「服务器需要用户名密码」，填上面那组账号密码`);
  console.log('');
  console.log('然后开启插件开关，用浏览器打开任意 https 网站（例如 https://www.baidu.com）。');
  console.log('下面会实时打印判定结果。按 Ctrl+C 停止。');
  console.log('');
});
