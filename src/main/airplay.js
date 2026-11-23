'use strict';

/**
 * AirPlay 屏幕镜像接收引擎（可选组件；主程序不依赖它才能启动）。
 *
 * 链路（1.0.13 起）：
 *   iPhone 控制中心 ->「屏幕镜像」-> 本机 UxPlay（DNS-SD + FairPlay + 解密 H.264）
 *     -> GStreamer 自己解码（d3d11videosink）并渲染到一个独立视频窗口
 *     -> 浮窗用桌面捕获把这扇窗口贴进自己的画面区
 *
 * 为什么不再走 -vdmp + ffmpeg：实测引擎写出的 H264 dump 里 SPS/PPS 与 slice
 * header 完全合法，但 CABAC 数据从第 500 多字节起就解不动（ffmpeg 报
 * "error while decoding MB ..."/"cabac_init_idc overflow"，导出的首帧只有
 * 顶部几行是真内容，其余全是错误隐藏填色）。而同一时刻引擎自己解码出来的
 * 画面是正常的 —— 说明坏数据只存在于它的调试输出里，不在解密/解码链路上。
 * 与其继续修一条引擎自己都不用的旁路，不如直接用它已经解码好的画面。
 *
 * 兼容两种引擎形态：
 *   - uxplay.exe（1.x CLI）：参数直接通过 argv 传入
 *   - uxplay-windows.exe（2.x GUI）：参数从 %APPDATA%/leapbtw/uxplay-windows/arguments.txt 读取，
 *     程序启动即自动开服；本模块会备份并恢复该文件。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execFileSync, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { app, dialog, desktopCapturer } = require('electron');
const { H264Normalizer } = require('./h264');
const { VnetSource } = require('./vnet');
const { setEngineActive, setSessionActive, setCastAudio, applyEngineMute } = require('./engine-audio');
const diag = require('./diag');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const ANNEXB4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const LOG_LINES = 14;

function exists(file) {
  try { return !!file && fs.existsSync(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
}

/**
 * Electron 的窗口捕获源 id 形如 `window:<hwnd>:<n>`，HWND 就在中间那段。
 * 拿到它就能和 EnumWindows 枚举到的窗口对齐，也能在列表缺项时自己拼一个。
 */
function hwndOfSource(source) {
  const m = /^window:(\d+):/.exec(String((source && source.id) || ''));
  return m ? Number(m[1]) : 0;
}

/** 把字符串转成能安全塞进 RegExp 的字面量（设备名可能带 . + 括号）。 */
function escapeRe(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 这些窗口属于「引擎进程树里的配角」，不是视频画面。
 *
 * 实测最坑的一个是 `PyInstaller Onefile Hidden Window`：uxplay-windows.exe 是
 * PyInstaller 单文件包，引导程序会先建一扇带尺寸的隐藏窗口，它满足「w>0 && h>0」，
 * 而且往往比视频窗口先出现 —— 于是被当成视频窗口绑上去，捕获到的是全黑。
 * （真窗口随后才由 d3d11videosink 建出来，日志里的 `found window to rename` 就是它。）
 *
 * 输入法、GDI+、程序管理器这一类同理：都属于进程内杂项窗口，永远不该被捕获。
 */
// 噪音窗口：引擎进程里一堆「不是画面」的顶层窗口，混进来就会被绑错。
//   PyInstaller Onefile Hidden Window  单文件包的引导窗口（曾经的黑屏元凶）
//   QtxxxxTrayIconMessageWindow        Qt 托盘图标的消息窗口，**尺寸会被撑到和视频
//                                      窗口一样大**，光看尺寸根本分辨不出来
//   QtxxxxTheme/ScreenChangeObserver   同样是 Qt 内部的观察者窗口
/**
 * 引擎开了 -d 之后会刷很多行，只有这几类跟「谁把会话拆了」有关：
 * TEARDOWN / SETUP 的类型、连接被拒、音频流起停、错误。
 * 其余全部丢掉，否则 60 行的日志窗口里全是噪音。
 */
const ENGINE_LOG_KEEP_RE = /TEARDOWN|SETUP|ANNOUNCE|connection request|starting mirroring|no longer true|Accepted (IPv4|IPv6) client|rejecting|Conflict|not initialized|audioMode|starting audio|audio_disabled|audio format|Mirroring initialized|client feedback|client may be offline|reset|error|Error|ERROR|failed/i;

// 「文件资源管理器 / 文件夹」必须在噪音名单里：1.0.24 实机日志里，手机还没投时
// 桌面捕获源里有一扇「MoyuFloat-1.0.24-AirPlay完整版 - 文件资源管理器」，
// 按设备名模糊匹配把它当成视频窗口绑走、还搬到了浮窗背后。
const NOISE_WINDOW_RE = /pyinstaller|onefile|hidden window|trayicon|themechange|screenchange|observerwindow|default ime|msctfime|msctf\b|gdi\+ window|program manager|^ime$|input method|tooltips_class32|文件资源管理器|文件夹|cabinetwclass|file explorer/i;

function isNoiseWindow(row) {
  if (!row) return true;
  const text = `${row.title || ''} ${row.cls || ''}`;
  return NOISE_WINDOW_RE.test(text);
}

/**
 * 给一个候选窗口打分，分越高越像「引擎渲染视频的那扇窗口」。
 *
 * 不靠单一条件判定：标题会被引擎改成设备名，窗口首帧前可能还隐藏着，
 * 而进程树里又混着 PyInstaller 引导窗口这类杂项。用打分比多层 if 更能表达
 * 「哪个更像」，也方便后面发现更好的窗口时直接比大小切换。
 */
/**
 * 候选窗口的最低分：达不到就当作「视频窗口还没出来」，继续等。
 *
 * 26 这个数字来自实测：GStreamer 的视频窗口类名是 GstD3D12Hwnd（+55），
 * 标题在改名前后分别是 "AirPlay Video Stream"（+50）和设备名（+40），
 * 任一都远高于门槛；而纯靠尺寸堆出来的窗口最多 14 分（大 + 可见），
 * 正好被挡在门外。
 */
const MIN_WINDOW_SCORE = 26;

function scoreWindow(row, deviceName) {
  if (isNoiseWindow(row)) return -1;
  let score = 0;
  const title = String(row.title || '');
  const cls = String(row.cls || '');
  // 引擎在拿到第一帧前把标题设成 "AirPlay Video Stream"，改名（found window to
  // rename）之后变成设备名。两种形态都要能认出来。
  if (/airplay\s*video/i.test(title)) score += 50;
  if (/direct3d|d3d11|d3d12|gstreamer|gstd3d/i.test(title)) score += 60;
  if (/direct3d|d3d11|d3d12|gstreamer|gstd3d/i.test(cls)) score += 55;
  if (deviceName && new RegExp(escapeRe(deviceName), 'i').test(title)) score += 40;
  if (/uxplay/i.test(title)) score += 10;
  // 视频窗口总是远大于杂项窗口：给尺寸一点分，但别让它压过标题特征
  const area = Math.max(0, Number(row.w) || 0) * Math.max(0, Number(row.h) || 0);
  if (area >= 120 * 120) score += 8;
  if (area >= 480 * 480) score += 6;
  if (row.visible) score += 4;
  return score;
}

/**
 * 从一张完整 JPEG 里读宽高（SOFn 段）。
 * 浮窗要「自适应手机尺寸」就得知道画面是几比几，而 JPEG 头里现成有，
 * 不必再去解析 SPS；解码器换任何参数都不影响这里。
 */
function jpegSize(buf) {
  const n = buf.length;
  let i = 2; // 跳过 SOI
  while (i + 8 < n) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0..SOF15，去掉 DHT(C4) / JPG(C8) / DAC(CC) 这三个非 SOF 标记
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda) return null; // 到 SOS 还没见到 SOF，放弃
    i += 2 + len;
  }
  return null;
}

/**
 * H264 裸流 -> JPEG 的 ffmpeg 命令行。
 *
 * 抽成纯函数（不依赖 Electron）便于自测直接验证「真实参数」的解码结果，
 * 而不是测试里另抄一份参数、和线上跑的不是同一套。
 *
 * 几个参数的由来：
 *  - probesize：必须压到极小。管道不可 seek、又永远等不到 EOF，
 *    探测窗口一大，ffmpeg 就会一直攒数据不肯出帧 —— 实测设 256KB 时，
 *    喂了 10KB 仍一个 JPEG 都没有（画面全黑）。32 字节可以让首帧约 48ms 出图。
 *  - r：裸流没有时间戳，ffmpeg 会按 25fps 假设，再经过 fps 滤镜就会被抽帧
 *    （20fps 的镜像被抽成 16fps，看起来一卡一卡）。显式声明输入帧率原速通过。
 *  - ec：错误隐藏。坏片时让解码器猜运动矢量 + 去块，而不是直接糊一片色块。
 */
function buildBridgeArgs(cfg = {}) {
  const fps = Math.max(5, Math.min(60, Number(cfg.airplayFps) || 30));
  const capW = Math.max(0, Number(cfg.airplayWidth) || 0);
  const quality = Math.max(2, Math.min(12, Number(cfg.airplayJpegQuality) || 5));
  const hw = resolveDecoder(cfg) === 'hardware';
  // 硬件解码出来的帧在显存里，必须先 hwdownload 回系统内存，才谈得上缩放与编码。
  const vf = [];
  if (hw) vf.push('hwdownload', 'format=nv12');
  vf.push(`fps=${fps}`);
  if (capW > 0) vf.push(`scale=min(iw\\,${capW}):-2:flags=bilinear`);
  // 注：试过 -flags -output_corrupt（丢弃含错误的帧）想「别出花屏」，
  // 实测 h264 解码器不认这个标志：帧数、告警数、图片大小完全一样，已放弃。
  const flags = '+low_delay';
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (hw) args.push('-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11');
  args.push(
    '-probesize', '32', '-analyzeduration', '0', '-flags', flags,
    // 无线链路偶发坏片时不要中断整条流：继续解码并让解码器做错误隐藏，
    // 否则一次坏帧就可能让画面永久停住。
    '-err_detect', 'ignore_err', '-ec', '7',
    '-r', String(fps),
    '-f', 'h264', '-i', 'pipe:0',
    '-vf', vf.join(','),
    '-an', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', String(quality), 'pipe:1'
  );
  return args;
}

/**
 * 解码后端归一化：auto 目前等于 software。
 *
 * 实测（scripts/probe-decoder-matrix.js，用真实的坏流样本）：
 *   软件 h264   474 帧 / 450 条告警 / 画面为灰蓝竖条纹（错误隐藏）
 *   硬件 D3D11VA 474 帧 /  28 条告警 / 画面 RGB 3,82,4 = 纯绿（失败时吐全零显存）
 * 也就是说硬件解码看着「告警少」，实际是把整帧变成绿屏 —— 对坏流反而更糟。
 * 所以 auto 选择软件解码，硬件作为可选项保留（好流时更省 CPU）。
 */
function resolveDecoder(cfg = {}) {
  return String(cfg.airplayDecoder || 'auto').toLowerCase() === 'hardware' ? 'hardware' : 'software';
}

/**
 * 坏帧闸门：这一帧解码时出过错，且此前至少有过一帧好画面 → 不推到观看端。
 * 让画面停在上一张干净的图上，比推一张糊满色块的「新帧」好得多。
 * 之前一帧好画面都没有时不丢：宁可先给点东西，也好过永远黑屏。
 */
function shouldDropFrame({ gate, hadError, goodFrames }) {
  return !!gate && !!hadError && Number(goodFrames) > 0;
}

/**
 * 「开局就坏」判定：解码器已经出帧，但至今一帧没解干净，告警还在涨。
 * 这是关键帧在传输中损坏的典型形态 —— 后面每一帧都参考它，永远不会自愈，
 * 只能让发送端重发一个关键帧（重启接收器 + 重新投屏）。
 */
function isCorruptStart({ frames, warnings, goodFrames }) {
  return Number(frames) > 0 && Number(frames) <= 45
    && Number(warnings) >= 8 && Number(goodFrames) === 0;
}

class AirPlayEngine extends EventEmitter {
  constructor({ config, relay, onReady, onStop }) {
    super();
    this.config = config;
    this.relay = relay;
    this.onReady = onReady || (() => {});
    this.onStop = onStop || (() => {});
    this.phase = 'idle';       // idle | starting | running | error
    this.error = '';
    this.pin = '';
    this.name = '';
    this.engineKind = '';
    this.uxplay = null;
    this.ffmpeg = null;
    this.tailer = null;
    this.normalizer = null;
    this.dumpOffset = 0;
    this.dumpFile = '';
    this.dumpBase = '';
    this.tmpDir = '';
    this.argsFile = '';
    this.argsBackup = null;
    this.log = [];
    this.startedAt = 0;
    this.hidden = false;
    this.jpegFrames = 0;
    this.pushedFrames = 0;
    this.firstFrameAt = 0;
    this.decodeWarnings = 0;
    this.samplePath = '';
    this.video = null;
    this._aspectCandidate = null;
    this._healed = false;
    this._lastFfmpeg = '';
    this._ffmpegRepeat = 1;
    // 视频质量统计：goodFrames=解码全程无错的帧，corruptFrames=带错帧，
    // droppedFrames=被闸门拦下没推到观看端的帧（画面继续停在上一张好图上）。
    this.goodFrames = 0;
    this.corruptFrames = 0;
    this.droppedFrames = 0;
    this.corruptStart = false;
    this._errSeq = 0;
    this._frameErrSeq = 0;
    this.diagTimer = null;
    this._ffmpegCache = null;
    this._push = null;
    // 会话状态：手机端是否正在镜像。唯一的可靠信号是引擎日志里的
    // "raop_rtp_mirror starting mirroring" / "... is no longer true" ——
    // 视频窗口在断线后并不会自己关，只看窗口会一直以为「还连着」。
    this.session = false;
    this.sessionLost = false;
    this._sessionAt = 0;
    // 自动重启：复用同一套参数（设备名 / PIN 不变，手机端不用重新配对）
    this._args = null;
    this._respawning = false;
    this._respawnTimer = null;
    this._restarts = [];
    // 某段时间内不去探测窗口（断线重启的前后几秒，免得又绑回那张「冻住的遗照」）
    this._suppressProbeUntil = 0;
    // 视频窗口通道：captureSource 给渲染层做 getDisplayMedia，winHwnd 用于把它藏到浮窗背后
    this.captureSource = null;
    this.winTimer = null;
    this.winHwnd = 0;
    this.winRect = null;
    // vnet 直通：引擎 -vnet 推来的 H264 裸码流（1.0.44 起的默认画面通道）
    this.vnet = null;
    // 权威值由 start() 里的 _resolveRenderMode() 决定（要探测引擎是 CLI 还是
    // GUI），构造时先按配置给个初值 —— 否则「构造后、start 前」这段窗口里
    // renderMode 会一直是 'window'，把显隐/重探这些路径的 vnet 守卫全部绕过。
    this.renderMode = this.config.get().airplayRender === 'window' ? 'window' : 'vnet';
    // winPlaced=true 表示窗口已经被摆到浮窗背后：此时捕获尺寸=浮窗尺寸，
    // 不能再拿它当画面比例依据（否则形成闭环，手机旋转后窗口也不变）
    this.winPlaced = false;
    this._psPath = '';
    // 诊断用：枚举调用失败次数（只在首次记日志）与最近一次没找到窗口时的现场
    this._psFails = 0;
    this._lastProbe = null;
    // 常驻 PowerShell 宿主（win-window.ps1 -Action server）。一次性 spawn 一次
    // 要 600-900ms，正是「拖动浮窗时引擎窗口跟不上 / 守卫纠偏太慢」的元凶；
    // 引擎运行期间常驻一个进程，逐行指令逐行应答，延迟降到毫秒级。
    this._host = null;
    this._hostPid = 0;
    this._hostBuf = '';
    this._hostQueue = [];
    this._probing = false;
    // 当前绑定窗口的得分：后出现的候选分更高才值得切换（见 _startWindowWatch）
    this._winScore = 0;

    // ---- 引擎窗口闸门（1.0.43：拖动跟手 + 隐藏不泄漏）----
    // 出站闸门：浮窗没完全到位时，一条 tuck 都不许发。tuck 在 ps1 里带
    // SWP_SHOWWINDOW，隐藏后哪怕只剩一条在途请求，也会把手机画面重新亮出来。
    this._engineGate = true;
    // 每次显隐翻转都 +1；所有 tuck 携带发出时的 epoch，宿主会丢掉过期的。
    this._engineEpoch = 0;
    this._gatePushed = false;
    // 合并式跟随：拖动时上百个 move 只保留「最新矩形」，且最多一条在途。
    // 旧实现每个 move 都发一条，队列上限 8 满了就丢新的 —— 表现就是窗口
    // 整个拖程留在原地，把背后的引擎画面露出来。
    this._tuckLatest = null;
    this._tuckBusy = false;
  }

  // ---- 组件定位 ----

  _exeDir() { try { return path.dirname(app.getPath('exe')); } catch (_) { return ''; } }
  _appDir() { try { return app.getAppPath(); } catch (_) { return ''; } }

  /** 搜索顺序：显式配置 -> exe 同级 airplay/ -> 资源目录 -> 常见安装位置。 */
  findEngine() {
    const cfg = this.config.get();
    const exeDir = this._exeDir();
    const appDir = this._appDir();
    const resDir = process.resourcesPath || '';
    const local = process.env.LOCALAPPDATA || '';
    // 单文件 portable 会自解压到 %TEMP%，app.getPath('exe') 指向临时副本；
    // electron-builder 会把原始 exe 所在目录放在 PORTABLE_EXECUTABLE_DIR。
    const portable = process.env.PORTABLE_EXECUTABLE_DIR || '';
    const dirs = [
      cfg.airplayEnginePath ? path.dirname(cfg.airplayEnginePath) : '',
      portable && path.join(portable, 'airplay'),
      exeDir && path.join(exeDir, 'airplay'),
      resDir && path.join(resDir, 'airplay'),
      resDir && path.join(resDir, '..', 'airplay'),
      appDir && path.join(appDir, 'airplay'),
      appDir && path.join(appDir, '..', 'airplay'),
      appDir && path.join(appDir, '..', '..', 'airplay'),
      'C:\\Program Files\\uxplay-windows',
      'C:\\Program Files (x86)\\uxplay-windows',
      local && path.join(local, 'Programs', 'uxplay-windows')
    ].filter(Boolean);
    if (exists(cfg.airplayEnginePath)) return cfg.airplayEnginePath;
    // 1.0.22 曾在这里按 airplayVideoOnly 切到「改了 /info 四张音频表」的引擎副本。
    // 实机验证：iOS 的音频路由根本不看 /info —— 镜像会话照样送音频、控制中心
    // 照样把本机列为音频输出，切到耳机照样 TEARDOWN 整条会话；反而因为接收器
    // 没了音频格式表，手机和电脑两头都没声音。该功能已移除，这里只认原版引擎。
    return this._firstEngine(dirs) || '';
  }

  _firstEngine(dirs) {
    for (const dir of dirs) {
      // uxplay-cli.exe 排在最前：只有它接受 argv，-vnet 才传得进去。
      // 后两个是旧的 GUI 引擎，留着做兜底（argv 会被丢弃，画面走旧捕获链路）。
      for (const exe of ['uxplay-cli.exe', 'uxplay.exe', 'uxplay-windows.exe']) {
        const candidate = path.join(dir, exe);
        if (exists(candidate)) return candidate;
      }
    }
    return '';
  }

  engineType(file) {
    return /uxplay-windows(-videoonly)?\.exe$/i.test(file) ? 'gui' : 'cli';
  }

  findFfmpeg() {
    const cfg = this.config.get();
    const exeDir = this._exeDir();
    const appDir = this._appDir();
    const portable = process.env.PORTABLE_EXECUTABLE_DIR || '';
    if (exists(cfg.airplayFfmpegPath)) return cfg.airplayFfmpegPath;
    const local = [
      portable && path.join(portable, 'airplay', 'ffmpeg.exe'),
      exeDir && path.join(exeDir, 'airplay', 'ffmpeg.exe'),
      exeDir && path.join(exeDir, 'ffmpeg.exe'),
      appDir && path.join(appDir, '..', 'airplay', 'ffmpeg.exe')
    ].find(exists);
    if (local) return local;
    if (this._ffmpegCache !== null) return this._ffmpegCache;
    try {
      const found = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
        .split(/\r?\n/).map((s) => s.trim()).find((s) => exists(s));
      this._ffmpegCache = found || '';
    } catch (_) {
      this._ffmpegCache = '';
    }
    return this._ffmpegCache;
  }

  async pickEngine() {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择 uxplay.exe / uxplay-windows.exe（AirPlay 接收引擎）',
        properties: ['openFile'],
        filters: [{ name: 'UxPlay', extensions: ['exe'] }]
      });
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return '';
      const file = result.filePaths[0];
      this.config.set({ airplayEnginePath: file });
      this.emit('status', this.status());
      return file;
    } catch (_) {
      return '';
    }
  }

  // ---- 状态 ----

  status() {
    const enginePath = this.findEngine();
    const ffmpegPath = this.findFfmpeg();
    const relay = this.relay.status();
    return {
      phase: this.phase,
      running: this.phase === 'starting' || this.phase === 'running',
      error: this.error,
      enginePath,
      engineKind: enginePath ? this.engineType(enginePath) : '',
      ffmpegPath,
      engineFound: !!enginePath,
      ffmpegFound: !!ffmpegPath,
      name: this.name,
      pin: this.pin,
      noPin: !!this.config.get().airplayNoPin,
      hidden: this.hidden,
      // 手机端是否正在镜像 / 刚刚断线 / 是否正在重启引擎进程
      // （断线后接收器是「保持在线待命」而不是立刻重启，见 _onSessionEnd，
      //  所以这里只把真正在换进程的那两秒算作 reconnecting）
      session: this.session,
      sessionLost: this.sessionLost,
      // 浮窗隐藏时**不暂停**画面投屏：捕获流保持连接、引擎会话不断。
      // status 里只带 hidden 让渲染层知道「这会儿别拿冻帧判黑」，不再有
      // capturePaused —— 隐藏时停流曾是「恢复后画面回不来」的根因。
      capturePaused: false,
      reconnecting: !!this._respawning,
      restarts: (this._restarts || []).length,
      // 画面通道：vnet = 引擎 -vnet 直出 H264，浮窗 WebCodecs 解码；
      // window = 旧链路（引擎解码到窗口 + 桌面捕获）
      render: this.renderMode,
      vnet: this.vnet ? this.vnet.status() : null,
      frames: relay.frames,
      // 链路诊断：逐段计数，任一段为 0 就能一眼定位卡在哪
      engineAlive: !!(this.uxplay && this.uxplay.exitCode === null),
      dumpFound: !!this.dumpFile,
      dumpBytes: this.dumpOffset,
      jpegFrames: this.jpegFrames,
      pushedFrames: this.pushedFrames,
      decodeWarnings: this.decodeWarnings,
      // 本次会话是否已触发过「坏关键帧自动重连」（每次投屏最多一次）
      autoHealed: !!this._healed,
      // 视频质量：解码器后端 + 干净帧/带错帧/被丢掉的帧
      decoder: resolveDecoder(this.config.get()),
      goodFrames: this.goodFrames,
      corruptFrames: this.corruptFrames,
      droppedFrames: this.droppedFrames,
      frameGate: !!this.config.get().airplayFrameGate,
      corruptStart: !!this.corruptStart,
      // 画面通道：引擎自己渲染出的视频窗口是否已经找到（找到了浮窗才有画面）
      windowReady: !!this.captureSource,
      windowName: this.captureSource ? this.captureSource.name : '',
      // 浮窗是否已经确认捕获到画面（渲染层回报成功之后才会把它摆到浮窗背后）
      windowPlaced: !!this.winPlaced,
      videoSink: String(this.config.get().airplayVideoSink || 'd3d11videosink'),
      videoW: this.video ? this.video.width : 0,
      videoH: this.video ? this.video.height : 0,
      // 花屏时留存下来的原始流样本，设置页给出路径，方便把样本发来定位
      samplePath: this.samplePath || '',
      clients: relay.clients,
      firstFrameMs: this.firstFrameAt ? this.firstFrameAt - this.startedAt : 0,
      uptime: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      log: this.log.slice(-LOG_LINES)
    };
  }

  /** 日志同时落一份到固定文件，便于用户把「连接上但没画面」的现场直接发回来。 */
  _diagPath() {
    return path.join(os.tmpdir(), 'moyu-airplay-last.log');
  }

  _note(line) {
    const text = String(line || '').trim();
    if (!text) return;
    this.log.push(text.slice(0, 220));
    if (this.log.length > 60) this.log.shift();
    try { fs.appendFileSync(this._diagPath(), `${new Date().toISOString()} ${text}\n`, 'utf8'); } catch (_) {}
    this.emit('status', this.status());
  }

  _fail(message) {
    this.error = message;
    this.phase = 'error';
    this._note(`[moyu] ${message}`);
  }

  // ---- 生命周期 ----

  /** 启动接收会话；组件缺失时只返回带原因的状态，绝不弹系统对话框。 */
  start() {
    if (this.phase === 'starting' || this.phase === 'running') return this.status();

    const engine = this.findEngine();
    if (!engine) {
      this._fail('未找到 AirPlay 引擎：请解压「引擎组件」到程序旁的 airplay 文件夹，或点下方按钮手动指定 uxplay.exe。');
      return this.status();
    }
    // ffmpeg 不再是必需组件：解码交给引擎自己，这里只保留它的位置供状态展示。
    const ffmpeg = this.findFfmpeg();

    const cfg = this.config.get();
    this.error = '';
    this.phase = 'starting';
    this.startedAt = Date.now();
    const fixed = String(cfg.airplayPin || '');
    // UxPlay 的 get_value() 会拒绝 0000（固定 PIN 必须是 1..9999）
    this.pin = /^(?!0000)\d{4}$/.test(fixed) ? fixed
      : String(Math.floor(1000 + Math.random() * 9000));
    // GUI 引擎用 QProcess::splitCommand 解析 arguments.txt，设备名不能含空白/引号
    this.name = String(cfg.airplayName || 'Winkow').trim()
      .replace(/[\s"'`\\]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'Winkow';
    this.engineKind = this.engineType(engine);
    this.engineFile = engine;
    this.hidden = false;
    this.log = [];
    this.dumpOffset = 0;
    this.dumpFile = '';
    this.jpegFrames = 0;
    this.pushedFrames = 0;
    this.firstFrameAt = 0;
    this.decodeWarnings = 0;
    this.samplePath = '';
    this.video = null;
    this._aspectCandidate = null;
    this._healed = false;
    this._lastFfmpeg = '';
    this._ffmpegRepeat = 1;
    // 视频质量统计：goodFrames=解码全程无错的帧，corruptFrames=带错帧，
    // droppedFrames=被闸门拦下没推到观看端的帧（画面继续停在上一张好图上）。
    this.goodFrames = 0;
    this.corruptFrames = 0;
    this.droppedFrames = 0;
    this.corruptStart = false;
    this._errSeq = 0;
    this._frameErrSeq = 0;
    this.captureSource = null;
    this.winHwnd = 0;
    this.winRect = null;
    this.winPlaced = false;
    this._abandonedHwnd = 0;

    try {
      this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-airplay-'));
      try { fs.writeFileSync(this._diagPath(), '', 'utf8'); } catch (_) {}
    } catch (err) {
      this._fail(`无法创建临时目录：${err.message}`);
      return this.status();
    }

    // 直接双击 airplay/ 里的引擎 exe 会用 GUI 默认参数起服务：默认 autovideosink
    // 弹出独立视频窗口、且没有 -vdmp，画面永远进不了浮窗，还会占住端口。
    // 这里在写参数前先接管：结束所有不是本工具启动的 UxPlay 会话。
    const foreign = this._reapForeignEngines();
    if (foreign) {
      this._note(`[moyu] 已结束 ${foreign} 个单独启动的引擎进程（请勿双击 airplay 文件夹里的 exe，只用这里的「开始投屏」或托盘菜单）`);
    }

    const args = this._buildArgs();
    this._args = args;
    this.renderMode = this._resolveRenderMode();
    this.session = false;
    this.sessionLost = false;
    this._sessionAt = 0;
    this._restarts = [];
    if (this.engineKind === 'gui' && !this._writeArgsFile(args)) return this.status();
    this.relay.setPaused(false);
    // 引擎压根没起来（spawn 同步抛错：文件被替换、被杀软隔离、路径失效）：
    // 停在 error 态直接返回。以前这里不判断返回值，start() 会接着往下把 phase
    // 设成 running —— 界面上一直显示「等待连接」，实际什么也没跑，用户只能干等。
    if (!this._spawnUxPlay(engine, args)) return this.status();
    // vnet 通道要等引擎把端口 bind 上，VnetSource 自己带重试，先起就行
    if (this.renderMode === 'vnet') this._startVnet(cfg);
    /* 只有「窗口捕获」这条通道才需要找引擎的视频窗口。
     *
     * vnet 通道下引擎是以 `-vs fakesink` 起的，根本不创建视频窗口 —— 这段轮询
     * 永远找不到东西，却每 800ms 跑一次 desktopCapturer.getSources() + 一次
     * PowerShell 进程树枚举。实测这会让主进程每 850ms 阻塞 550~650ms，帧在
     * IPC 上成批投递（push 的 p50 间隔 0.2ms、每秒只有 23 帧），用户看到的就是
     * 「规律地一秒卡一下」。vnet 下直接不启动它。
     */
    if (this.renderMode !== 'vnet') this._startWindowWatch();
    // 引擎进程起来了就是「接收中」：这条链路不再等首帧 JPEG，画面要等手机端
    // 真正开始投屏才出现，不该让状态一直停在「正在启动」。
    this.phase = 'running';
    this._note(`[moyu] 接收器已启动：设备名 ${this.name} · PIN ${this.pin}（${this.engineKind === 'gui' ? 'GUI 引擎' : 'CLI 引擎'}）`);
    this._note(`[moyu] 画面通道：${this.renderMode === 'vnet'
      ? `引擎 -vnet 直出 H264 → 浮窗 WebCodecs 解码（端口 ${this._vnetPort()}）`
      : `引擎自解码 → 独立视频窗口 → 浮窗捕获（sink=${this.config.get().airplayVideoSink || 'd3d11videosink'}）`}`);
    this._startDiag();
    this.emit('status', this.status());
    this.onReady(); // 把浮窗切到内置中继的投屏画面
    return this.status();
  }

  /**
   * 结束所有「不是本工具启动」的 UxPlay 进程（连同子进程树）。
   * 手工双击 airplay/uxplay-windows.exe 是最高频的误操作：GUI 会用默认参数
   * 弹出独立视频窗口，且不写 -vdmp，浮窗永远没有画面，还占住 7000 端口。
   * 只匹配 UxPlay 自己的 exe，绝不碰系统的 Bonjour / mDNSResponder 服务。
   */
  _reapForeignEngines() {
    const targets = ['uxplay-cli.exe', 'uxplay-windows.exe', 'uxplay-windows-videoonly.exe', 'uxplay.exe'];
    const own = this.uxplay && this.uxplay.pid;
    let pids = [];
    try {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 6000, windowsHide: true
      });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (!m) continue;
        const pid = Number(m[2]);
        if (targets.indexOf(m[1].toLowerCase()) >= 0 && pid && pid !== own) pids.push(pid);
      }
    } catch (_) {
      return 0;
    }
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5000, windowsHide: true, stdio: 'ignore'
        });
      } catch (_) {}
    }
    return pids.length;
  }

  /**
   * 投屏音频的 GStreamer sink —— 只决定「电脑端放不放声」，改变不了 iPhone 侧的路由。
   *
   * 开：wasapi2sink，声音从电脑音箱/耳机出来。
   *     注意本机 GStreamer 只有 libgstwasapi2.dll，**没有** wasapisink。
   *     实测 -as wasapisink 会让引擎启动即崩（exit 3221226505），
   *     而 wasapi2sink / autoaudiosink 都能正常起。这是 1.0.23「电脑播放」
   *     连画面都出不来的根因。
   * 关：fakesink，音频管道照常跑（不会给 iOS 一条「看起来坏了」的通道），
   *     只是不输出到设备 —— 即「不投放声音，仅投画面」。
   */
  _audioSink(cfg) {
    return cfg && cfg.airplayCastAudio === false ? 'fakesink' : 'wasapi2sink';
  }

  /**
   * 这次会话走哪条画面通道。
   *
   * vnet 的前提是引擎肯把 H264 交出来：CLI 版引擎（argv 直传）支持 -vnet，
   * 而 GUI 版 uxplay-windows.exe **完全忽略 argv、只读 arguments.txt，且实测
   * 会把 -vs 整条丢弃**（传 `-vs filesink location=...` 时 -vs 直接消失），
   * 所以它拿不到 -vnet，只能回退旧链路。
   */
  _resolveRenderMode() {
    const cfg = this.config.get();
    if (cfg.airplayRender === 'window') return 'window';
    const engine = this.engineFile || this.findEngine();
    if (engine && this.engineType(engine) === 'gui') return 'window';
    return 'vnet';
  }

  _vnetPort(cfg) {
    const p = Number((cfg || this.config.get()).airplayVnetPort);
    return p >= 1024 && p <= 65535 ? p : 7788;
  }

  /**
   * 起 vnet 收流。帧直接往浮窗扔：这里只做转发，不缓冲 —— 缓冲会把
   * 「引擎 → 浮窗」的延迟变成可变量，而画面延迟是这条链路最不能妥协的东西。
   */
  _startVnet(cfg) {
    this._stopVnet();
    const src = new VnetSource({ port: this._vnetPort(cfg) });
    src.on('frame', (buf, ts) => this.emit('vnetFrame', buf, ts));
    src.on('stats', (s) => {
      // 每秒一行：connected / 累计帧 / 距上次收到字节 / socket 已读字节。
      // 「connected=1 但 sinceData 一路涨」说明引擎没往这条连接写；
      // 「frames 不涨而 bytesRead 在涨」说明收到的是坏帧头，流已错位。
      diag.log('vnet', `connected=${s.connected ? 1 : 0} frames=${s.frames} fps=${s.fps} kbps=${s.kbps} sinceData=${s.sinceData} bytesRead=${s.bytesRead} bad=${s.badFrames} paused=${s.paused ? 1 : 0} flowing=${s.flowing} pending=${s.pending}`);
      this.emit('vnetStats', s);
    });
    src.on('connect', () => {
      this._note('[moyu] vnet 通道已连上引擎（H264 直通建立）');
      this.emit('status', this.status());
    });
    src.on('disconnect', () => {
      this._note('[moyu] vnet 通道断开，正在自动重连');
      this.emit('status', this.status());
    });
    this.vnet = src;
    src.start();
  }

  _stopVnet() {
    if (!this.vnet) return;
    try { this.vnet.stop(); } catch (_) {}
    this.vnet = null;
  }

  _buildArgs() {
    const cfg = this.config.get();
    // -nh  = 设备名后不加 "@主机名"
    // -nohold = 有新客户端连入时直接顶掉旧连接。默认行为是回 409
    //   "Conflict: Server is connected to another client" —— 断线后再点
    //   「屏幕镜像」如果上一条连接还没被回收，就会被这条规则挡在门外。
    const args = ['-n', this.name, '-nh', '-nohold'];

    // 免 PIN 模式不带 -pin：客户端会走「不做配对」的路径（另一条密钥协商），
    // 用于排查另一种兼容性问题。默认仍走带 PIN 的正常配对。
    if (!cfg.airplayNoPin) args.push('-pin', this.pin);
    // 画面通道决定 -vs：
    //   vnet   -> 0（= 引擎干脆不建视频渲染管线），H264 直接从 -vnet 端口出来
    //   window -> 旧链路，引擎解码到自己那扇窗口，浮窗再捕获它
    const render = this._resolveRenderMode();
    const videoArgs = render === 'vnet'
      ? ['-vs', '0', '-vnet', String(this._vnetPort(cfg))]
      : ['-vs', String(cfg.airplayVideoSink || 'd3d11videosink')];

    args.push(
      '-p', String(cfg.airplayBasePort),
      '-s', String(cfg.airplayResolution || '720x1560'),
      '-fps', String(cfg.airplayFps),
      // 引擎侧的画面去向。vnet 通道传 0 而不是 fakesink：fakesink 仍然要把
      // 每一帧喂进 GStreamer（appsrc → 解码 → 按 PTS 同步的 sink），那条管线
      // 跟我们的收流毫无关系，却是引擎里唯一可能反压 AirPlay 接收线程的地方。
      // 传 0 之后 use_video=false，video_process 里只剩 wink_vnet_emit（纯
      // 内存拷贝 + 非阻塞 send），链路短到没有可堵的环节。解码由浮窗的
      // WebCodecs 做，本来也不需要引擎再解一遍。
      ...videoArgs,
      '-as', this._audioSink(cfg),
      // 引擎默认「15 秒收不到客户端数据就重置会话」(-reset 15)。iPhone 静置 /
      // 自动锁定后心跳会停，接收端会自己把已经建立好的镜像踢掉 —— 用户看到的
      // 就是「放着不动过一会儿就断」。0 = 永不因静默重置；真断开仍由 TEARDOWN /
      // socket closed 判定，新客户端连入靠 -nohold 顶掉旧会话。
      '-reset', '0'
    );
    if (cfg.airplayTrace) args.push('-d', '1');   // RTSP 明细，只在排查时开
    return args;
  }

  /** dump 候选目录：精确路径优先，其余用于兜底 GUI 把 cwd 改到别处的情况。 */
  _dumpCandidates() {
    const dirs = [this.tmpDir];
    const engine = this.findEngine();
    if (engine) dirs.push(path.dirname(engine));
    const appdata = process.env.APPDATA || '';
    if (appdata) dirs.push(path.join(appdata, 'leapbtw', 'uxplay-windows'));
    if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR);
    return [...new Set(dirs.filter(Boolean))];
  }

  _argsPath() {
    return path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
  }

  /** 2.x GUI 引擎从固定路径读参数；备份原文件，停止时恢复，不留下系统改动。 */
  _writeArgsFile(args) {
    const machine = path.join(process.env.ProgramData || 'C:\\ProgramData', 'uxplay-windows', 'arguments.txt');
    if (exists(machine)) {
      this._fail(`检测到机器级参数文件 ${machine}，它会覆盖本工具的设置。请临时移除该文件再试。`);
      return false;
    }
    this.argsFile = this._argsPath();
    try {
      this.argsBackup = exists(this.argsFile) ? fs.readFileSync(this.argsFile) : null;
      fs.mkdirSync(path.dirname(this.argsFile), { recursive: true });
      // 引擎用 QProcess::splitCommand 解析；这里所有参数都不含空格
      fs.writeFileSync(this.argsFile, args.join(' '), 'utf8');
      return true;
    } catch (err) {
      this._fail(`无法写入引擎参数：${err.message}`);
      return false;
    }
  }

  _restoreArgsFile() {
    if (!this.argsFile) return;
    try {
      if (this.argsBackup === null) fs.unlinkSync(this.argsFile);
      else fs.writeFileSync(this.argsFile, this.argsBackup);
    } catch (_) {}
    this.argsFile = '';
    this.argsBackup = null;
  }

  /**
   * 引擎进程的环境变量。
   *
   * CLI 引擎是自己编译的裸 uxplay，不带 GUI 版那层启动器，所以有两件事必须由
   * 调用方补上：
   *
   *  1. **GST_PLUGIN_PATH**。GStreamer 按 `libgstreamer-1.0-0.dll` 所在目录往上
   *     推 `../lib/gstreamer-1.0`，而发行包把 DLL 平铺在 airplay/ 里，推出来的
   *     是 moyu-float/lib/gstreamer-1.0 —— 不存在。不显式指路就一个插件都扫不到，
   *     启动直接死在 check_plugins()（缺 app/playback/autodetect/videoparsersbad）。
   *  2. **GST_REGISTRY 到临时目录**。默认注册表缓存在 %LOCALAPPDATA%，而
   *     gst_registry_find_plugin() 命中缓存时不校验 DLL 是否还在。开发机上那份
   *     缓存记的是 msys2 的插件，会让人误以为发行包自带的插件够用。用会话专属的
   *     注册表，等于每次启动都真扫一遍，也让多用户/便携场景不受脏缓存影响。
   *
   * GUI 引擎（uxplay-windows.exe）自己会设好这些，别去动它的环境。
   */
  _engineEnv(engine) {
    const env = Object.assign({}, process.env);
    if (this.engineKind === 'gui') return env;

    const dir = path.dirname(engine);
    const plugins = path.join(dir, 'lib', 'gstreamer-1.0');
    // 注意：不能用上面的 exists()，它要求 isFile()，目录永远返回 false。
    if (fs.existsSync(plugins)) {
      // 半角分号是 Windows 的列表分隔符；GST 会把两个变量合起来当搜索路径
      env.GST_PLUGIN_PATH = plugins;
      env.GST_PLUGIN_SYSTEM_PATH = plugins;
    }
    // 用会话临时目录里的注册表，避免继承开发机上的脏缓存
    if (this.tmpDir) env.GST_REGISTRY = path.join(this.tmpDir, 'gst-registry.bin');
    // DLL 就在 exe 旁边：Windows 本来就会先搜应用目录，这里再显式加上，
    // 免得某些精简过的 PATH 让 libwinpthread / libstdc++ 找不到
    env.PATH = dir + ';' + (env.PATH || '');
    return env;
  }

  _spawnUxPlay(engine, args) {
    const spawnArgs = this.engineKind === 'gui' ? [] : args;
    let child = null;
    try {
      child = spawn(engine, spawnArgs, {
        cwd: this.tmpDir,
        env: this._engineEnv(engine),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      this._fail(`引擎启动失败：${err.message}`);
      return false;
    }
    this.uxplay = child;
    // 引擎的音频是独立进程直接输出到 WASAPI 的，静音按钮要靠 Windows 音量
    // 合成器里那条 per-session 会话才能管到它。进程一起来就登记目标状态，
    // 之后由 engine-audio 持续确认（音频会话要等 iPhone 连上才注册）。
    setEngineActive(true);
    setCastAudio(this.config.get().airplayCastAudio !== false);
    applyEngineMute(this.config.get().muted, { force: true });
    const collect = (chunk) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      // 会话起止必须看**全部**行：只取最后 3 行会漏掉夹在中间的会话事件
      lines.forEach((l) => this._watchSessionLine(l));
      // 排查期：引擎每一行都落进 winkow-diag.log。`[vnet] client connected /
      // dropped` 是判断「引擎有没有把帧发出来」的唯一直接证据，以前被
      // keep.slice(-3) 冲掉了，现场只剩一句「5 秒没收到帧」，等于没证据。
      lines.forEach((l) => diag.log('engine', l.slice(0, 300)));
      const keep = lines.filter((l) => ENGINE_LOG_KEEP_RE.test(l));
      keep.slice(-3).forEach((l) => this._note(`[uxplay] ${l.slice(0, 200)}`));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      if (this.uxplay === child) this._fail(`引擎无法运行：${err.message}`);
    });
    child.on('close', (code) => {
      // 自动重启 / 主动停止都会先把 this.uxplay 置空再 kill：
      // 不判断的话，旧进程的 close 会把新进程的引用抹掉，还会误报「已退出」。
      if (this.uxplay !== child) return;
      this.uxplay = null;
      if (this.phase !== 'starting' && this.phase !== 'running') return;
      this._stopBridge();
      // 引擎自己退了（端口被占 / 被杀软结束 / 崩溃）：先试着自动拉起来，
      // 连不上再报错，别让用户面对一个「code 1」发呆。
      if (this._scheduleRestart()) {
        this._note(`[moyu] 接收器进程意外退出（code ${code}），正在自动重启`);
        this.emit('status', this.status());
      } else {
        this._fail(`引擎已退出（code ${code}）。检查 Windows 防火墙是否允许它访问网络。`);
      }
    });
    return true;
  }

  // ---- 会话存活：手机还连着吗 ----

  /**
   * 从引擎日志读会话起止。
   *
   * 「镜像窗口在不在」不能当判据：uxplay 断线后不会清理那扇窗口，留着它就
   * 等于留一张冻住的遗照 —— 浮窗既不回 PIN 卡，也因为「窗口还在」而不去找
   * 新窗口，表现就是「连过，但重新打开什么都不动」。
   */
  _watchSessionLine(line) {
    if (/raop_rtp_mirror starting mirroring/i.test(line)) {
      this._onSessionStart();
      return;
    }
    if (!this.session) return;   // 会话没建立时那些 closed 只是 mDNS / 握手噪音
    if (/raop_rtp_mirror->running is no longer true|tcp socket was closed by client|raop_rtp_mirror error in/i.test(line)) {
      this._onSessionEnd(line);
    }
  }

  _onSessionStart() {
    this.session = true;
    this.sessionLost = false;
    this._sessionAt = Date.now();
    // 新一轮镜像会新建一条 WASAPI 音频会话：默认静音必须在这时真正落到它上面。
    // 旧版只等引擎启动那 6 秒，手机晚一点连上就永远静不掉（要手动点一下静音）。
    setSessionActive(true);
    setCastAudio(this.config.get().airplayCastAudio !== false);
    applyEngineMute(this.config.get().muted, { force: true });
    this._abandonedHwnd = 0;     // 新一轮会话：之前放弃的窗口不再排除
    this._cancelRespawn();       // 手机自己连回来了，不必重启
    this._cancelDrop();          // 冻结画面还没丢掉，正好接上
    // 手机刚开始投屏时，新的视频窗口马上就要出现：GStreamer 把它建在默认级联
    // 位置（屏幕右下角），晚一拍探测它就多亮一拍。立刻探测一拍，别等 800ms。
    // vnet 通道例外：没有窗口可找，这一拍纯属 400ms 的主进程停顿（还会把
    // 刚连上的 vnet 收流卡到引擎的 stall 上限）。
    if (this.renderMode !== 'vnet') {
      this._suppressProbeUntil = 0;
      this._winTick = 2;           // 下一拍 3 % 3 === 0：已绑定时也会立刻复核
      this._windowTick().catch(() => {});
    }
    this.emit('session', { active: true });
  }

  _onSessionEnd(line) {
    if (!this.session) return;
    this.session = false;
    this.sessionLost = true;
    setSessionActive(false);
    const live = this._sessionAt ? Math.round((Date.now() - this._sessionAt) / 1000) : 0;
    this._note(`[moyu] 手机端已结束投屏会话（持续 ${live} 秒）`);
    this.emit('session', { active: false, seconds: live, line: String(line || '').slice(0, 120) });
    // 先别急着丢窗口：引擎断线后本来就不会关掉镜像窗口，画面停在
    // 最后一帧。这 6 秒里浮窗仍然显示那幅画面，用户看不到黑屏或 PIN 卡 ——
    // 在 iPhone 上点一下「屏幕镜像」就能接上，比「先变回 PIN 卡再说」自然得多。
    this._scheduleDrop(6000);
    // 重启也要往后压：以前 1.5 秒就重启，engine 一退一进，mDNS 里的设备要
    // 消失一两秒 —— 用户这时正好去点「屏幕镜像」，反而找不到本机，看起来
    // 就是「断了以后再也连不上」。引擎本身没坏，留着它就能被秒连；
    // 真没人回来再重启清理状态。
    if (this._scheduleRestart(18000)) {
      this._note('[moyu] 接收器保持在线，随时可以重新镜像；18 秒内没人回来再自动重启');
    }
    this.emit('status', this.status());
  }

  _scheduleDrop(ms) {
    this._cancelDrop();
    this._dropTimer = setTimeout(() => {
      this._dropTimer = null;
      this._dropWindow(0);
    }, ms);
    if (this._dropTimer.unref) this._dropTimer.unref();
  }

  _cancelDrop() {
    clearTimeout(this._dropTimer);
    this._dropTimer = null;
  }


  /**
   * 放弃当前绑定的窗口。断线后必须丢：引擎不会自己关掉镜像窗口。
   */
  _dropWindow(suppressMs) {
    // 引擎断线后不会自己关掉这扇窗口。以前只清绑定，结果它带着最后一帧一直
    // 晾在桌面：浮窗一挪开 / 一收起，就露出「uxplay 的画面还留在屏幕上」的
    // bug（收起时句柄已被清空，setWindowVisible 静默失效）。我们已经不再
    // 捕获它了，趁句柄还在先把它藏掉 —— 冻帧无所谓，谁也看不见它。
    this.setWindowVisible(false);
    // 记下这扇被放弃的窗口：引擎断线后不关它，探测时必须跳过，否则会重新绑上
    // 一张冻住的画面，界面显示「已连接」但画面永远不动。
    this._abandonedHwnd = Number(this.winHwnd || (this.captureSource && this.captureSource.hwnd) || 0);
    this.captureSource = null;
    this.winHwnd = 0;
    this.winRect = null;
    this.winPlaced = false;
    this._winScore = 0;
    this._winTries = 0;
    this._winTick = 0;
    if (suppressMs) this._suppressProbeUntil = Date.now() + suppressMs;
    this.emit('window', { ready: false, id: '', name: '' });
  }

  _cancelRespawn() {
    clearTimeout(this._respawnTimer);
    this._respawnTimer = null;
  }

  /**
   * 断线后自动重启接收器（airplayReconnect，默认开）。
   *
   * 为什么不是「什么都不做，等手机自己重连」：这套引擎断线后既不清理镜像窗口，
   * 也不重置解码管线，重连上来常常还是旧那一帧；重启一次进程能让广播、端口、
   * 管线全部回到干净状态，iPhone 也更容易重新发现本机。设备名与 PIN 不变，
   * 所以不需要重新配对。
   *
   * 限流：10 分钟内最多 4 次。手机端反复试（比如刚连上就断）时，无限重启只会
   * 让「刚发现设备就消失」的循环一直持续。
   */
  _scheduleRestart(delayMs) {
    if (this.config.get().airplayReconnect === false) return false;
    if (this.phase !== 'running' && this.phase !== 'starting') return false;
    if (this._respawning) return true;
    if (this._respawnTimer) return true;
    const now = Date.now();
    this._restarts = (this._restarts || []).filter((t) => now - t < 10 * 60 * 1000);
    if (this._restarts.length >= 4) {
      this._note('[moyu] 10 分钟内已自动重启 4 次，先保持待命不再重启：需要时在手机上重新选择「屏幕镜像」');
      return false;
    }
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      this._respawn().catch(() => {});
    }, typeof delayMs === 'number' ? delayMs : 1500);
    if (this._respawnTimer.unref) this._respawnTimer.unref();
    return true;
  }

  async _respawn(force) {
    if (this._respawning) return;
    if (this.phase !== 'running' && this.phase !== 'starting') return;
    /* 平时会话还在就别动它：手机可能刚又连上了，重启等于把好的会话踢掉。
     *
     * 但 force 这条路径的前提正好相反 —— 会话在、画面却一帧都没有（零帧看门狗
     * 只在 session 存活时才会触发）。旧代码在这里无差别 return，等于那个
     * 「10 秒自动重启」从来没执行过：日志里提示打了，引擎纹丝不动，用户只能
     * 自己退出 Winkow。 */
    if (this.session && !force) return;
    if (force) {
      // 画面已经死了，这个会话只会挡路：先标记失效，重启完等手机建新会话
      this.session = false;
      this.sessionLost = true;
    }
    const engine = this.findEngine();
    if (!engine) { this._fail('未找到 AirPlay 引擎'); return; }
    this._respawning = true;
    try {
      this._restarts = (this._restarts || []).concat(Date.now());
      this._dropWindow(0);
      const child = this.uxplay;
      this.uxplay = null;
      if (child) {
        try { child.kill(); } catch (_) {}
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            timeout: 5000, windowsHide: true, stdio: 'ignore'
          });
        } catch (_) {}
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.phase !== 'running' && this.phase !== 'starting') return;
      const args = this._args || this._buildArgs();
      this._args = args;
      this.engineKind = this.engineType(engine);
      this.engineFile = engine;
      // 参数文件写不进去（机器级 arguments.txt 之类）时 _writeArgsFile 已经报了错，
      // 这时不要再拉起一个用默认参数的引擎，否则会弹出独立的视频窗口。
      if (this.engineKind === 'gui' && !this._writeArgsFile(args)) return;
      this._note(`[moyu] 接收器已自动重启（第 ${this._restarts.length} 次）：设备名 ${this.name} · PIN ${this.pin}，手机重新镜像即可连回`);
      if (!this._spawnUxPlay(engine, args)) return;
      this._suppressProbeUntil = Date.now() + 800;
      // 注意：这条重启路径以前是无条件 _startWindowWatch() 的，等于把 start()
      // 里那个「vnet 下不许开窗口轮询」的守卫绕过去了。实测一次引擎重启就能
      // 让 1Hz 的 PowerShell 枚举（每次钉住主进程 550~650ms）永久回来，把
      // vnet 的收流反复打断 —— 表现为「投一会儿就黑，手机还连着」。
      if (this.renderMode !== 'vnet') this._startWindowWatch();
      this._startDiag();
      this.emit('status', this.status());
    } finally {
      this._respawning = false;
    }
  }

  /**
   * 浮窗重新出现时调用：只确认「引擎窗口可见 + 捕获流还在跑」，**绝不重建**。
   *
   * 实机探针（probe-capture-visibility.js，动态变色窗口 + 全程一条流）：
   *   显示 → SW_HIDE（冻帧）→ 再显示，同一条 WGC 流会自己续上实时帧；
   *   屏外停放同样冻帧。所以 SW_HIDE 依然是隐藏时防泄漏的正确做法，而
   *   「隐藏时 stopCapture + 显示时 restart」纯属多余，还引入两条异步消息
   *   互相打断（startCapture 被 capStarting 挡掉、旧流又被 capSeq 判过期），
   *   正是 1.0.25 里「收起再打开就没画面」的根因。
   *
   * restart 固定为 false：渲染层看到已有流就什么都不做；只有「隐藏期间窗口
   * 才出现、还没建过流」这种边缘情况才会补建一条。
   */
  rearm(reason) {
    if (this.phase !== 'running' && this.phase !== 'starting') return this.status();
    /* vnet 通道没有「引擎窗口」这个概念，这里什么都不用做 —— 直接返回。
     *
     * 早先这里会掉到下面的 else 分支去「补找一次窗口」：一次 `_probeVideoWindow`
     * 要起 PowerShell 走进程树 + desktopCapturer，主进程被钉住 400ms 以上。
     * 而 vnet 的 socket 一停读，引擎那边的 send 就会在 1s 后放弃并关掉连接
     * （见 uxplay.cpp `wink_vnet_send_all` 的 stall 上限）。于是「浮窗刚唤出」
     * 这一拍恰好把正在看的那条流打断：画面没了，手机上还显示正在投屏。
     */
    if (this.renderMode === 'vnet') return this.status();
    const src = this.captureSource;
    if (src) {
      this.emit('window', {
        id: src.id, hwnd: src.hwnd, name: src.name, source: src.source, restart: false
      });
      if (reason) this._note(`[moyu] 浮窗已显示（${reason}）：捕获流保持连接，画面自动续上`);
    } else if (!this._probing) {
      this._suppressProbeUntil = 0;
      this._windowTick().catch(() => {});
    }
    return this.status();
  }

/**
 * H264 dump -> 归一化 -> ffmpeg stdin -> JPEG -> 本机中继。
 * ffmpeg 用 pipe:0 收裸流，不会因「文件读到结尾」提前退出；
 * 增量 tailer 每 40ms 把新增字节推进去，慢客户端时主动丢帧保持低延迟。
 */
  /**
   * 坏关键帧自动重连（airplayAutoHeal，默认开，每次投屏最多触发一次）。
   *
   * 依据：AirPlay 镜像整场往往只有会话开头一个 IDR 关键帧，且所有 P 帧都参考它。
   * 实测样本（%TEMP%\moyu-airplay-sample.h264，752KB / 339 NAL / 仅 1 IDR）里
   * 这个 IDR 从第 13 个宏块起就解不动 —— 整场绿屏且永远不会自愈，因为后续
   * P 帧「参考坏帧」本身并不报错。开局短时间就积起大量解码告警，只能说明
   * 关键帧坏了：此时唯一的出路是换一个关键帧，也就是重启接收端让发送端重连。
   * 触发条件收得很紧（开局 150 帧内 ≥25 条告警），正常的偶发无线抖动
   * （几十帧里 1-2 条）不会命中。
   */
  _checkAutoHeal() {
    if (this._healed || this.phase !== 'running') return;
    if (!this.config.get().airplayAutoHeal) return;
    // 开局若干帧一个都没解干净：关键帧从传输阶段就坏了，等下去只会一直花屏
    if (isCorruptStart({ frames: this.jpegFrames, warnings: this.decodeWarnings, goodFrames: this.goodFrames })) {
      this._healed = true;
      this.corruptStart = true;
      this._note(`[moyu] 开局 ${this.jpegFrames} 帧全部解码失败（${this.decodeWarnings} 条告警）：关键帧在传输中已损坏，自动重启接收器，请在手机上重新选择「屏幕镜像」`);
      this.emit('heal', { reason: 'corrupt-start' });
      return;
    }
    if (this.decodeWarnings < 25 || this.jpegFrames > 150) return;
    this._healed = true;
    this._note(`[moyu] 开局 ${this.jpegFrames} 帧内出现 ${this.decodeWarnings} 条解码告警：关键帧损坏，自动重启接收器（请在手机上重新投屏，如未自动重连）`);
    this.emit('heal', { reason: 'warnings' });
  }

  // ---- 视频窗口：定位 / 捕获 ----

  /**
   * 轮询寻找引擎自己弹出的视频窗口。
   *
   * 窗口由 GStreamer 的 d3d11videosink 在开始投屏时创建，标题是
   * "Direct3D11 renderer"。找不到不是错误：手机还没点「屏幕镜像」时它本来就不存在。
   */
  _startWindowWatch() {
    this._stopWindowWatch();
    this._winTries = 0;
    this._winTick = 0;
    this._winNagged = false;
    // 回调里返回的是 Promise：不接住的话，任何一次异常都会变成未处理的
    // rejection，而 Node 20+ 默认会直接终止进程 —— 投屏中途「程序自己退了」
    // 比画面黑更难排查，所以这里必须吞掉。
    this.winTimer = setInterval(() => { this._windowTick().catch(() => {}); }, 800);
    if (this.winTimer.unref) this.winTimer.unref();
  }

  /**
   * 轮询一拍：找窗口 / 复核已绑定的窗口。
   *
   * 抽成独立方法而不是写死在 setInterval 里，是为了能一拍一拍直接驱动它做回归
   * 测试：「后出现的真视频窗口能切过去」这种事只能这样验。
   */
  async _windowTick() {
    if (this.phase !== 'starting' && this.phase !== 'running') return;
    // 断线重启前后几秒不探测：这时旧窗口还在，探到了会把刚丢掉的「遗照」绑回来
    if (Date.now() < (this._suppressProbeUntil || 0)) return;
    this._winTick = (this._winTick || 0) + 1;
    // 绑定之后不能一停了之：引擎的真视频窗口常常比进程树里那些杂项窗口
    // （PyInstaller 引导窗口之类）出现得晚，停了就永远钉在错的那扇上——黑屏。
    // 所以降频复核，每 3 拍（约 2.4s）看一眼有没有更像视频窗口的新候选。
    if (this.captureSource) {
      if (this._winTick % 3 !== 0) return;
    } else {
      this._winTries = (this._winTries || 0) + 1;
    }
    // 枚举一次要 1s 上下（起 PowerShell + 走进程树），比轮询间隔还长。
    // 不加锁的话回调会叠起来，越积越多，最后同时开一堆 PowerShell。
    if (this._probing) return;
    this._probing = true;
    let found = null;
    try {
      found = await this._probeVideoWindow();
    } finally {
      this._probing = false;
    }
    const tries = this._winTries || 0;
    if (!found) {
      // 找不到就留证：把「引擎进程 / 进程内窗口 / 可捕获源」三段实际数量写进
      // 日志。之前这里全静默，用户只能看到「等待」，没法判断断在哪一环。
      if (tries === 3 || tries === 10 || (tries > 0 && tries % 30 === 0)) {
        const p = this._lastProbe || {};
        const rows = p.rows || [];
        const srcs = p.sources || [];
        this._note(
          `[moyu] 找视频窗口第 ${tries} 次未命中：引擎 pid=${p.pid || '（未运行）'}`
          + ` · 进程内顶层窗口 ${rows.length} 扇 · 可捕获窗口 ${srcs.length} 个`
          + (p.srcErr ? ` · 捕获源报错：${p.srcErr}` : '')
          + (rows.length
            ? ` │ ${rows.slice(0, 4).map((r) => `${r.w}x${r.h}${r.visible ? '' : '(隐藏)'}「${r.title || r.cls}」`).join(' ')}`
            : '')
        );
      }
      if (!this._winNagged && tries >= 15) {
        this._winNagged = true;
        this._note('[moyu] 还没出现视频窗口：若手机已点「屏幕镜像」并输入 PIN，请把上面那条「找视频窗口未命中」发给我');
      }
      return;
    }
    // 手机还没开始镜像时，引擎根本不会创建视频窗口；这时任何「按名字猜」出来的
    // 低分候选都是别的程序（实测把资源管理器窗口绑进来过）。只放行明确带渲染器
    // 特征的窗口，其余一律等会话真正建立。
    if (!this.session && !this.captureSource && Number(found.score) < 55) return;
    // DesktopCapturerSource 只能留在主进程给 setDisplayMediaRequestHandler 用；
    // status() 里只带 name，不往外传对象。
    // 列表里没有这扇窗口时（个别系统/驱动下外部窗口也会漏），按 HWND 合成一个
    // 只有 id 的 source —— setDisplayMediaRequestHandler 只认 id，能绑上。
    const source = found.source || (found.hwnd
      ? { id: `window:${found.hwnd}:0`, name: found.name || 'Direct3D11 renderer' }
      : null);
    if (!source) return;
    const score = Number(found.score) || 0;
    if (this.captureSource) {
      // 已经绑着某扇窗口：换不换得看「新候选是不是明显更像视频窗口」。
      // 同分不折腾，否则每轮都会重开一条捕获流，画面反而抖。
      if (this.captureSource.hwnd && found.hwnd === this.captureSource.hwnd) return;
      if (score <= (this._winScore || 0) + 10) return;
      this._note(`[moyu] 发现更像视频窗口的一扇「${found.name || '未命名'}」（${score} > ${this._winScore || 0}），切换捕获目标`);
    }
    this._winScore = score;
    this.captureSource = { id: source.id, name: String(found.name || ''), hwnd: found.hwnd || 0, source };
    this.winHwnd = found.hwnd || 0;
    // 新窗口还没被搬动：清掉上一次的画面尺寸，等渲染层报回这一扇的自然尺寸
    // （手机旋转会走到这里，比例因此能跟着更新）
    this.winPlaced = false;
    this.video = null;
    this._aspectCandidate = null;
    this._note(`[moyu] 已找到视频窗口「${this.captureSource.name}」，浮窗改用窗口捕获显示`);
    this.emit('window', {
      id: this.captureSource.id,
      hwnd: this.captureSource.hwnd,
      name: this.captureSource.name,
      source
    });
  }

  _stopWindowWatch() {
    clearInterval(this.winTimer);
    this.winTimer = null;
    this.captureSource = null;
    this.winHwnd = 0;
    this.winRect = null;
    this.winPlaced = false;
    this._lastProbe = null;
    this._probing = false;
    this._winScore = 0;
  }

  /**
   * 重新找一扇视频窗口。
   *
   * 手机旋转会让引擎销毁旧窗口、按新尺寸重建一扇，旧捕获流随之 ended
   * （桌面捕获的 item 已经不存在了）。此时必须重新枚举，不能复用旧 source。
   */
  reprobeWindow() {
    if (this.phase !== 'running' && this.phase !== 'starting') return;
    if (this.renderMode === 'vnet') return;  // vnet 没有窗口可找
    this._stopWindowWatch();
    this._note('[moyu] 捕获流已断开，重新寻找视频窗口（手机旋转 / 引擎重建窗口）');
    this._startWindowWatch();
  }

  /**
   * 枚举参数：进程名只是「猜引擎怎么给自己命名」，PID 才是事实 —— 引擎是我们
   * 自己 spawn 的，pid 一定准。两条都传，任一条命中就能拿到窗口。
   */
  _listArgs() {
    const args = ['-Action', 'list', '-ProcName', this._procName()];
    const pid = this.uxplay && this.uxplay.pid;
    if (pid) args.push('-OwnerPids', String(pid));
    return args;
  }

  /** 列出引擎进程的所有顶层窗口（同步，仅用于低频的 placeWindow）。 */
  _listWindows() {
    const list = this._ps(this._listArgs());
    if (!list) return [];
    const rows = Array.isArray(list) ? list : [list];
    return rows.filter((r) => r && r.hwnd);
  }

  /** 异步版：轮询必须用它，同步 execFileSync 每次要占住主进程 700ms 以上。 */
  async _listWindowsAsync() {
    const list = await this._runHostOr('list', this._listArgs());
    if (!list) return [];
    const rows = Array.isArray(list) ? list : [list];
    return rows.filter((r) => r && r.hwnd);
  }

  /**
   * 找引擎的视频窗口，返回 { source, hwnd, name }。
   *
   * 按「可靠度」排四条路：
   *   1. 标题带渲染器特征（"Direct3D11 renderer"）—— 最省事，直接可用。
   *   2. 按 PID 枚举进程内所有顶层窗口，再按 source id 的 `window:<hwnd>:<n>`
   *      前缀精确绑定。**标题被改掉时靠这条**。
   *   3. 引擎把窗口标题改成了设备名时按设备名匹配捕获源。
   *   4. 标题里带 uxplay 的兜底。
   *
   * 为什么不要求窗口 visible：d3d11videosink 在拿到第一帧之前窗口可能还是隐藏
   * 的，早期版本用 `visible` 过滤会把刚建好的窗口直接丢回空数组，于是永远
   * 「等待视频窗口」。现在只要求尺寸有效，显示由 place 的 SWP_SHOWWINDOW 负责。
   */
  async _probeVideoWindow() {
    let sources = [];
    let srcErr = '';
    try {
      sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      });
    } catch (err) {
      srcErr = String((err && err.message) || err);
    }
    // 噪音窗口 / 断线后放弃的那扇「冻住的遗照」在捕获源列表里也要剔掉。
    const skip = Number(this._abandonedHwnd || 0);
    const clean = sources.filter((s) => !NOISE_WINDOW_RE.test(String(s.name || ''))
      && (!skip || hwndOfSource(s) !== skip));
    const names = clean.map((s) => String(s.name || '')).filter(Boolean);
    const devName = this.name || '';

    // 1) 捕获源里直接认出渲染器（标题明确，最省事；不额外枚举进程）
    const byClass = clean.find((s) => /direct3d|gstreamer/i.test(String(s.name || '')));
    if (byClass) {
      return {
        source: byClass, hwnd: hwndOfSource(byClass),
        name: String(byClass.name || ''), score: 60
      };
    }

    // 2) 按 PID（含进程树）枚举引擎自己的顶层窗口。这一步同时是「归属证明」：
    //    后面所有兜底候选都必须出现在这份列表里。1.0.24 的实机现场是手机还没投
    //    时，全系统捕获源里有一扇「MoyuFloat-...- 文件资源管理器」文件夹窗口，
    //    被按设备名模糊匹配当成视频窗口绑走、还搬到了浮窗背后。
    const rows = (await this._listWindowsAsync())
      .filter((r) => r && !r.iconic && r.w > 0 && r.h > 0 && (!skip || r.hwnd !== skip));
    const own = new Set(rows.map((r) => Number(r.hwnd)));
    const ownSources = clean.filter((s) => own.has(hwndOfSource(s)));
    const ranked = rows
      .map((r) => ({ row: r, score: scoreWindow(r, devName) }))
      .filter((x) => x.score >= MIN_WINDOW_SCORE)
      .sort((a, b) => b.score - a.score);

    if (ranked.length) {
      const best = ranked[0].row;
      const hit = ownSources.find((s) => String(s.id || '').startsWith(`window:${best.hwnd}:`));
      if (hit) {
        return { source: hit, hwnd: best.hwnd, name: String(hit.name || best.title || ''), score: ranked[0].score };
      }
      // 捕获源列表里没有它：按 hwnd 自己拼 id（setDisplayMediaRequestHandler 只认 id）
      return { source: null, hwnd: best.hwnd, name: String(best.title || ''), score: ranked[0].score };
    }

    // 3/4) 低置信度兜底：只在「手机确实已经开始镜像」时启用，且候选必须属于
    //      引擎进程树。没会话时绝不按名字去全系统捕获源里猜窗口。
    if (this.session && ownSources.length) {
      const devRe = devName ? new RegExp(escapeRe(devName), 'i') : null;
      const byDevice = devRe ? ownSources.find((s) => devRe.test(String(s.name || ''))) : null;
      if (byDevice) {
        return { source: byDevice, hwnd: hwndOfSource(byDevice), name: String(byDevice.name || ''), score: 40 };
      }
      const loose = ownSources.find((s) => /uxplay/i.test(String(s.name || '')));
      if (loose) {
        return { source: loose, hwnd: hwndOfSource(loose), name: String(loose.name || ''), score: 10 };
      }
    }

    // 都没命中：把现场留下，用户复现时日志能直接看出断在哪一环，不用再猜。
    this._lastProbe = {
      pid: (this.uxplay && this.uxplay.pid) || 0,
      rows: rows.map((r) => ({
        hwnd: r.hwnd, title: String(r.title || ''), cls: String(r.cls || ''),
        w: r.w, h: r.h, visible: !!r.visible, score: scoreWindow(r, devName)
      })).slice(0, 10),
      sources: names.slice(0, 10),
      srcErr
    };
    return null;
  }

  /** 内嵌的 PowerShell 脚本先落到临时文件再执行：asar 里的 .ps1 无法被 powershell 直接读。 */
  _psScript() {
    if (this._psPath) return this._psPath;
    try {
      const src = fs.readFileSync(path.join(__dirname, 'win-window.ps1'), 'utf8');
      const out = path.join(os.tmpdir(), 'moyu-win-window.ps1');
      // powershell.exe 按 ANSI 读没有 BOM 的脚本：文件里一旦出现非 ASCII 字节，
      // 中文注释会被误解码并连带吃掉后面的代码（曾导致 $hwnd 赋值失效、整个
      // place 静默不生效）。脚本本身已保持纯 ASCII，这里再补一个 BOM 兜底。
      fs.writeFileSync(out, src.charCodeAt(0) === 0xfeff ? src : `\ufeff${src}`, 'utf8');
      this._psPath = out;
      return out;
    } catch (_) { return ''; }
  }

  _ps(args) {
    const script = this._psScript();
    if (!script) return null;
    try {
      const out = execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args
      ], { encoding: 'utf8', timeout: 9000, windowsHide: true });
      const text = String(out || '').trim();
      if (!text) return null;
      return JSON.parse(text);
    } catch (err) {
      this._psFails = (this._psFails || 0) + 1;
      if (this._psFails === 1) this._note(`[moyu] 窗口枚举失败：${String((err && err.message) || err).slice(0, 160)}`);
      return null;
    }
  }

  /**
   * 异步执行同一套脚本。
   *
   * 轮询里必须用它：execFileSync 每次要 700ms 上下，而轮询间隔只有 800ms，
   * 等于主进程一半时间被钉住 —— 界面会明显发滞，窗口搬运也会排队。
   */
  _psAsync(args) {
    const script = this._psScript();
    if (!script) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args
      ], { encoding: 'utf8', timeout: 9000, windowsHide: true }, (err, stdout) => {
        if (err) {
          this._psFails = (this._psFails || 0) + 1;
          if (this._psFails === 1) this._note(`[moyu] 窗口枚举失败：${String((err && err.message) || err).slice(0, 160)}`);
          return resolve(null);
        }
        const text = String(stdout || '').trim();
        if (!text) return resolve(null);
        try { resolve(JSON.parse(text)); } catch (_) { resolve(null); }
      });
    });
  }

  _procName() {
    if (this.engineKind !== 'gui') return 'uxplay';
    // 「只收画面」用的是 uxplay-windows-videoonly.exe，进程名跟着变，
    // 枚举窗口时必须用它自己的名字，否则一个窗口都找不到。
    const base = this.engineFile ? path.basename(this.engineFile) : 'uxplay-windows.exe';
    return base.replace(/\.exe$/i, '');
  }

  /**
   * 常驻 PowerShell 宿主：拉起 / 复用 / 应答分发。
   *
   * 引擎的 pid 变了（自动重启）就重拉一个：宿主枚举窗口靠 -OwnerPids 圈定
   * 进程树，钉着旧 pid 的宿主什么都看不到。请求排队上限 8 条：拖动时上层
   * 可能高频发指令，宿主消化不过来时丢掉新的（旧指令很快就让窗口到位了），
   * 绝不能让队列无限增长把内存吃穿。单条超时就整个作废重拉，卡死的宿主
   * 比没有宿主更糟。
   */
  _hostAlive() {
    return !!(this._host && !this._host.killed && this._host.exitCode === null);
  }

  _failHostQueue() {
    const q = this._hostQueue;
    this._hostQueue = [];
    for (const entry of q) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
  }

  _killHost() {
    const child = this._host;
    this._host = null;
    if (child) { try { child.kill(); } catch (_) {} }
    this._failHostQueue();
  }

  _ensureHost() {
    const pid = this.uxplay && this.uxplay.pid;
    if (!pid) return null;
    if (this._hostAlive() && this._hostPid === pid) return this._host;
    this._killHost();
    const script = this._psScript();
    if (!script) return null;
    try {
      const child = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Action', 'server', '-ProcName', this._procName(), '-OwnerPids', String(pid)
      ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this._host = child;
      this._hostPid = pid;
      this._hostBuf = '';
      this._hostQueue = [];
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => this._onHostData(c));
      // 新拉起的宿主 epoch=0 / gate=1，完全不知道主进程当前的显隐状态：
      // 不先同步的话，之后每条 tuck 都会被判成 stale，引擎窗口再也不跟手。
      // gate 会回一行 JSON，队列里先放一个占位应答保证后续不错位。
      this._hostQueue.push({ resolve: () => {}, timer: null });
      try {
        child.stdin.write(`gate ${this._engineEpoch} ${this._engineGate ? 1 : 0}\n`);
      } catch (_) {
        this._hostQueue = [];
      }
      const gone = () => {
        if (this._host !== child) return;
        this._host = null;
        this._failHostQueue();
      };
      child.on('exit', gone);
      child.on('error', gone);
      return child;
    } catch (_) {
      this._host = null;
      return null;
    }
  }

  _onHostData(chunk) {
    this._hostBuf += chunk;
    let i;
    while ((i = this._hostBuf.indexOf('\n')) >= 0) {
      const line = this._hostBuf.slice(0, i).trim();
      this._hostBuf = this._hostBuf.slice(i + 1);
      const entry = this._hostQueue.shift();
      if (!entry) continue;
      clearTimeout(entry.timer);
      let val = null;
      try { val = JSON.parse(line); } catch (_) {}
      entry.resolve(val);
    }
  }

  _hostSend(line, timeoutMs, opts) {
    return new Promise((resolve) => {
      const child = this._ensureHost();
      if (!child) return resolve(null);
      // gate / vis 是显隐控制命令：队列被拖动指令占满时也不能丢。丢了就等于
      // 隐藏没生效，手机画面直接晾在桌面上。宿主按 stdin 写入顺序应答，
      // 多放一个等待者不会造成错位，所以这里只是放宽本地队列上限。
      if (this._hostQueue.length >= 8 && !(opts && opts.critical)) return resolve(null);
      const entry = { resolve, timer: null };
      this._hostQueue.push(entry);
      entry.timer = setTimeout(() => {
        const idx = this._hostQueue.indexOf(entry);
        if (idx >= 0) this._hostQueue.splice(idx, 1);
        this._killHost();          // 卡死的宿主整体作废，下次调用重拉
        resolve(null);
      }, timeoutMs || 9000);
      if (entry.timer.unref) entry.timer.unref();
      try {
        child.stdin.write(`${line}\n`);
      } catch (_) {
        const idx = this._hostQueue.indexOf(entry);
        if (idx >= 0) this._hostQueue.splice(idx, 1);
        clearTimeout(entry.timer);
        resolve(null);
      }
    });
  }

  /** 引擎在跑就走常驻宿主（毫秒级延迟），否则（测试 / 引擎已停 / 宿主拉不起来）退回一次性调用。 */
  _runHostOr(line, args) {
    if (this.uxplay && this.uxplay.pid && !process.env.MOYU_NO_PS_HOST) {
      // 显式确认宿主真的起来了：拉起失败时 _hostSend 会一直返回 null，
      // 没有这条兜底就等于「宿主挂了 = 窗口再也不会被收拢」。
      if (this._ensureHost()) return this._hostSend(line, 9000);
    }
    return this._psAsync(args);
  }

  /**
   * 收拢引擎窗口（1.0.34 起守卫 / 跟随 / 补摆共用的一条通道）：
   *   1) 绑定的视频窗口摆到期望矩形（偏移 <=6px 不重复搬运）并压到浮窗背后；
   *   2) 引擎进程树里其余可见窗口全部藏掉 —— 断线后的「遗照」窗口、被 Qt 撑到
   *      视频窗口大小的托盘消息窗（默认落在屏幕右下角）、还没绑定的下一扇
   *      新视频窗口，都不该露脸。
   */
  tuckWindow(rect) {
    if (!rect || !rect.width || !rect.height) return Promise.resolve(null);
    const target = Number(this.winHwnd || (this.captureSource && this.captureSource.hwnd) || 0);
    if (!target) return Promise.resolve(null);
    // 出站闸门：隐藏态（以及显隐动画的两个过渡态）一律不发 tuck。
    // ps1 的 place 自带 SWP_SHOWWINDOW，发一条就等于把引擎窗口亮一次。
    if (!this._engineGate) return Promise.resolve(null);
    this._tuckLatest = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
      epoch: this._engineEpoch
    };
    return this._drainTuck(target);
  }

  /**
   * 合并式跟随：一次只让一条 tuck 在途，期间来的新矩形覆盖 _tuckLatest，
   * 上一条回来后立刻补发最新的。这样连续拖动既不会把宿主队列灌满（旧实现
   * 队列一满就丢新指令，窗口整个拖程留在原地），也不会落后超过一拍。
   */
  _drainTuck(target) {
    if (this._tuckBusy) return Promise.resolve(null);
    const job = this._tuckLatest;
    if (!job) return Promise.resolve(null);
    this._tuckLatest = null;
    if (!this._engineGate || job.epoch !== this._engineEpoch) return Promise.resolve(null);
    this._tuckBusy = true;
    // 一次性 PowerShell 进程没有跨调用状态，它的 epoch 永远是 0；传真实
    // epoch 会把每一条 tuck 都误判成 stale。epoch 只在常驻宿主（line）里校验，
    // 一次性兜底路径靠主进程的出站闸门 + gate 已经足够。
    const args = ['-Action', 'tuck', '-Target', String(target),
      '-X', String(job.x), '-Y', String(job.y), '-W', String(job.w), '-H', String(job.h),
      '-Epoch', '-1'];
    return this._runHostOr(
      `tuck ${target} ${job.x} ${job.y} ${job.w} ${job.h} ${job.epoch}`, args
    ).then((res) => {
      this._tuckBusy = false;
      // 显隐翻转之后才回来的结果一律作废，绝不写回 winRect / 不续发旧矩形。
      if (job.epoch !== this._engineEpoch) return res;
      if (res && res.ok) {
        this.winRect = { x: res.x, y: res.y, width: res.w, height: res.h };
        this.winPlaced = true;
      }
      // 拖动期间攒下的最新一拍：立刻补发，窗口永远不落后。
      if (this._tuckLatest && this._engineGate) this._drainTuck(target);
      return res;
    });
  }

  /**
   * 异步读一次引擎视频窗口的真实矩形。
   *
   * 巡检用：placeWindow 之后窗口可能又被引擎自己挪走（Qt 在首帧到达、resize、
   * 或者 activateWindow 时会重设几何），而同步的 _ps 一次要 700ms，拿它做
   * 轮询会把主进程钉死。这里走异步路径，读不到就返回 null，调用方自行跳过。
   */
  async readWindowRect(hwnd) {
    const want = Number(hwnd || this.winHwnd || (this.captureSource && this.captureSource.hwnd) || 0);
    if (!want) return null;
    const rows = await this._psAsync(this._listArgs());
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r) => r && Number(r.hwnd) === want);
    if (!row) return null;
    return {
      x: Number(row.x) || 0,
      y: Number(row.y) || 0,
      width: Number(row.w) || 0,
      height: Number(row.h) || 0,
      visible: !!row.visible,
      iconic: !!row.iconic
    };
  }

  /**
   * 异步把窗口重新压回浮窗背后（巡检纠偏用）。
   *
   * 和 placeWindow 的区别只有执行方式：这里不阻塞主进程，代价是拿不到返回值，
   * 所以只在「已经知道正确矩形」的场景用 —— 漂移时按浮窗当前的 bounds 重摆。
   */
  reassertWindow(rect) {
    if (!rect || !rect.width || !rect.height) return Promise.resolve(false);
    const target = Number(this.winHwnd || (this.captureSource && this.captureSource.hwnd) || 0);
    if (!target) return Promise.resolve(false);
    return this._psAsync([
      '-Action', 'place', '-Target', String(target),
      '-X', String(Math.round(rect.x)), '-Y', String(Math.round(rect.y)),
      '-W', String(Math.round(rect.width)), '-H', String(Math.round(rect.height)),
      '-Layer', 'bottom'
    ]).then((res) => {
      if (res && res.ok) {
        this.winRect = { x: res.x, y: res.y, width: res.w, height: res.h };
        this.winPlaced = true;
        return true;
      }
      return false;
    });
  }


  /**
   * 把引擎的视频窗口挪到指定矩形并置底，让它正好躲在浮窗背后。
   *
   * 为什么不干脆放到屏幕外：Windows Graphics Capture 对「完全不可见」的窗口
   * 可能直接跳过合成，抓出来是黑屏；被遮挡但仍在屏幕内的窗口则稳定可抓。
   * 浮窗默认置顶且几乎不透明，盖住之后用户看不到任何多余的窗口。
   */
  placeWindow(rect, opts) {
    if (!rect || !rect.width || !rect.height) return null;
    // 已经知道是哪扇窗口就直接用，省一次枚举；否则现找。
    let target = 0;
    if (this.winHwnd) target = this.winHwnd;
    else if (this.captureSource && this.captureSource.hwnd) target = this.captureSource.hwnd;
    else {
      // 不要求 visible：视频窗口在第一帧到达前可能还是隐藏的（place 里会用
      // SWP_SHOWWINDOW 把它显出来），按可见性过滤会把刚建好的窗口丢掉。
      // 但必须剔掉进程树里的杂项窗口，否则会去搬 PyInstaller 的引导窗口 ——
      // 视频窗口还在原地，捕获自然一直是黑的。
      const rows = this._listWindows()
        .filter((r) => r && !r.iconic && r.w > 0 && r.h > 0)
        .map((r) => ({ row: r, score: scoreWindow(r, this.name || '') }))
        .filter((x) => x.score >= MIN_WINDOW_SCORE)
        .sort((a, b) => b.score - a.score);
      if (!rows.length) return null;
      target = rows[0].row.hwnd;
    }
    if (!target) return null;
    const res = this._ps([
      '-Action', 'place', '-Target', String(target),
      '-X', String(Math.round(rect.x)), '-Y', String(Math.round(rect.y)),
      '-W', String(Math.round(rect.width)), '-H', String(Math.round(rect.height)),
      '-Layer', (opts && opts.top) ? 'top' : 'bottom'
    ]);
    this.winHwnd = target;
    // place 会剥掉窗口边框，实际矩形以系统返回的为准。
    // 但要防一手：句柄失效或参数异常时系统会给出离谱的尺寸（曾出现 65535），
    // 那会让桌面捕获直接 E_INVALIDARG，所以对结果做合理性检查。
    const wantW = Math.round(rect.width);
    const wantH = Math.round(rect.height);
    const sane = res && res.ok && res.w > 40 && res.h > 40
      && res.w < wantW * 4 && res.h < wantH * 4 && res.h < 20000;
    const box = sane
      ? { width: res.w, height: res.h, x: res.x, y: res.y }
      : { width: wantW, height: wantH };
    this.winRect = box;
    this.winPlaced = true;
    // 注意：这里**不能**拿 box 当「画面尺寸」。
    // 捕获出来的像素尺寸会跟着这扇窗口变大变小，用它去调浮窗比例等于自己量
    // 自己，窗口会永远保持原比例（手机旋转后也不会变）。画面比例只认捕获流
    // 在**放倒之前**报上来的自然尺寸（见 setVideoSize）。
    return box;
  }

  /**
   * 记录画面比例（渲染层从捕获流读出 w/h）。
   *
   * 1.0.24 实机日志里尺寸在 172×374 / 372×374 / 344×374 之间反复跳：引擎窗口
   * 被「按配置比例摆」和「铺满浮窗摆」两套逻辑来回搬运，捕获像素跟着变，浮窗
   * 又被捕获像素反过来调比例 —— 一个自己量自己的闭环。现在所有摆放都保持同一
   * 比例（见 index.js::engineBox），这里再加一道闸门：只认明确的竖屏 / 横屏，
   * 接近 1:1 的中间态一律忽略；同向的比例抖动要连续两次才采纳，方向翻转
   * （手机旋转）立即采纳。
   */
  setVideoSize(width, height) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    if (w < 16 || h < 16) return null;
    const ratio = h / w;
    const orient = ratio >= 1.35 ? 'portrait' : ratio <= 0.74 ? 'landscape' : '';
    if (!orient) { this._aspectCandidate = null; return null; }
    if (this.video) {
      const cur = this.video.height / this.video.width;
      const curOrient = cur >= 1.35 ? 'portrait' : cur <= 0.74 ? 'landscape' : '';
      if (Math.abs(ratio - cur) < 0.12) { this._aspectCandidate = null; return null; }
      if (orient === curOrient) {
        // 同向但比例明显变了：等一次确认，别让摆放过程中的中间态带着浮窗跳
        const c = this._aspectCandidate;
        if (!c || c.orient !== orient || Math.abs(c.ratio - ratio) >= 0.12) {
          this._aspectCandidate = { orient, ratio, count: 1 };
          return null;
        }
        c.count += 1;
        if (c.count < 2) return null;
      }
    }
    this._aspectCandidate = null;
    this.video = { width: w, height: h };
    this._note(`[moyu] 画面比例 ${w}×${h}（${orient === 'portrait' ? '竖屏' : '横屏'}）`);
    this.emit('video', this.video);
    return this.video;
  }

  _startBridge(ffmpeg) {
    if (this.ffmpeg) return;
    this._ffmpegPath = ffmpeg;
    this._ffmpegArgs = buildBridgeArgs(this.config.get());
    this.normalizer = new H264Normalizer();
    this._params = { sps: null, pps: null };
    this._decoderRestarts = 0;
    this._push = this._makePusher();
    this._spawnDecoder();
    this._startTailer();
  }

  /**
   * 起一个解码器进程并接线。和 tailer 分开，是因为「重新同步」时只需要换解码器，
   * 不需要重建中继、不需要打断 tailer 的读文件位置。
   */
  _spawnDecoder() {
    const child = spawn(this._ffmpegPath, this._ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ffmpeg = child;
    // 预置缓存的 SPS/PPS：解码器是新的，没有参数集就一个像素都解不出来，
    // 而下一个关键帧可能要等很久。先把参数集喂进去，等 IDR 一到立刻出画。
    if (this._params && this._params.sps && this._params.pps) {
      try { child.stdin.write(Buffer.concat([this._params.sps, this._params.pps])); } catch (_) {}
    }

    let buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const start = buffer.indexOf(SOI);
        if (start < 0) { buffer = buffer.slice(-1); break; }
        const end = buffer.indexOf(EOI, start + 2);
        if (end < 0) { buffer = buffer.slice(start); break; }
        this.jpegFrames += 1;
        const frame = buffer.slice(start, end + 2);
        // 每 10 帧复核一次画面尺寸：手机旋转会改变分辨率，
        // 窗口要跟着重新适配，否则竖屏画面被塞进横屏框里。
        if (!this.video || this.jpegFrames % 10 === 0) {
          const size = jpegSize(frame);
          if (size && (!this.video || size.width !== this.video.width || size.height !== this.video.height)) {
            this.video = size;
            this._note(`[moyu] 画面尺寸 ${size.width}x${size.height}`);
            this.emit('video', size);
          }
        }
        if (!this.firstFrameAt) {
          this.firstFrameAt = Date.now();
          this._note(`[moyu] 首帧画面已解码（${this.firstFrameAt - this.startedAt}ms）`);
        }
        // 这一帧在解的时候有没有报错？ffmpeg 的错误都打在 stderr 上，
        // 用「错误序号有没有变」来归属到当前这一帧。
        const hadError = this._errSeq !== this._frameErrSeq;
        this._frameErrSeq = this._errSeq;
        if (hadError) this.corruptFrames += 1;
        else this.goodFrames += 1;
        const drop = shouldDropFrame({
          gate: this.config.get().airplayFrameGate,
          hadError,
          goodFrames: this.goodFrames
        });
        if (drop) this.droppedFrames += 1;
        else this._push(frame);
        buffer = buffer.slice(end + 2);
      }
      if (buffer.length > 8 * 1024 * 1024) buffer = Buffer.alloc(0);
      if (this.phase === 'starting') {
        this.phase = 'running';
        this.emit('status', this.status());
      }
    });
    child.stderr.on('data', (chunk) => {
      String(chunk).split(/\r?\n/).filter(Boolean).slice(-2).forEach((raw) => {
        const line = raw.trim();
        if (/error while decoding MB|bytestream -|left block unavailable|top block unavailable|cabac_init_idc|decode_slice_header error|concealing \d+ corrupted|corrupted macroblock/i.test(line)) {
          this.decodeWarnings += 1;
          this._errSeq += 1;
          this._checkAutoHeal();
        }
        // 同一条告警连刷几百行只会把真正有用的信息挤出可视区，合并成一行计数
        if (line === this._lastFfmpeg) {
          this._ffmpegRepeat += 1;
          const last = this.log[this.log.length - 1];
          if (last && last.startsWith('[ffmpeg]')) {
            this.log[this.log.length - 1] = `${last.replace(/ ×\d+$/, '')} ×${this._ffmpegRepeat}`;
            this.emit('status', this.status());
          }
          return;
        }
        this._lastFfmpeg = line;
        this._ffmpegRepeat = 1;
        this._note(`[ffmpeg] ${line}`);
      });
    });
    child.on('error', (err) => this._fail(`ffmpeg 无法运行：${err.message}`));
    child.on('close', () => {
      // 只有「还是当前解码器」才算意外退出：stop() / _restartDecoder() 都会
      // 先把 this.ffmpeg 置空再 kill，那种退出不该触发重生。
      if (this.ffmpeg !== child) return;
      this.ffmpeg = null;
      if (this.phase !== 'running' || this._decoderRestarts >= 10) return;
      // 解码器自己挂了（显存/进程被杀/输入异常）时，以前是画面永久定格，
      // 只能手动停掉重开。这里自动重生，并靠缓存的 SPS/PPS 立刻具备解码能力。
      this._decoderRestarts += 1;
      const timer = setTimeout(() => {
        if (!this.ffmpeg && this.phase === 'running') this._spawnDecoder();
      }, 300);
      if (timer.unref) timer.unref();
    });
    return child;
  }

  /**
   * 换一个新的解码器。
   *
   * dump 被重建通常意味着流参数变了（手机旋转、分辨率切换、引擎换了新 SPS）。
   * 让旧解码器带着上一段流的参考帧继续吃新流，虽然 ffmpeg 多数情况能自己
   * 重新初始化（实测连放两遍同一段流是干净的），但「旧参考帧 + 新参数集」
   * 这种混态是花屏的经典来源，而重启一次只有几十毫秒。
   * 重启后靠缓存的 SPS/PPS 预热，不会出现「换了解码器却在等关键帧」的空窗。
   */
  _restartDecoder(reason) {
    const old = this.ffmpeg;
    this.ffmpeg = null;
    if (old) {
      try { old.stdout.removeAllListeners('data'); } catch (_) {}
      try { old.stderr.removeAllListeners('data'); } catch (_) {}
      try { old.stdin.end(); } catch (_) {}
      try { old.kill(); } catch (_) {}
    }
    if (this.normalizer) this.normalizer.reset();
    this._note(`[moyu] 重新同步解码器（${reason}）`);
    try { this._spawnDecoder(); } catch (_) {}
  }

  _startTailer() {
    clearInterval(this.tailer);
    const limit = Number(this.config.get().airplayMaxDumpMB || 256) * 1024 * 1024;
    const exact = this.dumpBase ? this.dumpBase + '.h264' : '';
    const candidates = this._dumpCandidates(); // 只在启动时解析一次，避免每 40ms 定位引擎
    let notedDump = false;
    this.tailer = setInterval(() => {
      if (!this.ffmpeg || !this.ffmpeg.stdin.writable) return;
      let file = this.dumpFile;
      if (!file) {
        if (exact && exists(exact)) {
          file = exact;
        } else {
          // GUI 用 QProcess 启动核心，工作目录未必继承我们的 cwd：
          // 显式路径没命中时，扫描所有候选目录取最新修改的 .h264 兜底。
          let best = '';
          let bestTime = 0;
          for (const dir of candidates) {
            let names = [];
            try { names = fs.readdirSync(dir); } catch (_) { continue; }
            for (const name of names) {
              if (!/\.h264$/i.test(name)) continue;
              const full = path.join(dir, name);
              try {
                const st = fs.statSync(full);
                if (st.isFile() && st.mtimeMs >= bestTime) { best = full; bestTime = st.mtimeMs; }
              } catch (_) {}
            }
          }
          file = best;
        }
        if (!file) return;
        this.dumpFile = file;
        if (!notedDump) {
          notedDump = true;
          this._note(`[moyu] 已收到视频流：${path.basename(file)}`);
        }
      }
      let size;
      try { size = fs.statSync(file).size; } catch (_) { return; }
      if (size < this.dumpOffset) {
        // dump 被重建（手机旋转 / 分辨率变化 / 引擎换了新 SPS）：从头读，
        // 并且连解码器一起换掉，保证新流从干净的参考帧开始。
        this.dumpOffset = 0;
        this._restartDecoder('dump 被重建');
      }
      if (size <= this.dumpOffset) return;
      if (size > limit) {
        this._fail('临时视频流超过上限，已自动停止以保护磁盘；点「开始投屏」可重新连接。');
        this.stop();
        return;
      }
      // 关键：隐藏时也必须持续喂 H264。ffmpeg 解码器需要开头的 SPS/PPS
      // 才能初始化，中途掐断输入会让恢复显示后永远解不出画面。
      // 「隐藏省资源」只体现在不推 JPEG / 不广播，绝不体现在断掉解码输入。
      const want = size - this.dumpOffset;
      const chunk = Buffer.alloc(want);
      let fd;
      let got = 0;
      try {
        fd = fs.openSync(file, 'r');
        // 必须循环读满：另一个进程正在追加写这个文件，readSync 允许短读。
        // 以前只调一次 readSync 却按 want 推进 offset，短读时会静默丢掉中间
        // 一段字节——H264 从此失步，ffmpeg 持续报
        // "error while decoding MB x y, bytestream -N"（部分宏块永远解不出来）。
        while (got < want) {
          const n = fs.readSync(fd, chunk, got, want - got, this.dumpOffset + got);
          if (n <= 0) break;
          got += n;
        }
      } catch (_) { return; }
      finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
      if (got <= 0) return;
      this.dumpOffset += got;
      const fresh = got === want ? chunk : chunk.subarray(0, got);
      const h264 = this.normalizer ? this.normalizer.push(fresh) : fresh;
      if (h264.length) {
        this._cacheParams(h264);
        try { this.ffmpeg.stdin.write(h264); } catch (_) {}
      }
    }, 40);
    if (this.tailer.unref) this.tailer.unref();
  }

  /**
   * 记住最新的 SPS/PPS。
   * 解码器重启后必须立刻有参数集，否则要等到下一个关键帧才出画（可能十几秒）。
   * 写入的是标准 4 字节起始码 + NAL，直接可喂 ffmpeg。
   */
  _cacheParams(buf) {
    if (!this._params) this._params = { sps: null, pps: null };
    for (let p = 0; p + 4 <= buf.length; p++) {
      if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
      const type = buf[p + 3] & 0x1f;
      if (type !== 7 && type !== 8) continue;
      let e = p + 3;
      while (e + 3 <= buf.length && !(buf[e] === 0 && buf[e + 1] === 0 && buf[e + 2] === 1)) e += 1;
      // 4 字节起始码是 00 00 00 01，上面按 00 00 01 找到的是它最后 3 个字节，
      // 会多带 1 个 0x00。H264 允许 trailing_zero_8bits 垫在 NAL 后面，
      // 解码不受影响，但缓存里留干净一点更好比对。
      let tail = e;
      while (tail > p + 4 && buf[tail - 1] === 0) tail -= 1;
      const nal = Buffer.concat([ANNEXB4, buf.subarray(p + 3, tail)]);
      if (type === 7) this._params.sps = nal;
      else this._params.pps = nal;
      p = e - 1;
    }
  }

  _stopBridge() {
    clearInterval(this.tailer);
    this.tailer = null;
    this.normalizer = null;
    this._params = null;
    const child = this.ffmpeg;
    this.ffmpeg = null;
    if (!child) return;
    try { child.stdout.removeAllListeners('data'); } catch (_) {}
    try { child.stdin.end(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }

  /**
   * JPEG 帧 -> 本机中继。
   *
   * 一次 POST 同时只允许一个在途，否则会互相挤占连接。但「忙就整帧丢掉」是错的：
   * 引擎的 -vdmp 文件是按块增长的，ffmpeg 往往一次吐出一串帧，那种突发下
   * 除了第一帧全被丢掉，观看端可能只收到一帧，连首个 multipart 分段都拼不完整，
   * 表现就是「连接成功但看不到画面」。
   *
   * 改成有界等待队列：最多积压 PENDING_MAX 帧，超出丢最旧的。
   * 既保证突发时画面能连续出，又保证延迟有上界（不会越积越旧）。
   */
  _makePusher() {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const PENDING_MAX = 3;
    const port = this.relay.status().port;
    const token = this.relay.info().token;
    let inFlight = false;
    let pending = [];

    const send = () => {
      if (inFlight) return;
      const frame = pending.shift();
      if (!frame) return;
      if (this.hidden) { pending.length = 0; return; }
      inFlight = true;
      this.pushedFrames += 1;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        inFlight = false;
        send();
      };
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', agent,
        path: `/push?token=${encodeURIComponent(token)}`,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': frame.length }
      }, (res) => {
        res.resume();
        res.on('end', done);
        res.on('close', done);
      });
      req.on('error', done);
      req.setTimeout(2000, () => req.destroy());
      req.end(frame);
    };

    const push = (frame) => {
      if (this.hidden) return;
      pending.push(frame);
      if (pending.length > PENDING_MAX) pending.shift(); // 丢最旧的一帧
      send();
    };
    push.destroy = () => {
      pending.length = 0;
      try { agent.destroy(); } catch (_) {}
    };
    return push;
  }

  /**
   * 隐藏态：默认保留 AirPlay 会话（iPhone 不断线），只暂停画面推送，
   * 解码器继续吃 H264 保持同步 —— 掐断输入会丢 SPS/PPS，恢复后永远没画面。
   * 配置开启「隐藏时断开」则整个会话下线。
   */
  /**
   * 显隐翻转时给常驻宿主设「权威可见性」。
   *
   * 为什么不能只发一条 vis：tuck 在 ps1 里带 SWP_SHOWWINDOW，隐藏那一刻
   * 宿主队列里往往还压着拖动 / 巡检留下的 tuck。vis 0 执行完，紧接着的
   * tuck 会把窗口重新亮出来 —— 表现就是「隐藏浮窗后 uxplay 又冒出来」。
   * gate 让宿主自己记住当前状态，并用 epoch 作废翻转前排队的 tuck。
   */
  setEngineGate(visible) {
    const next = !!visible;
    if (next === this._engineGate && this._gatePushed) return null;
    this._engineGate = next;
    this._engineEpoch += 1;
    this._tuckLatest = null;
    this._gatePushed = true;
    const epoch = this._engineEpoch;
    // gate 0 会在 ps1 里立刻隐藏引擎进程树的**所有**可见窗口，不只是绑定的
    // 那一扇 —— 遗照窗口 / Qt 托盘消息窗 / 尚未绑定的新视频窗都在内。
    if (this._hostAlive()) return this._hostSend(`gate ${epoch} ${next ? 1 : 0}`, 8000, { critical: true });
    return this._ps(['-Action', 'gate', '-Epoch', String(epoch), '-Show', next ? '1' : '0']);
  }

  setHidden(hidden) {
    const next = !!hidden;
    if (next === this.hidden) return this.status();
    this.hidden = next;
    if (this.phase !== 'starting' && this.phase !== 'running') return this.status();
    if (next && this.config.get().airplayStopOnHide) return this.stop();
    /* vnet 通道：显隐什么都不用做，**必须**在这里直接返回。
     *
     * 引擎是 `-vs fakesink` + `windowsHide` 起的，既没有视频窗口要藏，
     * 也没有捕获流要停。可下面那两行（gate / vis）在宿主没起来时会退化成
     * 一次同步 PowerShell，实测把主进程钉住 400~700ms —— 这期间 vnet 的
     * socket 没人读，引擎那边的非阻塞 send 累计停顿到 1s 就判定「对面不要了」
     * 直接把连接关掉。结果是：手机上仍显示「正在投屏」，浮窗却再也收不到
     * 一帧（新连接拿不到 SPS/PPS，会话中途不会重发），只能重开 Winkow。
     * 用户报的「收起几秒再唤出，画面就没了，重连也不出来」正是这条。
     */
    if (this.renderMode === 'vnet') {
      diag.log('hide', `vnet 通道收到 hidden=${next}（不做窗口操作）· vnet=${this.vnet ? JSON.stringify(this.vnet.status()) : 'null'}`);
      if (!next) {
        /* 隐藏期间一帧都没来（引擎/手机那边确实出过问题）：重新显示时补一次
         * 收流重连即可 —— 引擎会补发 SPS/PPS + 最近 IDR，画面立刻回来。
         * 隐藏中绝不主动做这件事，那等于自己把投屏掐断一次。 */
        const stall = this._vnetHiddenStall || 0;
        this._vnetHiddenStall = 0;
        if (stall >= 3 && this.vnet) {
          diag.log('vnet', `隐藏期间累计零帧 ${stall}s → 显示时补一次收流重连`);
          try { this.vnet.reconnect(); } catch (_) {}
        }
      }
      this._note(next
        ? '[moyu] 浮窗已隐藏：vnet 直通继续收流（引擎无窗口可藏，不做窗口操作）'
        : '[moyu] 浮窗已显示：vnet 直通保持连接');
      this.emit('status', this.status());
      return this.status();
    }
    diag.log('hide', `窗口通道 hidden=${next}`);
    // 先立闸门再切窗口：gate 会作废所有在途 tuck，并藏掉引擎进程树里
    // 每一扇可见窗口。顺序反了的话，隐藏后到达的 tuck 会重新亮出来。
    this.setEngineGate(!next);
    // 隐藏不暂停投屏链路：引擎会话、解码、捕获流全部保持连接，只把那扇视频
    // 窗口一起收起来（否则手机画面会整块晾在桌面上）。实测同一条 WGC 流在
    // SW_HIDE→SW_SHOW 后会自己续上实时帧，不需要停流也不需要重建。
    this.setWindowVisible(!next);
    this._note(next
      ? '[moyu] 浮窗已隐藏：投屏链路继续运行，仅收起引擎视频窗口防泄漏'
      : '[moyu] 浮窗已显示：同一条捕获流自动续上实时帧');
    this.emit('status', this.status());
    return this.status();
  }

  /**
   * 显示 / 隐藏引擎的视频窗口（没有窗口时什么都不做）。
   * 引擎在跑时优先走常驻宿主（隐私关键路径，宿主不在时同步一次性调用兜底）。
   */
  setWindowVisible(visible) {
    const hwnd = this.winHwnd || (this.captureSource && this.captureSource.hwnd) || 0;
    if (!hwnd) return null;
    if (this._hostAlive()) {
      this._hostSend(`vis ${hwnd} ${visible ? 1 : 0}`, 8000, { critical: true });
      return null;
    }
    return this._ps([
      '-Action', 'visibility', '-Target', String(hwnd), '-Show', visible ? '1' : '0'
    ]);
  }

  /** 每秒广播链路计数，并在明显卡住时给出可操作的提示。 */
  _startDiag() {
    clearInterval(this.diagTimer);
    let warnedDump = false;
    let warnedViewer = false;
    let lastVnetFrames = -1;
    let stallTicks = 0;
    let healed = 0;
    this.diagTimer = setInterval(() => {
      if (this.phase !== 'starting' && this.phase !== 'running') return;
      this.emit('status', this.status());
      const up = this.startedAt ? Date.now() - this.startedAt : 0;
      // 现在「有没有画面」只看一件事：引擎那扇视频窗口出没出现。
      // 以前这里等的是 dump 字节数（-vdmp 那条旁路已经不用了，永远是 0）。
      // vnet 通道下压根没有引擎视频窗口可言，这条提示只会在「窗口捕获」模式下成立。
      if (!warnedDump && up > 12000 && !this.captureSource && this.renderMode !== 'vnet') {
        warnedDump = true;
        this._note('[moyu] 还没出现视频窗口：请确认 iPhone「屏幕镜像」已选中本机并输入 PIN，且未播放 DRM 内容');
      }
      // 窗口找到了、但浮窗迟迟没确认捕获成功：多半是显示内容还没切到「投屏」
      if (!warnedViewer && this.captureSource && !this.winPlaced && up > 20000 && !this.hidden) {
        warnedViewer = true;
        this._note('[moyu] 视频窗口已就绪，但浮窗还没拿到画面：请把显示内容切到「投屏」');
      }
      // 浮窗藏起来之后本来就不该有捕获：这条提示只在可见时才成立，
      // 重新显示后允许再提示一次。
      if (this.hidden) warnedViewer = false;
      /* vnet 收流看门狗：「连接还在 + 手机确实在投屏 + 却一帧不涨」。
       *
       * 引擎自 1.0.51 起不再因为「接收端一时没读」而断开，所以这里遇到零帧
       * 只剩两种情况：引擎真的不在产帧，或者我们这条 socket 已经僵死。
       * 前者我们救不了，后者只要重连一次就能好 —— 引擎看到新连接会立刻
       * 顶掉旧 fd 并补发 SPS/PPS。
       *
       * 阈值取 5 秒：手机停在静态画面上时引擎仍按 fps 出帧，5 秒一帧没有
       * 只可能是链路断了；普通抖动不会命中。
       */
      if (this.renderMode === 'vnet' && this.vnet && this.vnet.connected) {
        const frames = this.vnet.frames;
        if (frames === lastVnetFrames && this.session && !this.sessionLost) {
          /* 隐藏期间**绝不动连接**。用户的要求是「隐藏不要断开投屏连接和画面」，
           * 而引擎自 1.0.51 起写不动只丢帧、不超时断开，所以隐藏时零帧本来
           * 就不需要任何干预。这里只记下卡了多久，等浮窗重新显示时再决定
           * 要不要补一次收流重连 —— 隐藏中重连等于主动制造一次断流。 */
          if (this.hidden) {
            this._vnetHiddenStall = (this._vnetHiddenStall || 0) + 1;
            lastVnetFrames = frames;
            return;
          }
          stallTicks += 1;
          if (stallTicks >= 5 && healed < 2) {
            healed += 1;
            stallTicks = 0;
            if (healed === 1) {
              this._note('[moyu] vnet 连接 5 秒没有收到任何帧（手机仍在投屏）：重建收流连接');
              diag.log('vnet', '零帧 5s → 重建收流 socket');
              try { this.vnet.reconnect(); } catch (_) {}
            } else {
              /* 重连一次仍然零帧：说明引擎根本不在产帧（手机停了，或者 RTP
               * 已经断了）。重开引擎能让 listen 端口重来一遍，用户在手机上
               * 重新点「屏幕镜像」即可连回（新会话自带 SPS/PPS，画面干净）。 */
              this._note('[moyu] vnet 重连后仍然没有画面（手机仍在投屏）：自动重启接收器，稍后在手机上重新点「屏幕镜像」即可');
              diag.log('vnet', '零帧 10s → 重启引擎（socket 重连无效）');
              // force：会话还在也要重启，这正是走投无路的那种状态
              this._respawn(true).catch(() => {});
            }
          }
        } else {
          stallTicks = 0;
          this._vnetHiddenStall = 0;
        }
        lastVnetFrames = frames;
      } else {
        lastVnetFrames = -1;
        stallTicks = 0;
      }
    }, 1000);
    if (this.diagTimer.unref) this.diagTimer.unref();
  }

  /**
   * 留存本次投屏的原始 H264 头部，供「花屏」问题离线定位。
   *
   * 只有解码报过错才留（正常会话不占空间）。8MB 足够覆盖一个关键帧到它后面
   * 若干 P 帧，能判断坏数据是「在指定位置被截断」还是「整段被替换」——
   * 这个区别决定了下一次修的是读取链路还是解密链路。
   */
  _keepSample() {
    if (!this.dumpFile || !this.decodeWarnings) return '';
    if (this.config.get().airplayKeepSample === false) return '';
    const out = path.join(os.tmpdir(), 'moyu-airplay-sample.h264');
    try {
      const size = fs.statSync(this.dumpFile).size;
      const want = Math.min(size, 8 * 1024 * 1024);
      if (!want) return '';
      const buf = Buffer.alloc(want);
      const fd = fs.openSync(this.dumpFile, 'r');
      let got = 0;
      try {
        while (got < want) {
          const n = fs.readSync(fd, buf, got, want - got, got);
          if (n <= 0) break;
          got += n;
        }
      } finally { fs.closeSync(fd); }
      fs.writeFileSync(out, buf.subarray(0, got));
      this._note(`[moyu] 已留存画质样本（${(got / 1048576).toFixed(1)}MB）：${out}`);
      return out;
    } catch (_) { return ''; }
  }

  stop() {
    const wasRunning = this.phase === 'starting' || this.phase === 'running';
    setEngineActive(false);
    setSessionActive(false);
    this._cancelRespawn();
    this._cancelDrop();
    this.session = false;
    this.sessionLost = false;
    this._sessionAt = 0;
    this._args = null;
    this._suppressProbeUntil = 0;
    clearInterval(this.diagTimer);
    this.diagTimer = null;
    this._stopWindowWatch();
    this._killHost();          // 常驻 PowerShell 宿主跟着引擎一起退场
    const sample = this._keepSample();
    if (sample) this.samplePath = sample;
    this._stopBridge();
    this._stopVnet();
    if (this._push && this._push.destroy) this._push.destroy();
    this._push = null;
    const child = this.uxplay;
    this.uxplay = null;
    if (child) {
      const pid = child.pid;
      try { child.kill(); } catch (_) {}
      // GUI 引擎会拉起 BLE beacon 等子进程，必须连同进程树结束。
      // 这里同步执行：以前用 1200ms + unref 的延迟定时器，主进程在 before-quit
      // 里会立刻退出，定时器根本没机会跑，结果是「停止投屏后引擎残留、
      // 参数文件被恢复成默认值，iPhone 仍连着独立视频窗口」。
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5000, windowsHide: true, stdio: 'ignore'
        });
      } catch (_) {}
    }
    this._restoreArgsFile();
    // 引擎可能仍持有 dump 文件句柄，延迟清理临时目录
    const dir = this.tmpDir;
    this.tmpDir = '';
    if (dir) {
      const timer = setTimeout(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      }, 1800);
      if (timer.unref) timer.unref();
    }
    this.dumpFile = '';
    this.dumpBase = '';
    this.dumpOffset = 0;
    this.jpegFrames = 0;
    this.pushedFrames = 0;
    this.firstFrameAt = 0;
    this.decodeWarnings = 0;
    this.goodFrames = 0;
    this.corruptFrames = 0;
    this.droppedFrames = 0;
    this.corruptStart = false;
    this._errSeq = 0;
    this._frameErrSeq = 0;
    this.phase = 'idle';
    this.error = '';
    this.hidden = false;
    this.startedAt = 0;
    this.relay.setPaused(false);
    if (wasRunning) {
      this._note('[moyu] 接收器已停止，局域网广播下线，临时视频流已删除');
      this.onStop();
    }
    this.emit('status', this.status());
    return this.status();
  }

  dispose() { this.stop(); }
}

module.exports = AirPlayEngine;
// 纯函数挂到类上，自测（scripts/selftest-airplay.js）可以直接验证 JPEG 头解析
module.exports.jpegSize = jpegSize;
// 线上 ffmpeg 参数由这里产出，取证脚本（scripts/probe-decode-integrity.js）
// 直接复用它，保证「测的参数」= 「跑的参数」。
module.exports.buildBridgeArgs = buildBridgeArgs;
// 纯函数：解码后端归一化、坏帧闸门、开局即坏判定（自测直接验证这三条）
module.exports.resolveDecoder = resolveDecoder;
module.exports.shouldDropFrame = shouldDropFrame;
module.exports.isCorruptStart = isCorruptStart;
