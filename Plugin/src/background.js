/**
 * 后台 Service Worker。
 *
 * 职责只有一件事：把浏览器的 HTTP/HTTPS 代理指向本机 127.0.0.1:<本地端口>，
 * 由桌面应用负责连接真正的远程代理服务器（凭据由桌面应用持有，插件一无所知）。
 *
 * 关键行为：
 *   1. enabled=true 且桌面应用在线  -> chrome.proxy.settings.set 固定代理到 127.0.0.1:port
 *   2. enabled=false                -> chrome.proxy.settings.clear 恢复直连
 *   3. enabled=true 但探测不到应用  -> 自动降级为直连（避免浏览器彻底断网），状态标记 appOffline
 *   4. 定时探测健康状态并写入 chrome.storage.session，供 popup 读取
 *
 * MV3 注意事项：Service Worker 会被随时休眠，模块顶层不保存任何持久状态，
 * 所有状态都从 chrome.storage 读取；本文件中的变量仅用于「本次唤醒期间」的流程编排。
 */

import {
  HEALTH_ALARM_NAME,
  HEALTH_ALARM_PERIOD_MINUTES,
  HEALTH_INTERVAL_MS,
  LOCAL_PROXY_HOST,
  STORAGE_KEYS,
  discoverDesktopApp,
  ensureConfig,
  readConfig,
  readState,
  writeConfig,
  writeState,
} from './shared.js';

/** 徽章文案。 */
const BADGE_TEXT = Object.freeze({
  on: 'ON',
  degraded: '!',
  off: '',
});

/** 徽章底色（深色系，和弹窗风格保持一致）。 */
const BADGE_COLOR = Object.freeze({
  on: '#22c55e',
  degraded: '#f59e0b',
  off: '#64748b',
});

/** 本次唤醒期间的串行队列，避免并发探测/写状态互相覆盖（非持久状态）。 */
let syncChain = Promise.resolve();

/** 本次唤醒期间的高频探测定时器（非持久状态，SW 休眠后由 alarms 兜底）。 */
let healthTimer = null;

/**
 * 把异常翻译成中文提示。
 * @param {unknown} error 捕获到的异常
 * @returns {string} 中文错误描述
 */
function describeProxyError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/another extension|controlled by/i.test(message)) {
    return '代理设置已被其他扩展接管，请先在其它扩展中关闭代理控制';
  }
  if (/permission|not allowed/i.test(message)) {
    return '缺少 proxy 权限，请在扩展管理页重新加载本插件';
  }
  return `设置代理失败：${message}`;
}

/**
 * 根据配置与在线状态计算「本次是否应该真正走代理」。
 * @param {{enabled: boolean}} config 配置
 * @param {{appOnline: boolean}} state 运行时状态
 * @returns {boolean} 是否应该启用本地代理
 */
function shouldProxy(config, state) {
  return config.enabled === true && state.appOnline === true;
}

/**
 * 真正调用 chrome.proxy API 应用或清除代理设置。
 * @param {{enabled: boolean, port: number, bypassList: string[]}} config 配置
 * @param {boolean} useProxy 是否使用本地代理
 * @returns {Promise<{proxyApplied: boolean, lastError: string}>} 应用结果
 */
async function applyProxySettings(config, useProxy) {
  try {
    if (useProxy) {
      const value = {
        mode: 'fixed_servers',
        rules: {
          singleProxy: {
            scheme: 'http',
            host: LOCAL_PROXY_HOST,
            port: config.port,
          },
          bypassList: config.bypassList,
        },
      };
      await chrome.proxy.settings.set({ value, scope: 'regular' });
      return { proxyApplied: true, lastError: '' };
    }

    // 等价于 clear({})，scope 默认为 regular。
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return { proxyApplied: false, lastError: '' };
  } catch (error) {
    console.error('[本地代理网关] 应用代理设置失败：', error);
    return { proxyApplied: false, lastError: describeProxyError(error) };
  }
}

/**
 * 更新工具栏徽章：开启显示 ON，降级显示 !，关闭为空。
 * @param {{enabled: boolean}} config 配置
 * @param {{appOnline: boolean, proxyApplied: boolean, degraded: boolean}} state 运行时状态
 * @returns {Promise<void>} 无返回值
 */
async function updateBadge(config, state) {
  let text = BADGE_TEXT.off;
  let color = BADGE_COLOR.off;
  let title = '本地代理网关：已关闭（点击开启）';

  if (config.enabled === true) {
    if (state.proxyApplied && !state.degraded) {
      text = BADGE_TEXT.on;
      color = BADGE_COLOR.on;
      title = `本地代理网关：已开启（${LOCAL_PROXY_HOST}:${config.port}）`;
    } else {
      text = BADGE_TEXT.degraded;
      color = BADGE_COLOR.degraded;
      title = '本地代理网关：已开启但已降级为直连（桌面应用未运行）';
    }
  }

  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title });
  } catch (error) {
    console.error('[本地代理网关] 更新徽章失败：', error);
  }
}

/**
 * 核心同步流程：读配置 -> 探测（可选）-> 应用代理 -> 写状态 -> 更新徽章。
 * @param {{probe?: boolean, reason?: string}} [options] 选项
 * @returns {Promise<{config: object, state: object}>} 同步后的配置与状态
 */
async function syncProxy({ probe = true, reason = 'sync' } = {}) {
  let config = await readConfig();
  const previous = await readState();

  let { appOnline, appVersion, appPort, lastCheckedAt, probeError } = previous;

  let portChanged = false;

  if (probe) {
    // 自动发现：先试配置的端口，再试候选端口，这样应用里改了端口插件能自己跟上
    const health = await discoverDesktopApp(config.port);
    appOnline = health.online;
    appVersion = health.version;
    appPort = health.port;
    lastCheckedAt = health.checkedAt;
    probeError = health.error;

    if (health.online && health.port && health.port !== config.port) {
      // 端口变了：写回配置。storage.onChanged 会再触发一次同步，但那时端口已经一致，
      // 不会形成循环（最多多跑一轮探测）。
      config = await writeConfig({ port: health.port, portAutoFilled: true });
      portChanged = true;
    }
  }

  const useProxy = shouldProxy(config, { appOnline });
  const applied = await applyProxySettings(config, useProxy);

  // enabled=true 却探测不到桌面应用时，已经清除代理设置并标记为降级状态。
  const degraded = config.enabled === true && !appOnline;

  const state = await writeState({
    appOnline,
    appVersion,
    appPort,
    lastCheckedAt,
    probeError,
    proxyApplied: applied.proxyApplied,
    degraded,
    lastError: applied.lastError,
    lastReason: portChanged ? `${reason}:port-changed` : reason,
  });

  if (portChanged) {
    console.info(`[本地代理网关] 已自动跟随桌面应用端口：${config.port}`);
  }

  await updateBadge(config, state);
  return { config, state, portChanged };
}

/**
 * 把同步流程排入串行队列，避免并发写状态。
 * @param {{probe?: boolean, reason?: string}} [options] 选项
 * @returns {Promise<{config: object, state: object}>} 同步结果
 */
function queueSync(options) {
  const run = () => syncProxy(options);
  syncChain = syncChain.then(run, run);
  return syncChain;
}

/**
 * 启动探测定时器。
 * - setInterval 在 Service Worker 存活期间提供 3 秒级探测（同时通过 API 调用延长 SW 寿命）；
 * - chrome.alarms 在 SW 被回收后唤醒它做兜底探测（周期 30 秒）。
 * @returns {void}
 */
function startHealthTimers() {
  if (healthTimer === null) {
    healthTimer = setInterval(() => {
      void queueSync({ probe: true, reason: 'interval' });
    }, HEALTH_INTERVAL_MS);
  }

  chrome.alarms.create(HEALTH_ALARM_NAME, {
    periodInMinutes: HEALTH_ALARM_PERIOD_MINUTES,
  });
}

/**
 * 扩展安装/更新/浏览器启动时的初始化流程。
 * @param {string} reason 触发原因，仅用于调试与状态记录
 * @returns {Promise<void>} 无返回值
 */
async function bootstrap(reason) {
  await ensureConfig();
  await queueSync({ probe: true, reason });
  startHealthTimers();
}

/**
 * 处理来自 popup / options 的消息。
 * @param {{type?: string, enabled?: boolean}} message 消息体
 * @returns {Promise<object>} 应答数据
 */
async function handleMessage(message) {
  const type = String(message?.type || '');

  switch (type) {
    case 'getStatus': {
      // 只返回缓存状态，保证弹窗秒开；弹窗随后会再发 refresh 获取最新结果。
      const config = await readConfig();
      const state = await readState();
      return { ok: true, config, state };
    }

    case 'refresh': {
      const { config, state } = await queueSync({ probe: true, reason: 'message:refresh' });
      return { ok: true, config, state };
    }

    case 'setEnabled': {
      // 写入配置后 storage.onChanged 也会触发一次应用，这里主动同步一次以便立刻返回结果。
      await writeConfig({ enabled: message.enabled === true });
      const synced = await queueSync({ probe: true, reason: 'message:setEnabled' });
      return { ok: true, config: synced.config, state: synced.state };
    }

    case 'saveConfig': {
      // 端口与绕过列表由设置页校验后提交，这里再规范化一次并立即重新应用。
      // portAutoFilled 置回 false：这是用户手动指定的端口，优先于自动发现。
      await writeConfig({
        port: message.port,
        bypassList: message.bypassList,
        portAutoFilled: false,
      });
      const synced = await queueSync({ probe: true, reason: 'message:saveConfig' });
      return { ok: true, config: synced.config, state: synced.state };
    }

    default:
      return { ok: false, error: `未知的消息类型：${type || '(空)'}` };
  }
}

// ---------------------------------------------------------------------------
// 事件监听
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap('onStartup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === HEALTH_ALARM_NAME) {
    void queueSync({ probe: true, reason: 'alarm' });
  }
});

// 配置变化时立即重新应用（只关心 local 中的 config，避免与状态写入互相触发）。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEYS.config]) {
    return;
  }
  void queueSync({ probe: false, reason: 'storage:config' });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error('[本地代理网关] 处理消息失败：', error);
      sendResponse({ ok: false, error: String(error?.message || error || '未知错误') });
    });
  // 返回 true 以保持消息通道，等待异步应答。
  return true;
});

// Service Worker 每次被唤醒（含冷启动）都立即校准一次代理状态并启动定时器。
void bootstrap('serviceWorkerStart');
