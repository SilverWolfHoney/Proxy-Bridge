/**
 * 设置页逻辑。
 *
 * 只做两件事：编辑「本地端口 + 绕过列表」，以及展示桌面应用的在线状态。
 * 这里没有、也不会有任何远程代理服务器地址或凭据——那些由桌面应用自己管理。
 */

import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  STORAGE_KEYS,
  formatTime,
  isValidPort,
  normalizeBypassList,
  normalizeConfig,
  sendToBackground,
} from './shared.js';

/** 界面元素引用。 */
const el = {
  port: document.getElementById('port'),
  bypassList: document.getElementById('bypassList'),
  save: document.getElementById('save'),
  reset: document.getElementById('reset'),
  recheck: document.getElementById('recheck'),
  message: document.getElementById('message'),
  savedAt: document.getElementById('savedAt'),
  appLight: document.getElementById('appLight'),
  appText: document.getElementById('appText'),
  proxyText: document.getElementById('proxyText'),
};

/** 当前配置与运行时状态。 */
let config = normalizeConfig(null);
let state = { ...DEFAULT_STATE };
/** 是否正在提交。 */
let busy = false;
/** 短暂的保存反馈，优先于常驻提示显示。 */
let feedback = null;
/** 反馈自动清除的定时器。 */
let feedbackTimer = null;

/**
 * 显示一条临时反馈（保存成功/失败等）。
 * @param {string} text 反馈内容
 * @param {'ok'|'warn'|'error'} [kind] 反馈类型
 * @param {number} [duration] 自动清除毫秒数，0 表示不自动清除
 * @returns {void}
 */
function showFeedback(text, kind = 'ok', duration = 4000) {
  feedback = { text, kind };
  if (feedbackTimer !== null) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  if (duration > 0) {
    feedbackTimer = setTimeout(() => {
      feedback = null;
      feedbackTimer = null;
      render();
    }, duration);
  }
  render();
}

/**
 * 把配置回填到表单。
 * @returns {void}
 */
function fillForm() {
  el.port.value = String(config.port);
  el.bypassList.value = config.bypassList.join('\n');
  el.port.classList.remove('input--invalid');
}

/**
 * 刷新状态栏与提示信息。
 * @returns {void}
 */
function render() {
  const online = state.appOnline === true;
  const everChecked = Number(state.lastCheckedAt) > 0;
  const enabled = config.enabled === true;

  // 状态栏
  el.appLight.className = `light ${online ? 'light--on' : everChecked ? 'light--off' : 'light--unknown'}`;
  el.appText.textContent = online
    ? `桌面应用：运行中${state.appVersion ? ` · v${state.appVersion}` : ''}`
    : everChecked
      ? '桌面应用：未运行'
      : '桌面应用：检测中…';

  if (state.proxyApplied) {
    el.proxyText.textContent = `代理：已启用（${config.port}）`;
  } else if (enabled) {
    el.proxyText.textContent = '代理：已降级为直连';
  } else {
    el.proxyText.textContent = '代理：已关闭';
  }

  el.savedAt.textContent = state.lastCheckedAt ? `最近检测 ${formatTime(state.lastCheckedAt)}` : '';

  // 提示信息：临时反馈优先，其次是常驻的离线/错误提示
  let text = '';
  let kind = 'warn';

  if (feedback) {
    text = feedback.text;
    kind = feedback.kind === 'ok' ? 'ok' : feedback.kind;
  } else if (state.lastError) {
    text = state.lastError;
    kind = 'error';
  } else if (!online && everChecked) {
    text = `未检测到桌面应用（${state.probeError || '连接失败'}）。开启代理后会自动降级为直连，浏览器不会断网。`;
    kind = 'warn';
  }

  if (!text) {
    el.message.hidden = true;
    el.message.textContent = '';
  } else {
    el.message.hidden = false;
    el.message.textContent = text;
    el.message.className =
      kind === 'ok' ? 'message' : kind === 'error' ? 'message message--error' : 'message message--warn';
  }

  el.save.disabled = busy;
  el.reset.disabled = busy;
  el.recheck.disabled = busy;
}

/**
 * 保存表单内容并让后台立即重新应用代理。
 * @returns {Promise<void>} 无返回值
 */
async function save() {
  const portText = el.port.value.trim();

  if (!isValidPort(portText)) {
    el.port.classList.add('input--invalid');
    showFeedback('端口必须是 1–65535 之间的整数。', 'error', 0);
    el.port.focus();
    return;
  }

  el.port.classList.remove('input--invalid');
  const port = Number.parseInt(portText, 10);
  const bypassList = normalizeBypassList(el.bypassList.value);

  busy = true;
  render();

  try {
    const response = await sendToBackground({ type: 'saveConfig', port, bypassList });
    config = normalizeConfig(response.config);
    state = { ...DEFAULT_STATE, ...(response.state || {}) };
    fillForm();
    busy = false;

    if (state.lastError) {
      showFeedback(`已保存，但应用代理时出错：${state.lastError}`, 'error', 0);
    } else if (config.enabled && !state.appOnline) {
      showFeedback('已保存。当前未检测到桌面应用，代理处于直连降级状态。', 'warn');
    } else {
      showFeedback(`已保存并生效：127.0.0.1:${config.port}`, 'ok');
    }
  } catch (error) {
    busy = false;
    showFeedback(`保存失败：${String(error?.message || error)}`, 'error', 0);
  }

  render();
}

/**
 * 把表单恢复为默认值（需再点保存才会生效）。
 * @returns {void}
 */
function resetToDefault() {
  el.port.value = String(DEFAULT_CONFIG.port);
  el.bypassList.value = DEFAULT_CONFIG.bypassList.join('\n');
  el.port.classList.remove('input--invalid');
  showFeedback('已填入默认值，点击「保存并立即生效」后生效。', 'warn');
}

/**
 * 从后台拉取配置与状态。
 * @param {{probe?: boolean}} [options] probe=true 时要求后台立即重新探测桌面应用
 * @returns {Promise<void>} 无返回值
 */
async function pullStatus({ probe = false } = {}) {
  const response = await sendToBackground({ type: probe ? 'refresh' : 'getStatus' });
  config = normalizeConfig(response.config);
  state = { ...DEFAULT_STATE, ...(response.state || {}) };
}

/**
 * 请求后台立即重新探测桌面应用。
 * @returns {Promise<void>} 无返回值
 */
async function recheck() {
  busy = true;
  render();
  try {
    await pullStatus({ probe: true });
    showFeedback(
      state.appOnline ? '已检测到桌面应用，连接正常。' : '仍未检测到桌面应用。',
      state.appOnline ? 'ok' : 'warn',
    );
  } catch (error) {
    showFeedback(`检测失败：${String(error?.message || error)}`, 'error', 0);
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
  el.save.addEventListener('click', () => {
    void save();
  });

  el.reset.addEventListener('click', resetToDefault);

  el.recheck.addEventListener('click', () => {
    void recheck();
  });

  // 回车即保存（端口输入框）
  el.port.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  });

  el.port.addEventListener('input', () => {
    el.port.classList.remove('input--invalid');
  });

  // 后台状态变化时同步刷新
  chrome.storage.onChanged.addListener((changes, areaName) => {
    let dirty = false;

    if (areaName === 'local' && changes[STORAGE_KEYS.config]) {
      config = normalizeConfig(changes[STORAGE_KEYS.config].newValue);
      if (document.activeElement !== el.port && document.activeElement !== el.bypassList) {
        fillForm();
      }
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
 * 初始化页面。
 * @returns {Promise<void>} 无返回值
 */
async function init() {
  bindEvents();
  render();

  try {
    // 先用缓存状态秒开
    await pullStatus();
    fillForm();
    render();
  } catch (error) {
    showFeedback(`无法连接后台服务：${String(error?.message || error)}`, 'error', 0);
    return;
  }

  // 首次打开时静默探测一次，避免一进页面就弹出「已检测到」的提示
  busy = true;
  render();
  try {
    await pullStatus({ probe: true });
  } catch (error) {
    showFeedback(`检测失败：${String(error?.message || error)}`, 'error', 0);
  } finally {
    busy = false;
    fillForm();
    render();
  }
}

void init();
