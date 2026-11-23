/* 找到 Winkow/Electron 浮窗的窗口矩形（物理像素）并打印 JSON。
 * 只做一件事：给截图脚本 / 拖动测试提供真实窗口位置。 */
const { execFileSync } = require('child_process');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(void *hwnd, intptr lParam)');

const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr lParam)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *h)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');

function pids() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process Winkow,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Id -join ','`
    ], { encoding: 'utf8' }).trim();
    return out ? out.split(',').map(Number).filter(Boolean) : [];
  } catch (_) { return []; }
}

const list = pids();
const found = [];
EnumWindows((hwnd) => {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  if (!list.includes(pid[0]) || !IsWindowVisible(hwnd)) return true;
  const r = {};
  if (!GetWindowRect(hwnd, r)) return true;
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  if (w < 80 || h < 60) return true;
  found.push({ pid: pid[0], x: r.left, y: r.top, w, h, area: w * h });
  return true;
}, 0);
found.sort((a, b) => b.area - a.area);
console.log(JSON.stringify(found[0] || null));
