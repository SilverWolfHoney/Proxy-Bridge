/**
 * 工具栏弹窗逻辑。
 *
 * 数据来源：全部通过消息向后台 Service Worker 索取，弹窗自己不直接读写配置，
 * 保证「后台是唯一状态源」，避免两边状态不一致。
 */

import {
  DEFAULT_STATE,
  STORAGE_KEYS,
  formatProxy,
  formatTime,
  isConfigured,
  normalizeConfig,
  sendToBackground,
} from './shared.js';

/** 界面元素引用。 */
const el = {
  badge: document.getElementById('badge'),
  toggle: document.getElementById('toggle'),
  toggleTitle: document.getElementById('toggleTitle'),
  toggleHint: document.getElementById('toggleHint'),
  server: document.getElementById('server'),
  authText: document.getElementById('authText'),
  proxyState: document.getElementById('proxyState'),
  appliedAt: document.getElementById('appliedAt'),
  notice: document.getElementById('notice'),
  refresh: document.getElementById('refresh'),
  openOptions: document.getElementById('openOptions'),
};

/** 当前配置与运行时状态。 */
let config = normalizeConfig(null);
let state = { ...DEFAULT_STATE };
/** 是否有请求正在进行中。 */
let busy = false;

/**
 * 显示提示条。
 * @param {string} text 提示内容
 * @param {'warn'|'error'} [kind] 提示类型
 * @returns {void}
 */
function showNotice(text, kind = 'warn') {
  if (!text) {
    el.notice.hidden = true;
    el.notice.textContent = '';
    return;
  }
  el.notice.hidden = false;
  el.notice.textContent = text;
  el.notice.className = kind === 'error' ? 'notice notice--error' : 'notice';
}

/** 刷新整个界面。 */
function render() {
  const enabled = config.enabled === true;
  const configured = isConfigured(config);
  const applied = state.proxyApplied === true;

  // 主开关
  el.toggle.setAttribute('aria-checked', String(enabled));
  el.toggle.disabled = busy;

  if (!configured) {
    el.toggleTitle.textContent = '尚未配置代理服务器';
    el.toggleHint.textContent = '请先打开设置填写服务器地址';
  } else if (enabled) {
    el.toggleTitle.textContent = '代理已开启';
    el.toggleHint.textContent = `流量经由 ${config.host}:${config.port}`;
  } else {
    el.toggleTitle.textContent = '代理已关闭';
    el.toggleHint.textContent = '点击开启代理';
  }

  // 顶部徽章
  if (state.lastError) {
    el.badge.textContent = '出错';
    el.badge.className = 'badge badge--warn';
  } else if (enabled && applied) {
    el.badge.textContent = '已开启';
    el.badge.className = 'badge badge--on';
  } else {
    el.badge.textContent = '已关闭';
    el.badge.className = 'badge badge--off';
  }

  // 信息行
  el.server.textContent = formatProxy(config);
  el.authText.textContent = config.authEnabled
    ? config.username
      ? `已启用（${config.username}）`
      : '已启用（未填用户名）'
    : '未启用';
  el.proxyState.textContent = applied
    ? `已启用 → ${config.host}:${config.port}`
    : enabled && configured
      ? '设置未生效'
      : '未启用';
  el.appliedAt.textContent = formatTime(state.appliedAt);

  // 提示条：错误优先，其次是未配置
  if (state.lastError) {
    showNotice(state.lastError, 'error');
  } else if (!configured) {
    showNotice('还没有填写代理服务器，点击下方「打开设置」开始配置。');
  } else if (enabled && config.authEnabled && config.scheme === 'socks5') {
    showNotice('SOCKS5 的账号密码浏览器会在需要时弹出输入框，且可能记住它。建议改用 HTTP 代理以获得自动认证。');
  } else {
    showNotice('');
  }

  el.refresh.disabled = busy;
}

/**
 * 向后台请求最新状态并重新应用配置。
 * @returns {Promise<void>} 无返回值
 */
async function refresh() {
  busy = true;
  render();
  try {
    const response = await sendToBackground({ type: 'refresh' });
    config = normalizeConfig(response.config);
    state = { ...DEFAULT_STATE, ...(response.state || {}) };
  } catch (error) {
    showNotice(String(error?.message || error), 'error');
  } finally {
    busy = false;
    render();
  }
}

/**
 * 切换代理开关。
 * @returns {Promise<void>} 无返回值
 */
async function toggleEnabled() {
  if (!isConfigured(config)) {
    // 没配置就别开，直接把用户引到设置页
    await chrome.runtime.openOptionsPage();
    window.close();
    return;
  }

  const next = config.enabled !== true;
  busy = true;
  config = { ...config, enabled: next };
  render();

  try {
    const response = await sendToBackground({ type: 'setEnabled', enabled: next });
    config = normalizeConfig(response.config);
    state = { ...DEFAULT_STATE, ...(response.state || {}) };
  } catch (error) {
    config = { ...config, enabled: !next };
    showNotice(String(error?.message || error), 'error');
  } finally {
    busy = false;
    render();
  }
}

/** 绑定界面事件。 */
function bindEvents() {
  el.toggle.addEventListener('click', () => {
    void toggleEnabled();
  });

  el.refresh.addEventListener('click', () => {
    void refresh();
  });

  el.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // 后台写入配置或状态后，弹窗自动跟随刷新
  chrome.storage.onChanged.addListener((changes, areaName) => {
    let dirty = false;

    if (areaName === 'local' && changes[STORAGE_KEYS.config]) {
      config = normalizeConfig(changes[STORAGE_KEYS.config].newValue);
      dirty = true;
    }

    if (changes[STORAGE_KEYS.state]) {
      state = { ...DEFAULT_STATE, ...(changes[STORAGE_KEYS.state].newValue || {}) };
      dirty = true;
    }

    if (dirty && !busy) {
      render();
    }
  });
}

/** 初始化：先用缓存状态秒开，再触发一次真实同步。 */
async function init() {
  bindEvents();
  render();

  try {
    const response = await sendToBackground({ type: 'getStatus' });
    config = normalizeConfig(response.config);
    state = { ...DEFAULT_STATE, ...(response.state || {}) };
    render();
  } catch (error) {
    showNotice(`无法连接后台服务：${String(error?.message || error)}`, 'error');
  }
}

void init();
