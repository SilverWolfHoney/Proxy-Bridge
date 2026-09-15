/**
 * 后台 Service Worker：扩展的代理控制中枢。
 *
 * 本扩展是**独立**的代理客户端：
 *   它把浏览器的 HTTP/HTTPS 代理设置指向用户自己填写的远程代理服务器，
 *   不依赖、不探测、也不需要任何本机应用。
 *
 * 关键行为：
 *   1. enabled=true  且配置完整 -> chrome.proxy.settings.set 固定代理到该服务器
 *   2. enabled=false 或配置不全 -> chrome.proxy.settings.clear 恢复直连
 *   3. HTTP/HTTPS 代理需要认证时，用 webRequest.onAuthRequired 自动提供凭据，
 *      用户不会看到浏览器弹出的账号密码框
 *
 * MV3 注意事项：Service Worker 会被随时休眠，模块顶层不保存任何持久状态，
 * 所有状态都从 chrome.storage 读取；本文件中的变量仅用于「本次唤醒期间」的流程编排。
 */

import {
  STORAGE_KEYS,
  buildProxyValue,
  ensureConfig,
  formatTime,
  isConfigured,
  readConfig,
  readState,
  writeConfig,
  writeState,
} from './shared.js';

/** 徽章文案与配色。 */
const BADGE = Object.freeze({
  on: { text: 'ON', color: '#22c55e', title: '代理已开启' },
  off: { text: '', color: '#64748b', title: '代理已关闭（点击开启）' },
  error: { text: '!', color: '#ef4444', title: '代理设置失败，点击查看' },
});

/** 本次唤醒期间的串行队列，避免并发写状态互相覆盖（非持久状态）。 */
let syncChain = Promise.resolve();

/** 最近一次应用配置时使用的凭据，供认证回调读取（非持久状态）。 */
let activeCredentials = { username: '', password: '' };

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
    return '缺少 proxy 权限，请在扩展管理页重新加载本扩展';
  }
  if (/Invalid|scheme/i.test(message)) {
    return `代理配置不合法：${message}`;
  }
  return `设置代理失败：${message}`;
}

/**
 * 更新工具栏徽章。
 * @param {'on'|'off'|'error'} kind 徽章状态
 * @param {object} [config] 当前配置，用于生成提示文字
 * @returns {Promise<void>} 无返回值
 */
async function updateBadge(kind, config) {
  const spec = BADGE[kind] || BADGE.off;
  let title = spec.title;
  if (kind === 'on' && config && isConfigured(config)) {
    title = `代理已开启：${config.scheme}://${config.host}:${config.port}`;
  }
  try {
    await chrome.action.setBadgeText({ text: spec.text });
    await chrome.action.setBadgeBackgroundColor({ color: spec.color });
    await chrome.action.setTitle({ title });
  } catch (error) {
    console.error('[代理快速切换] 更新徽章失败：', error);
  }
}

/**
 * 真正调用 chrome.proxy API 应用或清除代理设置。
 * @param {object} config 规范化配置
 * @returns {Promise<{proxyApplied: boolean, lastError: string}>} 结果
 */
async function applyProxySettings(config) {
  // 开关关闭，或配置不完整（没填服务器）时，一律恢复直连，避免把浏览器指到一个空地址
  const shouldApply = config.enabled === true && isConfigured(config);

  try {
    if (shouldApply) {
      await chrome.proxy.settings.set({ value: buildProxyValue(config), scope: 'regular' });
      // 凭据只放在内存里供认证回调使用；不写日志、不外传
      activeCredentials = {
        username: config.authEnabled ? config.username : '',
        password: config.authEnabled ? config.password : '',
      };
      return { proxyApplied: true, lastError: '' };
    }

    await chrome.proxy.settings.clear({ scope: 'regular' });
    activeCredentials = { username: '', password: '' };
    return { proxyApplied: false, lastError: '' };
  } catch (error) {
    console.error('[代理快速切换] 应用代理设置失败：', error);
    activeCredentials = { username: '', password: '' };
    return { proxyApplied: false, lastError: describeProxyError(error) };
  }
}

/**
 * 核心同步流程：读配置 -> 应用代理 -> 写状态 -> 更新徽章。
 * @param {{reason?: string}} [options] 选项
 * @returns {Promise<{config: object, state: object}>} 同步结果
 */
async function syncProxy({ reason = 'sync' } = {}) {
  const config = await readConfig();
  const applied = await applyProxySettings(config);

  const state = await writeState({
    proxyApplied: applied.proxyApplied,
    lastError: applied.lastError,
    appliedAt: Date.now(),
    lastReason: reason,
  });

  await updateBadge(applied.lastError ? 'error' : applied.proxyApplied ? 'on' : 'off', config);
  return { config, state };
}

/**
 * 把同步流程排入串行队列，避免并发写状态。
 * @param {{reason?: string}} [options] 选项
 * @returns {Promise<{config: object, state: object}>} 同步结果
 */
function queueSync(options) {
  const run = () => syncProxy(options);
  syncChain = syncChain.then(run, run);
  return syncChain;
}

/**
 * 处理来自 popup / options 的消息。
 * @param {{type?: string, enabled?: boolean, config?: object}} message 消息体
 * @returns {Promise<object>} 应答数据
 */
async function handleMessage(message) {
  const type = String(message?.type || '');

  switch (type) {
    case 'getStatus': {
      const config = await readConfig();
      const state = await readState();
      return { ok: true, config, state };
    }

    case 'setEnabled': {
      await writeConfig({ enabled: message.enabled === true });
      const synced = await queueSync({ reason: 'message:setEnabled' });
      return { ok: true, config: synced.config, state: synced.state };
    }

    case 'refresh': {
      // 重新把配置应用到浏览器，用于「重新应用」按钮
      const synced = await queueSync({ reason: 'message:refresh' });
      return { ok: true, config: synced.config, state: synced.state };
    }

    case 'saveConfig': {
      // 服务器信息与绕过列表由设置页校验后提交，这里再规范化一次并立即重新应用
      await writeConfig({
        scheme: message.scheme,
        host: message.host,
        port: message.port,
        authEnabled: message.authEnabled,
        username: message.username,
        password: message.password,
        rememberPassword: message.rememberPassword,
        bypassList: message.bypassList,
      });
      const synced = await queueSync({ reason: 'message:saveConfig' });
      return { ok: true, config: synced.config, state: synced.state };
    }

    default:
      return { ok: false, error: `未知的消息类型：${type || '(空)'}` };
  }
}

// ---------------------------------------------------------------------------
// 代理认证：HTTP/HTTPS 代理需要账号密码时，由这里自动应答 407
// ---------------------------------------------------------------------------

/**
 * 处理代理认证请求。
 *
 * 只对「代理服务器发起的认证」提供凭据；网站自身的 401 登录框不受影响。
 * 未配置凭据时返回空对象，浏览器会按自己的策略处理（通常是弹出原生登录框）。
 *
 * @param {object} details 请求详情
 * @returns {Promise<object>|undefined} 认证凭据；无凭据时不接管
 */
function handleAuthRequired(details) {
  // isProxy 为 true 表示这是代理服务器要求的认证，而不是目标网站的登录
  if (!details || details.isProxy !== true) {
    return undefined;
  }

  const { username, password } = activeCredentials;
  if (!username && !password) {
    // 没配凭据就不接管，交给浏览器处理
    return undefined;
  }

  return { authCredentials: { username, password } };
}

try {
  chrome.webRequest.onAuthRequired.addListener(
    handleAuthRequired,
    { urls: ['<all_urls>'] },
    ['asyncBlocking'],
  );
} catch (error) {
  // 某些 Chromium 版本不接受 asyncBlocking，退回同步形式（返回 undefined 视为不接管）
  console.warn('[代理快速切换] asyncBlocking 不可用，改用同步认证应答：', error);
  chrome.webRequest.onAuthRequired.addListener(handleAuthRequired, { urls: ['<all_urls>'] });
}

// ---------------------------------------------------------------------------
// 事件监听
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureConfig();
    await queueSync({ reason: 'onInstalled' });
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureConfig();
    await queueSync({ reason: 'onStartup' });
  })();
});

// 配置变化时立即重新应用（只关心 local 中的 config，避免与状态写入互相触发）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEYS.config]) {
    return;
  }
  void queueSync({ reason: 'storage:config' });
});

/**
 * 兜底：Service Worker 被回收后重新唤醒时，确保浏览器代理设置与配置一致。
 * 用 alarms 做低频校准，避免配置被外部改动后长期不一致。
 */
chrome.alarms.create('proxy-reapply', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === 'proxy-reapply') {
    void queueSync({ reason: 'alarm' });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error('[代理快速切换] 处理消息失败：', error);
      sendResponse({ ok: false, error: String(error?.message || error || '未知错误') });
    });
  // 返回 true 以保持消息通道，等待异步应答
  return true;
});

// Service Worker 每次被唤醒（含冷启动）都立即校准一次代理状态
void (async () => {
  await ensureConfig();
  await queueSync({ reason: 'serviceWorkerStart' });
})();

// 供调试：把最近一次应用时间打印出来（不含任何凭据）
void readState().then((state) => {
  if (state.appliedAt) {
    console.info(`[代理快速切换] 上次应用时间 ${formatTime(state.appliedAt)}（原因：${state.lastReason || '未知'}）`);
  }
});
