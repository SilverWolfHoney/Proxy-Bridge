/**
 * 打包脚本。
 *
 * electron-builder 在 Windows 上除了 npm 包，还要下载 NSIS、winCodeSign 等辅助工具，
 * 默认从 GitHub 拉取 —— 本机直连 GitHub 会超时，所以在这里固定走国内镜像。
 * 这样无论用哪个包管理器（npm/pnpm/yarn）执行，镜像设置都生效。
 *
 * 用法：
 *   node scripts/build-dist.mjs            打包安装程序 + 免安装版
 *   node scripts/build-dist.mjs --dir      只产出免安装目录（快，用于验证）
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extraArgs = process.argv.slice(2);

const env = {
  ...process.env,
  // electron-builder 打包时要自己下载一份对应版本的 Electron 二进制
  ELECTRON_MIRROR: 'https://registry.npmmirror.com/-/binary/electron/',
  // 其余辅助工具（nsis / winCodeSign / app-builder）走同一个镜像
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/',
  // 不自动找代码签名证书：本地打包没有证书，找了会白等
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};

const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');

console.log('开始打包（镜像已指向 npmmirror）...');
console.log('  参数:', extraArgs.length ? extraArgs.join(' ') : '（默认 Windows 安装程序 + 免安装版）');

const result = spawnSync(bin, ['--win', ...extraArgs], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.error(`\n打包失败，退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log('\n打包完成，产物在 release/ 目录。');
