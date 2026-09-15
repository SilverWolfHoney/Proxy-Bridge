/**
 * 共享常量与工具函数。
 *
 * 被 background.js / popup.js / options.js 以 ES Module 方式导入，
 * 保证「默认配置」「存储键名」「健康探测逻辑」三处只有一份实现。
 *
 * 安全约定（硬性要求）：
 *   本文件以及整个插件内不得出现任何真实的远程代理服务器地址、端口、账号或密码。
 *   插件只认识两个东西：本机回环地址 127.0.0.1，以及用户自定义的本地端口。
 *   真实远程代理服务器与账号密码全部由桌面应用持有和管理。
 */

/** 本地代理网关的固定监听地址（桌面应用监听在本机回环地址上）。 */
export const LOCAL_PROXY_HOST = '127.0.0.1';

/** 桌面应用提供的健康检查端点路径。 */
export const HEALTH_PATH = '/__proxybridge__/health';

/** 健康检查期望的应用标识，用于避免误判本机其它 HTTP 服务。 */
export const HEALTH_APP_ID = 'proxy-bridge';

/** 默认配置：默认不开启代理，默认本地端口 7890，默认绕过本机地址。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  port: 7890,
  bypassList: Object.freeze(['localhost', '127.0.0.1']),
});

/** chrome.storage 中使用的键名。 */
export const STORAGE_KEYS = Object.freeze({
  /** 持久配置，存放于 chrome.storage.local。 */
  config: 'config',
  /** 运行时状态，存放于 chrome.storage.session（不可用时回退 local）。 */
  state: 'runtimeState',
});

/** 运行时状态的默认值。 */
export const DEFAULT_STATE = Object.freeze({
  appOnline: false,
  appVersion: '',
  lastCheckedAt: 0,
  probeError: '',
  proxyApplied: false,
  degraded: false,
  lastError: '',
  lastReason: '',
  updatedAt: 0,
});

/** 端口合法范围。 */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/** 健康探测超时时间（毫秒）。 */
export const HEALTH_TIMEOUT_MS = 1500;

/** 存活期间的探测间隔（毫秒）。Service Worker 休眠后由 chrome.alarms 兜底。 */
export const HEALTH_INTERVAL_MS = 3000;

/** chrome.alarms 兜底探测的周期（分钟，0.5 = 30 秒，为 Chrome 允许的最小值）。 */
export const HEALTH_ALARM_PERIOD_MINUTES = 0.5;

/** chrome.alarms 名称。 */
export const HEALTH_ALARM_NAME = 'proxy-bridge-health-check';

/** 运行时状态存放区域：优先 session（会话级、不落盘），不可用时回退 local。 */
const stateArea = chrome.storage.session || chrome.storage.local;

/**
 * 把任意输入规范化为合法端口号。
 * @param {unknown} value 待校验的值
 * @param {number} [fallback] 非法时返回的端口
 * @returns {number} 合法端口号
 */
export function normalizePort(value, fallback = DEFAULT_CONFIG.port) {
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
 * 规范化绕过列表：去空行、去首尾空格、去重、保序。
 * @param {unknown} value 字符串数组或换行分隔的字符串
 * @returns {string[]} 规范化后的绕过列表
 */
export function normalizeBypassList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '').split(/\r?\n/);

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
 * @returns {{enabled: boolean, port: number, bypassList: string[]}} 规范化配置
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // 字段缺失/为 null 时回退默认值；显式传入的空数组表示「用户就是要清空绕过列表」，需保留。
  const rawBypass = source.bypassList;
  const bypassList =
    rawBypass === undefined || rawBypass === null
      ? [...DEFAULT_CONFIG.bypassList]
      : normalizeBypassList(rawBypass);

  return {
    enabled: source.enabled === true,
    port: normalizePort(source.port, DEFAULT_CONFIG.port),
    bypassList,
  };
}

/**
 * 构造健康检查地址。
 * @param {number} port 本地端口
 * @returns {string} 形如 http://127.0.0.1:7890/__proxybridge__/health
 */
export function buildHealthUrl(port) {
  return `http://${LOCAL_PROXY_HOST}:${normalizePort(port)}${HEALTH_PATH}`;
}

/**
 * 格式化用于展示的本地端点。
 * @param {number} port 本地端口
 * @returns {string} 形如 127.0.0.1:7890
 */
export function formatEndpoint(port) {
  return `${LOCAL_PROXY_HOST}:${normalizePort(port)}`;
}

/**
 * 把探测过程中的异常翻译成中文提示。
 * @param {unknown} error 捕获到的异常
 * @returns {string} 中文错误描述
 */
export function describeProbeError(error) {
  const name = String(error?.name || '');
  if (name === 'AbortError') {
    return `连接本机端口超时（超过 ${HEALTH_TIMEOUT_MS / 1000} 秒无响应）`;
  }
  if (name === 'TypeError') {
    return '无法连接本机端口，桌面应用可能未运行';
  }
  return String(error?.message || error || '未知错误');
}

/**
 * 探测桌面应用是否在运行。
 *
 * 使用 AbortController 设置 1.5 秒超时，避免 Service Worker 被卡住。
 * 任何异常都被吞掉并转成 {@link ProbeResult}，调用方无需再 try/catch。
 *
 * @param {number} port 本地端口
 * @returns {Promise<{online: boolean, version: string, error: string, checkedAt: number}>} 探测结果
 */
export async function probeDesktopApp(port) {
  const checkedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(buildHealthUrl(port), {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return {
        online: false,
        version: '',
        error: `健康检查返回 HTTP ${response.status}`,
        checkedAt,
      };
    }

    const payload = await response.json().catch(() => null);
    if (!payload || payload.app !== HEALTH_APP_ID || payload.ok !== true) {
      return {
        online: false,
        version: '',
        error: '端口已被占用，但响应不是本插件配套的桌面应用',
        checkedAt,
      };
    }

    return {
      online: true,
      version: String(payload.version ?? ''),
      error: '',
      checkedAt,
    };
  } catch (error) {
    return {
      online: false,
      version: '',
      error: describeProbeError(error),
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取配置（已补齐默认值）。
 * @returns {Promise<{enabled: boolean, port: number, bypassList: string[]}>} 配置
 */
export async function readConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.config);
  return normalizeConfig(stored?.[STORAGE_KEYS.config]);
}

/**
 * 写入配置（局部更新，自动规范化）。
 * @param {object} patch 需要更新的字段
 * @returns {Promise<{enabled: boolean, port: number, bypassList: string[]}>} 写入后的完整配置
 */
export async function writeConfig(patch) {
  const merged = normalizeConfig({ ...(await readConfig()), ...(patch || {}) });
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: merged });
  return merged;
}

/**
 * 确保 chrome.storage.local 中存在一份完整配置，返回该配置。
 * 仅在首次安装（配置缺失）时写入默认值，避免每次 Service Worker 唤醒都产生写入。
 * @returns {Promise<{enabled: boolean, port: number, bypassList: string[]}>} 配置
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
  const next = { ...(await readState()), ...(patch || {}), updatedAt: Date.now() };
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
