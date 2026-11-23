/* 设置窗口层级验证：设置必须压在浮窗上面（浮窗是 alwaysOnTop，容易被反超）。
 *
 * 判定方式用 Win32 的 z 序：EnumWindows 的枚举顺序就是「从上到下」，
 * 同一进程里两个 Chrome_WidgetWin_1（浮窗 420x300 / 设置 568x664）谁先出现谁在上。
 * 覆盖三种会反超的时机：刚打开、浮窗隐藏后再唤出、改配置（浮窗会重新
 * setAlwaysOnTop，把自己顶到 TOPMOST 组首）。
 *
 * 用法：node tools/test-settings-zorder.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const koffi = require('koffi');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
// 设 WINKOW_EXE 可以直接测打包后的 Winkow.exe（asar 版），不设则跑源码
const EXE = process.env.WINKOW_EXE || ELECTRON;
const ARGS = process.env.WINKOW_EXE ? [] : ['.'];
const PORT = 9468;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`PASS ${name}${extra ? ` (${extra})` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};

const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(void *hwnd, intptr lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr lParam)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *h)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, void *buf, int n)');

/** 返回该 pid 下可见的 Chrome_WidgetWin_1，顺序即 z 序（索引 0 最上）。 */
function windowsOf(pid) {
  const list = [];
  const cb = (hwnd) => {
    const p = [0];
    GetWindowThreadProcessId(hwnd, p);
    if (p[0] !== pid) return true;
    const cls = Buffer.alloc(256);
    GetClassNameW(hwnd, cls, 128);
    if (cls.toString('utf16le').replace(/\0.*$/, '') !== 'Chrome_WidgetWin_1') return true;
    const r = {};
    if (!GetWindowRect(hwnd, r)) return true;
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (w < 80 || h < 60) return true;
    if (!IsWindowVisible(hwnd)) return true;
    list.push({ hwnd, w, h, rect: r });
    return true;
  };
  EnumWindows(cb, 0);
  return list;
}

/** 把两个窗口分成「浮窗（小）」和「设置（大）」，并给出各自 z 索引。 */
function classify(pid) {
  const ws = windowsOf(pid);
  const settings = ws.find((x) => x.w >= 520);
  const float = ws.find((x) => x.w < 520);
  return {
    all: ws.map((x) => `${x.w}x${x.h}`),
    settingsIdx: settings ? ws.indexOf(settings) : -1,
    floatIdx: float ? ws.indexOf(float) : -1,
    settingsHwnd: settings ? settings.hwnd : 0,
    floatHwnd: float ? float.hwnd : 0
  };
}

async function evalIn(expr) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /float\.html/.test(t.url));
  if (!page) throw new Error('NO_FLOAT_TARGET');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const out = await new Promise((res) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) res(m.result && m.result.result && m.result.result.value);
    };
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true }
    }));
  });
  try { ws.close(); } catch (_) {}
  return out;
}

async function until(fn, ms) {
  const t = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch (_) {}
    if (Date.now() - t > ms) return false;
    await sleep(200);
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winkow-zorder-'));
  fs.writeFileSync(path.join(tmp, 'moyu-config.json'), JSON.stringify({
    configVersion: 7,
    mode: 'idle',
    alwaysOnTop: true,
    pureMode: true,
    hideOnMouseLeave: false,
    firstRun: false,
    window: { x: 260, y: 180, width: 420, height: 300 }
  }, null, 2), 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MOYU_SMOKE;

  const child = spawn(EXE, [...ARGS, `--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, stdio: 'ignore' });

  try {
    const ready = await until(async () => {
      try { return (await evalIn('document.readyState')) === 'complete'; } catch (_) { return false; }
    }, 25000);
    ok('浮窗就绪', ready);

    await evalIn(`window.moyu.openSettings('about')`);
    const shown = await until(async () => {
      const c = classify(child.pid);
      return c.settingsIdx >= 0 && c.floatIdx >= 0;
    }, 15000);
    const c1 = classify(child.pid);
    ok('设置窗口已打开（568 宽的那扇）', shown, `窗口=${c1.all.join(' / ')}`);
    ok('刚打开时设置压在浮窗上面（z 序更靠前）',
      c1.settingsIdx >= 0 && c1.floatIdx >= 0 && c1.settingsIdx < c1.floatIdx,
      `settings#${c1.settingsIdx} < float#${c1.floatIdx}`);

    // 浮窗隐藏再唤出：show() 会重新 SetWindowPos(TOPMOST)，最容易反超
    await evalIn(`window.moyu.hide('test')`);
    await sleep(900);
    await evalIn(`window.moyu.show()`);
    await sleep(1200);
    const c2 = classify(child.pid);
    ok('浮窗唤出后，设置仍在最上面',
      c2.settingsIdx >= 0 && c2.floatIdx >= 0 && c2.settingsIdx < c2.floatIdx,
      `settings#${c2.settingsIdx} < float#${c2.floatIdx}`);

    // 改配置：float.applyConfig 会 setAlwaysOnTop，同样会顶到最前
    await evalIn(`window.moyu.setConfig({ opacity: 0.9 })`);
    await sleep(900);
    const c3 = classify(child.pid);
    ok('改配置后（浮窗重新置顶），设置仍在最上面',
      c3.settingsIdx >= 0 && c3.floatIdx >= 0 && c3.settingsIdx < c3.floatIdx,
      `settings#${c3.settingsIdx} < float#${c3.floatIdx}`);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(fail === 0 ? `[PASS] 设置窗口层级 ${pass}/${pass}` : `[FAIL] ${fail} 项不符（共 ${pass + fail}）`);
  process.exit(fail === 0 ? 0 : 1);
})();
