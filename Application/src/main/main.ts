/**
 * 主进程入口。
 *
 * 职责：
 *  - 创建窗口、注册 IPC
 *  - 持有配置（含明文凭据）并驱动本地网关
 *  - 接管/还原系统代理
 *  - 退出时保证清理干净，不留残余代理设置
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ConfigStore } from './store';
import { ProxyBridge } from '../core/bridge';
import { testUpstream } from '../core/tester';
import { SystemProxyManager, flushDns } from './systemProxy';
import { IPC } from '../shared/ipc';
import {
  isUpstreamConfigured,
  type AppConfig,
  type BridgeStatus,
  type ConnRecord,
  type DeepPartial,
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
/** 系统代理当前是否指向本机网关 */
let systemProxyApplied = false;
/** 是否已进入退出流程，避免 before-quit 重入 */
let quitting = false;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 给状态快照填上主进程才知道的字段 */
function currentStatus(): BridgeStatus {
  return { ...bridge.getStatus(), systemProxyApplied };
}

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
    host: (input.host ?? saved.host).trim(),
    port: input.port ?? saved.port,
    authEnabled: input.authEnabled ?? saved.authEnabled,
    username: input.username ?? saved.username,
    // 界面上密码框留空表示「沿用已保存的密码」
    password: input.password === undefined || input.password === '' ? saved.password : input.password,
    timeoutMs: saved.timeoutMs,
  };
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 插件目录位置：打包后随资源一起发布，开发时就是仓库里的 Plugin 目录 */
function pluginDir(): string {
  const packed = path.join(process.resourcesPath ?? '', 'Plugin');
  if (app.isPackaged && fs.existsSync(packed)) return packed;
  return path.resolve(app.getAppPath(), '..', 'Plugin');
}

/* ------------------------------------------------------------------ */
/* 网关与系统代理                                                       */
/* ------------------------------------------------------------------ */

async function startBridgeAndMaybeSystemProxy(): Promise<BridgeStatus> {
  const config = store.getConfig();
  bridge.updateOptions({
    host: config.bridge.host,
    port: config.bridge.port,
    upstream: config.upstream,
    rules: config.rules,
  });

  const status = await bridge.start();

  if (status.state === 'running' && config.systemProxy.enabled) {
    const result = await systemProxy.apply(config.bridge.host, config.bridge.port, config.rules.direct);
    systemProxyApplied = result.ok;
    if (!result.ok && result.error) {
      bridge.emit('status', bridge.getStatus());
      console.error('[systemProxy]', result.error);
    }
  }

  return currentStatus();
}

async function stopBridgeAndRestoreSystemProxy(): Promise<BridgeStatus> {
  if (systemProxyApplied || systemProxy.hasStaleSnapshot) {
    const result = await systemProxy.restore();
    if (result.ok) systemProxyApplied = false;
    else console.error('[systemProxy]', result.error);
  }
  return bridge.stop();
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 880,
    minHeight: 620,
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

    // 监听地址或端口变了：必须重启监听才能生效
    const portChanged =
      config.bridge.host !== before.bridge.host || config.bridge.port !== before.bridge.port;

    bridge.updateOptions({
      host: config.bridge.host,
      port: config.bridge.port,
      upstream: config.upstream,
      rules: config.rules,
    });

    if (portChanged && bridge.getStatus().state === 'running') {
      void (async () => {
        await bridge.stop();
        await startBridgeAndMaybeSystemProxy();
      })();
    } else if (systemProxyApplied) {
      // 规则变了，绕过列表也要跟着更新
      void systemProxy.apply(config.bridge.host, config.bridge.port, config.rules.direct);
    }

    return safe;
  });

  ipcMain.handle(IPC.getStatus, (): BridgeStatus => currentStatus());

  ipcMain.handle(IPC.startBridge, async (): Promise<BridgeStatus> => {
    const config = store.getConfig();
    if (!isUpstreamConfigured(config.upstream)) {
      return {
        ...currentStatus(),
        error: '请先填写代理服务器地址和端口',
      };
    }
    return startBridgeAndMaybeSystemProxy();
  });

  ipcMain.handle(IPC.stopBridge, async (): Promise<BridgeStatus> => {
    const status = await stopBridgeAndRestoreSystemProxy();
    store.save({ systemProxy: { enabled: false } });
    return { ...status, systemProxyApplied };
  });

  ipcMain.handle(
    IPC.testUpstream,
    async (_e, input?: Parameters<typeof resolveUpstream>[0]): Promise<TestResult> => {
      const cfg = resolveUpstream(input);
      // 测试结果里绝不回显密码
      return testUpstream(cfg);
    },
  );

  ipcMain.handle(IPC.applySystemProxy, async (_e, enabled: boolean): Promise<BridgeStatus> => {
    const config = store.getConfig();

    if (enabled) {
      if (bridge.getStatus().state !== 'running') {
        return { ...currentStatus(), error: '请先启动网关，再接管系统代理' };
      }
      const result = await systemProxy.apply(config.bridge.host, config.bridge.port, config.rules.direct);
      systemProxyApplied = result.ok;
      store.save({ systemProxy: { enabled: result.ok } });
      if (!result.ok && result.error) {
        return { ...currentStatus(), error: result.error };
      }
      return currentStatus();
    }

    const result = await systemProxy.restore();
    if (result.ok) {
      systemProxyApplied = false;
      store.save({ systemProxy: { enabled: false } });
      await flushDns();
      return currentStatus();
    }
    return { ...currentStatus(), error: result.error };
  });

  ipcMain.handle(IPC.getConnections, (): ConnRecord[] => bridge.getRecords());

  ipcMain.handle(IPC.clearConnections, (): void => {
    bridge.clearRecords();
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string): Promise<void> => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle(IPC.openPath, async (_e, target: string): Promise<void> => {
    // 只允许打开插件目录，避免渲染层借这个通道打开任意路径
    const allowed = path.resolve(pluginDir());
    if (path.resolve(target) !== allowed) return;
    await shell.openPath(allowed);
  });

  ipcMain.handle(IPC.getPluginPath, (): string => pluginDir());

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

// 单实例：多开会导致网关端口冲突和配置互相覆盖
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

    bridge.on('status', (status: BridgeStatus) => {
      broadcast(IPC.statusEvent, { ...status, systemProxyApplied });
    });
    bridge.on('connection', (record: ConnRecord) => {
      broadcast(IPC.connectionEvent, record);
    });

    registerIpc();
    createWindow();

    // 上次异常退出可能残留了系统代理设置，这里主动还原一次
    if (systemProxy.hasStaleSnapshot) {
      const restored = await systemProxy.restore();
      if (restored.ok) systemProxyApplied = false;
    }

    if (config.bridge.autoStart && isUpstreamConfigured(config.upstream)) {
      await startBridgeAndMaybeSystemProxy();
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
        await stopBridgeAndRestoreSystemProxy();
      } catch (err) {
        console.error('[quit] 清理失败：', err);
      } finally {
        app.exit(0);
      }
    })();
  });
}
