/**
 * 工具栏弹窗逻辑。
 *
 * 数据来源：全部通过消息向后台 Service Worker 索取，弹窗自己不直接读写配置，
 * 保证「后台是唯一状态源」，避免两边状态不一致。
 */

import {
  DEFAULT_STATE,
  STORAGE_KEYS,
  formatEndpoint,
  formatTime,
  normalizeConfig,
  sendToBackground,
} from './shared.js';

/** 界面元素引用。 */
const el = {
  badge: document.getElementById('badge'),
  toggle: document.getElementById('toggle'),
  toggleTitle: document.getElementById('toggleTitle'),
  toggleHint: document.getElementById('toggleHint'),
  appLight: document.getElementById('appLight'),
  appText: document.getElementById('appText'),
  endpoint: document.getElementById('endpoint'),
  proxyState: document.getElementById('proxyState'),
  checkedAt: document.getElementById('checkedAt'),
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

/**
 * 根据当前 config / state 刷新整个界面。
 * @returns {void}
 */
function render() {
  const enabled = config.enabled === true;
  const online = state.appOnline === true;
  const everChecked = Number(state.lastCheckedAt) > 0;
  const endpoint = formatEndpoint(config.port);

  // 主开关
  el.toggle.setAttribute('aria-checked', String(enabled));
  el.toggleTitle.textContent = enabled ? '代理已开启' : '代理已关闭';

  // 顶部徽章
  if (!enabled) {
    el.badge.textContent = '已关闭';
    el.badge.className = 'badge badge--off';
  } else if (state.proxyApplied) {
    el.badge.textContent = '已开启';
    el.badge.className = 'badge badge--on';
  } else {
    el.badge.textContent = '已降级';
    el.badge.className = 'badge badge--warn';
  }

  // 开关副标题
  if (!enabled) {
    el.toggleHint.textContent = '点击开启本地代理';
  } else if (online) {
    el.toggleHint.textContent = `已指向 ${endpoint}`;
  } else {
    el.toggleHint.textContent = '桌面应用未运行，已临时切回直连';
  }

  // 桌面应用在线状态
  el.appLight.className = `light ${online ? 'light--on' : everChecked ? 'light--off' : 'light--unknown'}`;
  if (online) {
    el.appText.textContent = state.appVersion ? `运行中 · v${state.appVersion}` : '运行中';
  } else {
    el.appText.textContent = everChecked ? '未运行' : '检测中…';
  }

  // 其余信息行
  el.endpoint.textContent = enabled ? endpoint : `${endpoint}（未启用）`;
  el.proxyState.textContent = state.proxyApplied ? `已启用 → ${endpoint}` : enabled ? '已降级为直连' : '未启用';
  el.checkedAt.textContent = formatTime(state.lastCheckedAt);

  // 提示条：错误优先，其次是降级提醒
  if (state.lastError) {
    showNotice(state.lastError, 'error');
  } else if (enabled && !online) {
    showNotice('桌面应用未运行，已自动切回直连以免断网。请先启动桌面应用，再点击「重新检测」。');
  } else if (!online && state.probeError) {
    showNotice(`检测失败：${state.probeError}`);
  } else {
    showNotice('');
  }

  // 忙碌时禁用交互
  el.toggle.disabled = busy;
  el.refresh.disabled = busy;
}

/**
 * 向后台请求最新状态并重新探测桌面应用。
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
  const next = config.enabled !== true;
  busy = true;
  // 乐观更新，让开关跟手，随后以后台返回的真实状态为准。
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

/**
 * 绑定界面事件。
 * @returns {void}
 */
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

  // 后台写入配置或状态后，弹窗自动跟随刷新。
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

/**
 * 初始化：先用缓存状态秒开，再触发一次真实探测。
 * @returns {Promise<void>} 无返回值
 */
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
    return;
  }

  await refresh();
}

void init();
