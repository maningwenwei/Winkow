'use strict';

/**
 * 进程间通信频道。主进程 / preload / 渲染进程共用，避免字符串散落。
 */
const CH = Object.freeze({
  // renderer -> main
  FLOAT_READY: 'float:ready',
  HIDE: 'hide:request',
  SHOW: 'show:request',
  TOGGLE: 'toggle:request',
  OPEN_SETTINGS: 'settings:open',
  CLOSE_SETTINGS: 'settings:close',
  QUIT: 'app:quit',
  SET_MODE: 'content:set-mode',
  WEBVIEW_READY: 'webview:ready',
  WIN_RESIZE_START: 'win:resize-start',
  WIN_RESIZE_MOVE: 'win:resize-move',
  WIN_RESIZE_END: 'win:resize-end',
  WIN_DRAG_START: 'win:drag-start',
  WIN_DRAG_MOVE: 'win:drag-move',
  WIN_DRAG_END: 'win:drag-end',
  // main -> renderer (broadcast)
  STATE: 'state:changed',
  CONFIG: 'config:changed',
  MIRROR: 'mirror:status',
  NOTICE: 'app:notice',
  SETTINGS_TAB: 'settings:tab',
  // 显隐动画：{ scale, alpha, dy, ms, immediate }
  // 窗口几何全程不动，缩放/位移/淡入交给渲染层的合成层做。
  ANIM: 'float:anim',
  // 主题：mode = 用户选的 light/dark/system，effective = 实际生效的 light/dark
  THEME: 'theme:changed',
  // 渲染层启动时主动问一次当前主题。不能只靠 THEME 广播：窗口刚 ready 那一拍
  // 主进程可能已经把消息发完了（页面还没挂上监听），结果就是首屏明暗正确、
  // 但「用户选的是哪种」永远是空的。拉一次最省事也最稳。
  THEME_GET: 'theme:get',
  // settings <-> main (invoke / handle)
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_RESET: 'config:reset',
  HOTKEY_TEST: 'hotkey:test',
  HOTKEY_CAPTURE_START: 'hotkey:capture-start',
  HOTKEY_CAPTURE_STOP: 'hotkey:capture-stop',
  MIRROR_INFO: 'mirror:info',
  // 关于页的版本号：从 package.json 读，不在 HTML 里写死（写死必然漂）
  APP_INFO: 'app:info',
  CLEAR_TRACES: 'privacy:clear-traces',
  PICK_STREAM: 'content:pick-stream',
  AIRPLAY_ACTION: 'airplay:action',
  AIRPLAY_STATUS: 'airplay:status',
  AIRPLAY_PICK: 'airplay:pick',
  // 主进程找到引擎的视频窗口后通知浮窗改用窗口捕获
  AIRPLAY_WINDOW: 'airplay:window',
  // 渲染层回报捕获是否成功：成功才把引擎窗口藏到小窗背后
  AIRPLAY_CAPTURE: 'airplay:capture-state',
  // 捕获流断了（手机旋转会让引擎重建视频窗口）→ 请求主进程重新找窗口
  AIRPLAY_REPROBE: 'airplay:reprobe',
  // ---- vnet 直通通道（1.0.44）----
  // 引擎用 -vnet 把解密后的 H264 裸码流推到本地 TCP，主进程收下来直接转给
  // 浮窗，由 WebCodecs 解码渲染。整条链路没有视频窗口、没有桌面捕获。
  //
  // 只有「主进程 -> 浮窗」两个方向，没有 start/stop：收流完全由 airplay 模块
  // 在引擎启动/停止时自己管理，渲染层不需要也**不应该**去开关它 —— 多一个
  // 渲染层能发起的开关，就多一种「浮窗刷新后忘了重开、画面再也回不来」的坑。
  // main -> 浮窗：单帧 { data: Uint8Array, ts: number }
  VNET_FRAME: 'vnet:frame',
  // main -> 浮窗：{ state, frames, kbps, fps, dropped, width, height }
  VNET_STATS: 'vnet:stats',
  // 网页里点 target=_blank / window.open 时，主进程拦下来交给浮窗开成新标签页
  WEB_OPEN_TAB: 'web:open-tab',
  // 标签页的前进/后退/刷新：webview 自带的 canGoBack() 在部分版本上恒为 false，
  // 改由主进程读 navigationHistory 的真实下标来判定。
  WEB_NAV: 'web:nav',
  // 网页 guest 里的 Ctrl+滚轮：'in' / 'out'。事件在 guest 的 preload 里截，
  // 因为它不会冒泡到宿主页面（不同渲染进程），宿主那套 wheel 监听管不到网页内部。
  GUEST_ZOOM: 'guest:wheel-zoom',
  // 主进程把上一条转给浮窗：{ dir }
  ZOOM_NUDGE: 'zoom:nudge',
  // 浏览器收藏 / 历史（1.0.52）。一个频道 + op 字段，避免为每条列表操作
  // 都开一条 IPC；返回值始终是最新的一份 { bookmarks, history, remember }。
  BROWSER_DATA: 'browser:data'
});

/** 隐藏原因。粘性原因必须显式解除；自动原因随条件反转自动解除。 */
const REASON = Object.freeze({
  HOTKEY: 'hotkey',
  TRAY: 'tray',
  MANUAL: 'manual',
  MOUSE_LEAVE: 'mouseLeave',
  BLUR: 'blur'
});

const STICKY = Object.freeze([REASON.HOTKEY, REASON.TRAY, REASON.MANUAL]);

const STATE = Object.freeze({
  VISIBLE: 'visible',
  HIDING: 'hiding',
  HIDDEN: 'hidden',
  SHOWING: 'showing'
});

const MODE = Object.freeze({
  IDLE: 'idle',
  WEB: 'web',
  MIRROR: 'mirror'
});

/** 默认值即"开箱即隐蔽"：静音、不记忆网址、内容防截屏、只绑定本机回环。 */
const DEFAULT_CONFIG = Object.freeze({
  // 隐藏与恢复
  hotkey: 'Alt+Q',
  settingsHotkey: 'Alt+Shift+S', // 托盘隐藏时仍能唤出设置
  hideOnMouseLeave: true,
  mouseLeaveDelay: 320,
  mousePadding: 18,
  hideOnBlur: false,
  blurDelay: 700,
  peekEnabled: true,
  peekEdge: 'right',
  peekWidth: 6,
  peekDelay: 260,
  showGraceMs: 1200,
  pollInterval: 33,
  // 外观与动画
  // 主题：light / dark / system（跟随 Windows 应用主题）。默认跟随系统，
  // 与「开箱即隐」的其它默认值一致 —— 不打扰，用户想固定再自己选。
  theme: 'system',
  animationMs: 170,
  reducedMotion: false,
  opacity: 0.98,
  alwaysOnTop: true,
  snapToEdge: true,
  // 窗口与内容布局
  resizable: true,        // 允许拖拽 8 个方向的手柄改变宽高
  zoom: 1,                // 内容缩放（同时作用于网页与投屏查看页）
  pureMode: false,        // 纯净模式：只显示网页 / 投屏画面，没有卡通边框
  mirrorFit: 'contain',   // 投屏画面适配：contain / cover / fill
  // 声音
  muted: true,
  // 播放：收起时把**浏览器网页里**正在播的视频/音频停下，唤回时只续播
  // 「被我们停下的」。只作用于网页，投屏那头没有暂停通道，隐藏期间画面与
  // 声音继续跑。（1.0.59 起删掉「隐藏时系统静音」：它会连带压住整台电脑的
  // 输出，和用户自己的静音状态反复打架，收益远小于风险。）
  pauseOnHide: true,
  // 内容
  mode: MODE.IDLE,
  webUrl: '',
  mirrorSource: '',
  rememberLastUrl: false,
  // 隐私
  contentProtection: true,
  skipTaskbar: true,
  trayVisible: true,
  autoStart: false,
  // iOS 屏幕镜像（AirPlay 接收引擎，可选组件；默认全部关闭/不外联）
  airplayName: 'Winkow',            // iPhone「屏幕镜像」里显示的设备名
  airplayPin: '',                 // 空 = 每次启动随机 4 位
  // 免 PIN 兼容模式：不带 -pin 启动引擎，客户端走「不做配对」的旧路径。
  // 带 -pin 时引擎会与 iPhone 协商共享密钥；若这一步出问题，未加密的 SPS/PPS
  // 正常、加密的 VCL 画面却花屏 —— 关掉 PIN 正好能换一条密钥路径验证。
  airplayNoPin: false,
  airplayEnginePath: '',          // 手动指定 uxplay.exe / uxplay-windows.exe
  airplayFfmpegPath: '',          // 手动指定 ffmpeg.exe
  airplayBasePort: 7000,          // 固定端口便于防火墙放行
  // 向 iPhone 请求的镜像分辨率。
  // 客户端是「等比塞进这个框」，竖屏 iPhone 的宽高比约 0.46：
  // 请求 1280x720 这种横向框，实际只会给 332x720（窄得糊成一片）；
  // 请求竖屏框才能拿到接近框高的清晰画面。
  // 1.0.43 起默认 1080x2340：720x1560 会让 iPhone 先把整屏降采样掉约 1/3
  // 细节，之后引擎再缩到浮窗那么小，文字边缘就再也回不来了。申报得越接近
  // 手机原生分辨率，D3D 缩放时可用的采样点越多。卡顿时可在设置里改回竖屏 720。
  airplayResolution: '1080x2340',
  // 引擎视频输出目标。默认 d3d11videosink：让引擎自己解码并渲染到一扇独立
  // 视频窗口，浮窗再把这扇窗口捕获进来。这条链路用的是引擎成熟的解码器。
  // （旧的 -vdmp + ffmpeg 旁路写出的 H264 数据是坏的，见 src/main/airplay.js 注释）
  airplayVideoSink: 'd3d11videosink',
  /**
   * 画面通道（1.0.44）：
   *   'vnet'   —— 引擎 -vnet 直出 H264 裸码流，浮窗用 WebCodecs 解码渲染。
   *               没有视频窗口、没有桌面捕获、没有窗口摆位，CPU 也低得多。
   *   'window' —— 旧链路：引擎自解码到独立视频窗口，浮窗用 getDisplayMedia 捕获。
   *               只在 vnet 不可用（引擎不支持 -vnet / WebCodecs 缺失）时回退。
   */
  airplayRender: 'vnet',
  // vnet 直通的本地 TCP 端口（仅绑 127.0.0.1）。与 AirPlay 的 7000 段分开，
  // 避免和基端口冲突。
  airplayVnetPort: 7788,
  // 画面异常时不再自动断开重连：实测断开会把用户已经建立的投屏直接打断，
  // 而重连后拿到的新关键帧往往还是坏的，等于反复踢人。保留开关只用于诊断。
  airplayAutoHeal: false,
  // 解码后端：auto(等价 software) | software | hardware(D3D11VA)。
  // 实测坏流下硬件解码会把整帧变成纯绿（失败时吐全零显存），只有好流才更省 CPU。
  airplayDecoder: 'auto',
  // 坏帧闸门：解码时报错的帧不再推给观看端，画面停在上一张干净的图上。
  // 比「把糊满色块的新帧推过去」观感好得多，代价是画面会短暂静止。
  airplayFrameGate: true,
  // 帧率直接决定「顺不顺」。之前压到 20 是为省 CPU，但 20fps 的手机镜像
  // 看着就是一卡一卡；30 也正好是引擎自己的默认上限，不容易触发客户端丢帧。
  airplayFps: 30,
  // 转 JPEG 的「最大宽度」：只做等比缩小，绝不放大。
  // 源画面本身就是 720 宽，这里设 720 等于零缩放 —— 一次插值都不做，最清晰。
  airplayWidth: 720,
  // JPEG 质量（ffmpeg -q:v，2 最好 31 最差）。5 在 720 宽下几乎看不出压缩痕迹，
  // 单帧约 50-80KB，环回中继完全吃得下。
  airplayJpegQuality: 5,
  // 花屏时把原始 H264 头部留存到 %TEMP%\moyu-airplay-sample.h264（8MB），
  // 便于离线定位是读取链路还是解密链路的问题。正常会话不写文件。
  airplayKeepSample: true,
  airplayFitWindow: true,         // 投屏时把浮窗自动调成手机宽高比，画面铺满不留黑边
  airplayMaxDumpMB: 256,          // 临时 H264 流上限，超过自动停止
  airplayStopOnHide: false,       // 默认隐藏时保留会话、只暂停画面推送
  // 手机端结束投屏（锁屏 / 切换音频设备 / 走远）后自动重启接收器：
  // 这套引擎断线后不清理镜像窗口，不重启的话重连常停在旧那一帧。
  airplayReconnect: true,
  // 投放声音：开 = 电脑播放 iPhone 送过来的音频；关 = 只投画面（引擎用 fakesink）。
  // 注意这只决定「电脑端放不放声」，改变不了 iPhone 侧的音频路由；
  // 手机仍会把接收器列为一个音频输出，切走它依旧会结束整条镜像会话。
  // 电脑端是否静音由浮窗的静音按钮实时控制（见 audio.js / engine-audio.js）。
  airplayCastAudio: true,
  // 让引擎输出 RTSP 明细（TEARDOWN 的 96/110、SETUP 类型）。排查断线时打开一次即可。
  airplayTrace: false,
  airplayKeepVisible: true,       // 投屏期间抑制「鼠标移出 / 失焦」自动隐藏，老板键仍可手动隐藏
  // 窗口
  window: { x: null, y: null, width: 372, height: 268 },
  mirrorPort: 27183,
  firstRun: true,
  // 配置结构版本号（由 src/main/config.js 的迁移表维护，勿手动修改）
  configVersion: 2
});

module.exports = { CH, REASON, STICKY, STATE, MODE, DEFAULT_CONFIG };
