'use strict';

/**
 * 真实应用端到端：收起真的会把网页视频停下、唤回真的会续播。
 *
 *   node scripts/e2e-pause-live.js
 *
 * 做法：把打包目录里的「Winkow.exe」用独立 --user-data-dir 拉起（不碰用户配置），
 * 预置「网页模式 + 本地页面（autoplay 视频）」，然后把鼠标移到窗口外触发自动隐藏、
 * 再移回窗口触发恢复，最后用 %TEMP%\moyu-pause.log 里主进程写下的记录做判定。
 *
 * 这一段专门验证「隐藏状态机 -> playback」的接线，探针 probe-pause-hide.js 只验证
 * playback 本身。
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
// 打包目录里的 exe 名跟 productName 走：1.0.39 起是 Winkow.exe，兼容旧产物名
const EXE = ['Winkow.exe', '摸鱼小窗.exe', 'MoyuFloat.exe']
  .map((n) => path.join(ROOT, 'dist', 'win-unpacked', n))
  .find((p) => fs.existsSync(p)) || path.join(ROOT, 'dist', 'win-unpacked', 'Winkow.exe');
const USERDATA = path.join(os.tmpdir(), 'moyu-137-e2e');
const PLOG = path.join(os.tmpdir(), 'moyu-pause.log');
const PORT = 27991;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>e2e media</title>
<style>body{margin:0;background:#fff;font:14px sans-serif}video{width:360px;height:200px;background:#000}</style>
<video id="v" autoplay muted loop playsinline></video>
<script>
function wavUrl(sec, rate) {
  const n = Math.floor(sec * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); put(36, 'data'); dv.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
document.getElementById('v').src = wavUrl(4, 8000);
</script>`;

function moveCursor(x, y) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`
    ], { windowsHide: true, timeout: 15000 });
    return true;
  } catch (_) { return false; }
}

// 1.0.39 把产品名改成了 Winkow，按名字只匹配「摸鱼」就杀不到新进程，
// 旧实例会一直占着单实例锁，导致后面起的第二个进程被顶掉、日志全是旧实例写的。
// 这里同时兼容三个历史进程名，并且只杀 dist\win-unpacked 下的测试实例，
// 不碰用户自己安装的正式版。
const killAll = () => {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { " +
      "($_.ProcessName -like 'Winkow*' -or $_.ProcessName -like '*摸鱼*' -or $_.ProcessName -like 'MoyuFloat*') " +
      "} | ForEach-Object { try { $p = $_.Path } catch { $p = '' } " +
      "if ($p -like '*win-unpacked*') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }"
    ], { windowsHide: true, timeout: 20000 });
  } catch (_) {}
};

run().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); fail += 1; }).then(finish);

function finish() {
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

async function run() {
  if (!fs.existsSync(EXE)) { console.log('缺少打包产物：' + EXE); fail += 1; return; }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  killAll();
  await wait(600);
  fs.rmSync(USERDATA, { recursive: true, force: true });
  fs.mkdirSync(USERDATA, { recursive: true });
  try { fs.writeFileSync(PLOG, ''); } catch (_) {}

  // 窗口固定在一个已知位置：鼠标 (5,5) 一定在外，(830,470) 一定在里
  const cfg = {
    configVersion: 4,
    firstRun: false,
    mode: 'web',
    webUrl: `http://127.0.0.1:${PORT}/`,
    rememberLastUrl: true,
    hideOnMouseLeave: true,
    mouseLeaveDelay: 120,
    mousePadding: 6,
    peekEnabled: false,
    muted: true,
    pauseOnHide: true,
    window: { x: 620, y: 320, width: 420, height: 300 }
  };
  fs.writeFileSync(path.join(USERDATA, 'moyu-config.json'), JSON.stringify(cfg, null, 2));

  console.log(`启动 ${path.basename(EXE)}（user-data-dir=${USERDATA}）`);
  const child = spawn(EXE, [`--user-data-dir=${USERDATA}`], { stdio: 'ignore', windowsHide: false, env: cleanEnv() });

  try {
    // 页面加载 + 视频播起来
    await wait(9000);
    const warm = readLog();
    ok('应用启动并进入网页模式（窗口存活）', isAlive(child), `pid=${child.pid}`);

    // ---- 鼠标移出窗口：自动隐藏 → 暂停 ----
    const moved = moveCursor(5, 5);
    ok('能把光标移到窗口外（触发自动隐藏）', moved);
    await wait(2600);
    const hideLine = readLog().split('\n').filter((l) => /hide frames=/.test(l)).pop() || '';
    ok('收起时暂停了网页里的媒体', /hide frames=\d+ media=[1-9]/.test(hideLine) || /media=[1-9]/.test(hideLine),
      hideLine.trim() || '日志里没有 hide 记录');

    // ---- 鼠标移回窗口：恢复 → 续播 ----
    moveCursor(830, 470);
    await wait(2800);
    const showLine = readLog().split('\n').filter((l) => /show frames=/.test(l)).pop() || '';
    ok('唤回时续播了被暂停的媒体', /show frames=\d+ media=[1-9]/.test(showLine) || /media=[1-9]/.test(showLine),
      showLine.trim() || '日志里没有 show 记录');
    ok('唤回没有多播（不重复 play 用户本来没在放的）', !/media=0/.test(showLine), showLine.trim());

    // ---- 关掉开关：收起时不再暂停 ----
    // 先杀干净再改配置：旧进程退出时会把内存里的配置写回文件，
    // 如果在 killAll 之前写，false 会被退出时的那次写回覆盖成 true。
    const cfg2 = { ...cfg, pauseOnHide: false };
    killAll();
    await wait(1600);
    fs.writeFileSync(path.join(USERDATA, 'moyu-config.json'), JSON.stringify(cfg2, null, 2));
    const wrote = JSON.parse(fs.readFileSync(path.join(USERDATA, 'moyu-config.json'), 'utf8'));
    ok('把 pauseOnHide=false 落盘且没有被退出写回冲掉', wrote.pauseOnHide === false, String(wrote.pauseOnHide));
    try { fs.writeFileSync(PLOG, ''); } catch (_) {}
    const child2 = spawn(EXE, [`--user-data-dir=${USERDATA}`], { stdio: 'ignore', windowsHide: false, env: cleanEnv() });
    await wait(9000);
    try {
      const after = JSON.parse(fs.readFileSync(path.join(USERDATA, 'moyu-config.json'), 'utf8'));
      if (after.pauseOnHide !== false) console.log(`  [diag] 启动后配置文件被改回 pauseOnHide=${after.pauseOnHide}`);
    } catch (e) { console.log('  [diag] 读配置失败 ' + e.message); }
    moveCursor(5, 5);
    await wait(2400);
    const off = readLog();
    ok('第二个进程真的起来了（不是首实例锁把自己顶掉）', isAlive(child2), `pid=${child2.pid}`);
    if (!/hide skipped: pauseOnHide=off/.test(off)) {
      console.log('  [diag] 完整日志：');
      off.split('\n').filter((l) => l.trim()).slice(-12).forEach((l) => console.log('    ' + l.trim()));
    }
    ok('开关关掉后收起不再暂停', /hide skipped: pauseOnHide=off/.test(off), off.split('\n').filter((l) => l.trim()).pop() || '空日志');
    try { child2.kill(); } catch (_) {}
  } finally {
    killAll();
    await wait(800);
    server.close();
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch (_) {}
  }
  finish();
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function isAlive(child) {
  try { return !child.killed && child.exitCode === null; } catch (_) { return false; }
}

function readLog() {
  try { return fs.readFileSync(PLOG, 'utf8'); } catch (_) { return ''; }
}
