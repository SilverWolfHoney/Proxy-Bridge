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

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from 'electron';
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
let tray: Tray | null = null;
let store: ConfigStore;
let systemProxy: SystemProxyManager;
let bridge: ProxyBridge;

/** 用户是否点了「退出」。只有这时关窗口才真的退出，否则只是收进托盘 */
let quittingRequested = false;
/** 是否已提示过「已最小化到托盘」，只提示一次，免得每次关窗都弹 */
let trayHintShown = false;

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
  refreshTray();
}

/* ------------------------------------------------------------------ */
/* 托盘：关掉窗口后应用继续在后台跑，全局代理才不会断                    */
/* ------------------------------------------------------------------ */

/** 托盘图标所在目录：打包后在 resources，开发时在项目根 */
function resourcePath(file: string): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'resources', file);
  return path.join(app.getAppPath(), 'resources', file);
}

/**
 * 读取托盘图标。
 *
 * 源图给的是 32px：Windows 会按 DPI 自行缩放（16 缩放的观感比从 16 放大好），
 * 在 125%/150% 缩放下还能用上更清晰的版本。
 */
function loadTrayIcon(file: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(resourcePath(file));
  if (image.isEmpty()) return image;
  return image.resize({ width: 32, height: 32, quality: 'best' });
}

/** 显示并聚焦主窗口 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * 退出前的清理，只执行一次，完成后直接结束进程。
 * @param reason 触发来源，仅用于日志
 */
function cleanupAndExit(reason: string): void {
  if (quitting) return;
  quitting = true;

  void (async () => {
    try {
      // 无论如何都要把系统代理还原回去，不能让用户退出后断网
      if (systemProxyApplied || systemProxy.hasStaleSnapshot) {
        await systemProxy.restore();
      }
      await bridge.stop();
    } catch (err) {
      console.error(`[quit:${reason}] 清理失败：`, err);
    } finally {
      app.exit(0);
    }
  })();
}

/**
 * 系统关机 / 重启 / 注销时的处理（win32 的窗口事件）。
 *
 * 不做这件事的后果：Windows 会保留代理设置，而本机网关已经不在了，
 * 下次开机所有走系统代理的程序都连不上，用户得自己去关掉代理。
 *
 * 这个事件不提供 event、无法阻止系统，所以只能力所能及：
 * 先用**同步**写注册表关掉代理开关（不依赖事件循环，来得及），
 * 再走异步还原；万一系统没等我们做完，下次启动应用也会还原残留。
 */
function handleSessionEnd(): void {
  if (quitting) return;
  console.info('[session-end] 系统正在关机或注销，先同步关闭系统代理');
  systemProxy.disableSync();
  cleanupAndExit('session-end');
}

/**
 * 刷新托盘的提示与菜单。
 *
 * 图标本身不随状态变化：曾经用「已开启时整体偏绿」来区分状态，
 * 结果把角色的白色衣服、米色细节一起染绿了，很难看。
 * 状态改由悬停提示与右键菜单呈现，图标保持原色。
 */
function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return;

  const state = currentGlobalState();
  const detail = state.enabled ? `已开启（${state.listen ?? '启动中'}）` : '未开启';

  tray.setToolTip(`Proxy Bridge · 全局代理${detail}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `全局代理：${detail}`, enabled: false },
      { type: 'separator' },
      { label: '显示主界面', click: () => showMainWindow() },
      {
        label: state.enabled ? '关闭全局代理' : '开启全局代理',
        click: () => {
          void (state.enabled ? disableGlobalProxy() : enableGlobalProxy());
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quittingRequested = true;
          app.quit();
        },
      },
    ]),
  );
}

/** 创建托盘图标 */
function createTray(): void {
  if (tray) return;

  const image = loadTrayIcon('tray-32.png');
  if (image.isEmpty()) {
    console.error('[tray] 托盘图标读取失败，托盘将不可用');
    return;
  }

  tray = new Tray(image);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  refreshTray();
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
  const windowIcon = nativeImage.createFromPath(resourcePath('app.png'));

  mainWindow = new BrowserWindow({
    width: 620,
    height: 620,
    minWidth: 520,
    minHeight: 480,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Proxy Bridge',
    // 开发运行时用这张；打包后 Windows 会用 exe 自带的图标
    ...(windowIcon.isEmpty() ? {} : { icon: windowIcon }),
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

  // 点 X 不退出，收进托盘：全局代理必须继续跑，否则关个窗口就断网了。
  // 只有从托盘菜单选「退出」才真的结束应用。
  mainWindow.on('close', (event) => {
    if (quittingRequested) return;
    event.preventDefault();
    mainWindow?.hide();

    if (!trayHintShown && tray) {
      trayHintShown = true;
      try {
        tray.displayBalloon({
          title: 'Proxy Bridge 仍在后台运行',
          content: '全局代理保持开启。要重新打开界面，点右下角托盘的图标；要退出，右键它选「退出」。',
        });
      } catch {
        // 部分系统不支持气泡通知，忽略即可，托盘图标本身就是提示
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 系统关机 / 重启 / 注销：这是 BrowserWindow 上的事件（win32），不是 app 上的。
  // 窗口虽然在点 X 时被隐藏，但依然存在，所以监听器一直有效。
  mainWindow.on('session-end', () => {
    handleSessionEnd();
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
    createTray();
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
      showMainWindow();
    });
  });

  // 刻意不在这里退出：关掉窗口只是收进托盘，应用要继续在后台跑，
  // 否则全局代理会跟着一起停掉。真正退出只走托盘菜单的「退出」。
  app.on('window-all-closed', () => {
    // 什么都不做
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    cleanupAndExit('quit');
  });

  // 仅用于自动化验证的钩子：带上这个环境变量时，启动若干秒后自动走正常退出流程，
  // 方便检验便携版是否会在退出后清理它解压出来的临时目录。
  if (process.env.PROXY_BRIDGE_QUIT_AFTER_MS) {
    const delay = Number(process.env.PROXY_BRIDGE_QUIT_AFTER_MS);
    if (Number.isFinite(delay) && delay > 0) {
      console.info(`[test] 将在 ${delay}ms 后自动退出`);
      setTimeout(() => cleanupAndExit('test-hook'), delay);
    }
  }
}
