const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

for (const platform of ['darwin', 'win32', 'linux']) test(`desktop lifecycle and packaged window options on ${platform}`, async () => {
  const app = new EventEmitter();
  Object.assign(app, { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => '/tmp/player-user', setAboutPanelOptions() {}, quit() {} });
  const windows = [];
  const views = [];
  let miniHandler;
  class Window extends EventEmitter {
    static getAllWindows() { return windows.filter(w => !w.closed); }
    constructor(options) {
      super(); this.options = options; this.size = [options.width, options.height];
      this.contentView = {
        addChildView: view => { this.child = view; },
        removeChildView: view => { assert.equal(this.child, view); this.child = null; }
      };
      windows.push(this);
    }
    getContentSize() { return this.size; }
    isDestroyed() { return !!this.closed; }
    isFullScreen() { return !!this.fullscreen; }
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
      this.webContents.reload = () => { this.reloaded = true; };
      this.webContents.reloadIgnoringCache = () => { this.forceReloaded = true; };
      this.webContents.toggleDevTools = () => { this.devtools = true; };
      this.webContents.getZoomLevel = () => this.zoom || 0;
      this.webContents.setZoomLevel = level => { this.zoom = level; };
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  let starts = 0;
  let lastMenuTemplate = [];
  let openedUrl = null;
  const context = { console, process: { platform, env: {} }, __dirname: '/repo/src/electron',
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window, WebContentsView: View,
        ipcMain: { handle(name, handler) { assert.equal(name, 'set-mini-mode'); miniHandler = handler; } },
        Menu: { buildFromTemplate(tmpl) { lastMenuTemplate = tmpl; return tmpl; }, setApplicationMenu() {} },
        shell: { openExternal: async (url) => { openedUrl = url; }, openPath: async () => {} },
        dialog: { showErrorBox() {}, showMessageBox: async () => ({ response: 0 }) } };
      if (name === '../server/index.js') return { startServer: async () => { starts++; return { server: { close() {} }, port: 8899 }; } };
      if (name === '../server/services/logger') return require('../../src/server/services/logger');
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows[0].shown, true);
  if (platform === 'win32') {
    assert.equal(windows[0].options.titleBarStyle, 'hidden');
    assert.equal(windows[0].options.titleBarOverlay.height, 40);
    assert.ok(require('../../package.json').build.files.includes('build/icon.ico'));
  }
  const original = windows[0];
  const view = views[0];
  const sender = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
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
  mini.size = [500, 300];
  mini.emit('resize');
  assert.equal(view.bounds.width, 500);
  assert.equal(view.bounds.height, 300);
  miniHandler(sender, false);
  assert.equal(original.child, view);
  assert.equal(original.shown, true);
  assert.equal(view.closed, undefined);
  miniHandler(sender, true);
  const miniAgain = windows[2];
  let prevented = false;
  miniAgain.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(view.sent, 'mini-mode-restored');
  assert.equal(original.child, view);
  miniHandler(sender, true);
  const miniReload = windows[3];
  view.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:8899/', false, true);
  assert.equal(miniReload.closed, true);
  assert.equal(original.child, view);
  const viewMenu = lastMenuTemplate.find(m => m.label === '视图');
  for (const label of ['重新加载', '强制重新加载', '开发者工具', '放大']) {
    viewMenu.submenu.find(item => item.label === label).click();
  }
  assert.equal(view.reloaded, true);
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
  }
  assert.equal(windows[4].shown, true);
  assert.equal(windows.length, 5);
  assert.equal(views[1].open({ url: 'file:///etc/passwd' }).action, 'deny');
  const helpMenu = lastMenuTemplate.find(m => m.label === '帮助');
  assert.ok(helpMenu);
  const aboutHelp = helpMenu.submenu.find(i => i.label === '关于 红果开源播放器');
  assert.ok(aboutHelp);
  aboutHelp.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(openedUrl, 'https://github.com/zfdang/hongguo-open-player');
});

test('packaging artifact names use english hongguo-open-player without breaking chinese productName', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.build.productName, '红果开源播放器');
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
