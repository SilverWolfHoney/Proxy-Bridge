/**
 * 共享常量与工具函数。
 *
 * 被 background.js / popup.js / options.js 以 ES Module 方式导入，
 * 保证「默认配置」「存储键名」「配置规范化」三处只有一份实现。
 *
 * 设计前提：本扩展是**独立**的代理客户端。
 *   它自己连接用户填写的远程代理服务器，不依赖、不探测、也不需要任何桌面应用。
 *   因此这里不存在任何「本机端口」「健康检查」之类的概念。
 */

/** 代理协议。与 chrome.proxy 的 ProxyServer.scheme 取值一一对应。 */
export const PROXY_SCHEMES = Object.freeze(['http', 'https', 'socks5']);

/** 各协议默认端口，仅用于输入框占位提示。 */
export const DEFAULT_PORTS = Object.freeze({
  http: 8080,
  https: 8443,
  socks5: 1080,
});

/** 默认配置：默认关闭、不预置任何服务器信息。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关：关闭时清除浏览器代理，恢复直连 */
  enabled: false,
  /** 代理协议 */
  scheme: 'http',
  /** 代理服务器地址（域名或 IP），空字符串表示尚未配置 */
  host: '',
  /** 代理服务器端口，0 表示尚未配置 */
  port: 0,
  /** 服务器是否需要用户名密码认证 */
  authEnabled: false,
  username: '',
  /** 密码。是否明文写盘由 rememberPassword 决定 */
  password: '',
  /**
   * 是否把密码保存到本地存储。
   * 关闭时密码只留在内存中，Service Worker 休眠后需要重新填写 —— 这是隐私与便利的取舍。
   */
  rememberPassword: true,
  /** 走直连、不经过代理的地址列表 */
  bypassList: Object.freeze(['localhost', '127.0.0.1']),
});

/** chrome.storage 中使用的键名。 */
export const STORAGE_KEYS = Object.freeze({
  /** 持久配置，存放于 chrome.storage.local */
  config: 'config',
  /** 运行时状态，存放于 chrome.storage.session（不可用时回退 local） */
  state: 'runtimeState',
});

/** 运行时状态的默认值。 */
export const DEFAULT_STATE = Object.freeze({
  /** 代理是否已真正写入浏览器 */
  proxyApplied: false,
  /** 最近一次操作的错误信息 */
  lastError: '',
  /** 最近一次应用配置的时间 */
  appliedAt: 0,
  /** 最近一次变更原因，便于排查 */
  lastReason: '',

  /* ---- 连通性探测：证明代理是真的能用，而不只是「已写入配置」 ---- */

  /** 连通状态：unknown（还没测）/ connecting（正在测）/ connected / failed */
  connection: 'unknown',
  /** 探测成功时拿到的出口 IP */
  exitIp: '',
  /** 本轮的连续失败次数（成功或重新开启时归零） */
  probeFailures: 0,
  /** 最近一次探测的时间 */
  lastProbeAt: 0,
  /** 探测失败的原因 */
  probeError: '',
});

/**
 * 连通性探测参数。
 *
 * 开启后**不立刻探测**：刚开启时浏览器往往还在建立连接，立刻测没有意义，只会白耗流量。
 * 第一次检测安排在第 60 秒，之后每 30 秒一次，共 5 次
 * —— 即第 60、90、120、150、180 秒各测一次。用完就停止自动重试，
 * 状态定为「连不上服务器」，等用户手动点「重新检测」。
 */
export const PROBE = Object.freeze({
  /** 单次探测超时（毫秒） */
  timeoutMs: 4000,
  /** 开启后到第一次检测的等待（秒） */
  initialDelaySec: 60,
  /** 第一次之后的重试间隔（秒）：每 30 秒一次，共 4 次，合计 5 次检测 */
  retryIntervalSec: 30,
  /** 连通之后的常态心跳间隔（毫秒） */
  heartbeatMs: 60_000,
  /** 用于探测的纯文本端点，按顺序尝试 */
  endpoints: Object.freeze(['https://api.ipify.org', 'https://icanhazip.com']),
});

/** 端口合法范围。 */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/** 配置完全没填时，界面上提示用户去填写。 */
export function isConfigured(config) {
  return Boolean(config && config.host && config.host.trim() && config.port > 0);
}

/** 运行时状态存放区域：优先 session（会话级、不落盘），不可用时回退 local。 */
const stateArea = chrome.storage.session || chrome.storage.local;

/**
 * 把任意输入规范化为合法端口号。
 * @param {unknown} value 待校验的值
 * @param {number} [fallback] 非法时返回的端口
 * @returns {number} 合法端口号
 */
export function normalizePort(value, fallback = 0) {
  const port = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    return fallback;
  }
  return port;
}

/**
 * 判断端口是否合法。
 * @param {unknown} value 待校验的值
 * @returns {boolean} 是否合法
 */
export function isValidPort(value) {
  const port = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
}

/**
 * 判断协议是否受支持。
 * @param {unknown} value 待校验的值
 * @returns {boolean} 是否受支持
 */
export function isValidScheme(value) {
  return PROXY_SCHEMES.includes(String(value));
}

/**
 * 规范化绕过列表：去空行、去首尾空格、去重、保序。
 * @param {unknown} value 字符串数组或换行分隔的字符串
 * @returns {string[]} 规范化后的绕过列表
 */
export function normalizeBypassList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);

  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const entry = String(item ?? '').trim();
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * 把任意输入补齐成一份完整可用的配置对象。
 * @param {unknown} raw 原始配置
 * @returns {object} 规范化配置
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  // 字段缺失/为 null 时回退默认值；显式传入的空数组表示「用户就是要清空」，需保留。
  const rawBypass = source.bypassList;
  const bypassList =
    rawBypass === undefined || rawBypass === null
      ? [...DEFAULT_CONFIG.bypassList]
      : normalizeBypassList(rawBypass);

  const scheme = isValidScheme(source.scheme) ? String(source.scheme) : DEFAULT_CONFIG.scheme;
  const rememberPassword = source.rememberPassword !== false;

  /**
   * 密码是否已经保存过。
   *
   * 已保存的密码**不回填到界面**：界面上密码框永远从空白开始，
   * 想改就重新输入，不改就留空沿用已保存的那个。
   * 这样即使有人看到屏幕，也看不到密码。
   *
   * 兼容早期版本（那时没有这个字段）：存储里确实有密码就认为已保存，
   * 否则升级后用户会被要求重新输入一次。
   */
  const hasPassword =
    source.hasPassword === true ||
    (source.hasPassword === undefined && typeof source.password === 'string' && source.password.length > 0);

  // 不记住、或已被清空时，读取一律返回空串
  const password =
    rememberPassword && hasPassword && typeof source.password === 'string' ? source.password : '';

  return {
    enabled: source.enabled === true,
    scheme,
    host: String(source.host ?? '').trim(),
    port: normalizePort(source.port, DEFAULT_CONFIG.port),
    authEnabled: source.authEnabled === true,
    username: String(source.username ?? ''),
    password,
    hasPassword,
    rememberPassword,
    bypassList,
  };
}

/**
 * 把配置整理成 chrome.proxy 需要的 ProxyConfig。
 * @param {object} config 规范化配置
 * @returns {object} chrome.proxy.settings.set 的 value
 */
export function buildProxyValue(config) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme: config.scheme,
        host: config.host,
        port: config.port,
      },
      bypassList: config.bypassList,
    },
  };
}

/**
 * 把配置整理成给人看的一行描述。
 * @param {object} config 规范化配置
 * @returns {string} 形如 socks5://example.com:1080
 */
export function formatProxy(config) {
  if (!isConfigured(config)) return '未配置';
  return `${config.scheme}://${config.host}:${config.port}`;
}

/**
 * 读取配置（已补齐默认值）。
 * @returns {Promise<object>} 配置
 */
export async function readConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.config);
  return normalizeConfig(stored?.[STORAGE_KEYS.config]);
}

/**
 * 写入配置（局部更新，自动规范化）。
 *
 * 密码字段的语义：undefined = 保持已保存的密码不变，空串 = 清空，其他 = 覆盖。
 * 因此 hasPassword 会随之更新，界面据此显示「已保存（留空表示不修改）」。
 *
 * @param {object} patch 需要更新的字段
 * @returns {Promise<object>} 写入后的完整配置
 */
export async function writeConfig(patch) {
  const previous = await readConfig();
  const raw = { ...previous, ...(patch || {}) };

  // 补丁里没提 password 就沿用已保存的；提了就按新值判断是否还存有密码
  const password = typeof patch?.password === 'string' ? patch.password : previous.password;
  const hasPassword = password.length > 0;

  const merged = normalizeConfig({ ...raw, password, hasPassword });
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: merged });
  return merged;
}

/**
 * 确保 chrome.storage.local 中存在一份完整配置。
 * @returns {Promise<object>} 配置
 */
export async function ensureConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.config);
  if (stored?.[STORAGE_KEYS.config]) {
    return normalizeConfig(stored[STORAGE_KEYS.config]);
  }
  const config = normalizeConfig(null);
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: config });
  return config;
}

/**
 * 读取运行时状态（已补齐默认值）。
 * @returns {Promise<object>} 运行时状态
 */
export async function readState() {
  const stored = await stateArea.get(STORAGE_KEYS.state);
  return { ...DEFAULT_STATE, ...(stored?.[STORAGE_KEYS.state] || {}) };
}

/**
 * 局部更新运行时状态。
 * @param {object} patch 需要更新的字段
 * @returns {Promise<object>} 写入后的完整状态
 */
export async function writeState(patch) {
  const next = { ...(await readState()), ...(patch || {}) };
  await stateArea.set({ [STORAGE_KEYS.state]: next });
  return next;
}

/**
 * 向后台 Service Worker 发送消息并等待应答。
 * @param {object} message 消息体
 * @returns {Promise<object>} 后台返回的数据
 */
export async function sendToBackground(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (error) {
    throw new Error(`无法与后台服务通信：${String(error?.message || error)}`);
  }
  if (!response || response.ok !== true) {
    throw new Error(String(response?.error || '后台服务未返回有效结果'));
  }
  return response;
}

/**
 * 把时间戳格式化成 HH:MM:SS。
 * @param {number} timestamp 毫秒时间戳
 * @returns {string} 时间字符串，无效时返回「—」
 */
export function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
