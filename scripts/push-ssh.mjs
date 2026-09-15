/**
 * 推送助手：这个网络环境下 github.com 的 HTTPS(443) 被阻断，但 SSH 通道可用。
 * 本脚本把 origin 切到 SSH、验证授权、然后推送，失败时给出人话提示，不静默重试。
 *
 * 用法（在仓库根目录）：
 *   node scripts/push-ssh.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'SilverWolfHoney';
const REPO_NAME = 'Proxy';
const SSH_REMOTE = `git@github.com:${OWNER}/${REPO_NAME}.git`;

/** 执行命令并返回 { ok, out }，不抛异常 */
function run(cmd, args, cwd = REPO) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, out };
}

function readPublicKey() {
  const pubPath = path.join(process.env.USERPROFILE ?? '', '.ssh', 'id_ed25519.pub');
  try {
    return fs.readFileSync(pubPath, 'utf8').trim();
  } catch {
    return '';
  }
}

console.log('仓库目录:', REPO);

// 1) 确认这是个 git 仓库
const insideRepo = run('git', ['rev-parse', '--is-inside-work-tree']);
if (!insideRepo.ok || insideRepo.out !== 'true') {
  console.log('✗ 这里不是 git 仓库');
  process.exit(1);
}

// 2) 测试 SSH 授权
console.log('\n[1/3] 测试 GitHub SSH 授权…');
const sshTest = run('ssh', [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15',
  '-T', 'git@github.com',
]);

if (/successfully authenticated/i.test(sshTest.out)) {
  const who = /Hi ([^!]+)!/.exec(sshTest.out);
  console.log(`  ✓ 授权成功${who ? `，GitHub 识别为：${who[1]}` : ''}`);
  if (who && who[1] !== OWNER) {
    console.log(`  ⚠ 但仓库地址用的是 ${OWNER}，两者不一致时可能没有写权限`);
  }
} else if (/Permission denied/i.test(sshTest.out)) {
  console.log('  ✗ 公钥还没加到 GitHub。');
  console.log('    打开 https://github.com/settings/ssh/new 添加下面这行公钥后，重跑本脚本：');
  const pub = readPublicKey();
  console.log(pub ? `\n    ${pub}\n` : '    （读取 ~/.ssh/id_ed25519.pub 失败，请手动查看该文件）');
  process.exit(1);
} else {
  console.log('  ✗ SSH 连接异常：', sshTest.out);
  process.exit(1);
}

// 3) 切换 remote 到 SSH（HTTPS 在本网络被阻断）
console.log('\n[2/3] 检查 origin 地址…');
const current = run('git', ['remote', 'get-url', 'origin']);
console.log('  当前 origin:', current.out || '(未设置)');

if (current.out === SSH_REMOTE) {
  console.log('  已经是 SSH 地址，无需修改');
} else {
  const action = current.ok ? 'set-url' : 'add';
  const changed = run('git', ['remote', action, 'origin', SSH_REMOTE]);
  if (!changed.ok) {
    console.log('  ✗ 修改 origin 失败：', changed.out);
    process.exit(1);
  }
  console.log(`  ✓ 已${action === 'add' ? '设置' : '改为'} ${SSH_REMOTE}`);
}

// 4) 推送
console.log('\n[3/3] 推送…');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
const pending = run('git', ['rev-list', '--count', `origin/${branch}..${branch}`]);
console.log(`  分支 ${branch}，待推送 ${pending.ok ? pending.out : '?'} 个提交`);

const push = spawnSync('git', ['push', '-u', 'origin', branch], {
  cwd: REPO,
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(push.stdout ?? '');
process.stderr.write(push.stderr ?? '');

if (push.status === 0) {
  console.log(`\n✓ 推送成功：${branch} → origin/${branch}`);
  console.log(`  仓库地址：https://github.com/${OWNER}/${REPO_NAME}`);
} else {
  console.log(`\n✗ 推送失败（退出码 ${push.status}）`);
  console.log('  常见原因：');
  console.log('   - GitHub 上还没有这个仓库 → 先建一个空的 Proxy 仓库（不要勾选 README / .gitignore / license）');
  console.log(`   - 登录的账号不是 ${OWNER} → 确认最终有写权限的那个人`);
  process.exit(push.status ?? 1);
}
