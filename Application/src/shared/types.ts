/**
 * 主进程 / 渲染进程 / 预加载脚本之间共享的类型定义。
 *
 * 重要安全约定：
 *  - 本文件不包含任何真实服务器地址、端口、账号或密码，所有字段均为用户运行时填写。
 *  - 明文密码只允许出现在主进程内存中，传递给渲染层的对象一律经过 `redactConfig` 脱敏。
 */

/**
 * 远程代理服务器使用的协议。
 * `auto` 是「用户的选择」，表示不确定，由程序逐个尝试后自行判断。
 */
export type UpstreamProtocol = 'http' | 'https' | 'socks5';
export type UpstreamProtocolSetting = UpstreamProtocol | 'auto';

/** 远程代理服务器配置（由用户填写，凭据本地加密存储） */
export interface UpstreamConfig {
  /** 用户的选择；`auto` 表示由程序逐个尝试判断 */
  protocol: UpstreamProtocolSetting;
  /** 服务器域名或 IP，空字符串表示尚未配置 */
  host: string;
  port: number;
  /** 是否启用用户名密码认证 */
  authEnabled: boolean;
  username: string;
  /** 明文密码；仅在主进程内存与首次写入时存在，落盘前会加密。渲染层永远拿不到 */
  password: string;
  /** 连接超时（毫秒） */
  timeoutMs: number;
  /** 自动判断出的协议：判断过一次后记住它，下次不必重复尝试 */
  detectedProtocol?: UpstreamProtocol;
}

/**
 * 本机转发端口配置。
 *
 * Windows 的系统代理只能指向本机地址，所以全局代理必须经由这个端口转发。
 * 它是实现细节，界面上收在「高级设置」里。
 */
export interface BridgeConfig {
  /** 监听地址，出于安全考虑默认只监听回环 */
  host: string;
  /** 监听端口，系统代理会指向它 */
  port: number;
}

/** 域名分流规则 */
export interface RulesConfig {
  /** 强制直连（不走代理）的域名后缀 / 关键词 */
  direct: string[];
  /** 强制走代理的域名后缀 / 关键词；非空时表现为白名单模式 */
  proxy: string[];
}

/**
 * 全局代理配置。
 *
 * 开启后应用会把本机网关的地址写进 Windows 系统代理设置，
 * 于是整台电脑上所有读取系统代理的程序都会经由这里转发。
 */
export interface GlobalProxyConfig {
  /** 用户是否希望启用全局代理；应用启动时据此自动恢复 */
  enabled: boolean;
  /** 是否同时接管 HTTPS（系统代理只认一个地址，此项保留用于将来区分协议） */
  alsoHttps: boolean;
}

/** 应用完整配置 */
export interface AppConfig {
  upstream: UpstreamConfig;
  bridge: BridgeConfig;
  rules: RulesConfig;
  globalProxy: GlobalProxyConfig;
}

/** 脱敏后的配置：渲染层只能看到这个 */
export interface SafeConfig extends AppConfig {
  upstream: UpstreamConfig & { hasPassword: boolean; password: '' };
}

export type BridgeState = 'stopped' | 'starting' | 'running' | 'error';

export type ConnKind = 'connect' | 'http' | 'socks5';

export type ConnOutcome = 'pending' | 'ok' | 'denied' | 'failed';

/** 单条连接记录 */
export interface ConnRecord {
  id: number;
  /** 时间戳（毫秒） */
  at: number;
  host: string;
  port: number;
  kind: ConnKind;
  outcome: ConnOutcome;
  /** 判定为直连还是走代理 */
  route: 'direct' | 'proxy';
  /** 失败原因或备注 */
  note?: string;
  /** 建立连接耗时（毫秒），未完成时为 null */
  latencyMs: number | null;
  /** 上行字节数 */
  bytesUp: number;
  /** 下行字节数 */
  bytesDown: number;
}

/** 累计流量统计 */
export interface TrafficStats {
  totalConnections: number;
  activeConnections: number;
  failedConnections: number;
  bytesUp: number;
  bytesDown: number;
  /** 网关启动时刻的时间戳 */
  startedAt: number | null;
}

/** 网关运行状态快照 */
export interface BridgeStatus {
  state: BridgeState;
  /** 实际监听地址，形如 127.0.0.1:7890；未运行时为 null */
  listen: string | null;
  error: string | null;
  stats: TrafficStats;
  /** 系统代理是否已由本应用接管 */
  systemProxyApplied: boolean;
}

/** 全局代理的对外状态：一个开关背后的全部事实 */
export interface GlobalProxyState {
  /** 是否已开启（网关在跑 + 系统代理已接管） */
  enabled: boolean;
  /** 当前正在进行的步骤，用于界面上显示进度 */
  phase: 'off' | 'starting' | 'applying' | 'on' | 'stopping' | 'error';
  /** 本机网关监听地址，未运行为 null */
  listen: string | null;
  /** 出错时的中文说明 */
  error: string | null;
}

/** 开启/关闭全局代理的结果 */
export interface GlobalProxyResult {
  ok: boolean;
  state: GlobalProxyState;
  error: string | null;
}

/** 单个协议的尝试记录，用于「自动」模式下告诉用户试过什么 */
export interface ProtocolAttempt {
  protocol: UpstreamProtocol;
  ok: boolean;
  /** 该协议的耗时；失败时为 null */
  latencyMs: number | null;
  /** 失败原因；成功时为 null */
  error: string | null;
}

/** 上游代理连通性测试结果 */
export interface TestResult {
  ok: boolean;
  /** 用户选择的设置（可能是 auto） */
  protocol: UpstreamProtocolSetting;
  /** 实际测通的协议；失败时为 null */
  testedProtocol: UpstreamProtocol | null;
  /** 握手 + 建连耗时（毫秒） */
  latencyMs: number | null;
  /** 出口 IP（如果能取到） */
  exitIp: string | null;
  /** 失败原因，成功时为 null */
  error: string | null;
  /** 人类可读的详细说明 */
  detail: string;
  /** 自动模式下逐个协议尝试的结果 */
  attempts?: ProtocolAttempt[];
}

/** 预加载脚本暴露给渲染层的 API */
export interface ProxyBridgeApi {
  getConfig(): Promise<SafeConfig>;
  saveConfig(patch: DeepPartial<AppConfig>): Promise<SafeConfig>;
  getStatus(): Promise<BridgeStatus>;
  testUpstream(input?: {
    protocol?: UpstreamProtocolSetting;
    host?: string;
    port?: number;
    authEnabled?: boolean;
    username?: string;
    password?: string;
  }): Promise<TestResult>;

  /* 全局代理：界面上的那一个开关 */
  getGlobalProxyState(): Promise<GlobalProxyState>;
  setGlobalProxy(enabled: boolean): Promise<GlobalProxyResult>;
  onGlobalProxyState(listener: (state: GlobalProxyState) => void): () => void;

  /** 用系统文件管理器打开某个目录 */
  openPath(target: string): Promise<void>;
  getAppInfo(): Promise<{ version: string; electron: string; node: string; userData: string }>;
}

/* ------------------------------------------------------------------ */
/* 工具类型                                                             */
/* ------------------------------------------------------------------ */

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer _U> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** 默认配置：刻意保持空白，不预置任何服务器信息 */
export const DEFAULT_CONFIG: AppConfig = {
  upstream: {
    protocol: 'auto',
    host: '',
    port: 0,
    authEnabled: true,
    username: '',
    password: '',
    timeoutMs: 10_000,
  },
  bridge: {
    host: '127.0.0.1',
    port: 7890,
  },
  rules: {
    direct: ['localhost', '127.0.0.1', '::1', '*.local', '10.*', '192.168.*'],
    proxy: [],
  },
  globalProxy: {
    enabled: false,
    alsoHttps: true,
  },
};

/** 判断上游配置是否已经可以用（host 与 port 必填） */
export function isUpstreamConfigured(upstream: UpstreamConfig): boolean {
  return upstream.host.trim().length > 0 && Number.isInteger(upstream.port) && upstream.port > 0 && upstream.port <= 65535;
}
