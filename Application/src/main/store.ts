/**
 * 配置持久化与凭据保护。
 *
 * 约定：
 *  - 磁盘上只保存用户自己填写的配置，代码里不存在任何默认服务器信息。
 *  - 密码使用 Electron 的 safeStorage（Windows 下为 DPAPI）加密后以 base64 落盘；
 *    若当前环境不支持加密，则退化为明文存储并在界面上给出警告，绝不静默降级。
 *  - 对外暴露的配置一律经过脱敏，密码字段永远不出现在返回值里。
 */

import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type DeepPartial,
  type SafeConfig,
  type UpstreamConfig,
} from '../shared/types';

/** 磁盘上的结构：密码被替换成加密串 */
interface StoredUpstream extends Omit<UpstreamConfig, 'password'> {
  passwordEnc: string | null;
}

interface StoredConfig extends Omit<AppConfig, 'upstream'> {
  upstream: StoredUpstream;
  /** 记录写入时的格式版本，便于以后迁移 */
  schemaVersion: number;
  /** 早期版本用过的字段名，仅用于读取时兼容，不再写入 */
  systemProxy?: AppConfig['globalProxy'];
}

const SCHEMA_VERSION = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只保留字符串数组，去掉空项 */
function sanitizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback.slice();
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function clampPort(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 65535) return fallback;
  return num;
}

export interface ConfigStoreOptions {
  /** 配置文件所在目录，通常是 app.getPath('userData') */
  dir: string;
  /** 覆写文件名，便于测试 */
  fileName?: string;
}

export class ConfigStore {
  private readonly filePath: string;
  private config: AppConfig;

  constructor(options: ConfigStoreOptions) {
    this.filePath = path.join(options.dir, options.fileName ?? 'config.json');
    this.config = this.readFromDisk();
  }

  /** 配置文件绝对路径 */
  get path(): string {
    return this.filePath;
  }

  /** 当前是否具备加密能力 */
  get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** 含明文密码的完整配置，仅限主进程内部使用 */
  getConfig(): AppConfig {
    return {
      upstream: { ...this.config.upstream },
      bridge: { ...this.config.bridge },
      rules: { direct: this.config.rules.direct.slice(), proxy: this.config.rules.proxy.slice() },
      globalProxy: { ...this.config.globalProxy },
    };
  }

  /** 可以安全发给渲染层的配置 */
  getSafeConfig(): SafeConfig {
    const full = this.getConfig();
    return {
      ...full,
      upstream: {
        ...full.upstream,
        password: '',
        hasPassword: full.upstream.password.length > 0,
      },
    };
  }

  /**
   * 合并保存配置。
   * password 字段的语义：undefined = 保持不变，空串 = 清空，其他 = 覆盖。
   */
  save(patch: DeepPartial<AppConfig>): SafeConfig {
    const next = this.getConfig();

    if (isPlainObject(patch.upstream)) {
      const raw = patch.upstream as DeepPartial<UpstreamConfig>;
      if (raw.protocol === 'http' || raw.protocol === 'https' || raw.protocol === 'socks5') {
        next.upstream.protocol = raw.protocol;
      }
      if (typeof raw.host === 'string') next.upstream.host = raw.host.trim();
      if (raw.port !== undefined) next.upstream.port = clampPort(raw.port, next.upstream.port);
      if (typeof raw.authEnabled === 'boolean') next.upstream.authEnabled = raw.authEnabled;
      if (typeof raw.username === 'string') next.upstream.username = raw.username;
      if (typeof raw.password === 'string') next.upstream.password = raw.password;
      if (raw.timeoutMs !== undefined) {
        const t = Number(raw.timeoutMs);
        if (Number.isFinite(t)) next.upstream.timeoutMs = Math.min(120_000, Math.max(1_000, Math.round(t)));
      }
    }

    if (isPlainObject(patch.bridge)) {
      const raw = patch.bridge as DeepPartial<AppConfig['bridge']>;
      if (typeof raw.host === 'string' && raw.host.trim()) next.bridge.host = raw.host.trim();
      if (raw.port !== undefined) next.bridge.port = clampPort(raw.port, next.bridge.port);
      if (typeof raw.autoStart === 'boolean') next.bridge.autoStart = raw.autoStart;
    }

    if (isPlainObject(patch.rules)) {
      const raw = patch.rules as DeepPartial<AppConfig['rules']>;
      if (raw.direct !== undefined) next.rules.direct = sanitizeStringList(raw.direct, next.rules.direct);
      if (raw.proxy !== undefined) next.rules.proxy = sanitizeStringList(raw.proxy, next.rules.proxy);
    }

    if (isPlainObject(patch.globalProxy)) {
      const raw = patch.globalProxy as DeepPartial<AppConfig['globalProxy']>;
      if (typeof raw.enabled === 'boolean') next.globalProxy.enabled = raw.enabled;
      if (typeof raw.alsoHttps === 'boolean') next.globalProxy.alsoHttps = raw.alsoHttps;
    }

    this.config = next;
    this.writeToDisk();
    return this.getSafeConfig();
  }

  /* ---------------------------------------------------------------- */
  /* 磁盘读写                                                          */
  /* ---------------------------------------------------------------- */

  private readFromDisk(): AppConfig {
    try {
      if (!fs.existsSync(this.filePath)) return cloneDefault();
      const text = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) return cloneDefault();

      const base = cloneDefault();
      const stored = parsed as Partial<StoredConfig>;

      if (isPlainObject(stored.upstream)) {
        const up = stored.upstream as Partial<StoredUpstream>;
        if (up.protocol === 'http' || up.protocol === 'https' || up.protocol === 'socks5') {
          base.upstream.protocol = up.protocol;
        }
        if (typeof up.host === 'string') base.upstream.host = up.host;
        if (up.port !== undefined) base.upstream.port = clampPort(up.port, 0);
        if (typeof up.authEnabled === 'boolean') base.upstream.authEnabled = up.authEnabled;
        if (typeof up.username === 'string') base.upstream.username = up.username;
        if (up.timeoutMs !== undefined) {
          const t = Number(up.timeoutMs);
          if (Number.isFinite(t)) base.upstream.timeoutMs = Math.min(120_000, Math.max(1_000, Math.round(t)));
        }
        base.upstream.password = this.decryptPassword(up.passwordEnc ?? null);
      }

      if (isPlainObject(stored.bridge)) {
        const br = stored.bridge as Partial<AppConfig['bridge']>;
        if (typeof br.host === 'string' && br.host.trim()) base.bridge.host = br.host.trim();
        if (br.port !== undefined) base.bridge.port = clampPort(br.port, base.bridge.port);
        if (typeof br.autoStart === 'boolean') base.bridge.autoStart = br.autoStart;
      }

      if (isPlainObject(stored.rules)) {
        const ru = stored.rules as Partial<AppConfig['rules']>;
        if (ru.direct !== undefined) base.rules.direct = sanitizeStringList(ru.direct, base.rules.direct);
        if (ru.proxy !== undefined) base.rules.proxy = sanitizeStringList(ru.proxy, base.rules.proxy);
      }

      // 兼容早期版本写下的 systemProxy 字段名（那时这个功能叫「系统代理」）
      const storedGlobal = isPlainObject(stored.globalProxy)
        ? stored.globalProxy
        : isPlainObject(stored.systemProxy)
          ? stored.systemProxy
          : null;
      if (storedGlobal) {
        const gp = storedGlobal as Partial<AppConfig['globalProxy']>;
        if (typeof gp.enabled === 'boolean') base.globalProxy.enabled = gp.enabled;
        if (typeof gp.alsoHttps === 'boolean') base.globalProxy.alsoHttps = gp.alsoHttps;
      }

      return base;
    } catch (err) {
      // 配置文件损坏时不静默丢数据：备份后回退到默认值
      try {
        if (fs.existsSync(this.filePath)) {
          fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}.bak`);
        }
      } catch {
        /* 备份失败也不影响启动 */
      }
      console.error('[config] 读取配置失败，已回退到默认配置：', err);
      return cloneDefault();
    }
  }

  private writeToDisk(): void {
    const stored: StoredConfig = {
      schemaVersion: SCHEMA_VERSION,
      upstream: {
        protocol: this.config.upstream.protocol,
        host: this.config.upstream.host,
        port: this.config.upstream.port,
        authEnabled: this.config.upstream.authEnabled,
        username: this.config.upstream.username,
        timeoutMs: this.config.upstream.timeoutMs,
        passwordEnc: this.encryptPassword(this.config.upstream.password),
      },
      bridge: { ...this.config.bridge },
      rules: { direct: this.config.rules.direct.slice(), proxy: this.config.rules.proxy.slice() },
      globalProxy: { ...this.config.globalProxy },
    };

    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 先写临时文件再原子替换，避免掉电/崩溃写坏配置
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  private encryptPassword(plain: string): string | null {
    if (!plain) return null;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return 'enc:' + safeStorage.encryptString(plain).toString('base64');
      }
    } catch (err) {
      console.error('[config] 密码加密失败，将退化为明文存储：', err);
    }
    // 明确标注明文，便于用户识别风险
    return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
  }

  private decryptPassword(storedValue: string | null): string {
    if (!storedValue) return '';
    try {
      if (storedValue.startsWith('enc:')) {
        return safeStorage.decryptString(Buffer.from(storedValue.slice(4), 'base64'));
      }
      if (storedValue.startsWith('plain:')) {
        return Buffer.from(storedValue.slice(6), 'base64').toString('utf8');
      }
    } catch (err) {
      console.error('[config] 密码解密失败，需要重新填写：', err);
    }
    return '';
  }
}

function cloneDefault(): AppConfig {
  return {
    upstream: { ...DEFAULT_CONFIG.upstream },
    bridge: { ...DEFAULT_CONFIG.bridge },
    rules: { direct: DEFAULT_CONFIG.rules.direct.slice(), proxy: DEFAULT_CONFIG.rules.proxy.slice() },
    globalProxy: { ...DEFAULT_CONFIG.globalProxy },
  };
}
