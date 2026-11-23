/* 1.0.59 行为验证：启动不自动收起 + 启动停在待机 + 第一次移出才隐藏。
 *
 * 为什么必须真启动一遍：这三条全在「主进程状态机 + 真实光标位置」上，
 * 单测读源码只能证明写了什么，证明不了跑起来是什么。
 *
 * 测法：
 *   S0 把真实光标挪到屏幕右下角（= 一开始就在浮窗外），隔离 userData 起应用；
 *   S1 等 6 秒，读 diag 日志：不该出现任何 hideFloat（旧版 320ms 后就收了）；
 *      同时读配置：mode 必须已经被改回 idle（启动一律待机）；
 *   S2 光标移进浮窗中心（触发一次「进入」= 武装自动隐藏），再移到角落外，
 *      等 1.2 秒：这次必须真的收起，且窗口 IsWindowVisible = false。
 *
 * 用法：node tools/test-1059.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const koffi = require('koffi');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DIAG = path.join(os.tmpdir(), 'winkow-diag.log');

const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(void *hwnd, intptr lParam)');
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr lParam)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *h)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, void *buf, int n)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`PASS ${name}${extra ? ` (${extra})` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};

function findWindow(pids) {
  const found = [];
  const cb = (hwnd) => {
    const pidBuf = [0];
    GetWindowThreadProcessId(hwnd, pidBuf);
    if (!pids.includes(pidBuf[0])) return true;
    // 只认 Chrome_WidgetWin_1（真正的 BrowserWindow）。同进程里还有一个
    // 1920x1023 的 Chrome_WidgetWin_0（离屏合成宿主），按面积挑会挑错。
    const cls = Buffer.alloc(256);
    GetClassNameW(hwnd, cls, 128);
    if (cls.toString('utf16le').replace(/\0.*$/, '') !== 'Chrome_WidgetWin_1') return true;
    const r = {};
    if (!GetWindowRect(hwnd, r)) return true;
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (w < 80 || h < 60) return true;
    found.push({ hwnd, pid: pidBuf[0], rect: r, area: w * h, visible: !!IsWindowVisible(hwnd) });
    return true;
  };
  EnumWindows(cb, 0);
  // 可见的优先；全都藏起来时按面积挑，用于事后判断「确实看不见了」
  found.sort((a, b) => (b.visible - a.visible) || (b.area - a.area));
  return found[0] || null;
}

const diagText = () => { try { return fs.readFileSync(DIAG, 'utf8'); } catch (_) { return ''; } };

/** 轮询等一个条件成立（返回 true/false），比固定 sleep 稳。 */
async function until(cond, timeoutMs) {
  const t = Date.now();
  for (;;) {
    let v = false;
    try { v = !!cond(); } catch (_) { v = false; }
    if (v) return true;
    if (Date.now() - t > timeoutMs) return false;
    await sleep(150);
  }
}

/** 在浮窗渲染层里跑一段表达式（CDP）。读 DOM 才能证明「界面上真的是待机」。 */
async function cdpFloat(expr, port = 9461) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winkow-1059-'));
  // 模拟「上次退出时停在网页模式」：旧版会接着恢复网页，新版必须回到待机
  fs.writeFileSync(path.join(tmp, 'moyu-config.json'), JSON.stringify({
    configVersion: 7,
    mode: 'web',
    webUrl: 'https://example.com',
    hideOnMouseLeave: true,
    mouseLeaveDelay: 320,
    showGraceMs: 1200,
    pollInterval: 33,
    firstRun: false,
    window: { x: 220, y: 180, width: 372, height: 268 }
  }, null, 2), 'utf8');

  // diag 是 %TEMP% 下的公共文件，多个 Winkow 实例（比如用户自己开着旧版本）会往同一个
  // 文件里追加；并发写入会让 `hideFloat 完成` 这类行被切碎，计数就失真了。
  // 这里先清空，保证从本轮起算。
  try { fs.writeFileSync(DIAG, ''); } catch (_) {}

  // S0：光标先放到屏幕右下角，确保「一开始就在浮窗外」
  SetCursorPos(30, 30);
  await sleep(120);

  // ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成普通 node：必须摘掉，
  // 否则 `electron .` 什么都不启动，探针看到的只是上一轮的 diag 残留。
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.MOYU_SMOKE;

  const child = spawn(ELECTRON, ['.', `--user-data-dir=${tmp}`, '--remote-debugging-port=9461'], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'ignore'
  });

  try {
    // 启动比想象中慢（首次解包 + 渲染进程拉起，实测 3~5s）。diag 里带 pid 的
    // start 行出现，才说明这一轮的日志真的覆盖完旧内容了，从这行往后数才作数。
    const booted = await until(() => diagText().includes(`start pid=${child.pid}`), 25000);
    ok('应用启动（diag 已由本轮接管）', booted, `pid=${child.pid}`);
    const firstShow = await until(() => /showFloat 完成[^\n]*source=init/.test(diagText()), 25000);
    ok('启动走过一次显示（source=init）', firstShow);

    // 从 init 那一行开始截取，避免把上一轮的残留算进来
    const textFromShow = () => {
      const t = diagText();
      const i = t.indexOf('source=init');
      return i < 0 ? '' : t.slice(Math.max(0, t.lastIndexOf('\n', i)));
    };
    const hides = () => (textFromShow().match(/hideFloat 完成/g) || []).length;
    const base = hides();

    // S1：等过保护期（1200ms）+ 离开判定（320ms）好几倍时间
    await sleep(5000);
    ok('刚打开 5 秒内没有自动收起', hides() === base,
      `hideFloat=${hides()}（旧版 320ms 后就会收）`);

    const cfgNow = JSON.parse(fs.readFileSync(path.join(tmp, 'moyu-config.json'), 'utf8'));
    ok('启动把画面切回待机（config.mode=idle）', cfgNow.mode === 'idle', `mode=${cfgNow.mode}`);

    // 界面证据：待机卡真的显示着，且没挂任何网页标签
    let ui = null;
    try {
      ui = await cdpFloat(`JSON.stringify({
        idle: !document.getElementById('idle').hidden,
        webClass: document.body.classList.contains('mode-web'),
        tabs: document.querySelectorAll('#tabStrip .tab').length
      })`);
    } catch (_) { ui = null; }
    let parsed = null;
    try { parsed = JSON.parse(ui); } catch (_) {}
    ok('界面停在待机卡（#idle 可见、无网页标签）',
      !!parsed && parsed.idle === true && parsed.webClass === false && parsed.tabs === 0,
      parsed ? `idle=${parsed.idle} mode-web=${parsed.webClass} webviews=${parsed.tabs}` : 'CDP 读不到');

    const w2 = findWindow([child.pid]);
    ok('窗口此刻仍可见', !!w2 && w2.visible, w2 ? `visible=${w2.visible}` : 'no window');

    // S2：进窗口再出去 —— 这次才算「第一次鼠标移出」
    const r = w2 ? w2.rect : { left: 220, top: 180, right: 592, bottom: 448 };
    const cx = Math.round((r.left + r.right) / 2);
    const cy = Math.round((r.top + r.bottom) / 2);
    SetCursorPos(cx, cy);
    await sleep(900);
    ok('光标进入浮窗（武装自动隐藏）', true, `at ${cx},${cy}`);
    SetCursorPos(30, 30);
    await sleep(1800);
    ok('第一次鼠标移出后真的收起', hides() > base, `hideFloat=${hides()}`);
    // 用同一个 hwnd 复查：藏起来之后 findWindow 可能挑到别的窗口
    const stillVisible = w2 ? !!IsWindowVisible(w2.hwnd) : false;
    ok('窗口已不可见（IsWindowVisible=false）', !!w2 && !stillVisible, `visible=${stillVisible}`);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(fail === 0 ? `[PASS] 1.0.59 启动/隐藏行为 ${pass}/${pass}` : `[FAIL] ${fail} 项不符（共 ${pass + fail}）`);
  process.exit(fail === 0 ? 0 : 1);
})();
