'use strict';

/**
 * 真实主进程 E2E：验证「从托盘 / 设置页启动投屏」这条唯一正确路径。
 *
 * 断言链：主程序找到引擎 -> 启动后 arguments.txt 含我们的
 * -vs d3d11videosink 参数（而不是 GUI 默认的 autovideosink）-> 引擎由主进程拉起有 pid
 * -> 浮窗切到 mirror 模式 -> 停止后参数文件恢复、引擎进程树无残留。
 *
 * 这条路径跑通，才能排除「用户直接双击 airplay/uxplay-windows.exe 导致
 * 独立视频窗口」这类误操作。全程不需要 iPhone 连接。
 *
 *   node scripts/e2e-airplay-start.js
 *   node scripts/e2e-airplay-start.js dist/win-unpacked/Winkow.exe
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `moyu-ap-e2e-${process.pid}`);
const USER_DATA = path.join(TMP, 'userData');
const logFile = path.join(TMP, 'smoke.log');
const cfgFile = path.join(USER_DATA, 'moyu-config.json');
const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const target = process.argv[2] ? path.resolve(process.argv[2]) : DEV_ELECTRON;
const packaged = path.resolve(target) !== path.resolve(DEV_ELECTRON);
const argsFile = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
const argsBefore = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;

let finished = false;
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

function uxplayPids() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 6000, windowsHide: true
    });
    return out.split(/\r?\n/).map((l) => l.match(/^"([^"]+)","(\d+)"/))
      .filter((m) => m && /^uxplay(-windows)?\.exe$/i.test(m[1]))
      .map((m) => Number(m[2]));
  } catch (_) { return []; }
}

if (!fs.existsSync(DEV_ELECTRON)) {
  process.stderr.write('[ap-e2e] 需要先安装 Electron\n');
  process.exit(1);
}

// 源码模式下主程序目录里没有 airplay/，把引擎与 ffmpeg 的绝对路径预置进
// 独立 userData 的配置（打包版则用自身目录里的组件，不需要这一段）。
function locateFfmpeg() {
  const candidates = [
    'D:\\CODE\\ffmpeg\\ffmpeg.exe',
    path.join(ROOT, '..', 'third_party', 'uxplay-windows', 'ffmpeg.exe')
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (hit) return hit;
  try {
    return execFileSync('where', ['ffmpeg'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s)) || '';
  } catch (_) { return ''; }
}

try {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const preset = {
    mode: 'idle', webUrl: '', firstRun: false, muted: true,
    trayVisible: false, autoStart: false, contentProtection: false
  };
  if (!packaged) {
    const engine = path.join(ROOT, '..', 'third_party', 'uxplay-windows', 'uxplay-windows.exe');
    if (fs.existsSync(engine)) preset.airplayEnginePath = engine;
    const ffmpeg = locateFfmpeg();
    if (ffmpeg) preset.airplayFfmpegPath = ffmpeg;
  }
  fs.writeFileSync(cfgFile, JSON.stringify(preset, null, 2), 'utf8');
} catch (err) {
  process.stderr.write(`[ap-e2e] 预置配置失败: ${err.message}\n`);
  cleanup();
  process.exit(1);
}

const env = {
  ...process.env,
  MOYU_SMOKE: '1',
  MOYU_AIRPLAY_START: '1',
  MOYU_SMOKE_LOG: logFile
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const args = packaged ? [`--user-data-dir=${USER_DATA}`] : ['.', `--user-data-dir=${USER_DATA}`];
const child = spawn(target, args, { cwd: ROOT, env, windowsHide: true });
let output = '';
const collect = (c) => { output += c.toString(); };
child.stdout.on('data', collect);
child.stderr.on('data', collect);

// ---- 假 H264 喂料 ----
// 真机不在场时，用一段真实编码的 H264 冒充 UxPlay 的 -vdmp 输出，写进主程序
// 自己创建的 moyu-airplay-* 临时目录。这样整条真实链路（tailer -> 归一化 ->
// ffmpeg -> /push -> 浮窗 webview 的 <img>）都会被真实跑一遍，
// 「观看端有没有画面」就不再靠猜。
function annexbToAvcc(buf) {
  const nals = [];
  for (let p = 0; p < buf.length - 3; p++) {
    if (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 0 && buf[p + 3] === 1) {
      nals.push({ code: p, body: p + 4 }); p += 3;
    } else if (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1) {
      nals.push({ code: p, body: p + 3 }); p += 2;
    }
  }
  const parts = [];
  for (let i = 0; i < nals.length; i++) {
    const end = i + 1 < nals.length ? nals[i + 1].code : buf.length;
    const nal = buf.subarray(nals[i].body, end);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(nal.length, 0);
    parts.push(head, nal);
  }
  return Buffer.concat(parts);
}

function buildSample() {
  const ffmpeg = locateFfmpeg();
  if (!ffmpeg) return null;
  const src = path.join(ROOT, 'scripts', 'fixtures', 'sample.h264');
  try {
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
      '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10',
      '-f', 'h264', src
    ], { timeout: 20000, windowsHide: true, stdio: 'ignore' });
    if (!fs.existsSync(src) || fs.statSync(src).size < 1000) return null;
    return annexbToAvcc(fs.readFileSync(src));
  } catch (_) {
    return null;
  }
}

// 画面通道已改为「引擎自解码 → 独立视频窗口 → 浮窗捕获」，不再有任何 H264
// dump / ffmpeg 环节，因此这里不需要再伪造喂料。真机不在场时能验证到的是：
// 参数正确下发、引擎由主进程拉起、浮窗切到投屏、停止后无残留。
// 「浮窗里真的出现手机画面」只能在有 iPhone 时人工确认。

const timer = setTimeout(() => {
  if (!finished) {
    process.stderr.write('[ap-e2e] 超时，终止应用\n');
    try { child.kill(); } catch (_) {}
  }
}, 45000);

child.on('error', (err) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  cleanup();
  process.stderr.write(`[ap-e2e] 无法启动: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { output += fs.readFileSync(logFile, 'utf8'); } catch (_) {}

  const line = (tag) => {
    const m = output.match(new RegExp(`\\[moyu-airplay-e2e\\] ${tag}=([^\\n]*)`));
    return m ? m[1].trim() : '';
  };
  const engineLine = output.match(/\[moyu-smoke\] airplay engine=([^\n]*)/);
  const engineOk = !!engineLine && !/MISSING/.test(engineLine[1]);
  const a = line('args');
  const state = line('mode');
  const stopped = output.match(/\[moyu-airplay-e2e\] afterStop phase=([^\s]+) argsRestored=(\w+)/);
  const pid = line('pid') || (state.match(/pid=(\d+)/) || [])[1] || '';
  const residual = uxplayPids();
  const after = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;
  const restoredToOriginal = argsBefore === null ? after === null
    : !!after && after.equals(argsBefore);

  const checks = {
    engineFound: engineOk,
    // 参数必须是真渲染器，且不再让引擎导出 H264 dump（那条旁路的数据是坏的）
    argsVideoSink: /-vs d3d11videosink/.test(a),
    noDump: !/-vdmp/.test(a),
    argsCustomName: /-n Winkow\b/.test(a) || /-n MoyuFloat/.test(a),
    // -reset 0：关掉引擎默认的 15 秒静默重置，手机静置/锁屏不该被接收端踢掉
    argsResetOff: /-reset 0/.test(a),
    modeMirror: /^mirror\b/.test(state),
    engineSpawned: Number(pid) > 0,
    // 投屏期间「鼠标移出」不得把正在看的画面藏掉（老板键等粘性隐藏不受影响）
    autoHideSuppressed: /autoHideSuppressed=true/.test(output),
    stayedVisible: /hiddenAfterMouseLeave=false/.test(output),
    stoppedIdle: !!stopped && stopped[1] === 'idle',
    argsRestored: !!stopped && stopped[2] === 'true',
    noResidual: residual.length === 0,
    globalArgsIntact: restoredToOriginal,
    cleanExit: code === 0
  };

  const diag = output.match(/\[moyu-airplay-e2e\] diag (@?\d*) ?([^\n]*)/);
  console.log(`[ap-e2e] diag=${diag ? diag[2] : 'MISSING'}`);
  const viewer = output.match(/viewer@\d+ img=[^\n]*/);
  console.log(`[ap-e2e] viewer=${viewer ? viewer[0] : 'MISSING'}`);
  const hide = output.match(/\[moyu-airplay-e2e\] autoHideSuppressed=([^\n]*)/);
  console.log(`[ap-e2e] hideProbe=${hide ? hide[1] : 'MISSING'}`);
  console.log(`[ap-e2e] args=${a}`);
  console.log(`[ap-e2e] state=${state}`);
  console.log(`[ap-e2e] afterStop=${stopped ? stopped[0] : 'MISSING'} residualPids=${JSON.stringify(residual)} exit=${code}`);
  console.log(`[ap-e2e] checks=${JSON.stringify(checks)}`);
  const failed = Object.keys(checks).filter((k) => !checks[k]);
  if (failed.length) {
    console.log(`[ap-e2e] captured output:\n${output}`);
    console.log(`AP-E2E FAIL: ${failed.join(', ')}`);
  } else {
    console.log('AP-E2E PASS: 托盘启动路径 -> 自定义参数生效 -> 引擎由主进程拉起 -> 浮窗切投屏 -> 停止后无残留');
  }
  cleanup();
  // 显式退出：假 H264 喂料的定时器/管道句柄可能还在，不能让进程挂着
  process.exit(failed.length ? 1 : 0);
});
