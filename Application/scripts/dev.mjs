/**
 * 开发模式启动器：一条命令同时拉起 Vite 开发服务器和 Electron。
 *
 * 直接运行 `vite` 只会启动界面服务器，Electron 那边拿不到地址就会去加载构建产物；
 * 这里由同一个进程先启动 Vite，再把真实地址通过 VITE_DEV_SERVER_URL 传给 Electron，
 * 这样界面改动可以热更新，主进程代码改动则重跑本命令即可。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  console.error('[dev] 无法获取 Vite 开发服务器地址');
  await server.close();
  process.exit(1);
}

console.log(`[dev] 界面开发服务器已就绪：${url}`);
console.log('[dev] 正在启动 Electron…');

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  await server.close().catch(() => {});
  process.exit(code);
};

child.on('close', (code) => {
  void shutdown(code ?? 0);
});

// Ctrl+C 时先结束 Electron，再关掉 Vite，避免端口残留
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
    void shutdown(0);
  });
}
