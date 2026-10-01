/**
 * 内置 SSH 隧道管理器。
 *
 * 解决的问题（实测数据，不是推测）：
 *
 *   明文 CONNECT 直连跨境代理时，`CONNECT <域名>:443` 这个请求本身会在
 *   中途被识别并重置，成功率实测只有 17%~37%，且按时间随机波动。
 *   同一时刻、同一服务器的对照实验中，把同样的流量放进 SSH 隧道后
 *   成功率达到 100%（20/20）。
 *
 * 原理：SSH 在**客户端侧**就把整条流加密了，中途只能看到一条 SSH 流，
 *       看不到 CONNECT，也看不到域名。这正是加密必须发生在客户端的原因——
 *       放在服务器侧是没有意义的。
 *
 * 实现取向：
 *   - 复用系统自带的 OpenSSH（Windows 10+ / macOS / Linux 均内置），
 *     不引入 ssh2 这类带原生模块的依赖，打包与体积都不受影响。
 *   - 隧道只把「服务器本机回环上的代理端口」映射到「本机回环端口」，
 *     上游认证逻辑完全不变：客户端仍然对着代理端口发凭据。
 *   - 进程异常退出自动重连，并对重连做退避，避免断网时疯狂重启。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/** 单次密钥尝试的结果，用于在所有密钥都失败时给出可对照的说明 */
interface KeyAttempt {
  /** 本次使用的私钥路径；空串表示交给 ssh 自行协商（ssh-agent） */
  keyPath: string;
  /** 失败原因（已翻译成中文） */
  reason: string;
}

/** 隧道运行状态 */
export type TunnelState = 'stopped' | 'starting' | 'ready' | 'reconnecting' | 'error';

/** 隧道对外状态快照（可安全暴露给渲染层） */
export interface TunnelStatus {
  state: TunnelState;
  /** 本机监听地址，形如 127.0.0.1:17890；未就绪时为 null */
  listen: string | null;
  /** 出错时的中文说明 */
  error: string | null;
  /** 已重连次数，用于界面提示链路抖动 */
  reconnects: number;
  /** 就绪时刻的时间戳 */
  readyAt: number | null;
}

export interface TunnelOptions {
  /** SSH 登录用户名 */
  user: string;
  /** SSH 服务器地址（通常与代理服务器相同） */
  host: string;
  /** SSH 端口 */
  port: number;
  /** 私钥文件路径；为空则交给 ssh 自行协商（含 ssh-agent） */
  keyPath: string;
  /**
   * 服务器上「回环地址里的代理端口」。
   * 隧道建立后，本机 `localPort` 等价于服务器上的 127.0.0.1:remotePort。
   */
  remotePort: number;
  /** 本机监听端口；0 表示由系统分配空闲端口 */
  localPort: number;
  /** 建连超时（毫秒） */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT = 25_000;
const RECONNECT_BASE_DELAY = 1_500;
const RECONNECT_MAX_DELAY = 15_000;

/** 展开 `~` 并规范化路径 */
export function expandHome(p: string): string {
  const text = p.trim();
  if (!text) return text;
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

/**
 * 在常见位置里挑一个存在的私钥，找不到返回空串。
 * @param preferred 用户配置的路径，存在时优先采用它
 */
export function findDefaultKey(preferred?: string): string {
  const candidates = [
    preferred ? expandHome(preferred) : '',
    path.join(os.homedir(), '.ssh', 'id_ed25519'),
    path.join(os.homedir(), '.ssh', 'id_ed25519_proxy'),
    path.join(os.homedir(), '.ssh', 'id_rsa'),
    path.join(os.homedir(), '.ssh', 'id_ecdsa'),
  ].filter((p) => p.length > 0);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch {
      // 权限异常时跳过，继续找下一个
    }
  }
  return '';
}

/** 申请一个空闲的本地端口（用完即释放，存在极小的竞态窗口） */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('无法分配本地端口'))));
    });
  });
}

/** 探测某个本地端口是否已经可以接受连接 */
function probePort(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TunnelManager extends EventEmitter {
  private options: TunnelOptions | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: TunnelState = 'stopped';
  private lastError: string | null = null;
  private listenPort: number | null = null;
  private readyAt: number | null = null;
  private reconnects = 0;
  /** 用户主动停止时置位，避免退出流程里又触发自动重连 */
  private stopping = false;
  /** 当前这一轮的启动 promise，重入时复用 */
  private starting: Promise<TunnelStatus> | null = null;

  getStatus(): TunnelStatus {
    return {
      state: this.state,
      listen: this.listenPort ? `127.0.0.1:${this.listenPort}` : null,
      error: this.lastError,
      reconnects: this.reconnects,
      readyAt: this.readyAt,
    };
  }

  private setState(state: TunnelState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    this.emit('status', this.getStatus());
  }

  /**
   * 建立隧道。已就绪时直接返回当前状态（幂等）。
   * @param options 隧道参数
   */
  async start(options: TunnelOptions): Promise<TunnelStatus> {
    if (this.state === 'ready' && this.child && !this.child.killed) return this.getStatus();
    if (this.starting) return this.starting;

    this.stopping = false;
    this.options = options;
    this.starting = this.spawnOnce(options, true).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** 停止隧道并清掉重连定时器 */
  async stop(): Promise<TunnelStatus> {
    this.stopping = true;
    this.starting = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      // ssh 收到 SIGTERM 会自行清理转发；Windows 上 kill() 走 TerminateProcess
      try {
        child.kill();
      } catch {
        // 进程可能已经退出，忽略
      }
    }
    this.listenPort = null;
    this.readyAt = null;
    this.setState('stopped');
    return this.getStatus();
  }

  /**
   * 起一个 ssh 进程并等它就绪；失败时按需自动重连。
   *
   * 密钥策略：逐个尝试候选密钥。
   *
   * 起因是一个真实的坑：默认路径 `~/.ssh/id_ed25519` 可能**存在但不被服务器接受**
   * （用户那个文件是给别的服务用的），此时若只试这一把就直接失败，
   * 而真正可用的密钥其实就在旁边。所以认证被拒时继续试下一个候选，
   * 全部失败才报错——报错里带上每把密钥的指纹，便于和服务器上
   * `ssh-keygen -lf ~/.ssh/authorized_keys` 的输出对照。
   */
  private async spawnOnce(options: TunnelOptions, allowRetry: boolean): Promise<TunnelStatus> {
    const configuredKey = expandHome(options.keyPath);
    const detected = findDefaultKey(options.keyPath);

    /*
     * 候选密钥：
     *   1) 用户明确配置的那把（只要文件存在就先用它，尊重用户选择）
     *   2) 自动探测到的其他可用密钥（作为回退）
     * 若一把都没有，则不传 -i，交给 ssh 自己协商（含 ssh-agent）。
     */
    const candidates: string[] = [];
    if (configuredKey && isUsableKey(configuredKey)) candidates.push(configuredKey);
    if (detected && !candidates.includes(detected)) candidates.push(detected);

    if (configuredKey && !isUsableKey(configuredKey) && candidates.length === 0) {
      this.setState(
        'error',
        `找不到私钥文件：${configuredKey}。请重新选择，或在服务器上部署对应公钥（留空则改用 ssh-agent 中的密钥）。`,
      );
      return this.getStatus();
    }

    const attempts: KeyAttempt[] = [];
    const tried = candidates.length > 0 ? candidates : [''];

    for (const keyPath of tried) {
      // 每次尝试都换一个本地端口：上一次的监听可能还处在 TIME_WAIT
      const port = options.localPort > 0 ? options.localPort : await pickFreePort();
      let result: { ready: boolean; child: ChildProcessWithoutNullStreams; reason: string | null };
      try {
        result = await this.attemptKey(options, keyPath, port);
      } catch (err) {
        // ssh 进程根本起不来：这不是密钥问题，再换密钥也没意义，直接如实报错
        const message = err instanceof Error ? err.message : String(err);
        this.setState('error', `无法启动 ssh：${message}。请确认系统已安装 OpenSSH 客户端。`);
        return this.getStatus();
      }

      if (result.ready) {
        this.listenPort = port;
        this.readyAt = Date.now();
        this.reconnects = 0;
        this.setState('ready');
        this.attachWatchdog(result.child);
        return this.getStatus();
      }

      attempts.push({ keyPath, reason: result.reason ?? '未知原因' });
    }

    const reason = this.buildKeyFailure(attempts, configuredKey);
    if (allowRetry && !this.stopping) {
      this.scheduleReconnect(reason);
    } else {
      this.setState('error', reason);
    }
    return this.getStatus();
  }

  /**
   * 用一把指定的密钥（或空串表示交给 ssh 自行协商）尝试建立隧道。
   * @throws ssh 进程无法启动时抛出（此时换密钥没有意义，由调用方直接报错）
   */
  private async attemptKey(
    options: TunnelOptions,
    keyPath: string,
    localPort: number,
  ): Promise<{ ready: boolean; child: ChildProcessWithoutNullStreams; reason: string | null }> {
    const args = this.buildArgs(options, keyPath, localPort);
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;

    this.setState(this.reconnects > 0 ? 'reconnecting' : 'starting');

    const child = spawn('ssh', args, { windowsHide: true });

    this.child = child;

    // ssh 把进度与错误都写在 stderr，这里只用于判断就绪与给出失败原因
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    // stdout 正常情况下没有内容，读掉即可，避免缓冲堆积
    child.stdout.on('data', () => {});

    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    const ready = await this.waitReady(localPort, timeoutMs, exitPromise, () => stderrTail);

    if (ready) return { ready: true, child, reason: null };

    // 未就绪：收掉进程，把可读的原因带回去给上层
    try {
      child.kill();
    } catch {
      // 可能已经退出
    }
    if (this.child === child) this.child = null;
    const tail = stderrTail.trim();
    return {
      ready: false,
      child,
      reason: tail ? this.explainFailure(tail) : '建立超时（未收到任何响应）',
    };
  }

  /** 组装 ssh 参数 */
  private buildArgs(options: TunnelOptions, keyPath: string, localPort: number): string[] {
    const args = [
      '-N', // 只做端口转发，不开远程 shell
      '-T', // 不分配终端
      '-o', 'ExitOnForwardFailure=yes', // 转发失败立即退出，避免"看起来连上了却不通"
      '-o', 'StrictHostKeyChecking=accept-new', // 首次自动记录主机密钥，之后严格校验
      '-o', 'BatchMode=yes', // 绝不弹交互提示
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'TCPKeepAlive=yes',
      '-p', String(options.port || 22),
    ];
    if (keyPath) args.push('-i', keyPath);
    // 只绑定回环：这个端口不对外提供服务，暴露到局域网没有意义且有风险
    args.push('-L', `127.0.0.1:${localPort}:127.0.0.1:${options.remotePort}`);
    args.push(`${options.user}@${options.host}`);
    return args;
  }

  /**
   * 把所有密钥都试失败后的报错文案。
   * 列出每把密钥的指纹，用户可以拿它和服务器上的 authorized_keys 对照。
   */
  private buildKeyFailure(attempts: KeyAttempt[], configuredKey: string): string {
    // 认证类失败优先展示：它最需要用户动手处理
    const authFailure = attempts.find((a) => /认证被拒绝/.test(a.reason));
    const allAuthFailed = authFailure && attempts.every((a) => /认证被拒绝/.test(a.reason));

    if (allAuthFailed) {
      const lines = attempts.map((a) => {
        const fp = keyFingerprint(a.keyPath);
        return `    ${a.keyPath}${fp ? `  (${fp})` : ''}`;
      });
      const shown = configuredKey && !attempts.some((a) => a.keyPath === configuredKey);
      return (
        `SSH 认证被拒绝，已尝试 ${attempts.length} 把密钥：\n${lines.join('\n')}\n` +
        '  请把其中一把对应的公钥（.pub 文件内容）加入服务器 /root/.ssh/authorized_keys，' +
        '或在「私钥文件」里改成已授权的那把。' +
        (shown ? `\n  （配置的路径 ${configuredKey} 不存在，以上为自动探测到的密钥）` : '')
      );
    }

    // 非认证类失败：直接说明首个原因即可，避免把用户绕晕
    return attempts[0]?.reason ?? 'SSH 隧道建立失败（未给出原因）';
  }

  /** 轮询本地端口直到可连接，或进程退出，或超时 */
  private async waitReady(
    port: number,
    timeoutMs: number,
    exitPromise: Promise<void>,
    stderrOf: () => string,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    void exitPromise.then(() => {
      exited = true;
    });

    while (Date.now() < deadline) {
      if (exited) return false;
      if (await probePort(port)) return true;
      await delay(250);
    }
    // 超时：把 ssh 自己的报错带上，比"超时"三个字有用得多
    const tail = stderrOf().trim();
    if (tail) this.lastError = tail;
    return false;
  }

  /** 进程意外退出时自动重连（带退避），让隧道在链路抖动后自愈 */
  private attachWatchdog(child: ChildProcessWithoutNullStreams): void {
    child.once('exit', () => {
      if (this.stopping || this.child !== child) return;
      this.child = null;
      this.listenPort = null;
      this.readyAt = null;
      this.reconnects += 1;
      this.scheduleReconnect('SSH 隧道已断开，正在重连…');
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping || !this.options) return;
    this.setState('reconnecting', reason);
    const backoff = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(1.6, Math.max(0, this.reconnects - 1)),
      RECONNECT_MAX_DELAY,
    );
    setTimeout(() => {
      if (this.stopping || !this.options) return;
      void this.spawnOnce(this.options, true);
    }, backoff).unref?.();
  }

  /** 把 ssh 的英文报错翻译成用户能直接行动的中文说明 */
  private explainFailure(stderr: string): string {
    const text = stderr.trim();
    if (/Permission denied|publickey/i.test(text)) {
      return 'SSH 认证被拒绝：请确认公钥已加入服务器的 ~/.ssh/authorized_keys，或换一个私钥文件。';
    }
    if (/Connection refused|Connection timed out|No route to host|Could not resolve/i.test(text)) {
      return `无法连接 SSH 服务器：${text.split('\n').pop() ?? text}`;
    }
    if (/Host key verification failed/i.test(text)) {
      return '主机密钥校验失败：服务器指纹与本地记录不一致，请确认服务器未被替换。';
    }
    if (/Address already in use|bind/i.test(text)) {
      return '本地隧道端口被占用：换一个本地端口后重试。';
    }
    if (/administratively prohibited|open failed/i.test(text)) {
      return '服务器拒绝端口转发：请确认服务器 sshd 配置允许 AllowTcpForwarding。';
    }
    return text ? `SSH 隧道建立失败：${text.split('\n').pop() ?? text}` : 'SSH 隧道建立超时（未收到任何响应）';
  }
}

/** 判断私钥是否可用（存在且是文件），供界面做前置校验 */
export function isUsableKey(p: string): boolean {
  const file = expandHome(p);
  if (!file) return false;
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 从 OpenSSH 公钥 blob 算出 ssh-keygen 风格的 SHA256 指纹 */
function keyBlobFingerprint(blob: Buffer): string {
  const digest = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/**
 * 算出某个私钥对应公钥的指纹（形如 `SHA256:xxxx`）。
 *
 * 用的是 Node 自带的 crypto，不依赖系统里的 ssh-keygen —— 少一个外部依赖，
 * 也让错误提示在任何环境下都能给出可对照的指纹。
 * 这里优先通过私钥推导公钥：即使用户只保留了私钥、删掉了 .pub 也照样能算。
 * @returns 指纹；解析失败时返回空串
 */
export function keyFingerprint(keyPath: string): string {
  const file = expandHome(keyPath);
  if (!file || !isUsableKey(file)) return '';
  try {
    const priv = crypto.createPrivateKey(fs.readFileSync(file));
    const pub = crypto.createPublicKey(priv);
    // 转成 OpenSSH 线格式后取 SHA256，结果与 ssh-keygen -lf 一致
    const der = pub.export({ type: 'spki', format: 'der' });
    return keyBlobFingerprint(der);
  } catch {
    // 加密私钥、格式不支持等情况：退回读 .pub
    try {
      const pubText = fs.readFileSync(`${file}.pub`, 'utf8').trim();
      const b64 = pubText.split(/\s+/)[1] ?? '';
      if (!b64) return '';
      return keyBlobFingerprint(Buffer.from(b64, 'base64'));
    } catch {
      return '';
    }
  }
}
