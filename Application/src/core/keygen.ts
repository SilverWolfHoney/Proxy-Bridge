/**
 * SSH 密钥对生成（ed25519）。
 *
 * 为什么需要自己造轮子：
 *
 *   Node 的 crypto 只能导出 PKCS#8 私钥，而 Windows / macOS 自带的 ssh 客户端
 *   只认 **OpenSSH 原生格式**（`-----BEGIN OPENSSH PRIVATE KEY-----`）。
 *   实测把 PKCS#8 交给 ssh-keygen 会直接报 `invalid format`。
 *
 *   而"把安装包发给别人"这种场景下，对方机器上未必有 ssh-keygen 可用，
 *   也不该要求他理解 SSH。所以这里按 OpenSSH 的线格式手工拼一份私钥，
 *   让他点一下就能拿到可用的密钥对，只需把公钥贴到服务器上。
 *
 * 格式要点（都是实测踩出来的）：
 *
 *   1. 整体是二进制 `openssh-key-v1\0` + 若干「长度前缀字符串」。
 *   2. ed25519 的**私钥字段是 64 字节 = 32 字节种子 + 32 字节公钥**，
 *      只放种子会被判为 invalid format。
 *   3. 两个 checkint 必须相同且随机，sshd 用它校验解密结果。
 *   4. 未加密的私钥块要填充到 8 字节边界，填充字节为 1,2,3…
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** OpenSSH 线格式字符串：4 字节大端长度 + 内容 */
function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** uint32 大端 */
function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

export interface GeneratedKey {
  /** 私钥文件路径 */
  privateKeyPath: string;
  /** 公钥文件路径（`<privateKeyPath>.pub`） */
  publicKeyPath: string;
  /** 公钥单行内容，需要用户粘贴到服务器的 authorized_keys */
  publicKey: string;
  /** 公钥指纹（与 `ssh-keygen -lf` 一致），便于和服务器上的记录对照 */
  fingerprint: string;
}

export interface GenerateKeyOptions {
  /** 私钥写到哪个路径；同名的 .pub 放公钥 */
  path: string;
  /** 公钥行末尾的备注 */
  comment?: string;
}

/**
 * 生成一对 ed25519 密钥并落盘（权限 0600）。
 *
 * 已存在同名文件时**拒绝覆盖**：那可能是用户自己正在用的密钥，
 * 静默覆盖会造成无法挽回的后果，交由调用方换一个路径。
 */
export function generateSshKey(options: GenerateKeyOptions): GeneratedKey {
  const keyPath = options.path;
  if (fs.existsSync(keyPath)) {
    throw new Error(`文件已存在，未覆盖：${keyPath}。请换一个文件名，或先备份原文件。`);
  }

  const comment = options.comment ?? 'proxy-bridge';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // ed25519 的原始密钥都是 32 字节：SPKI 尾部是公钥，PKCS#8 尾部是种子
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const rawPub = spki.subarray(spki.length - 32);
  const seed = pkcs8.subarray(pkcs8.length - 32);

  const keyType = Buffer.from('ssh-ed25519', 'utf8');
  const pubBlob = Buffer.concat([sshString(keyType), sshString(rawPub)]);

  // 私钥字段 = 种子 + 公钥（共 64 字节），漏掉后半段会导致 invalid format
  const privKey = Buffer.concat([seed, rawPub]);

  const check = crypto.randomBytes(4);
  const privBlock = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(rawPub),
    sshString(privKey),
    sshString(Buffer.from(comment, 'utf8')),
  ]);

  const padLen = (8 - (privBlock.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString(Buffer.from('none', 'utf8')), // 加密算法（不加密）
    sshString(Buffer.from('none', 'utf8')), // KDF
    sshString(Buffer.alloc(0)), // KDF 选项
    u32(1), // 密钥数量
    sshString(pubBlob),
    sshString(Buffer.concat([privBlock, padding])),
  ]);

  const b64 = body.toString('base64').match(/.{1,70}/g)?.join('\n') ?? '';
  const privPem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const pubLine = `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`;
  const fingerprint =
    'SHA256:' + crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '');

  // 目录可能不存在（例如用户改了路径）
  const dir = path.dirname(keyPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(keyPath, privPem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(`${keyPath}.pub`, pubLine + '\n', { encoding: 'utf8', mode: 0o644 });

  /*
   * Windows 会忽略 writeFileSync 的 mode 参数（实测落盘是 0666），
   * 所以再显式收紧一次私钥权限。在 Unix 上这一步是必要的，
   * 在 Windows 上虽然语义不同（走 ACL），但 chmodSync 仍会尽力设置只读位。
   */
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // 某些文件系统（如挂载的网络盘）不支持改权限，忽略即可
  }

  return {
    privateKeyPath: keyPath,
    publicKeyPath: `${keyPath}.pub`,
    publicKey: pubLine,
    fingerprint,
  };
}

/**
 * 建议的密钥存放路径：优先放进 ~/.ssh，并用一个不与常见密钥冲突的名字。
 * 若该名字已被占用，则追加序号，避免覆盖用户既有密钥。
 */
export function suggestKeyPath(): string {
  const dir = path.join(os.homedir(), '.ssh');
  const base = 'id_ed25519_proxy';
  let candidate = path.join(dir, base);
  let n = 2;
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.pub`)) {
    candidate = path.join(dir, `${base}${n}`);
    n += 1;
  }
  return candidate;
}
