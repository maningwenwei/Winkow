'use strict';

/**
 * 应用入口：组装各模块并只做「接线」，业务逻辑全部下沉到独立模块。
 * 生命周期：单实例 -> 配置/中继/音频 -> 窗口 -> 隐藏状态机 -> 输入源 -> 托盘 -> IPC。
 */
const fs = require('fs');
const path = require('path');
const { app, session, powerSaveBlocker, nativeTheme } = require('electron');
const ConfigStore = require('./config');
const MirrorRelay = require('./mirrorServer');
const AudioPolicy = require('./audio');
const { createPlayback } = require('./playback');
const AirPlayEngine = require('./airplay');
const { WindowLayer } = require('./windows');
const HideController = require('./hideController');
const HotkeyManager = require('./hotkeys');
const MouseWatcher = require('./mouseWatcher');
const TrayManager = require('./tray');
const { registerIpc } = require('./ipc');
const { normalizeMode, themeState } = require('./theme');
const { CH, MODE, REASON, STATE } = require('../shared/constants');
const { engineVisible, followPlan, FOLLOW_GAP_MS } = require('./engineWindow');
const diag = require('./diag');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function safeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : '';
  } catch (_) {
    return '';
  }
}

function boot() {
  const ctx = {};

  // 只改品牌名、不改数据目录：productName 变成 Winkow 后 Electron 的默认
  // userData 会跟着变成 %APPDATA%/Winkow，老配置、网页 session、开机自启项
  // 会被留在旧目录里。打包运行时显式钉回原名目录，功能与已有设置一律不变。
  // 两个例外必须放行，否则会覆盖调用方指定：① 命令行 --user-data-dir
  // （端到端探针用它隔离配置）；② 源码模式（app.isPackaged=false，本来就用
  // package.json 的 name，不需要纠正）。
  const customUserData = process.argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
  if (app.isPackaged && !customUserData) {
    app.setPath('userData', path.join(app.getPath('appData'), '摸鱼小窗'));
  }

  app.whenReady().then(async () => {
    app.setAppUserModelId('Winkow.Float');
    diag.start();

    const config = new ConfigStore();
    // 1.0.59：每次启动都从「待机」开始。以前会把上次退出时的 mode（网页 / 投屏）
    // 接着恢复，用户一开应用就是一张网页，还得自己切回待机。待机是唯一的入口，
    // 网页 / 投屏改成由用户显式进入（地址栏、胶囊按钮、托盘）。
    if (config.get().mode !== MODE.IDLE) config.set({ mode: MODE.IDLE });
    const relay = new MirrorRelay(config.get().mirrorPort);
    const audio = new AudioPolicy(config);
    const playback = createPlayback({ config });
    const windows = new WindowLayer(config);
    const controller = new HideController({ windows, config, audio, relay });
    const hotkeys = new HotkeyManager(config, controller, windows);
    const watcher = new MouseWatcher(config, windows, controller);
    let preAirplay = null;
    let lastMode = config.get().mode;
    // 系统主题变化（Windows「应用模式」切了、或用户改了强调色）：跟着推一次。
    // 只推「有效明暗」，不动用户选的 theme —— 选 system 时这就是唯一的刷新来源。
    nativeTheme.on('updated', () => {
      try { applyTheme(config.get()); } catch (_) {}
    });

    const airplay = new AirPlayEngine({
      config, relay,
      onReady: () => {
        const c = config.get();
        preAirplay = { mode: c.mode, webUrl: c.webUrl, mirrorSource: c.mirrorSource };
        windows.beginFit();   // 记下投屏前的窗口尺寸，停止时还原
        applyMode({ mode: MODE.MIRROR, mirrorSource: '' });
        // 投屏时用户注意力在 iPhone 上，鼠标一移出就会把小窗自动藏掉。
        // 只解除「自动」隐藏原因；老板键 / 托盘等粘性隐藏一律不动，隐私语义不变。
        if (c.airplayKeepVisible !== false) {
          controller.release(REASON.MOUSE_LEAVE);
          controller.release(REASON.BLUR);
        }
      },
      // 停止投屏（含退出时清理）后回到投屏前的画面，避免留下空白投屏页
      onStop: () => {
        const back = preAirplay || { mode: MODE.IDLE, webUrl: '', mirrorSource: '' };
        preAirplay = null;
        windows.endFit();     // 还原投屏前的窗口尺寸
        fitDone = '';         // 下次投屏（可能换了设备 / 分辨率）重新适配
        if (back.mode === MODE.MIRROR) applyMode({ mode: MODE.IDLE });
        else applyMode({ mode: back.mode, webUrl: back.webUrl, mirrorSource: back.mirrorSource });
      }
    });
    const tray = new TrayManager(config, controller, {
      setMode: (mode, url) => applyMode(mode === MODE.WEB ? { mode, webUrl: url || '' }
        : mode === MODE.MIRROR ? { mode, mirrorSource: url || '' } : { mode }),
      setMuted: (v) => setMuted(v),
      openSettings: (tab) => windows.openSettings(tab),
      clearTraces: () => ctx.clearTraces && ctx.clearTraces(),
      airplayToggle: () => (airplay.status().running ? airplay.stop() : airplay.start()),
      airplayStatus: () => airplay.status()
    });

    await relay.start();

    function broadcastMode(cfg) {
      let url = '';
      if (cfg.mode === MODE.WEB) {
        url = safeUrl(cfg.webUrl);
      } else if (cfg.mode === MODE.MIRROR) {
        if (!relay.server) {
          windows.sendFloat(CH.NOTICE, { text: '画面来源没有准备好，请到设置里换一个视频源', tone: 'warn' });
        } else {
          const fit = ['contain', 'cover', 'fill'].includes(cfg.mirrorFit) ? cfg.mirrorFit : 'contain';
          // 观看页自带卡通标题栏，纯净模式下由 URL 参数让它只保留画面
          url = `${relay.viewerUrl(safeUrl(cfg.mirrorSource))}&fit=${fit}&pure=${cfg.pureMode ? 1 : 0}`;
        }
      }
      windows.sendFloat(CH.SET_MODE, { mode: cfg.mode, url, muted: cfg.muted });
    }

    function applyMode(patch) {
      // 进出网页模式时顺手把窗口掰成横屏 / 还原。放在这里而不是渲染层：
      // 托盘、右键菜单、IPC 都走这条路，只有一处真相。
      const next = patch && patch.mode;
      if (next && next !== lastMode) {
        if (next === MODE.WEB) windows.fitForWeb();
        // 去投屏不还原：投屏自己会按手机比例重排，回来还要接着横屏网页；
        // 只有真正回到待机才把用户原来的尺寸还给他。
        else if (lastMode === MODE.WEB && next === MODE.IDLE) windows.endWebFit();
        lastMode = next;
      }
      config.set(patch); // -> config 'change' -> applyConfig -> broadcastMode
    }

    function setMuted(value) {
      config.set({ muted: !!value });
    }

    /**
     * 把「用户选的主题」翻译成「实际生效的明暗」再广播。
     * 判定依据由主进程传入而不是在模块里读注册表：themeSource = system 时
     * shouldUseDarkColors 就是 Windows「应用模式」的当前值，系统切换时
     * nativeTheme 会发 updated，我们跟着推一次即可。
     * 映射本身放在 theme.js，可以脱离 Electron 单测。
     */
    function applyTheme(cfg) {
      const mode = normalizeMode(cfg && cfg.theme);
      // 只改 themeSource，不改 shouldUseDarkColors 的实际来源；
      // 固定 light/dark 时 Electron 自身的原生控件（滚动条等）也会跟着变。
      if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
      // 先设 themeSource 再取 shouldUseDarkColors：固定明暗时这两步是同步生效的，
      // 顺序反了会推出上一帧的明暗，界面要等下一次广播才纠正。
      windows.broadcast(CH.THEME, themeState(cfg, nativeTheme.shouldUseDarkColors));
    }

    function applyConfig(cfg) {
      windows.applyConfig(cfg);
      applyTheme(cfg);
      tray.applyConfig();
      audio.apply();
      // 设置里关掉「隐藏时暂停」时，把当前正被我们停着的页面放回去
      playback.sync(cfg);
      if (!ctx.isCapturing || !ctx.isCapturing()) hotkeys.apply();
      watcher.restart();
      if (ctx.syncLoginItem) ctx.syncLoginItem();
      windows.broadcast(CH.CONFIG, cfg);
      broadcastMode(cfg);
      tray.refresh();
    }

    Object.assign(ctx, {
      config, relay, audio, playback, windows, controller, hotkeys, watcher, tray, airplay,
      applyMode, setMuted, broadcastMode,
      // 渲染层启动时主动来问一次（广播有可能在它挂上监听之前就发完了）
      themeNow: () => themeState(config.get(), nativeTheme.shouldUseDarkColors)
    });
    registerIpc(ctx);

    // ---- 输入源接线 ----
    windows.on('float-ready', () => {
      controller.boot();
      attachEngineWindowFollow();
      tray.init();
      hotkeys.apply();
      watcher.start();
      ctx.syncLoginItem();
      // 启动即把默认静音落到所有渲染层 + 引擎的系统音频会话目标状态上。
      // 以前 apply() 只在配置变化时跑，默认 muted=true 从没被同步过。
      audio.apply();
      // 预热音频宿主：C# 类型在子进程里编译一次，之后收起/恢复的静音只要几毫秒。
      // 不预热的话第一次收起还得现场编译 1.5–2.5s，正是「静音慢半拍」的来源。
      audio.preload();
      // 启动一律停在待机（见 boot 顶部），这里不再按上次的 mode 掰窗口尺寸。
      windows.broadcast(CH.CONFIG, config.get());
      applyTheme(config.get());
      windows.broadcast(CH.STATE, controller.snapshot());
      broadcastMode(config.get());
      // 浮窗渲染进程刚起来（含崩溃后自动重载）：解码器是全新的，必须补发一次
      // 带 SPS/PPS 的会话首帧，否则它永远停在「等参数集」，画面不会出来
      if (vnetKeyFrame) {
        try { windows.sendFloat(CH.VNET_FRAME, vnetKeyFrame); } catch (_) {}
      }
      if (config.get().firstRun) {
        windows.sendFloat(CH.NOTICE, {
          text: `按 ${config.get().hotkey} 随时收起；鼠标移开也会自动藏好`,
          tone: 'tip'
        });
        setTimeout(() => config.set({ firstRun: false }), 9000);
      }
    });
    windows.on('close-request', () => controller.requestHide(REASON.TRAY));
    windows.on('blur', () => controller.onBlur());
    windows.on('focus', () => controller.onFocus());
    // 只在「真从藏好变成显示」那一拍做恢复：change 事件还会因为
    // 「武装状态 / 保护期」之类的原因频繁触发，不该每拍都动引擎窗口。
    // 隐藏期间投屏链路全程不停：不断会话、不停解码、不掐捕获流。
    let wasHidden = controller.isHidden();
    // 引擎视频窗口只在「浮窗完全到位」时才许可见 —— 规则和原因见 engineWindow.js：
    // SHOWING 期间卡片正从 86% 长上来，而引擎窗口尺寸不缩，必然露一圈；
    // HIDING 期间卡片正在缩小，引擎窗口必须比动画更早藏起来（隐私优先）。
    const engineShouldShow = () => engineVisible(controller.state);
    let engineWasShown = engineShouldShow();
    controller.on('change', (snapshot) => {
      windows.broadcast(CH.STATE, snapshot);
      tray.refresh();
      const hiddenNow = controller.isHidden();
      const showNow = engineShouldShow();
      airplay.setHidden(!showNow);   // 只切引擎视频窗口的可见性，防画面泄漏
      // 收起即暂停 / 唤回即续播：只动网页里的 <video>/<audio>，标记存在元素自己
      // 身上，所以「用户本来就没在播」的绝不会被我们擅自放起来。
      if (!wasHidden && hiddenNow) playback.onHide();
      else if (wasHidden && !hiddenNow) playback.onShow();
      if (wasHidden && !hiddenNow) {
        // 实测：同一条 WGC 捕获流在 SW_HIDE→SW_SHOW 后自己续上实时帧。
        // rearm 只负责「确认窗口可见 / 还没有流时补一条」，不带 restart，
        // 避免两条异步重建消息互相打断导致恢复后反而没画面（1.0.25 的 bug）。
        airplay.rearm('浮窗显示');
      }
      // 动画跑完才真正摆出去：这时卡片已经是最终矩形，引擎窗口不会露在它外面。
      // 只认「刚才不可见 → 现在可见」这一拍，否则压制标记变化之类无关的 change
      // 也会补一次 tuck，跟引擎自己的 resize 抢窗口。
      if (showNow && !engineWasShown) syncEngineWindow(0);
      engineWasShown = showNow;
      wasHidden = hiddenNow;
    });
    // 投屏期间阻止系统空闲休眠：Windows 空闲后会把设备切到低功耗/待机，
    // 网络一断 AirPlay 就掉线 —— 「藏一会儿就断开」多半是这条，而不是窗口被藏。
    let keepAwakeId = 0;
    const syncKeepAwake = (status) => {
      const want = !!(status && status.running);
      if (want && !keepAwakeId) {
        // prevent-display-sleep 同时挡住「显示器关闭 / 系统空闲睡眠」；原来只用
        // prevent-app-suspension 时，长时间不碰鼠标键盘仍会让 Windows 进入低功耗，
        // 网卡一断 AirPlay 就掉线 —— 用户看到的正是「放着不动过一会儿就断」。
        try { keepAwakeId = powerSaveBlocker.start('prevent-display-sleep'); } catch (_) { keepAwakeId = 0; }
      } else if (!want && keepAwakeId) {
        try { powerSaveBlocker.stop(keepAwakeId); } catch (_) {}
        keepAwakeId = 0;
      }
    };
    airplay.on('status', (status) => {
      windows.broadcast(CH.AIRPLAY_STATUS, status);
      tray.refresh();
      controller.setAutoHideSuppressed(status.running && config.get().airplayKeepVisible !== false);
      syncKeepAwake(status);
    });
    // 手机端结束投屏：告诉用户「不是坏了，是手机断开」，接收器会自己重启待命
    airplay.on('session', (info) => {
      if (info && info.active) return;
      // 只在看投屏的时候提示：正在刷网页时弹「投屏断开」只会打扰
      if (config.get().mode !== MODE.MIRROR) return;
      windows.broadcast(CH.NOTICE, {
        text: '手机断开了投屏。稍等几秒，在控制中心重新选一次「屏幕镜像」就能连回来，PIN 不变',
        tone: 'warn'
      });
    });
    // 把浮窗调成画面比例：不拉伸、不留黑边。
    // 没等到首帧时也要先按设置里请求的分辨率调一次（用户已经选了竖屏/横屏），
    // 否则竖屏手机画面会在横屏浮窗里干等，看起来就是「没有自适应」。
    // 刚出首帧时渲染层可能还没量到 webview 尺寸，一次失败就放弃会让窗口永远
    // 不匹配，所以跟着状态轮询重试；用比例当去重键，成功一次即锁定。
    let fitDone = '';
    let fitBusy = false;
    const tryFit = (status) => {
      if (config.get().airplayFitWindow === false) return;
      let w = Number(status && status.videoW) || 0;
      let h = Number(status && status.videoH) || 0;
      if ((!w || !h) && status && status.running) {
        const m = /^(\d+)x(\d+)$/.exec(String(config.get().airplayResolution || ''));
        if (m && Number(m[2]) > 0) { w = Number(m[1]); h = Number(m[2]); }
      }
      if (!w || !h) return;
      const key = (h / w).toFixed(3);
      if (fitDone === key || fitBusy) return;
      fitBusy = true;
      windows.fitToVideo(w, h).then((box) => {
        if (!box) return;
        fitDone = key;
        // 打包成 GUI 子系统后 stdout 不回传，诊断信息一并写进冒烟日志文件
        if (process.env.MOYU_AIRPLAY_START === '1') {
          const line = `[moyu-airplay-e2e] fit=${box.width}x${box.height} video=${w}x${h}`;
          if (process.env.MOYU_SMOKE_LOG) {
            try { fs.appendFileSync(process.env.MOYU_SMOKE_LOG, `${line}\n`); } catch (_) {}
          }
          console.log(line);
        }
      }).catch(() => {}).then(() => { fitBusy = false; });
    };
    airplay.on('video', (size) => tryFit({ videoW: size.width, videoH: size.height }));
    airplay.on('status', (status) => tryFit(status));

    // ---- vnet 直通：引擎 -vnet 推来的 H264 裸码流 → 浮窗 WebCodecs ----
    // 这条链路没有视频窗口、没有桌面捕获，所以不需要「把引擎窗口摆到浮窗背后」
    // 那一整套逻辑。帧只做一件事：转给浮窗。
    //
    // 取「浮窗」而不是广播：画面只有这一个消费者，广播会把同一帧也发给设置页，
    // 白白多一次 IPC 序列化（每帧一次，30fps 下很可观）。
    const floatContents = () => {
      const fw = windows.float && windows.float.win;
      return fw && !fw.isDestroyed() ? fw.webContents : null;
    };

    /* 缓存「会话首帧」——也就是唯一带 SPS/PPS 的那一帧。
     *
     * H264 的参数集每段会话只出现一次（引擎在首包前拼上 SPS+PPS），之后全是
     * 依赖前帧的 P 帧。所以浮窗一旦错过这一帧（渲染进程重载、崩溃恢复、
     * 页面刷新），新建的解码器就永远等不到参数集，画面再也不会出现 ——
     * 用户的感受就是"必须退出 Winkow 重开"。把这一帧留着，浮窗就绪时补发一次，
     * 解码器就能自己重建起来。
     */
    let vnetKeyFrame = null;
    const hasSPS = (buf) => {
      // 只在开头一小段里扫：SPS 必然在第一帧的最前面
      const n = Math.min(buf.length - 3, 128);
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && (buf[i + 3] & 0x1f) === 7) return true;
      }
      return false;
    };

    airplay.on('vnetFrame', (data, ts) => {
      if (data && hasSPS(data)) vnetKeyFrame = { data, ts };
      const wc = floatContents();
      if (!wc) return;
      // 投递耗时也记一笔：正常是几十微秒。如果隐藏后一路涨到毫秒级，
      // 说明渲染进程不消费、跨进程队列在堆积 —— 那才是主线程被拖慢的源头。
      const t0 = process.hrtime.bigint();
      try { wc.send(CH.VNET_FRAME, { data, ts }); } catch (_) {}
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      if (us > 4000) diag.log('ipc', `vnetFrame 投递耗时 ${us.toFixed(0)}us len=${data ? data.length : 0}`);
    });
    airplay.on('vnetStats', (stats) => {
      const wc = floatContents();
      if (!wc) return;
      try { wc.send(CH.VNET_STATS, stats); } catch (_) {}
    });

    // ---- 画面通道：引擎自解码 → 视频窗口 → 浮窗捕获 ----
    // 以前是「-vdmp 导出 H264 + ffmpeg 解码」，但引擎写出的 dump 数据是坏的
    // （slice header 合法、CABAC 数据解不动），画面必然花屏。现在改成捕获引擎
    // 自己已经解码好的那扇窗口 —— 同一时刻它显示的内容是完全正常的。
    let pendingCapture = null;
    try {
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        if (!pendingCapture) { callback({}); return; }
        callback({ video: pendingCapture });
      }, { useSystemPicker: false });
    } catch (_) {}

    /**
     * 当前生效的画面宽高比（w/h）：优先用实测比例（手机旋转会更新），首帧还没
     * 来时用设置里请求的分辨率。所有引擎窗口摆放只认这一个比例 —— 1.0.24 的
     * 实机日志里，窗口一会儿按配置比例摆（172×374）、一会儿铺满浮窗（372×374），
     * 捕获像素跟着变、浮窗又被像素反调，比例永远收敛不了。
     */
    const activeAspect = () => {
      const v = airplay.video;
      if (v && v.width > 16 && v.height > 16) return v.width / v.height;
      const m = /^(\d+)x(\d+)$/.exec(String(config.get().airplayResolution || ''));
      return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 16 / 9;
    };

    /**
     * 画面区域（渲染层的 .viewport）相对窗口内容区的矩形，由渲染层回报。
     * 引擎窗口必须摆在这块矩形里 —— 浮窗是透明窗口，卡片外面还有一圈
     * padding（左右各 12px，加上 shell 边框、viewport 内缩，合计约 26px），
     * 按整个窗口摆的话引擎画面会从那一圈露出来，看起来就是「浮窗后面还
     * 叠着一块手机投屏画面」。
     */
    let castViewport = null;

    const engineBox = (b) => {
      const ratio = activeAspect();
      const area = castViewport && castViewport.w > 40 && castViewport.h > 40
        ? {
          x: b.x + castViewport.x,
          y: b.y + castViewport.y,
          width: castViewport.w,
          height: castViewport.h
        }
        : b;
      let w = area.width;
      let h = Math.round(w / ratio);
      if (h > area.height) { h = area.height; w = Math.round(h * ratio); }
      // 不能分别 clamp 到 80：竖屏画面投进横屏小窗时 w 可能只有 60，分别取
      // 80 会把宽高比撑歪 —— D3D 把手机画面压变形，浏览器再 contain 一次，
      // 用户看到的就是「又糊又变形」。只留一个不会触发的兜底值。
      w = Math.max(16, w);
      h = Math.max(16, h);
      // 居中而不是左上角对齐：四周留出的空隙一样多，露出的部分也被画面区域
      // 自己的圆角/描边盖住，不会出现「左边贴边、右边一大块」的偏斜感。
      return {
        x: Math.round(area.x + (area.width - w) / 2),
        y: Math.round(area.y + (area.height - h) / 2),
        width: w,
        height: h
      };
    };

    let placeTimer = null;
    let captureOk = false;
    const syncEngineWindow = (delay) => {
      const immediate = !delay;
      // 补拍定时器不能被下一个 move 无条件 clearTimeout 掉：旧实现里每个
      // move 都清掉上一拍，连续拖动时定时器被一遍遍取消，**整个拖程一次
      // tuck 都没发出去**，引擎画面就留在原地、从浮窗后面露出来。
      // 现在：立即调用才清；已有补拍在排队就让它按时执行（届时读最新 bounds）。
      if (!immediate && placeTimer) return;
      clearTimeout(placeTimer);
      placeTimer = null;
      const run = () => {
        placeTimer = null;
        const win = windows.float && windows.float.win;
        if (!win || win.isDestroyed() || !airplay.captureSource) return;
        // 浮窗没完全到位就别摆：tuck 自带 SWP_SHOWWINDOW，摆一次就是把引擎窗口
        // 亮出来一次。动画途中被这里提前亮出来，就会出现「画面比浮窗先到」。
        if (!engineShouldShow()) return;
        // tuck 而不是 place：顺带把引擎进程树里其它可见窗口（断线遗照 / Qt
        // 托盘消息窗 / 尚未绑定的新视频窗）全部藏掉，用户就不该看见任何
        // 「浮窗之外的第二份投屏画面」。
        airplay.tuckWindow(engineBox(win.getBounds()));
      };
      if (immediate) run();
      else {
        placeTimer = setTimeout(run, delay);
        if (placeTimer.unref) placeTimer.unref();
      }
    };

    // 窗口刚刚报上来之后的「安抚」动作：异步、不发散、可被新一轮覆盖。
    let settleTimers = [];
    const settleEngineWindow = (base) => {
      settleTimers.forEach((t) => clearTimeout(t));
      settleTimers = [];
      for (const extra of [80, 300, 800]) {
        const t = setTimeout(() => {
          const win = windows.float && windows.float.win;
          if (!win || win.isDestroyed() || !airplay.captureSource || !engineShouldShow()) return;
          airplay.tuckWindow(engineBox(win.getBounds()));
        }, base + extra);
        if (t.unref) t.unref();
        settleTimers.push(t);
      }
    };

    airplay.on('window', (info) => {
      pendingCapture = (info && info.source) || null;
      // id 一起发下去：主进程可能在投屏中途换成另一扇窗口（真视频窗口后出现），
      // 渲染层凭 id 判断「是不是同一扇」，不同就重建捕获流。
      windows.broadcast(CH.AIRPLAY_WINDOW, {
        ready: !!pendingCapture,
        id: (info && info.id) || '',
        name: (info && info.name) || '',
        // 只有「换了窗口」才需要重建；浮窗显示回来不再重建（同一条流会自己续帧）
        restart: !!(info && info.restart)
      });
      // 浮窗藏着的时候绝不把引擎窗口摆出来：那等于把整块手机画面晾在桌面上
      if (!pendingCapture) return;
      // 隐藏态下新冒出来的视频窗口（重连 / Qt 重建）也必须立刻收进闸门，
      // 否则它会出现在桌面任意位置，看起来就是「uxplay 自己弹出来了」。
      if (!engineShouldShow()) { airplay.setEngineGate(false); airplay.setWindowVisible(false); return; }
      // 窗口刚建出来时往往还是隐藏的（GStreamer 等到首帧才 ShowWindow）。而桌面
      // 捕获抓不可见窗口只能拿到冻结帧/黑帧，渲染层拿不到像素就不会回报成功，
      // 而「把窗口摆出来」又要等回报成功 —— 两边互相等，画面永远出不来。
      // 所以这里先把它摆出去（置底 + place 里的 SWP_SHOWWINDOW 强制显示），让捕获
      // 有内容可抓。
      //
      // 尺寸按「请求分辨率」的长宽比算，而不是直接用浮窗矩形：直接照抄浮窗尺寸
      // 的话，捕获像素=浮窗像素，浮窗再拿它当比例依据就是自己量自己，手机比例
      // 永远学不到（手机旋转后也不会变）。同时保证摆出来的矩形不超出浮窗，
      // 否则超出的部分会露在浮窗外，等于把手机画面晾在桌面上。
      const win = windows.float && windows.float.win;
      if (win && !win.isDestroyed()) {
        airplay.placeWindow(engineBox(win.getBounds()));
        // 首帧刚落地的时刻，Qt 往往还没定好窗口几何：紧接着的 resize /
        // activateWindow 会把它挪回屏幕中间（或提到最前），于是手机画面就
        // 「跑到浮窗外面去了」。这里在之后 2 秒内异步补几次收拢（tuck 会把
        // 偏移纠正 + 藏掉游离窗口），不会和用户的拖动抢窗口。
        settleEngineWindow(0);
      }
    });

    // 渲染层回报捕获结果
    ctx.onAirplayCapture = (info) => {
      const ok = !!(info && info.ok);
      captureOk = ok;
      // 画面区域变了（窗口缩放 / 切换模式）就更新，引擎窗口下一轮对齐会用到
      if (info && info.rect) castViewport = info.rect;
      if (captureOk) {
        // 先按捕获流的真实像素把浮窗调成同一比例，再把引擎窗口对齐过去。
        // 顺序不能反：先摆窗口的话，捕获尺寸会变成浮窗尺寸，比例就永远算不出来。
        // 只有 setVideoSize 真的采纳了新尺寸（比例确实变了）时才调窗口 ——
        // 否则拖动浮窗让窗口跟着变尺寸，会反过来触发一次「自适应」，跟用户抢窗口。
        if (info.width > 16 && info.height > 16) {
          const natural = airplay.setVideoSize(info.width, info.height);
          if (natural) tryFit({ videoW: natural.width, videoH: natural.height });
        }
        // 拖动浮窗时捕获尺寸会连续变化：这里用防抖合成一次对齐，
        // 否则每变一次就起一次 PowerShell，进程会被刷爆。
        // 但引擎自己 resize（手机旋转 / Qt 重新布局）也走这条路 —— 那时窗口
        // 已经整块露在桌面上了，600ms 太慢，压到 250ms：既能合并拖动过程中
        // 的连续变化，又不会让手机画面在桌面上多停一秒。
        syncEngineWindow(airplay.winPlaced ? 250 : 160);
      } else if (airplay.captureSource) {
        // 捕获没成功时，以前会把引擎窗口挪到屏幕正中并置顶，想着「至少别让
        // 小窗变黑框」。实际效果正好相反：手机画面突然出现在桌面中央、还压在
        // 小窗上面，用户看到的就是「画面跑到浮窗外去了 / 被浮窗挡了一块」。
        // 这里改成继续让它躲在浮窗背后 —— 用户看不见它，浮窗自己显示恢复提示。
        syncEngineWindow(300);
      }
    };

    // 浮窗被拖动/缩放后同步引擎窗口（监听在 float-ready 里注册，那时窗口才存在）
    const attachEngineWindowFollow = () => {
      const fw = windows.float && windows.float.win;
      if (!fw || fw.isDestroyed()) return;
      // 不看 captureOk：捕获流偶尔重建时它会是 false，而窗口该跟还得跟。
      // 拖动时旧版要等「最后一个 move 事件 + 420ms」才动一次（一次性
      // PowerShell 一次 700ms，动不起），引擎窗口整个拖程都留在原地 ——
      // 用户看到的就是「画面跑到浮窗外面」。现在走常驻宿主（毫秒级）。
      let lastFollowAt = 0;
      const follow = () => {
        if (!airplay.captureSource) return;
        if (!engineShouldShow()) return;
        // 16ms ≈ 一帧（旧的 250ms / 80ms 都能看出「画面慢半拍跟着卡片走」）。
        // tuck 已在 airplay 里做成合并式，不会再灌满宿主队列。
        // 抖动合并的规则在 engineWindow.js 里，纯函数，可单测。
        // lastFollowAt 记的是「这一拍打算落在哪个时刻」（立即 / 补拍），
        // 连续 move 会被 syncEngineWindow 里的补拍定时器合并成一次。
        const plan = followPlan(Date.now(), lastFollowAt, FOLLOW_GAP_MS);
        lastFollowAt = plan.at;
        syncEngineWindow(plan.delay);
      };
      fw.on('move', follow);
      fw.on('resize', follow);
    };

    /**
     * 收拢守卫：引擎窗口会自己跑偏，游离窗口会自己冒出来。
     *
     * Qt/GStreamer 在首帧到达、窗口 resize、以及偶尔 activateWindow 时都会重设
     * 窗口几何或把它提到前面；断线后的旧窗口、Qt 的托盘消息窗、重连时的新
     * 窗口也都会以「可见」状态出现在桌面任意位置。这里低频 tuck 一轮：
     * 绑定窗口偏了就搬回来，其余可见窗口一律藏掉。常驻宿主让一轮只要毫秒级，
     * 所以 1.2s 的节奏也不会有进程开销。
     */
    let guardTimer = null;
    let guardBusy = false;
    const startAlignGuard = () => {
      if (guardTimer) return;
      guardTimer = setInterval(async () => {
        if (guardBusy) return;
        const win = windows.float && windows.float.win;
        if (!win || win.isDestroyed() || !airplay.captureSource) return;
        if (!engineShouldShow()) return;
        const b = win.getBounds();
        if (!b || b.width < 40 || b.height < 40) return;
        guardBusy = true;
        try {
          await airplay.tuckWindow(engineBox(b));
        } finally {
          guardBusy = false;
        }
      }, 500);
      if (guardTimer.unref) guardTimer.unref();
    };
    startAlignGuard();

    // 画面异常时只记一笔，不再自动断开重连：断开会把用户已经建立好的投屏踢掉，
    // 重连拿到的关键帧往往还是坏的，等于反复踢人。（airplayAutoHeal 默认已关）
    airplay.on('heal', () => {
      windows.broadcast(CH.NOTICE, { text: '画面有点异常，正在自动恢复', tone: 'warn' });
    });
    watcher.on('inside', (inside) => controller.onCursorInside(inside));
    watcher.on('leave', () => controller.onMouseLeave());
    watcher.on('peek', () => controller.peek());
    config.on('change', (cfg) => applyConfig(cfg));
    hotkeys.on('applied', (result) => {
      const failed = result.filter((item) => !item.ok);
      if (failed.length) {
        windows.broadcast(CH.NOTICE, {
          text: '快捷键被其他程序占用了，请到设置里换一个',
          tone: 'warn'
        });
      }
    });

    // 所有新建 WebContents 都纳入静音策略（含 webview guest）
    app.on('web-contents-created', (_event, wc) => {
      if (wc && wc.getType && (wc.getType() === 'webview' || wc.getType() === 'window')) audio.attach(wc);
    });

    const mirrorTimer = setInterval(() => windows.broadcast(CH.MIRROR, relay.status()), 1800);
    if (mirrorTimer.unref) mirrorTimer.unref();

    app.on('second-instance', () => controller.forceShow('hotkey'));
    app.on('window-all-closed', () => { /* 托盘常驻，不自动退出 */ });
    app.on('before-quit', () => {
      clearInterval(mirrorTimer);
      if (keepAwakeId) { try { powerSaveBlocker.stop(keepAwakeId); } catch (_) {} keepAwakeId = 0; }
      // 先停 AirPlay：onStop 会恢复投屏前的画面并落盘，此时窗口/托盘仍存活
      airplay.dispose();
      windows.prepareQuit();
      watcher.stop();
      hotkeys.dispose();
      controller.dispose();
      tray.destroy();
      audio.dispose();
      relay.close();
      try { session.fromPartition('persist:moyu-content').flushStorageData(); } catch (_) {}
    });

    // 诊断入口：MOYU_SMOKE=1 electron . 可无人工干预地验证启动链路后自动退出。
    // 打包成 GUI 子系统后 stdout 可能不回传，因此同时支持 MOYU_SMOKE_LOG 文件日志。
    if (process.env.MOYU_SMOKE === '1') {
      const logFile = process.env.MOYU_SMOKE_LOG || '';
      const log = (line) => {
        process.stdout.write(`${line}\n`);
        if (logFile) { try { fs.appendFileSync(logFile, `${line}\n`); } catch (_) {} }
      };
      // 真实应用链路的网页加载观测：配置 -> broadcastMode -> webview guest
      app.on('web-contents-created', (_event, wc) => {
        if (!wc.getType || wc.getType() !== 'webview') return;
        wc.on('did-finish-load', async () => {
          log(`[moyu-smoke] webview loaded ${wc.getURL()}`);
          // 视口一致性：guest 内部高度必须等于渲染层 webview 容器高度。
          // 若宿主把 display 改成 block，iframe 会退回默认 150px，网页只画在上部一小条。
          try {
            const g = JSON.parse(await wc.executeJavaScript('JSON.stringify([innerWidth, innerHeight])'));
            // 网页模式看的是标签页的 webview（.tabview.active），#view 只留给投屏观看页。
            // 用 offsetHeight 而不是 getBoundingClientRect：.shell 上有显隐动画的
            // transform: scale()，动画期间 rect 量到的是「缩放后的盒子」
            // （139px 在 86% 时显示成 120px），会把正常布局误判成 CLIPPED。
            // guest 那边的 innerHeight 也确实是布局尺寸，两边必须同一种尺子。
            const host = windows.float.win && !windows.float.win.isDestroyed()
              ? await windows.float.win.webContents.executeJavaScript(
                `(() => {
                  const el = document.querySelector('.tabview.active') || document.getElementById('view');
                  return el ? Math.round(el.offsetHeight) : -1;
                })()`)
              : -1;
            const diff = host - g[1];
            log(`[moyu-smoke] viewport guest=${g[0]}x${g[1]} domH=${host} diff=${diff} ` +
              `${Math.abs(diff) <= 2 ? 'FULL' : 'CLIPPED'}`);
            // guest 里的 Ctrl+滚轮靠 <webview preload> 截获。打包后 preload 走的是
            // app.asar 里的路径（file: 协议必须认 asar），这条链一旦断掉，界面上
            // 什么都不会报错，只是「网页里 Ctrl+滚轮没反应」。派一个可取消的合成
            // 滚轮事件：被 cancel 说明 preload 真的装上了并且在监听。
            try {
              const canceled = await wc.executeJavaScript(
                '(() => { const e = new WheelEvent("wheel", { deltaY: -120, ctrlKey: true,'
                + ' bubbles: true, cancelable: true });'
                + ' return !(document.body || document.documentElement).dispatchEvent(e); })()'
              );
              log(`[moyu-smoke] zoom preload=${canceled ? 'ACTIVE' : 'ABSENT'}`);
            } catch (err2) {
              log(`[moyu-smoke] zoom preload error ${err2.message}`);
            }
          } catch (err) {
            log(`[moyu-smoke] viewport error ${err.message}`);
          }
          // 网页模式横屏适配的证据：窗口宽高比要足够横，网站才放得下
          try {
            const fb = windows.float.win && !windows.float.win.isDestroyed() ? windows.float.win.getBounds() : null;
            if (fb) {
              const ratio = (fb.width / Math.max(1, fb.height)).toFixed(2);
              log(`[moyu-smoke] webfit w=${fb.width} h=${fb.height} ratio=${ratio} ` +
                `${fb.width / fb.height >= 1.45 ? 'LANDSCAPE' : 'PORTRAIT'}`);
            }
          } catch (_) {}
        });
        wc.on('did-fail-load', (_e, code, desc) => log(`[moyu-smoke] webview failed ${code} ${desc}`));
        // 观看页里 <img src="/mirror"> 是一条永不结束的 MJPEG 流，
        // 浏览器的 load 事件要等所有子资源收完，所以 did-finish-load 永远不会触发。
        // 用 dom-ready 才能观测到「观看页已经到位」。
        wc.on('dom-ready', () => log(`[moyu-smoke] webview dom-ready ${wc.getURL()}`));
      });
      const airplayE2E = process.env.MOYU_AIRPLAY_START === '1';
      let guestWc = null;
      if (airplayE2E) {
        app.on('web-contents-created', (_event, wc) => {
          if (wc.getType && wc.getType() === 'webview') guestWc = wc;
        });
      }
      windows.on('float-ready', () => {
        log('[moyu-smoke] float ready');
        log(`[moyu-smoke] airplay engine=${airplay.findEngine() || 'MISSING'} ffmpeg=${airplay.findFfmpeg() || 'MISSING'}`);
        // 触发一次完整配置变更，覆盖置顶 / 防截屏 / 全局快捷键 / 托盘刷新等原生调用
        setTimeout(() => config.set({ firstRun: false }), 300);
        if (airplayE2E) {
          const pathMod = require('path');
          const argsFile = pathMod.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
          setTimeout(() => {
            const s = airplay.start();
            log(`[moyu-airplay-e2e] phase=${s.phase} engineFound=${s.engineFound} ffmpegFound=${s.ffmpegFound} error=${s.error || ''}`);
          }, 600);
          setTimeout(() => {
            // 模拟「用户在操作 iPhone，鼠标移出小窗」：投屏期间自动隐藏必须被抑制，
            // 否则画面链路会在隐藏时被掐断，恢复后永远出不来。
            controller.onMouseLeave();
            const snap = controller.snapshot();
            log(`[moyu-airplay-e2e] autoHideSuppressed=${snap.autoHideSuppressed} hiddenAfterMouseLeave=${controller.isHidden()}`);
          }, 1500);
          // 观看端连接是异步的（webview 要先加载 viewing 页再发 /mirror 请求），
          // 打包后首次加载更慢，单次采样容易误判成「没连上」。多次采样，任一命中即可。
          [1200, 2000, 2800, 3400, 4200, 5000].forEach((at) => {
            setTimeout(() => {
              const rs = relay.status();
              log(`[moyu-airplay-e2e] diag@${at} clients=${rs.clients} frames=${rs.frames}` +
                ` dumpFound=${!!airplay.dumpFile} jpeg=${airplay.jpegFrames} pushed=${airplay.pushedFrames}` +
                ` dec=${!!airplay.ffmpeg} rs=${airplay._decoderRestarts}`);
            }, at);
          });
          // 决定性断言：不是「链路计数不为 0」，而是浮窗 viewer 里的 <img>
          // 真的解码出了像素（=用户看到画面）。用真实 Chromium 渲染层取证。
          // 打包后渲染进程更慢，且在 stop() 之后 viewer 会被切回 about:blank，
          // 所以多次轮询采样，任一次拿到非零像素即视为通过。
          const probeViewer = async (at) => {
            // 决定性断言：不是「链路计数不为 0」，而是浮窗 viewer 里的 <img>
            // 真的解出了像素（=用户看到画面）。证据来自渲染层：观看页自己把
            // naturalWidth/naturalHeight 写进 document.title。
            // 不能用 executeJavaScript 注入取证——<img src="/mirror"> 是多部分
            // MJPEG 流，load 事件永不结束，注入的脚本会一直等着而挂死超时，
            // 源码模式偶尔侥幸通过、打包版必然失败。
            const all = require('electron').webContents.getAllWebContents()
              .filter((w) => w.getType && w.getType() === 'webview' && !w.isDestroyed());
            const live = all.filter((w) => /\/viewer/.test(w.getURL() || '')).pop() || guestWc;
            if (!live || live.isDestroyed()) {
              log(`[moyu-airplay-e2e] viewer@${at} img=NOGUEST`);
              return false;
            }
            const title = String(live.getTitle ? live.getTitle() : '');
            const m = title.match(/moyu-live (\d+)x(\d+)/);
            const w = m ? Number(m[1]) : 0;
            const h = m ? Number(m[2]) : 0;
            log(`[moyu-airplay-e2e] viewer@${at} img=${w}x${h} title="${title}"`);
            return w > 0 && h > 0;
          };
          // 便携版首次启动要解压自身到 %TEMP%，渲染进程就绪时间波动很大，采样窗拉宽。
          // 一旦量到非零像素就停，避免 stop() 之后继续打无效日志。
          // 便携版每次冷启动都要把自身解压到 %TEMP%，渲染层就绪时间波动极大
          // （偶发 6s 之后才解出首帧），采样窗必须覆盖到接近退出时刻。
          let viewed = false;
          const samples = [];
          for (let at = 2000; at <= 12000; at += 400) samples.push(at);
          samples.forEach((at) => {
            setTimeout(async () => {
              if (viewed) return;
              if (await probeViewer(at)) viewed = true;
            }, at);
          });
          setTimeout(() => {
            const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '(missing)';
            const rs = relay.status();
            log(`[moyu-airplay-e2e] args=${args}`);
            log(`[moyu-airplay-e2e] mode=${config.get().mode} pid=${airplay.uxplay ? airplay.uxplay.pid : 0} phase=${airplay.phase}`);
            log(`[moyu-airplay-e2e] diag clients=${rs.clients} frames=${rs.frames} dumpFound=${!!airplay.dumpFile}` +
              ` jpeg=${airplay.jpegFrames} pushed=${airplay.pushedFrames}`);
            airplay.stop();
            const after = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '(deleted)';
            log(`[moyu-airplay-e2e] afterStop phase=${airplay.phase} argsRestored=${after !== args}`);
          }, 12400);
        }
        setTimeout(() => app.quit(), airplayE2E ? 13400 : 3200);
      });
    }

    windows.createFloat();
  }).catch((err) => {
    // 启动失败不弹系统对话框，避免暴露工具；写 stderr 供排查
    process.stderr.write(`[moyu] startup failed: ${err && err.stack ? err.stack : err}\n`);
    app.quit();
  });
}
