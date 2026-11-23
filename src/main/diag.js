'use strict';

/**
 * 现场取证日志（只在排查期用，不影响功能）。
 *
 * 这次的病是「隐藏浮窗后几秒，vnet 一帧都收不到；手机仍显示投屏中，重连也不
 * 恢复」。它有两个完全不同的可能来源，光看零帧日志分不清：
 *
 *   A. 主进程不再读 socket（事件循环被同步调用钉住 / IPC 投递变慢），
 *      引擎的非阻塞 send 累计 1s 写不动就把客户端关掉（wink_vnet_send_all）；
 *   B. 引擎自己不再调 video_process（音频管线卡住 / 手机停推流）。
 *
 * 所以这里同时记三样东西，任何一样落空都能把范围砍一半：
 *   1. 事件循环卡顿（timer 漂移 > 120ms）与堆占用 —— 查 A；
 *   2. 引擎 stderr 全量逐行落盘（含 `[vnet] client connected/dropped`）—— 查 B；
 *   3. vnet 每秒采样（connected / 累计帧 / 距上次收到数据的毫秒 / socket 已读字节）
 *      —— 区分「没发」和「发了没读」。
 *
 * 文件固定为 %TEMP%/winkow-diag.log，每次启动清空（一次复现一份，不用翻旧数据）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.tmpdir(), 'winkow-diag.log');

let stream = null;
let started = 0;
let lagTimer = null;
let memTimer = null;

function open() {
  if (stream) return stream;
  try {
    // 上一次运行的日志留一份：现场复现往往要连做两组对照（开/关某个开关），
    // 每次启动都覆盖的话，前一组证据就没了。
    if (fs.existsSync(FILE)) {
      try { fs.copyFileSync(FILE, path.join(os.tmpdir(), 'winkow-diag.prev.log')); } catch (_) {}
    }
    stream = fs.createWriteStream(FILE, { flags: 'w' });
    stream.on('error', () => { stream = null; });
  } catch (_) {
    stream = null;
  }
  return stream;
}

/** HH:MM:SS.mmm —— 和 moyu-airplay-last.log 的本地时刻对得上，便于交叉对照。 */
function stamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(tag, msg) {
  const line = `${stamp()} [${tag}] ${msg}\n`;
  const s = open();
  try { if (s) s.write(line); } catch (_) { /* 磁盘满 / 句柄失效都不该影响主流程 */ }
  if (process.env.WINKOW_DIAG_ECHO) {
    try { process.stdout.write(line); } catch (_) {}
  }
}

function mb(n) {
  return (n / 1048576).toFixed(1);
}

/**
 * 事件循环体检。
 *
 * 250ms 的 interval 在 Windows 上本身会有 ~1ms 抖动，阈值取 120ms：正常的
 * 定时器抖动、GC 小停顿都进不来，只有「同步调用钉住主线程」才会记录。
 */
function start() {
  if (started) return;
  started = Date.now();
  log('diag', `start pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node} cwd=${process.cwd()}`);

  let last = Date.now();
  lagTimer = setInterval(() => {
    const now = Date.now();
    const drift = now - last - 250;
    last = now;
    if (drift > 120) log('loop', `事件循环卡顿 ${drift}ms（这一拍本该在 ${new Date(now - drift).toTimeString().slice(0, 8)} 执行）`);
  }, 250);
  if (lagTimer.unref) lagTimer.unref();

  // 堆/外部内存：如果隐藏后 external 一路涨，说明跨进程投递在堆积（IPC 背压）
  memTimer = setInterval(() => {
    const m = process.memoryUsage();
    log('mem', `heap=${mb(m.heapUsed)}M ext=${mb(m.external)}M rss=${mb(m.rss)}M`);
  }, 5000);
  if (memTimer.unref) memTimer.unref();
}

module.exports = { start, log, FILE, uptime: () => (started ? Date.now() - started : 0) };
