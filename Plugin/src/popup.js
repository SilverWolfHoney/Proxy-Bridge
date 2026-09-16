/**
 * 工具栏弹窗逻辑。
 *
 * 数据来源：全部通过消息向后台 Service Worker 索取，弹窗自己不直接读写配置，
 * 保证「后台是唯一状态源」，避免两边状态不一致。
 *
 * 显示重点是**连接状态**而不是「配置已生效」：
 * 用户想知道的是「我现在能不能上网」，所以后台会真的探测一次并回报结果。
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
  connCard: document.getElementById('connCard'),
  connText: document.getElementById('connText'),
  connHint: document.getElementById('connHint'),
  toggle: document.getElementById('toggle'),
  toggleTitle: document.getElementById('toggleTitle'),
  toggleHint: document.getElementById('toggleHint'),
  server: document.getElementById('server'),
  authText: document.getElementById('authText'),
  exitIp: document.getElementById('exitIp'),
  probeAt: document.getElementById('probeAt'),
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
 * 计算要展示的连接状态。
 * @returns {{kind: string, title: string, hint: string}} 状态描述
 */
function resolveConnectionView() {
  const enabled = config.enabled === true;
  const configured = isConfigured(config);

  if (!enabled) {
    return {
      kind: 'idle',
      title: '未开启',
      hint: configured ? '打开开关即可让浏览器走代理' : '先在设置里填写代理服务器',
    };
  }

  if (!configured) {
    return { kind: 'failed', title: '配置不完整', hint: '请填写服务器地址与端口' };
  }

  if (state.connection === 'connecting') {
    return { kind: 'connecting', title: '正在连接…', hint: `经 ${config.host}:${config.port} 验证中` };
  }

  if (state.connection === 'connected') {
    return {
      kind: 'ok',
      title: '已连接',
      hint: state.exitIp ? `出口 IP ${state.exitIp}` : '代理工作正常',
    };
  }

  if (state.connection === 'failed') {
    const attempts = state.probeFailures ?? 0;
    return {
      kind: 'failed',
      title: '连不上服务器',
      hint: attempts > 1 ? `已重试 ${attempts - 1} 次，仍在自动重试` : '正在重试…',
    };
  }

  // unknown：刚开启、后台还没测出结果
  return { kind: 'connecting', title: '正在连接…', hint: `将要经 ${config.host}:${config.port} 出网` };
}

/** 刷新整个界面。 */
function render() {
  const enabled = config.enabled === true;
  const configured = isConfigured(config);

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

  // 连接状态卡
  const view = resolveConnectionView();
  el.connCard.className = `conn conn--${view.kind}`;
  el.connText.textContent = view.title;
  el.connHint.textContent = view.hint;

  // 顶部徽章
  if (state.lastError) {
    el.badge.textContent = '出错';
    el.badge.className = 'badge badge--warn';
  } else if (enabled && state.connection === 'connected') {
    el.badge.textContent = '已连接';
    el.badge.className = 'badge badge--on';
  } else if (enabled) {
    el.badge.textContent = '连接中';
    el.badge.className = 'badge badge--warn';
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
  el.exitIp.textContent = state.exitIp || '—';
  el.probeAt.textContent = formatTime(state.lastProbeAt);

  // 提示条
  if (state.lastError) {
    showNotice(state.lastError, 'error');
  } else if (!configured) {
    showNotice('还没有填写代理服务器，点击下方「打开设置」开始配置。');
  } else if (enabled && state.connection === 'failed') {
    showNotice(state.probeError || '连不上代理服务器，请检查地址、端口与账号密码。', 'error');
  } else if (enabled && config.scheme === 'socks5' && config.authEnabled) {
    showNotice('SOCKS5 的账号密码需要浏览器弹窗输入；想免弹窗可在设置里改用 HTTP 代理。');
  } else {
    showNotice('');
  }

  el.refresh.disabled = busy;
}

/**
 * 向后台请求最新状态。
 * @param {{probe?: boolean}} [options] 是否让后台立刻重新探测一次
 * @returns {Promise<void>} 无返回值
 */
async function refresh({ probe = true } = {}) {
  busy = true;
  render();
  try {
    const response = await sendToBackground(probe ? { type: 'refresh' } : { type: 'getStatus' });
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
  // 乐观更新，让开关跟手
  config = { ...config, enabled: next };
  if (next) state = { ...state, connection: 'connecting', probeError: '', exitIp: '' };
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
    void refresh({ probe: true });
  });

  el.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // 后台写状态后弹窗自动跟随：探测结果就是这么实时反映出来的
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

/** 初始化：先用缓存状态秒开，再让后台探测一次。 */
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

  await refresh({ probe: true });
}

void init();
