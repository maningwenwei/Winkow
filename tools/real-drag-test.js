/* 真实系统鼠标拖动测试：验证顶部横条能不能拖动窗口。
 *
 * 为什么必须用真实鼠标事件：渲染层自己算的 pointer 事件、CDP 注入的
 * Input.dispatchMouseEvent、elementFromPoint 都测不出「窗口有没有真的移动」。
 * 只有 SetCursorPos + mouse_event 走系统输入队列，再用 GetWindowRect 读回
 * 窗口位置，才能证明拖动是否生效。
 *
 * 用法：node tools/real-drag-test.js [y偏移=10]
 *   y 偏移是相对窗口顶端的物理像素，横条带是 0~20（纯净模式）/ 0~14（普通模式）。
 */
const { execFileSync } = require('child_process');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(void *hwnd, intptr lParam)');
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr lParam)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *h)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *h, int cmd)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *h)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, int32 dx, int32 dy, uint32 data, uintptr extra)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function winkowPids() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process Winkow,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Id -join ','`
    ], { encoding: 'utf8' }).trim();
    return out ? out.split(',').map(Number).filter(Boolean) : [];
  } catch (_) { return []; }
}

function findWindow(pids) {
  const found = [];
  const cb = (hwnd) => {
    const pidBuf = [0];
    GetWindowThreadProcessId(hwnd, pidBuf);
    if (!pids.includes(pidBuf[0])) return true;
    if (!IsWindowVisible(hwnd)) return true;
    const r = {};
    if (!GetWindowRect(hwnd, r)) return true;
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (w < 80 || h < 60) return true;
    found.push({ hwnd, pid: pidBuf[0], rect: r, area: w * h });
    return true;
  };
  EnumWindows(cb, 0);
  found.sort((a, b) => b.area - a.area);
  return found[0] || null;
}

function rect(h) {
  const r = {};
  GetWindowRect(h, r);
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

async function main() {
  const yOff = Number(process.argv[2] || 10);
  const pids = winkowPids();
  if (!pids.length) { console.error('NO_PROCESS'); process.exit(1); }
  let target = findWindow(pids);
  if (!target) { console.error('NO_WINDOW'); process.exit(1); }
  const h = target.hwnd;

  ShowWindow(h, 5);            // SW_SHOW
  SetForegroundWindow(h);
  await sleep(500);
  // 鼠标先压进窗口里，避免「移开就自动隐藏」把窗口收走
  const r0 = rect(h);
  SetCursorPos(Math.round((r0.x + r0.x + r0.w) / 2), r0.y + Math.round(r0.h / 2));
  await sleep(600);

  const b0 = rect(h);
  const cx = b0.x + Math.round(b0.w / 2);
  const cy = b0.y + yOff;
  console.log('BOUNDS0 ' + JSON.stringify(b0));

  // 真实拖动：按下 → 分 8 步右移 → 抬起
  const cur = {};
  GetCursorPos(cur);
  SetCursorPos(cx, cy);
  await sleep(220);
  mouse_event(0x0002, 0, 0, 0, 0);        // LEFTDOWN
  await sleep(200);
  for (let i = 1; i <= 8; i++) {
    SetCursorPos(cx + i * 8, cy);
    await sleep(45);
  }
  await sleep(120);
  mouse_event(0x0004, 0, 0, 0, 0);        // LEFTUP
  await sleep(450);

  const b1 = rect(h);
  const dx = b1.x - b0.x;
  const dy = b1.y - b0.y;
  console.log(`DRAG y=${yOff} moved by (${dx}, ${dy})`);
  console.log(dx > 40 ? '[PASS] 横条能拖动窗口' : '[FAIL] 横条拖不动窗口');

  // 对照组：画面中部按下拖动，窗口不应该动
  const cy2 = b0.y + Math.round(b0.h * 0.6);
  SetCursorPos(cx, cy2);
  await sleep(200);
  mouse_event(0x0002, 0, 0, 0, 0);
  await sleep(150);
  for (let i = 1; i <= 8; i++) { SetCursorPos(cx + i * 8, cy2); await sleep(40); }
  mouse_event(0x0004, 0, 0, 0, 0);
  await sleep(400);
  const b2 = rect(h);
  const cx2 = b2.x - b1.x;
  console.log(`CONTROL moved by (${cx2}, ${b2.y - b1.y})`);
  console.log(cx2 === 0 ? '[PASS] 对照组（画面区）不拖动窗口' : '[FAIL] 对照组异常');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
