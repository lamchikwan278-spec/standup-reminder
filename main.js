const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, powerMonitor } = require('electron');
const path = require('path');
// 诊断日志已关闭(强提醒问题已定位修复)。留空函数,保留各处调用点,需要时把函数体加回即可。
function dlog(msg){}

let win = null;
let tray = null;

// 单实例:重复打开只唤出已开的窗口,不再起第二个
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

// ---- “你在用电脑但没开计时” 提醒 ----
let rendererState = 'ready';       // 渲染层上报的当前状态
let activeReadyMs = 0;             // 累计：处于待命 且 你在操作电脑 的时长
let lastNudge = 0;                 // 上次弹框时间(做冷却,防唠叨)
const CHECK_MS = 5000;             // 每 5 秒查一次
const NUDGE_AFTER_MS = 30 * 1000;  // 持续操作满 30 秒还没开始 → 提醒
const NUDGE_COOLDOWN_1_MS = 5 * 60 * 1000;   // 第 1 次点“先不用”→ 5 分钟后再提醒
const NUDGE_COOLDOWN_2_MS = 30 * 60 * 1000;  // 再拒绝 → 之后每 30 分钟才提醒一次
let declineCount = 0;                        // 连续点“先不用”的次数(点了“开始”清零)
let nudgeOpen = false;                       // 弹框还开着时不再叠弹
const ACTIVE_IDLE_SEC = 30;        // 系统空闲 < 30 秒 视为“正在用电脑”

function startNudgeChecker() {
  setInterval(() => {
    let idle = 999;
    try { idle = powerMonitor.getSystemIdleTime(); } catch (e) {}
    const activeAndIdleTimer = (rendererState === 'ready') && (idle < ACTIVE_IDLE_SEC);
    activeReadyMs = activeAndIdleTimer ? activeReadyMs + CHECK_MS : 0;

    const now = Date.now();
    // 递进冷却:没拒绝过→只受30秒活跃门槛;拒绝1次→5分钟;拒绝2次及以上→30分钟
    const cooldown = declineCount === 0 ? 0 : (declineCount === 1 ? NUDGE_COOLDOWN_1_MS : NUDGE_COOLDOWN_2_MS);
    if (!nudgeOpen && activeReadyMs >= NUDGE_AFTER_MS && (now - lastNudge) > cooldown) {
      lastNudge = now;
      activeReadyMs = 0;
      promptStart();
    }
  }, CHECK_MS);
}

function promptStart() {
  nudgeOpen = true;
  dialog.showMessageBox({
    type: 'info',
    title: '纸巾别久坐',
    message: '你已经在电脑前忙一阵了',
    detail: '还没开始久坐计时哦，要现在开始吗？',
    buttons: ['开始计时', '先不用'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then((res) => {
    nudgeOpen = false;
    lastNudge = Date.now();            // 冷却从“你回应弹框”那一刻起算
    if (res.response === 0) {
      declineCount = 0;                // 开始了 → 拒绝记录清零
      if (win) { win.show(); win.webContents.send('do-start'); }
    } else {
      declineCount++;                  // 连续拒绝:第1次→5分钟后再提醒,第2次起→30分钟一次
    }
  }).catch(() => { nudgeOpen = false; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 600,
    height: 920,
    minWidth: 420,
    minHeight: 680,
    title: '纸巾别久坐',
    backgroundColor: '#e9edf0',
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // 关键:窗口藏到后台/被别的窗口盖住时,依然全速运行倒计时,不像浏览器标签页那样被冻结
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // 窗口藏起/显示时,明确通知渲染层「停/续绘制」。
  // 关键:不能只靠渲染层的 visibilitychange —— win.hide() 在 macOS 上不一定触发它,
  // 叠加上面的 backgroundThrottling:false,隐藏后渲染层会自以为还亮着、继续 60fps 空绘,
  // 把 CPU/风扇/电池全拖下水。这里由主进程直接下达停绘指令,可靠。
  win.on('hide', () => { dlog('窗口 hide 事件'); if (win && !win.isDestroyed()) win.webContents.send('vis', 'hidden'); });
  win.on('show', () => { dlog('窗口 show 事件'); if (win && !win.isDestroyed()) win.webContents.send('vis', 'shown'); });

  // 点关闭 = 收进菜单栏,而不是退出(计时继续跑)。真要退出走托盘菜单「退出」
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png')).resize({ height: 18 });
  icon.setTemplateImage(true);   // 模板图:菜单栏明暗自动适配
  tray = new Tray(icon);
  tray.setToolTip('纸巾别久坐 · 久坐提醒');

  const menu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => win && win.show() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { if (win) (win.isVisible() ? win.hide() : win.show()); });
}

app.whenReady().then(() => {
  dlog('======== App 启动 ========');
  app.setName('纸巾别久坐');
  createWindow();
  createTray();
  startNudgeChecker();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) win.show();
  });
});

// 久坐到点触发强提醒时,把窗口弹到最前
// 关键:普通 show()+focus() 唤不醒——如果用户正在另一个 App 的 macOS 原生全屏空间里,
// 背景窗口根本无法跨越到那个全屏 Space,提醒会在后台默默存在但用户完全看不见。
// 用 setAlwaysOnTop('screen-saver') + setVisibleOnAllWorkspaces(visibleOnFullScreen:true)
// 让它能盖过任何全屏 App、跨 Space 显示,提醒才真正"跳"得出来。
function raiseWindowNow() {
  if (!win || win.isDestroyed()) return;
  try{ win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); }catch(e){ dlog('setVisibleOnAllWorkspaces 抛错: ' + e.message); }
  try{ win.setAlwaysOnTop(true, 'screen-saver'); }catch(e){ dlog('setAlwaysOnTop 抛错: ' + e.message); }
  if (win.isMinimized()) { try{ win.restore(); }catch(e){} }
  try{ win.show(); }catch(e){ dlog('show() 抛错: ' + e.message); }
  try{ win.moveTop(); }catch(e){}
  try{ app.focus({ steal: true }); }catch(e){ dlog('app.focus 抛错: ' + e.message); }
  try{ win.focus(); }catch(e){}
}
ipcMain.on('standup-alert', () => {
  dlog('收到 standup-alert IPC · win=' + !!win + (win ? (' 调用前isVisible=' + win.isVisible() + ' isFullScreen=' + win.isFullScreen()) : ''));
  if (!win) return;
  raiseWindowNow();
  try{ if (app.dock) app.dock.bounce('critical'); }catch(e){}   // Dock 图标持续弹跳,直到 App 被激活
  dlog('同步调用后 · isVisible=' + win.isVisible() + ' isFocused=' + win.isFocused());
  // macOS 上焦点/激活是异步的,同步 isFocused 常常还是 false;延迟两拍再抢一次,并记录真实结果
  setTimeout(() => { raiseWindowNow(); dlog('延迟200ms · isFocused=' + (win&&!win.isDestroyed()?win.isFocused():'win没了')); }, 200);
  setTimeout(() => { raiseWindowNow(); dlog('延迟600ms · isFocused=' + (win&&!win.isDestroyed()?win.isFocused():'win没了')); }, 600);
});
// 提醒结束(自动或手动)后恢复正常窗口层级,不影响日常使用体验
ipcMain.on('standup-alert-clear', () => {
  if (!win) return;
  win.setAlwaysOnTop(false);
  win.setVisibleOnAllWorkspaces(false);
});

// 渲染层上报状态变化(ready/running/break/…),供“该开始了”提醒判断
ipcMain.on('state', (e, s) => {
  rendererState = s;
  if (s !== 'ready') { activeReadyMs = 0; declineCount = 0; }   // 一旦开始/休息,累计和拒绝记录都清零
});

// 渲染层每秒把「秒表+倒计时」画成图发来,当作托盘图标(文字精确垂直居中)
ipcMain.on('tray', (e, dataUrl) => {
  if (!tray) return;
  try {
    if (dataUrl && dataUrl.indexOf('data:image') === 0) {
      const img = nativeImage.createEmpty();
      img.addRepresentation({ scaleFactor: 2.0, dataURL: dataUrl }); // 2x 图当视网膜表示
      img.setTemplateImage(true);
      tray.setImage(img);
      tray.setTitle('');
    }
  } catch (err) {}
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => { /* 留在菜单栏,不退出 */ });
