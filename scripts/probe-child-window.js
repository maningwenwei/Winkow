/**
 * 探针：透明（frameless）浮窗里能不能塞一个原生 WS_CHILD 子窗口？
 *
 * 为什么问这个：
 *   如果可行，就能让引擎把画面直接画进浮窗（SetParent），彻底不需要
 *   「桌面窗口 + 浮窗遮盖 + WGC 捕获」这条链，画质和延迟都会好一个档次。
 *   如果不可行（layered / DirectComposition 吞掉子窗口），这条路就只能
 *   靠改引擎输出（appsink）来实现。
 *
 * 做法：Electron 开一扇 transparent 窗，Python ctypes 建一个黑色 STATIC
 * 子窗口挂上去，然后抓整屏像素，看那块区域是不是黑的。
 *
 * 判读：
 *   - 屏幕像素变黑 => 子窗口可见 => SetParent 路线成立
 *   - 屏幕像素仍是背景色 => 被父窗口合成吞掉 => 路线不成立
 */
'use strict';
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(os.tmpdir(), 'winkow-child-window.log');
try { fs.unlinkSync(LOG); } catch (_) {}
const log = (s) => { fs.appendFileSync(LOG, s + '\n'); console.log(s); };

const PY = [
  'import ctypes, sys, time, json',
  'from ctypes import wintypes',
  'u = ctypes.WinDLL("user32", use_last_error=True)',
  'parent = int(sys.argv[1])',
  'pax, pay, rx, ry, w, h, sf = [float(v) for v in sys.argv[2:9]]',
  'abx, aby = int(round((pax + rx) * sf)), int(round((pay + ry) * sf))',
  'pw, ph = int(round(w * sf)), int(round(h * sf))',
  'WS_POPUP = 0x80000000',
  'WS_CHILD = 0x40000000',
  'WS_VISIBLE = 0x10000000',
  'SS_BLACKRECT = 0x00000004',
  '# 跨进程 SetParent 要求两个进程 DPI 感知级别一致，否则 ERROR_INVALID_STATE(5023)。',
  '# Electron 是 per-monitor-v2，这里必须跟上，system-aware 不够。',
  'try:',
  '    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))',
  'except Exception:',
  '    u.SetProcessDPIAware()',
  'u.CreateWindowExW.restype = ctypes.c_void_p',
  'u.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,',
  '                              ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,',
  '                              ctypes.c_void_p, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]',
  'u.SetParent.restype = ctypes.c_void_p',
  'u.SetParent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]',
  'u.SetWindowLongW.restype = ctypes.c_long',
  'u.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]',
  'u.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,',
  '                           ctypes.c_int, ctypes.c_int, ctypes.c_uint]',
  '# 先建成 popup，再 SetParent 过去：直接以别的进程的 HWND 当 parent 建窗会失败',
  'hwnd = u.CreateWindowExW(0, "STATIC", "", WS_POPUP | WS_VISIBLE | SS_BLACKRECT,',
  '                         abx, aby, pw, ph, None, None, None, None)',
  'if not hwnd:',
  '    print(json.dumps({"ok": False, "err": "CreateWindowEx %d" % ctypes.get_last_error()}), flush=True)',
  '    sys.exit(1)',
  'prev = u.SetParent(ctypes.c_void_p(hwnd), ctypes.c_void_p(parent))',
  'err = ctypes.get_last_error()',
  'u.SetWindowLongW(ctypes.c_void_p(hwnd), -16, WS_CHILD | WS_VISIBLE | SS_BLACKRECT)',
  '# SetParent 之后坐标是相对父窗口客户区的，必须换成 rel 而不是绝对坐标',
  'u.SetWindowPos(ctypes.c_void_p(hwnd), None, int(round(rx * sf)), int(round(ry * sf)),',
  '               pw, ph, 0x0014)',
  'u.ShowWindow(ctypes.c_void_p(hwnd), 4)',
  'u.RedrawWindow(ctypes.c_void_p(hwnd), None, None, 0x0085)',
  'print(json.dumps({"ok": True, "prev": prev, "err": err, "hwnd": hwnd,',
  '                  "px": abx, "py": aby, "pw": pw, "ph": ph}), flush=True)',
  'while True: time.sleep(0.5)'
].join('\n');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  const sf = screen.getPrimaryDisplay().scaleFactor;
  const disp = screen.getPrimaryDisplay();
  log(`display=${disp.size.width}x${disp.size.height} scale=${sf}`);

  const win = new BrowserWindow({
    x: 200, y: 160, width: 460, height: 320,
    frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, resizable: false, skipTaskbar: true,
    show: false,
    webPreferences: { backgroundThrottling: false }
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="margin:0;background:rgba(255,214,0,0.55)">'
    + '<div style="font:14px sans-serif;padding:8px">transparent host</div></body>'
  ));
  win.showInactive();
  await wait(700);

  const buf = win.getNativeWindowHandle();
  const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : Number(buf.readUInt32LE(0));
  log(`host hwnd=${hwnd} (0x${hwnd.toString(16)})`);

  const b = win.getBounds();
  const cx = Math.round(b.width / 2 - 100);
  const cy = Math.round(b.height / 2 - 60);
  const kid = spawn('python', ['-u', '-c', PY, String(hwnd),
    String(b.x), String(b.y), String(cx), String(cy), '200', '120', String(sf)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  kid.stdout.on('data', (d) => { out += String(d); });
  kid.stderr.on('data', (d) => log(`py-err: ${String(d).trim()}`));
  await wait(1500);
  log(`py: ${out.trim()}`);

  let child = null;
  try { child = JSON.parse(out.trim().split('\n').pop()); } catch (_) {}

  const shot = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) }
  });
  if (!shot.length) { log('FAIL: 抓不到屏幕'); return finish(kid, win, 1); }
  const bmp = shot[0].thumbnail.toBitmap();
  const W = shot[0].thumbnail.getSize().width;

  const at = (x, y) => {
    const i = ((y * W) + x) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
  };

  if (!child || !child.px) { log('FAIL: 子窗口没建起来'); return finish(kid, win, 1); }
  const midX = Math.round(child.px + child.pw / 2);
  const midY = Math.round(child.py + child.ph / 2);
  const inChild = at(midX, midY);
  const outsideX = Math.round((b.x + 12) * sf);
  const outsideY = Math.round((b.y + b.height - 14) * sf);
  const outside = at(outsideX, outsideY);

  log(`pixel child=rgb(${inChild.r},${inChild.g},${inChild.b}) at ${midX},${midY}`);
  log(`pixel host =rgb(${outside.r},${outside.g},${outside.b}) at ${outsideX},${outsideY}`);

  const childIsBlack = inChild.r < 40 && inChild.g < 40 && inChild.b < 40;
  const hostIsYellow = outside.r > 180 && outside.g > 150 && outside.b < 120;
  log(`check host-transparent-and-visible = ${hostIsYellow}`);
  log(`check child-window-visible        = ${childIsBlack}`);
  log(childIsBlack && hostIsYellow
    ? 'RESULT PASS: 透明浮窗里可以承载原生子窗口（SetParent 路线成立）'
    : 'RESULT FAIL: 子窗口没有出现在透明浮窗上（ladder 被合成吞掉 / 位置不对）');
  return finish(kid, win, childIsBlack && hostIsYellow ? 0 : 1);
}

function finish(kid, win, code) {
  try { py.kill(); } catch (_) {}
  try { win.destroy(); } catch (_) {}
  setTimeout(() => app.exit(code), 300);
}

main().catch((e) => { log('ERR ' + (e && e.stack || e)); app.exit(1); });
