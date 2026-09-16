/**
 * 系统代理接管（Windows）。
 *
 * 通过修改 HKCU\...\Internet Settings 下的注册表值让系统级流量走本机网关，
 * 并在关闭时**还原**用户原本的设置，而不是粗暴地一律清空。
 *
 * 原始设置会同时落盘缓存，即使应用被强杀，下次启动也能一键还原。
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 注册表中的原始代理设置快照 */
export interface ProxySnapshot {
  ProxyEnable: number | null;
  ProxyServer: string | null;
  ProxyOverride: string | null;
  AutoConfigURL: string | null;
}

export interface SystemProxyResult {
  ok: boolean;
  /** 实际生效的代理字符串 */
  applied: string | null;
  error: string | null;
}

/** 运行 reg.exe 并返回输出（reg 自身不做转义处理，所以用 execFile 传参数组，避免注入） */
function runReg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg.exe',
      args,
      { windowsHide: true, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = decodeConsole(stdout);
        if (err) {
          const detail = decodeConsole(stderr).trim();
          reject(new Error(detail || err.message));
          return;
        }
        resolve(out);
      },
    );
  });
}

/** Windows 控制台默认是 GBK/CP936，先按 UTF-8 解，出现替换字符再退回 GBK */
function decodeConsole(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf;
  if (buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

/** 读取注册表里的一项，不存在返回 null */
async function readValue(name: string): Promise<string | null> {
  try {
    const out = await runReg(['query', REG_KEY, '/v', name]);
    const match = /REG_\w+\s+(.*)/.exec(out);
    if (!match) return null;
    return match[1].trim();
  } catch {
    return null; // 值不存在时 reg 会返回非 0
  }
}

/** 读取当前系统代理设置快照 */
export async function readProxySnapshot(): Promise<ProxySnapshot> {
  const [enable, server, override, autoConfig] = await Promise.all([
    readValue('ProxyEnable'),
    readValue('ProxyServer'),
    readValue('ProxyOverride'),
    readValue('AutoConfigURL'),
  ]);

  const parseNum = (v: string | null): number | null => {
    if (v === null) return null;
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  };

  return {
    ProxyEnable: parseNum(enable),
    ProxyServer: server,
    ProxyOverride: override,
    AutoConfigURL: autoConfig,
  };
}

async function writeValue(name: string, type: 'REG_DWORD' | 'REG_SZ', value: string): Promise<void> {
  await runReg(['add', REG_KEY, '/v', name, '/t', type, '/d', value, '/f']);
}

/** 同步写注册表：只用在「系统要关机了、来不及等异步」的场景 */
function writeValueSync(name: string, type: 'REG_DWORD' | 'REG_SZ', value: string): void {
  execFileSync('reg.exe', ['add', REG_KEY, '/v', name, '/t', type, '/d', value, '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

async function deleteValue(name: string): Promise<void> {
  try {
    await runReg(['delete', REG_KEY, '/v', name, '/f']);
  } catch {
    /* 值本来就不存在，忽略 */
  }
}

/**
 * 广播 WM_SETTINGCHANGE，让已经运行的程序（浏览器等）立刻感知到代理设置变化。
 * 纯注册表写入不会被已启动的进程感知，这一步是必要的。
 * 通过 PowerShell 现场编译一小段 P/Invoke 实现；失败只影响「立即生效」，不影响功能。
 */
async function notifySettingsChanged(): Promise<void> {
  if (process.platform !== 'win32') return;

  const script = [
    "$sig = '[DllImport(\"user32.dll\", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
    "'using System;' | Out-Null",
    "$t = Add-Type -MemberDefinition $sig -Name 'PbWin32' -Namespace 'Pb' -PassThru",
    '$r = [UIntPtr]::Zero',
    "[void]$t::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 2, 3000, [ref]$r)",
  ].join('; ');

  await new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 10_000 },
      () => resolve(),
    );
  });
}

/** 清空 DNS 缓存，避免刚切换代理时命中旧的解析结果 */
export async function flushDns(): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile('ipconfig.exe', ['/flushdns'], { windowsHide: true }, () => resolve());
  });
}

export class SystemProxyManager {
  private readonly cachePath: string;
  private snapshot: ProxySnapshot | null = null;

  constructor(userDataDir: string) {
    this.cachePath = path.join(userDataDir, 'system-proxy-backup.json');
    this.loadCache();
  }

  /** 上次运行留下的原始设置（用于异常退出后的恢复） */
  getSnapshot(): ProxySnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.snapshot = parsed as ProxySnapshot;
      }
    } catch {
      this.snapshot = null;
    }
  }

  private saveCache(snapshot: ProxySnapshot | null): void {
    this.snapshot = snapshot;
    try {
      if (snapshot === null) {
        if (fs.existsSync(this.cachePath)) fs.unlinkSync(this.cachePath);
        return;
      }
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (err) {
      console.error('[systemProxy] 备份系统代理设置失败：', err);
    }
  }

  /**
   * 让系统流量走本机网关。
   * @param host 网关监听地址
   * @param port 网关监听端口
   * @param bypass 绕过代理的地址列表（来自直连规则里可识别的部分）
   */
  async apply(host: string, port: number, bypass: string[]): Promise<SystemProxyResult> {
    if (process.platform !== 'win32') {
      return { ok: false, applied: null, error: `当前系统（${process.platform}）暂不支持自动接管，请手动把系统代理指向 ${host}:${port}` };
    }

    try {
      // 只在第一次接管时记录原始值，避免二次接管把「自己的设置」当成原始值
      if (this.snapshot === null) {
        this.saveCache(await readProxySnapshot());
      }

      const proxyServer = `${host}:${port}`;
      const override = bypass.length > 0 ? bypass.join(';') : '<local>';

      await writeValue('ProxyServer', 'REG_SZ', proxyServer);
      await writeValue('ProxyOverride', 'REG_SZ', override);
      // 系统代理与 PAC 互斥，接管期间清掉 AutoConfigURL，还原时再写回
      await deleteValue('AutoConfigURL');
      await writeValue('ProxyEnable', 'REG_DWORD', '1');
      await notifySettingsChanged();
      await flushDns();

      return { ok: true, applied: proxyServer, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, applied: null, error: `设置系统代理失败：${message}` };
    }
  }

  /** 还原到接管前的状态 */
  async restore(): Promise<SystemProxyResult> {
    if (process.platform !== 'win32') {
      return { ok: false, applied: null, error: '当前系统暂不支持自动还原' };
    }

    try {
      const snapshot = this.snapshot;

      if (snapshot === null) {
        // 没有备份说明不是我们设置的，稳妥起见只关掉代理开关
        await writeValue('ProxyEnable', 'REG_DWORD', '0');
        await flushDns();
        return { ok: true, applied: null, error: null };
      }

      if (snapshot.ProxyServer) await writeValue('ProxyServer', 'REG_SZ', snapshot.ProxyServer);
      else await deleteValue('ProxyServer');

      if (snapshot.ProxyOverride) await writeValue('ProxyOverride', 'REG_SZ', snapshot.ProxyOverride);
      else await deleteValue('ProxyOverride');

      if (snapshot.AutoConfigURL) await writeValue('AutoConfigURL', 'REG_SZ', snapshot.AutoConfigURL);
      else await deleteValue('AutoConfigURL');

      const enable = snapshot.ProxyEnable ?? 0;
      await writeValue('ProxyEnable', 'REG_DWORD', String(enable === 1 ? 1 : 0));
      await notifySettingsChanged();
      await flushDns();

      this.saveCache(null);
      return {
        ok: true,
        applied: enable === 1 ? (snapshot.ProxyServer ?? null) : null,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, applied: null, error: `还原系统代理失败：${message}` };
    }
  }

  /**
   * 同步关闭系统代理开关，用于「系统正在关机/注销、来不及等异步」的场景。
   *
   * 只做最关键的一件事：把 ProxyEnable 置 0。
   * 这样即使 ProxyServer 还指着本机端口，重启后也没有程序会去用它；
   * 用户原有的代理设置仍完整留在备份里，下次启动应用时会还原回去。
   *
   * @returns 是否成功
   */
  disableSync(): boolean {
    if (process.platform !== 'win32') return false;
    try {
      writeValueSync('ProxyEnable', 'REG_DWORD', '0');
      return true;
    } catch (err) {
      console.error('[systemProxy] 同步关闭系统代理失败：', err);
      return false;
    }
  }

  /** 当前系统代理是否指向我们的网关 */
  async isPointingTo(host: string, port: number): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const snapshot = await readProxySnapshot();
    if (snapshot.ProxyEnable !== 1 || !snapshot.ProxyServer) return false;
    const expected = `${host}:${port}`;
    return snapshot.ProxyServer.trim().toLowerCase() === expected.toLowerCase();
  }

  /** 应用是否曾接管过但没还原（上次异常退出的痕迹） */
  get hasStaleSnapshot(): boolean {
    return this.snapshot !== null;
  }
}
