/**
 * 主进程入口。
 *
 * 设计取向：这是一个**全局代理**工具。
 * 界面上只有一个开关，它背后自动完成三件事：
 *   开启 → 校验服务器可用 → 启动本机网关 → 接管 Windows 系统代理
 *   关闭 → 还原系统代理 → 停止本机网关
 * 「本机网关」是实现全局代理的必要环节（Windows 系统代理只能指向本机地址），
 * 不是需要用户理解的概念，因此它的参数被收进「高级设置」。
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { ConfigStore } from './store';
import { ProxyBridge } from '../core/bridge';
import { testUpstream } from '../core/tester';
import { SystemProxyManager } from './systemProxy';
import { IPC } from '../shared/ipc';
import {
  isUpstreamConfigured,
  type AppConfig,
  type BridgeStatus,
  type DeepPartial,
  type GlobalProxyResult,
  type GlobalProxyState,
  type SafeConfig,
  type TestResult,
  type UpstreamConfig,
} from '../shared/types';

/**
 * 是否以开发模式运行（连接 Vite 开发服务器，而不是加载构建产物）。
 *
 * 判定必须严格依赖显式的环境变量：`app.isPackaged` 在「用 npx electron . 跑打包前的应用」
 * 这种最常见的调试方式下同样是 false，据此判断会去连一个并不存在的开发服务器，
 * 结果就是一个空白窗口。
 */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? '';
const isDev = DEV_SERVER_URL.length > 0;

let mainWindow: BrowserWindow | null = null;
let store: ConfigStore;
let systemProxy: SystemProxyManager;
let bridge: ProxyBridge;

/** 系统代理当前是否由本应用接管 */
let systemProxyApplied = false;
/** 全局代理当前阶段 */
let globalPhase: GlobalProxyState['phase'] = 'off';
/** 全局代理最近一次的错误，供界面显示 */
let globalError: string | null = null;
/** 是否正在切换，避免连点导致状态错乱 */
let switching = false;
/** 启动时自动恢复全局代理的过程中，不向界面报错 */
let restoring = false;
/** 是否已进入退出流程，避免 before-quit 重入 */
let quitting = false;

/* ------------------------------------------------------------------ */
/* 全局代理状态                                                        */
/* ------------------------------------------------------------------ */

function currentGlobalState(): GlobalProxyState {
  const status = bridge.getStatus();
  return {
    enabled: systemProxyApplied && status.state === 'running',
    phase: globalPhase,
    listen: status.listen,
    error: globalError,
  };
}

function broadcastGlobalState(): void {
  const payload = currentGlobalState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.globalProxyEvent, payload);
  }
}

function setPhase(phase: GlobalProxyState['phase']): void {
  globalPhase = phase;
  // 启动时自动恢复全局代理属于后台行为：中间阶段不推给界面，
  // 免得窗口刚打开就闪一下「正在启动…」
  if (restoring && (phase === 'starting' || phase === 'applying')) return;
  broadcastGlobalState();
}

/* ------------------------------------------------------------------ */
/* 开关的两个方向                                                      */
/* ------------------------------------------------------------------ */

/** 把配置同步给网关实例（不改动监听参数以外的行为） */
function pushConfigToBridge(): AppConfig {
  const config = store.getConfig();
  bridge.updateOptions({
    host: config.bridge.host,
    port: config.bridge.port,
    upstream: config.upstream,
    rules: config.rules,
  });
  return config;
}

/**
 * 开启全局代理。
 * @param options.skipVerify 跳过服务器连通性校验（仅在启动时自动恢复用，避免拖延启动）
 */
async function enableGlobalProxy(options: { skipVerify?: boolean } = {}): Promise<GlobalProxyResult> {
  if (switching) {
    return { ok: false, state: currentGlobalState(), error: '正在切换中，请稍候' };
  }
  switching = true;
  globalError = null;

  try {
    const config = pushConfigToBridge();

    if (!isUpstreamConfigured(config.upstream)) {
      globalError = '请先填写代理服务器地址和端口';
      setPhase('error');
      return { ok: false, state: currentGlobalState(), error: globalError };
    }

    // 1) 先确认服务器真的能用：否则开着全局代理等于让整台电脑断网
    if (!options.skipVerify) {
      setPhase('starting');
      const test = await testUpstream(config.upstream);
      if (!test.ok) {
        globalError = test.error ?? '代理服务器无法连接';
        setPhase('error');
        return { ok: false, state: currentGlobalState(), error: globalError };
      }
    }

    // 2) 启动本机网关
    setPhase('starting');
    const bridgeStatus = await bridge.start();
    if (bridgeStatus.state !== 'running') {
      globalError = bridgeStatus.error ?? '本机代理端口启动失败';
      setPhase('error');
      return { ok: false, state: currentGlobalState(), error: globalError };
    }

    // 3) 接管系统代理
    setPhase('applying');
    const applied = await systemProxy.apply(config.bridge.host, config.bridge.port, config.rules.direct);
    if (!applied.ok) {
      globalError = applied.error ?? '接管系统代理失败';
      setPhase('error');
      return { ok: false, state: currentGlobalState(), error: globalError };
    }

    systemProxyApplied = true;
    store.save({ globalProxy: { enabled: true } });
    setPhase('on');
    return { ok: true, state: currentGlobalState(), error: null };
  } finally {
    switching = false;
  }
}

/** 关闭全局代理：先还原系统代理，再停网关 */
async function disableGlobalProxy(): Promise<GlobalProxyResult> {
  if (switching) {
    return { ok: false, state: currentGlobalState(), error: '正在切换中，请稍候' };
  }
  switching = true;
  globalError = null;

  try {
    setPhase('stopping');

    if (systemProxyApplied || systemProxy.hasStaleSnapshot) {
      const restored = await systemProxy.restore();
      if (!restored.ok) {
        globalError = restored.error ?? '还原系统代理失败';
        setPhase('error');
        return { ok: false, state: currentGlobalState(), error: globalError };
      }
    }
    systemProxyApplied = false;

    await bridge.stop();
    store.save({ globalProxy: { enabled: false } });
    setPhase('off');
    return { ok: true, state: currentGlobalState(), error: null };
  } finally {
    switching = false;
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 合并磁盘配置与本次测试用的临时输入，得到一份完整可用的上游配置 */
function resolveUpstream(input?: {
  protocol?: UpstreamConfig['protocol'];
  host?: string;
  port?: number;
  authEnabled?: boolean;
  username?: string;
  password?: string;
}): UpstreamConfig {
  const saved = store.getConfig().upstream;
  if (!input) return saved;

  return {
    protocol: input.protocol ?? saved.protocol,
    // 用已保存的识别结果，避免每次都重新逐个协议尝试
    detectedProtocol: saved.detectedProtocol,
    host: (input.host ?? saved.host).trim(),
    port: input.port ?? saved.port,
    authEnabled: input.authEnabled ?? saved.authEnabled,
    username: input.username ?? saved.username,
    // 界面上密码框留空表示「沿用已保存的密码」
    password: input.password === undefined || input.password === '' ? saved.password : input.password,
    timeoutMs: saved.timeoutMs,
  };
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 620,
    minWidth: 520,
    minHeight: 480,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Proxy Bridge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 站内链接用系统浏览器打开，不在应用里开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle(IPC.getConfig, (): SafeConfig => store.getSafeConfig());

  ipcMain.handle(IPC.saveConfig, (_e, patch: DeepPartial<AppConfig>): SafeConfig => {
    const before = store.getConfig();
    const safe = store.save(patch ?? {});
    const config = store.getConfig();

    // 监听地址或端口变了：需要重启本机网关才能生效
    const portChanged =
      config.bridge.host !== before.bridge.host || config.bridge.port !== before.bridge.port;

    pushConfigToBridge();

    if (portChanged && bridge.getStatus().state === 'running') {
      void (async () => {
        await bridge.stop();
        // 网关参数变了但系统代理还指着旧端口，这里重新拉起一次
        if (systemProxyApplied || store.getConfig().globalProxy.enabled) {
          await bridge.start();
        }
      })();
    }

    return safe;
  });

  ipcMain.handle(IPC.getStatus, (): BridgeStatus => bridge.getStatus());

  ipcMain.handle(IPC.getGlobalProxyState, (): GlobalProxyState => currentGlobalState());

  ipcMain.handle(IPC.setGlobalProxy, async (_e, enabled: boolean): Promise<GlobalProxyResult> => {
    return enabled ? enableGlobalProxy() : disableGlobalProxy();
  });

  ipcMain.handle(
    IPC.testUpstream,
    async (_e, input?: Parameters<typeof resolveUpstream>[0]): Promise<TestResult> => {
      const cfg = resolveUpstream(input);
      // 测试结果里绝不回显密码
      const result = await testUpstream(cfg);

      // 协议设为「自动」时，把识别出来的协议记进配置：之后不必每次都逐个试
      if (result.ok && result.testedProtocol && cfg.protocol === 'auto') {
        const saved = store.getConfig().upstream;
        const sameServer =
          saved.host === cfg.host && saved.port === cfg.port && saved.username === cfg.username;
        if (sameServer && saved.detectedProtocol !== result.testedProtocol) {
          store.save({ upstream: { detectedProtocol: result.testedProtocol } });
          pushConfigToBridge();
        }
      }

      return result;
    },
  );

  ipcMain.handle(IPC.openPath, async (_e, target: string): Promise<void> => {
    // 只允许打开配置文件所在目录，避免渲染层借这个通道打开任意路径
    const allowed = path.resolve(app.getPath('userData'));
    if (path.resolve(target) !== allowed) return;
    await shell.openPath(allowed);
  });

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
  }));
}

/* ------------------------------------------------------------------ */
/* 启动 / 退出                                                         */
/* ------------------------------------------------------------------ */

// 单实例：多开会导致端口冲突和配置互相覆盖
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    store = new ConfigStore({ dir: userData });
    systemProxy = new SystemProxyManager(userData);

    const config = store.getConfig();
    bridge = new ProxyBridge({
      host: config.bridge.host,
      port: config.bridge.port,
      upstream: config.upstream,
      rules: config.rules,
      appVersion: app.getVersion(),
    });

    // 网关状态变化时同步刷新全局代理状态（界面据此显示运行时长等）
    bridge.on('status', () => broadcastGlobalState());

    registerIpc();
    createWindow();

    // 上次异常退出可能残留了系统代理设置，先还原掉
    if (systemProxy.hasStaleSnapshot) {
      const restored = await systemProxy.restore();
      systemProxyApplied = !restored.ok;
    }

    // 用户上次是开着全局代理的：自动恢复，跳过连通性校验以免拖慢启动
    if (config.globalProxy.enabled && isUpstreamConfigured(config.upstream)) {
      restoring = true;
      const result = await enableGlobalProxy({ skipVerify: true });
      restoring = false;
      if (!result.ok && result.error) {
        console.error('[startup] 自动恢复全局代理失败：', result.error);
      }
    } else {
      broadcastGlobalState();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;

    void (async () => {
      try {
        // 无论如何都要把系统代理还原回去，不能让用户退出后断网
        if (systemProxyApplied || systemProxy.hasStaleSnapshot) {
          await systemProxy.restore();
        }
        await bridge.stop();
      } catch (err) {
        console.error('[quit] 清理失败：', err);
      } finally {
        app.exit(0);
      }
    })();
  });
}
