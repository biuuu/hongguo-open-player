const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readBounds, fitBounds, writeBounds } = require('../../src/electron/miniWindowBounds');

function createUserData(t) {
  const dir = path.join(__dirname, `electron-test-data-${randomUUID()}`);
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const platform of ['darwin', 'win32', 'linux']) test(`desktop lifecycle and packaged window options on ${platform}`, async t => {
  const userData = createUserData(t);
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => userData, setAboutPanelOptions() {}, quit() {} });
  const windows = [];
  const views = [];
  const handlers = new Map();
  const shortcuts = new Map();
  const globalShortcut = {
    register(accelerator, callback) {
      if (accelerator === 'Invalid') throw new Error('invalid accelerator');
      if (accelerator === 'Ctrl+Busy' || shortcuts.has(accelerator)) return false;
      shortcuts.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) { shortcuts.delete(accelerator); },
    unregisterAll() { shortcuts.clear(); }
  };
  let saveTimer;
  class Window extends EventEmitter {
    static getAllWindows() { return windows.filter(w => !w.closed); }
    constructor(options) {
      super(); this.options = options; this.size = [options.width, options.height];
      this.position = [options.x ?? 100, options.y ?? 100];
      this.contentView = {
        addChildView: view => { this.child = view; },
        removeChildView: view => { assert.equal(this.child, view); this.child = null; }
      };
      windows.push(this);
    }
    getContentSize() { return this.size; }
    getNormalBounds() { return { x: this.position[0], y: this.position[1], width: this.size[0], height: this.size[1] }; }
    isDestroyed() { return !!this.closed; }
    isFullScreen() { return !!this.fullscreen; }
    isVisible() { return !!this.shown; }
    isMinimized() { return !!this.minimized; }
    restore() { this.minimized = false; }
    destroy() { this.closed = true; this.emit('closed'); }
    hide() { this.shown = false; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
  }
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = handler => { this.open = handler; };
      this.webContents.loadURL = async () => { this.webContents.emit('did-finish-load'); };
      this.webContents.isDestroyed = () => !!this.closed;
      this.webContents.close = () => { this.closed = true; };
      this.webContents.send = channel => { this.sent = channel; };
      this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1; };
      this.webContents.reloadIgnoringCache = () => { this.forceReloaded = true; };
      this.webContents.toggleDevTools = () => { this.devtools = true; };
      this.webContents.getZoomLevel = () => this.zoom || 0;
      this.webContents.setZoomLevel = level => { this.zoom = level; };
      this.webContents.executeJavaScript = async code => { this.executed = code; };
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  let starts = 0;
  let lastMenuTemplate = [];
  let openedUrl = null;
  const dialogs = [];
  const context = { console, URL, process: { platform, env: {} }, __dirname: '/repo/src/electron',
    setTimeout: fn => { saveTimer = fn; return fn; }, clearTimeout: () => { saveTimer = null; },
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window, WebContentsView: View,
        screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
        ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, globalShortcut,
        Menu: { buildFromTemplate(tmpl) { lastMenuTemplate = tmpl; return tmpl; }, setApplicationMenu() {} },
        shell: { openExternal: async (url) => { openedUrl = url; }, openPath: async () => {} },
        dialog: { showErrorBox() {}, showMessageBox: async (parent, options) => { dialogs.push({ parent, options }); return { response: 0 }; } } };
      if (name === '../server/index.js') return { startServer: async port => {
        assert.equal(port, 8900);
        starts++;
        return { server: { close() {} }, port: 8901 };
      } };
      if (name === '../server/services/logger') return { info() {} };
      if (name === '../server/services/streamService') return { shutdown() {} };
      if (name === '../server/services/storeService') return { pending: Promise.resolve() };
      if (name === './miniWindowBounds') return require('../../src/electron/miniWindowBounds');
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows[0].shown, true);
  views[0].webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
  views[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  views[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views[0].reloads, 1);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].parent, windows[0]);
  assert.ok(require('../../package.json').build.files.includes('build/icon.png'));
  if (platform === 'win32') {
    assert.equal(windows[0].options.titleBarStyle, 'hidden');
    assert.equal(windows[0].options.titleBarOverlay.height, 40);
    assert.ok(require('../../package.json').build.files.includes('build/icon.ico'));
  }
  const original = windows[0];
  const view = views[0];
  const sender = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  const miniHandler = (...args) => handlers.get('set-mini-mode')(...args);
  const getSettings = (...args) => handlers.get('settings:get')(...args);
  const setBossKey = (...args) => handlers.get('settings:setBossKey')(...args);
  for (const invalidSender of [{ sender: {}, senderFrame: {} }, { ...sender, senderFrame: {} }]) {
    assert.throws(() => getSettings(invalidSender), /无效/);
    assert.throws(() => setBossKey(invalidSender, 'Ctrl+A'), /无效/);
  }
  assert.equal(getSettings(sender).bossKey, null);
  assert.equal(setBossKey(sender, 'Ctrl+A').success, true);
  assert.equal(getSettings(sender).bossKey, 'Ctrl+A');
  assert.equal(setBossKey(sender, 'Ctrl+A').success, true);
  assert.equal(setBossKey(sender, 'Ctrl+Busy').success, false);
  assert.equal(setBossKey(sender, 'Invalid').success, false);
  assert.equal(getSettings(sender).bossKey, 'Ctrl+A');
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'data', 'desktop-settings.json'), 'utf8')).bossKey, 'Ctrl+A');
  assert.equal(shortcuts.size, 1);
  shortcuts.get('Ctrl+A')();
  assert.equal(original.shown, false);
  shortcuts.get('Ctrl+A')();
  assert.equal(original.shown, true);
  original.minimized = true;
  shortcuts.get('Ctrl+A')();
  assert.equal(original.minimized, false);
  assert.equal(original.shown, true);
  assert.throws(() => miniHandler({ sender: {}, senderFrame: {} }, true), /无效/);
  assert.throws(() => miniHandler({ ...sender, senderFrame: {} }, true), /无效/);
  assert.throws(() => miniHandler(sender, 'true'), /无效/);
  original.fullscreen = true;
  assert.throws(() => miniHandler(sender, true), /全屏/);
  original.fullscreen = false;
  miniHandler(sender, true);
  const mini = windows[1];
  assert.equal(mini.options.frame, false);
  assert.equal(mini.options.minWidth, 240);
  assert.equal(mini.options.minHeight, 160);
  assert.equal(original.shown, false);
  assert.equal(mini.child, view);
  assert.equal(mini.shown, true);
  shortcuts.get('Ctrl+A')();
  assert.equal(mini.shown, false);
  assert.equal(original.shown, false);
  shortcuts.get('Ctrl+A')();
  assert.equal(mini.shown, true);
  assert.equal(original.shown, false);
  shortcuts.get('Ctrl+A')();
  app.emit('second-instance');
  assert.equal(mini.shown, true);
  assert.equal(original.shown, false);
  view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialogs[1].parent, mini);
  assert.equal(view.reloads, 2);
  mini.size = [500, 300];
  mini.position = [220, 180];
  mini.emit('resize');
  mini.emit('move');
  assert.equal(view.bounds.width, 500);
  assert.equal(view.bounds.height, 300);
  saveTimer();
  assert.deepEqual(readBounds(userData), { x: 220, y: 180, width: 500, height: 300 });
  mini.position = [240, 200];
  mini.emit('move');
  miniHandler(sender, false);
  assert.equal(original.child, view);
  assert.equal(original.shown, true);
  assert.equal(view.closed, undefined);
  miniHandler(sender, true);
  const miniAgain = windows[2];
  assert.deepEqual({ ...miniAgain.options }, {
    x: 240, y: 200, width: 500, height: 300, minWidth: 240, minHeight: 160,
    frame: false, show: false, backgroundColor: '#000000', title: '红果开源播放器'
  });
  miniAgain.position = [300, 240];
  let prevented = false;
  miniAgain.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(view.sent, 'mini-mode-restored');
  assert.equal(original.child, view);
  miniHandler(sender, true);
  const miniReload = windows[3];
  assert.equal(miniReload.options.x, 300);
  miniReload.size = [600, 400];
  view.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:8901/', false, true);
  assert.equal(miniReload.closed, true);
  assert.equal(original.child, view);
  const viewMenu = lastMenuTemplate.find(m => m.label === '视图');
  for (const label of ['重新加载', '强制重新加载', '开发者工具', '放大']) {
    viewMenu.submenu.find(item => item.label === label).click();
  }
  assert.equal(view.reloads, 3);
  assert.equal(view.forceReloaded, true);
  assert.equal(view.devtools, true);
  assert.equal(view.zoom, 0.5);
  windows[0].closed = true;
  windows[0].emit('closed');
  app.emit('activate');
  app.emit('activate');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  for (const name of ['will-navigate', 'will-redirect']) {
    let blocked = 0;
    for (const url of ['bad url', 'file:///etc/passwd', 'https://elsewhere.example']) views[1].webContents.emit(name, { preventDefault() { blocked++; } }, url);
    assert.equal(blocked, 3);
    views[1].webContents.emit(name, { preventDefault() { blocked++; } }, 'http://127.0.0.1:8901/');
    assert.equal(blocked, 3);
  }
  assert.equal(windows[4].shown, true);
  assert.equal(windows.length, 5);
  assert.equal(views[1].open({ url: 'file:///etc/passwd' }).action, 'deny');
  const helpMenu = lastMenuTemplate.find(m => m.label === '帮助');
  assert.ok(helpMenu);
  helpMenu.submenu.find(i => i.label === '生成新的设备 ID').click();
  assert.match(views[1].executed, /resetDevice/);
  const aboutHelp = helpMenu.submenu.find(i => i.label === '关于 红果播放器 Plus');
  assert.ok(aboutHelp);
  aboutHelp.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(openedUrl, 'https://github.com/zfdang/hongguo-open-player');

  const newView = views[1];
  const newSender = { sender: newView.webContents, senderFrame: newView.webContents.mainFrame };
  assert.throws(() => getSettings(sender), /无效/);
  assert.throws(() => setBossKey(sender, 'Ctrl+B'), /无效/);
  assert.throws(() => miniHandler(sender, true), /无效/);
  assert.equal(setBossKey(newSender, 'Ctrl+B').success, true);
  assert.equal(shortcuts.has('Ctrl+A'), false);
  assert.equal(setBossKey(newSender, null).success, true);
  assert.equal(shortcuts.size, 0);
  assert.equal(getSettings(newSender).bossKey, null);
  assert.equal(setBossKey(newSender, 'Ctrl+C').success, true);
  miniHandler(newSender, true);
  const miniOnQuit = windows[5];
  assert.equal(miniOnQuit.options.width, 600);
  miniOnQuit.size = [700, 500];
  miniOnQuit.position = [400, 350];
  let quitPrevented = false;
  app.emit('before-quit', { preventDefault() { quitPrevented = true; } });
  assert.equal(quitPrevented, true);
  assert.deepEqual(readBounds(userData), { x: 400, y: 350, width: 700, height: 500 });
  app.emit('will-quit');
  assert.equal(shortcuts.size, 0);

  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8'), { ...context });
  await new Promise(resolve => setImmediate(resolve));
  const restartedView = views[2];
  assert.equal(getSettings({ sender: restartedView.webContents, senderFrame: restartedView.webContents.mainFrame }).bossKey, 'Ctrl+C');
  assert.equal(shortcuts.has('Ctrl+C'), true);
  miniHandler({ sender: restartedView.webContents, senderFrame: restartedView.webContents.mainFrame }, true);
  assert.equal(windows[7].options.x, 400);
  assert.equal(windows[7].options.y, 350);
  assert.equal(windows[7].options.width, 700);
  assert.equal(windows[7].options.height, 500);
});

test('preload exposes both desktop APIs and unsubscribes mini restore listeners', () => {
  const exposed = {};
  const invocations = [];
  const events = new EventEmitter();
  const electron = {
    contextBridge: { exposeInMainWorld(name, api) { exposed[name] = api; } },
    ipcRenderer: {
      invoke(...args) { invocations.push(args); },
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events)
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/preload.js'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return electron; }
  });
  exposed.desktopPlayer.setMiniMode(true);
  exposed.hongguoDesktop.getSettings();
  exposed.hongguoDesktop.setBossKey('Ctrl+A');
  assert.deepEqual(invocations, [
    ['set-mini-mode', true], ['settings:get'], ['settings:setBossKey', 'Ctrl+A']
  ]);
  let restored = 0;
  const unsubscribe = exposed.desktopPlayer.onMiniModeRestored(() => { restored++; });
  events.emit('mini-mode-restored');
  unsubscribe();
  events.emit('mini-mode-restored');
  assert.equal(restored, 1);
});

test('mini window bounds recover from missing or invalid data and fit the current display', t => {
  const userData = createUserData(t);
  assert.equal(readBounds(userData), null);
  const bounds = { x: -1800, y: 100, width: 500, height: 600 };
  writeBounds(userData, bounds);
  assert.deepEqual(readBounds(userData), bounds);
  const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 20, width: 1000, height: 700 } }) };
  assert.deepEqual(fitBounds(bounds, screen), { x: 0, y: 100, width: 500, height: 600 });
  assert.deepEqual(fitBounds({ x: 900, y: 600, width: 1200, height: 900 }, screen),
    { x: 0, y: 20, width: 1000, height: 700 });
  const secondScreen = { getDisplayMatching: () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }) };
  assert.deepEqual(fitBounds(bounds, secondScreen), bounds);
  fs.writeFileSync(path.join(userData, 'mini-window-bounds.json'), '{"x":0,"y":0,"width":1,"height":600}');
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(readBounds(userData), null);
    fs.writeFileSync(path.join(userData, 'mini-window-bounds.json'), '{');
    assert.equal(readBounds(userData), null);
    writeBounds(path.join(userData, 'mini-window-bounds.json'), bounds);
    assert.equal(errors.filter(([message]) => message === '读取小窗位置和尺寸失败:').length, 2);
    assert.ok(errors.some(([message]) => message === '保存小窗位置和尺寸失败:'));
  } finally {
    console.error = originalError;
  }
});

test('packaging artifact names use english hongguo-player-plus without breaking chinese productName', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.build.productName, '红果播放器 Plus');
  assert.ok(pkg.build.artifactName.startsWith('${name}-'));
  assert.equal(pkg.build.mac.artifactName, '${name}-${version}-mac-${arch}.${ext}');
  assert.equal(pkg.build.win.artifactName, '${name}-${version}-win-${arch}.${ext}');
  assert.equal(pkg.build.nsis.artifactName, '${name}-${version}-win-${arch}-setup.${ext}');
  assert.equal(pkg.build.portable.artifactName, '${name}-${version}-win-${arch}-portable.${ext}');
  for (const pattern of [
    pkg.build.artifactName,
    pkg.build.mac.artifactName,
    pkg.build.win.artifactName,
    pkg.build.nsis.artifactName,
    pkg.build.portable.artifactName,
  ]) {
    assert.ok(/^[\w-${}.]+$/.test(pattern), `Pattern ${pattern} contains disallowed characters`);
  }
});
