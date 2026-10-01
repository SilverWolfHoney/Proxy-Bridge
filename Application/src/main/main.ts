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
import net from 'node:net';
import { ConfigStore } from './store';
import { ProxyBridge } from '../core/bridge';
import { testUpstream } from '../core/tester';
import { TunnelManager, expandHome, isUsableKey } from '../core/tunnel';
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
  type TunnelConfig,
  type TunnelStatus,
  type TunnelTestResult,
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

/**
 * 关掉主进程的所有控制台输出。
 *
 * 两个目的，缺一不可：
 *
 *  1) **避免 EPIPE 崩溃**。输出一旦被接到管道，读的那一端关闭后再调用 console.log
 *     就会抛 EPIPE；这类调用散落在启动路径上、没人接住，应用会直接起不来（真实踩过）。
 *     让 console 什么都不做，就从根上不会有这次写入。
 *
 *  2) **不留痕**。错误信息里会带出代理服务器地址（例如「无法连接代理服务器 <地址>:<端口>」），
 *     而错误对象里往往还夹着其它上下文。与其逐处脱敏、漏一个就前功尽弃，不如根本不写。
 *
 * 开发模式下保留原生行为，否则本地调试时什么都看不见。
 */
function silenceProcessStreams(): void {
  if (isDev) return;
  const noop = (): void => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
}

silenceProcessStreams();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: ConfigStore;
let systemProxy: SystemProxyManager;
let bridge: ProxyBridge;
let tunnel: TunnelManager;

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
    tunnel: tunnel ? tunnel.getStatus() : null,
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
      // 最后拆隧道：顺序反了会让网关在无隧道的状态下继续收流量
      if (tunnel) await tunnel.stop();
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
/* 内置 SSH 隧道                                                       */
/* ------------------------------------------------------------------ */

/**
 * 解析隧道参数：把「留空表示沿用」的字段补全，得到一份完整可用的配置。
 *
 * 约定：
 *  - `host` 留空时沿用上游服务器地址（代理和 SSH 通常在同一台机器上）
 *  - `user` 留空时按 root 处理
 */
function resolveTunnelConfig(input?: Partial<TunnelConfig>): TunnelConfig {
  const saved = store.getConfig();
  const t: TunnelConfig = { ...saved.tunnel, ...(input ?? {}) };
  const upstreamHost = saved.upstream.host.trim();
  return {
    ...t,
    host: (t.host || upstreamHost).trim(),
    user: (t.user || 'root').trim(),
    keyPath: (t.keyPath || '').trim(),
    port: Number.isInteger(t.port) && t.port > 0 ? t.port : 22,
    remotePort: Number.isInteger(t.remotePort) && t.remotePort > 0 ? t.remotePort : 9999,
    localPort: Number.isInteger(t.localPort) && t.localPort >= 0 ? t.localPort : 0,
  };
}

/** 隧道配置是否填全了（至少要能确定 SSH 服务器） */
function isTunnelConfigured(cfg: TunnelConfig): boolean {
  return cfg.host.length > 0 && cfg.port > 0 && cfg.remotePort > 0;
}

/** 按当前配置启动隧道 */
function startTunnel(cfg: TunnelConfig): Promise<TunnelStatus> {
  return tunnel.start({
    user: cfg.user,
    host: cfg.host,
    port: cfg.port,
    keyPath: cfg.keyPath,
    remotePort: cfg.remotePort,
    localPort: cfg.localPort,
  });
}

/** 试建一次隧道并立即拆掉，供界面上的「测试隧道」按钮使用 */
async function testTunnelOnce(cfg: TunnelConfig): Promise<TunnelTestResult> {
  if (!isTunnelConfigured(cfg)) {
    return { ok: false, latencyMs: null, listen: null, detail: '请先填写 SSH 服务器地址与端口' };
  }
  if (cfg.keyPath && !isUsableKey(cfg.keyPath)) {
    return {
      ok: false,
      latencyMs: null,
      listen: null,
      detail: `找不到私钥文件：${expandHome(cfg.keyPath)}。请重新选择，或改用 ssh-agent 中的密钥。`,
    };
  }

  const probe = new TunnelManager();
  const started = Date.now();
  try {
    const status = await probe.start({
      user: cfg.user,
      host: cfg.host,
      port: cfg.port,
      keyPath: cfg.keyPath,
      remotePort: cfg.remotePort,
      localPort: 0,
      // 试建时不必等满默认超时，尽早给出结论
      connectTimeoutMs: 15_000,
    });

    if (status.state !== 'ready' || !status.listen) {
      return {
        ok: false,
        latencyMs: null,
        listen: null,
        detail: status.error ?? '隧道建立失败（未给出原因）',
      };
    }

    // 隧道通了不代表对端代理可用：再从隧道里发一次 HTTP 探测
    const proxyReachable = await probeProxyThrough(status.listen);
    const ms = Date.now() - started;
    await probe.stop();

    if (!proxyReachable.ok) {
      return {
        ok: false,
        latencyMs: ms,
        listen: status.listen,
        detail: `SSH 隧道已建立（${status.listen}），但隧道对端的代理无响应：${proxyReachable.error}`,
      };
    }
    return {
      ok: true,
      latencyMs: ms,
      listen: status.listen,
      detail: `隧道连通，耗时 ${ms}ms；对端代理可用`,
    };
  } catch (err) {
    await probe.stop();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: null, listen: null, detail: `隧道测试异常：${message}` };
  }
}

/** 从隧道端口发一次最小 HTTP 请求，确认对端代理真的在服务 */
function probeProxyThrough(listen: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    const [host, portText] = listen.split(':');
    const port = Number(portText);
    const socket = net.connect({ host: host || '127.0.0.1', port });
    let settled = false;
    const done = (ok: boolean, error = '') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };

    socket.setTimeout(8_000);
    socket.once('connect', () => {
      // 不带凭据的 CONNECT：代理应回 407（说明在服务）而不是直接断连
      socket.write(
        'CONNECT www.example.com:443 HTTP/1.1\r\nHost: www.example.com:443\r\n\r\n',
        () => {
          socket.once('data', (chunk: Buffer) => {
            const line = chunk.toString('latin1').split('\r\n')[0] ?? '';
            done(true, line);
          });
        },
      );
    });
    socket.once('timeout', () => done(false, '对端代理响应超时'));
    socket.once('error', (err) => done(false, err.message));
  });
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
 * 得到「本次实际会被使用的上游配置」。
 *
 * 隧道就绪时它指向本机隧道端口——连通性校验必须用同一份配置，
 * 否则会出现「校验通过但实际不通」这种最难排查的情况。
 */
function effectiveUpstreamForTest(base: UpstreamConfig): UpstreamConfig {
  const port = tunnel?.getStatus().listen;
  if (!port) return base;
  const localPort = Number(port.split(':')[1]);
  if (!Number.isInteger(localPort) || localPort <= 0) return base;
  return { ...base, host: '127.0.0.1', port: localPort };
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

    // 1) 内置隧道：必须最先建立。
    //    它决定了后面「连通性校验」与「实际转发」连到哪个端口，
    //    所以不能和网关并行做，否则校验会打到旧路径上得出错误结论。
    if (config.tunnel.enabled) {
      const tunnelCfg = resolveTunnelConfig();
      if (!isTunnelConfigured(tunnelCfg)) {
        globalError = '已启用内置隧道，但未填写 SSH 服务器地址';
        setPhase('error');
        return { ok: false, state: currentGlobalState(), error: globalError };
      }

      setPhase('starting');
      const tunnelStatus = await startTunnel(tunnelCfg);
      if (tunnelStatus.state !== 'ready') {
        globalError = tunnelStatus.error ?? '内置隧道建立失败';
        setPhase('error');
        return { ok: false, state: currentGlobalState(), error: globalError };
      }
    }

    // 2) 再确认服务器真的能用：否则开着全局代理等于让整台电脑断网。
    //    隧道已就绪时，这一步探测的是「隧道对端」的代理，而不是直连服务器。
    if (!options.skipVerify) {
      setPhase('starting');
      const test = await testUpstream(effectiveUpstreamForTest(config.upstream));
      if (!test.ok) {
        globalError = test.error ?? '代理服务器无法连接';
        setPhase('error');
        return { ok: false, state: currentGlobalState(), error: globalError };
      }
    }

    // 3) 启动本机网关
    setPhase('starting');
    const bridgeStatus = await bridge.start();
    if (bridgeStatus.state !== 'running') {
      globalError = bridgeStatus.error ?? '本机代理端口启动失败';
      setPhase('error');
      return { ok: false, state: currentGlobalState(), error: globalError };
    }

    // 4) 接管系统代理
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
    // 网关停掉之后再拆隧道，避免拆的瞬间还有在途连接被硬断。
    // 判据用隧道自身的状态：用户可能刚关掉开关但隧道还活着。
    const tunnelState = tunnel?.getStatus().state;
    if (tunnelState && tunnelState !== 'stopped') {
      await tunnel.stop();
    }
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

  /**
   * 清空本机保存的全部配置。
   *
   * 顺序很重要：**先关掉全局代理，再清配置**。
   * 反过来的话，网关和隧道仍然按旧参数在跑，而用户已经看到"配置已清空"，
   * 会出现"显示未配置、实际还在代理"的错觉——凭据也还留在内存里。
   */
  ipcMain.handle(IPC.clearConfig, async (): Promise<SafeConfig> => {
    const running = systemProxyApplied || store.getConfig().globalProxy.enabled;
    if (running) {
      await disableGlobalProxy();
    }
    const safe = store.clearAll();
    pushConfigToBridge();
    broadcastGlobalState();
    return safe;
  });

  ipcMain.handle(IPC.getGlobalProxyState, (): GlobalProxyState => currentGlobalState());

  ipcMain.handle(IPC.getTunnelStatus, (): TunnelStatus => tunnel.getStatus());

  ipcMain.handle(
    IPC.testTunnel,
    async (_e, input?: Partial<TunnelConfig>): Promise<TunnelTestResult> => {
      return testTunnelOnce(resolveTunnelConfig(input));
    },
  );

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

    // 隧道管理器：把「服务器回环上的代理端口」映射到本机，
    // 供网关在启用隧道时改连本地端口（其余上游参数不变）
    tunnel = new TunnelManager();
    tunnel.on('status', () => broadcastGlobalState());

    bridge = new ProxyBridge({
      host: config.bridge.host,
      port: config.bridge.port,
      upstream: config.upstream,
      rules: config.rules,
      appVersion: app.getVersion(),
      // 回调而不是快照：隧道会重连，端口必须每次现取
      tunnelPort: () => {
        const status = tunnel.getStatus();
        if (status.state !== 'ready' || !status.listen) return null;
        const port = Number(status.listen.split(':')[1]);
        return Number.isInteger(port) && port > 0 ? port : null;
      },
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
