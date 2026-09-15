/**
 * 设置页逻辑。
 *
 * 只做三件事：编辑代理服务器信息、编辑绕过列表、把改动提交给后台立即生效。
 * 后台是唯一状态源，本页不直接调用 chrome.proxy。
 */

import {
  DEFAULT_CONFIG,
  DEFAULT_PORTS,
  PROXY_SCHEMES,
  isValidPort,
  normalizeConfig,
  sendToBackground,
} from './shared.js';

/** 界面元素引用。 */
const el = {
  scheme: document.getElementById('scheme'),
  host: document.getElementById('host'),
  port: document.getElementById('port'),
  authEnabled: document.getElementById('authEnabled'),
  authFields: document.getElementById('authFields'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  togglePassword: document.getElementById('togglePassword'),
  bypassList: document.getElementById('bypassList'),
  rememberPassword: document.getElementById('rememberPassword'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  feedback: document.getElementById('feedback'),
  save: document.getElementById('save'),
  applyNow: document.getElementById('applyNow'),
  resetDefaults: document.getElementById('resetDefaults'),
};

/** 当前配置。 */
let config = normalizeConfig(null);
/** 是否正在提交。 */
let busy = false;
/** 用户是否动过密码框（没动过就沿用已保存的密码）。 */
let passwordTouched = false;

/**
 * 显示反馈信息。
 * @param {string} text 内容
 * @param {'ok'|'error'} [kind] 类型
 * @returns {void}
 */
function showFeedback(text, kind = 'ok') {
  if (!text) {
    el.feedback.hidden = true;
    el.feedback.textContent = '';
    return;
  }
  el.feedback.hidden = false;
  el.feedback.textContent = text;
  el.feedback.className = kind === 'error' ? 'feedback feedback--error' : 'feedback feedback--ok';
  if (kind === 'ok') {
    setTimeout(() => {
      if (el.feedback.textContent === text) showFeedback('');
    }, 2600);
  }
}

/**
 * 根据协议与认证开关调整界面提示。
 * @returns {void}
 */
function syncFieldVisibility() {
  el.authFields.hidden = el.authEnabled.checked !== true;
  el.port.placeholder = String(DEFAULT_PORTS[el.scheme.value] ?? 8080);
}

/** 把配置渲染到表单。 */
function render() {
  el.scheme.value = PROXY_SCHEMES.includes(config.scheme) ? config.scheme : DEFAULT_CONFIG.scheme;
  el.host.value = config.host;
  el.port.value = config.port > 0 ? String(config.port) : '';

  el.authEnabled.checked = config.authEnabled === true;
  el.username.value = config.username;
  // 选择不记住密码时存储里没有密码，需要用户重新输入
  el.password.value = config.password;
  passwordTouched = false;

  el.bypassList.value = config.bypassList.join('\n');
  el.rememberPassword.checked = config.rememberPassword === true;

  syncFieldVisibility();

  const enabled = config.enabled === true;
  const configured = Boolean(config.host && config.port > 0);
  el.status.className = `status ${enabled && configured ? 'status--on' : 'status--off'}`;
  el.statusText.textContent =
    enabled && configured
      ? `代理已开启 · ${config.scheme}://${config.host}:${config.port}`
      : configured
        ? '代理已关闭'
        : '尚未配置代理服务器';
}

/**
 * 从表单读取配置草稿并校验。
 * @returns {{ok: true, value: object} | {ok: false, error: string, focus: HTMLElement}} 校验结果
 */
function readForm() {
  const host = el.host.value.trim();
  if (!host) {
    return { ok: false, error: '请填写代理服务器地址', focus: el.host };
  }
  if (/^[a-z]+:\/\//i.test(host)) {
    return { ok: false, error: '服务器地址不要带协议前缀，例如直接填 proxy.example.com', focus: el.host };
  }
  if (/\s/.test(host)) {
    return { ok: false, error: '服务器地址不能包含空格', focus: el.host };
  }

  const portText = el.port.value.trim();
  if (!isValidPort(portText)) {
    return { ok: false, error: '端口需要在 1–65535 之间', focus: el.port };
  }

  const authEnabled = el.authEnabled.checked === true;
  if (authEnabled && !el.username.value.trim()) {
    return { ok: false, error: '已启用认证，请填写用户名', focus: el.username };
  }

  return {
    ok: true,
    value: {
      scheme: el.scheme.value,
      host,
      port: Number.parseInt(portText, 10),
      authEnabled,
      username: el.username.value,
      // 用户没动过密码框就沿用已保存的密码，避免「保存一次就把密码清空」
      password: passwordTouched ? el.password.value : config.password,
      rememberPassword: el.rememberPassword.checked === true,
      bypassList: el.bypassList.value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    },
  };
}

/**
 * 提交表单。
 * @param {{silent?: boolean}} [options] 选项
 * @returns {Promise<boolean>} 是否成功
 */
async function submit({ silent = false } = {}) {
  if (busy) return false;

  const result = readForm();
  if (!result.ok) {
    showFeedback(result.error, 'error');
    result.focus.focus();
    return false;
  }

  busy = true;
  el.save.disabled = true;
  try {
    const response = await sendToBackground({ type: 'saveConfig', ...result.value });
    config = normalizeConfig(response.config);
    render();
    if (!silent) {
      showFeedback(
        config.enabled ? `已保存并生效：${config.scheme}://${config.host}:${config.port}` : '已保存',
        'ok',
      );
    }
    return true;
  } catch (error) {
    showFeedback(String(error?.message || error), 'error');
    return false;
  } finally {
    busy = false;
    el.save.disabled = false;
  }
}

/** 重新把当前配置应用到浏览器。 */
async function reapply() {
  if (busy) return;
  busy = true;
  try {
    const response = await sendToBackground({ type: 'refresh' });
    config = normalizeConfig(response.config);
    render();
    showFeedback(config.enabled ? '已重新应用代理设置' : '代理当前是关闭状态', 'ok');
  } catch (error) {
    showFeedback(String(error?.message || error), 'error');
  } finally {
    busy = false;
  }
}

/** 清空全部配置（连同代理一并关闭）。 */
async function resetAll() {
  if (busy) return;
  const confirmed = window.confirm(
    '确定要清空全部配置吗？代理会被关闭，服务器地址与账号密码都会从本扩展中删除。',
  );
  if (!confirmed) return;

  busy = true;
  try {
    const response = await sendToBackground({
      type: 'saveConfig',
      scheme: DEFAULT_CONFIG.scheme,
      host: '',
      port: 0,
      authEnabled: false,
      username: '',
      password: '',
      rememberPassword: true,
      bypassList: [...DEFAULT_CONFIG.bypassList],
    });
    config = normalizeConfig(response.config);
    render();
    showFeedback('已清空配置', 'ok');
  } catch (error) {
    showFeedback(String(error?.message || error), 'error');
  } finally {
    busy = false;
  }
}

/** 绑定界面事件。 */
function bindEvents() {
  el.scheme.addEventListener('change', syncFieldVisibility);
  el.authEnabled.addEventListener('change', syncFieldVisibility);

  el.password.addEventListener('input', () => {
    passwordTouched = true;
  });

  el.togglePassword.addEventListener('click', () => {
    const showing = el.password.type === 'text';
    el.password.type = showing ? 'password' : 'text';
    el.togglePassword.textContent = showing ? '显示' : '隐藏';
  });

  // 输入框里按回车直接保存
  for (const input of [el.host, el.port, el.username, el.password]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    });
    input.addEventListener('input', () => showFeedback(''));
  }

  el.bypassList.addEventListener('input', () => showFeedback(''));

  el.save.addEventListener('click', () => {
    void submit();
  });

  el.applyNow.addEventListener('click', () => {
    void (async () => {
      // 先把表单里的改动落盘再重新应用，避免用户以为「立即应用」会丢掉未保存的编辑
      const saved = await submit({ silent: true });
      if (saved) await reapply();
    })();
  });

  el.resetDefaults.addEventListener('click', () => {
    void resetAll();
  });

  // 配置被别处（弹窗）改动时同步到表单
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.config || busy) return;
    config = normalizeConfig(changes.config.newValue);
    render();
  });
}

/** 初始化。 */
async function init() {
  bindEvents();

  try {
    const response = await sendToBackground({ type: 'getStatus' });
    config = normalizeConfig(response.config);
    render();
    if (!config.host) {
      showFeedback('请填写代理服务器地址与端口，然后点击保存', 'ok');
    }
  } catch (error) {
    showFeedback(`无法读取配置：${String(error?.message || error)}`, 'error');
  }
}

void init();
