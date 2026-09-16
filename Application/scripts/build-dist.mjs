/**
 * 打包脚本。
 *
 * electron-builder 在 Windows 上除了 npm 包，还要下载 NSIS、winCodeSign 等辅助工具，
 * 默认从 GitHub 拉取 —— 本机直连 GitHub 会超时，所以在这里固定走国内镜像。
 * 这样无论用哪个包管理器（npm/pnpm/yarn）执行，镜像设置都生效。
 *
 * 用法：
 *   node scripts/build-dist.mjs                     打包安装程序 + 免安装版
 *   node scripts/build-dist.mjs --dir               只产出免安装目录（快，用于验证）
 *   node scripts/build-dist.mjs --out=<目录> [参数]  换输出目录，其余参数交给 electron-builder
 *    例如只出安装程序：--out=dist-verify -c.win.target=nsis
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 解析 --out=<目录>：临时换个输出位置（用于产出额外的一套包），
 * 其余参数原样交给 electron-builder。 */
const rawArgs = process.argv.slice(2);
let outputDir = path.resolve(ROOT, '..', 'release');
const extraArgs = [];

for (const arg of rawArgs) {
  const match = /^--out=(.+)$/.exec(arg);
  if (match) {
    outputDir = path.resolve(ROOT, '..', match[1]);
    continue;
  }
  extraArgs.push(arg);
}

// electron-builder 的 output 是相对配置所在目录（Application/）解析的，
// 这里换算成相对路径，避免绝对路径里的反斜杠被 shell 吃掉
const outputRelativeToApp = path.relative(ROOT, outputDir).split(path.sep).join('/');

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
console.log('  输出目录:', outputDir);
console.log('  参数:', extraArgs.length ? extraArgs.join(' ') : '（默认 Windows 安装程序 + 免安装版）');

const result = spawnSync(bin, ['--win', `-c.directories.output=${outputRelativeToApp}`, ...extraArgs], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.error(`\n打包失败，退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}

/* 收尾：清掉 .blockmap
 *
 * 那是自动更新做增量下载用的索引，本项目不发布更新（publish 为 null），
 * 留着没意义。配置里已经用 differentialPackage: false 关掉了生成，
 * 这里再扫一遍兜底：万一某个版本的 electron-builder 仍然产出，
 * 也不至于让它留在交付目录里让人困惑。 */
const removed = [];
if (fs.existsSync(outputDir)) {
  for (const name of fs.readdirSync(outputDir)) {
    if (name.endsWith('.blockmap')) {
      fs.rmSync(path.join(outputDir, name), { force: true });
      removed.push(name);
    }
  }
}

/* 收尾：清掉中间产物
 *
 * 同时打 portable + nsis 时 electron-builder 会自己删掉 win-unpacked，
 * 只打其中一种时它就留在原地了（白占约 270 MB）。这里统一兜底删掉，
 * 交付目录里只应该剩安装包本身。 */
for (const name of ['win-unpacked', 'builder-debug.yml']) {
  const target = path.join(outputDir, name);
  if (!fs.existsSync(target)) continue;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(name);
}

console.log(`\n打包完成，产物在 ${outputDir}：`);
for (const name of fs.readdirSync(outputDir)) {
  const full = path.join(outputDir, name);
  const isDir = fs.statSync(full).isDirectory();
  const size = isDir ? '' : `${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB`;
  console.log(`  ${name}${isDir ? '/' : ''}  ${size}`);
}
if (removed.length > 0) {
  console.log(`\n已清理无用的更新索引：${removed.join(', ')}`);
}
