'use strict';

/**
 * 让「静音按钮」真正管住电脑播放出来的投屏声音。
 *
 * AirPlay 音频由 uxplay-windows.exe 经 WASAPI 直接输出，不经过 Electron 的
 * WebContents：AudioPolicy.setAudioMuted 对它完全无效。这里通过 Windows 音量
 * 合成器的 per-session ISimpleAudioVolume::SetMute，按进程名只静音引擎那条
 * 系统音频会话，不动系统主音量、不影响别的程序 —— 与「工具内静音」同一套语义。
 *
 * 为什么不能只在「状态变化时」同步一次：
 *   音频会话要等 iPhone 连上、音频管道起来之后才注册。接收器刚启动那一刻
 *   根本没有会话；1.0.24 只在启动时起一个「等 6 秒」的脚本，手机稍晚连上
 *   就错过，于是「设置默认静音，投屏上去声音却还在，必须手动开关一下才生效」。
 *
 * 现在改成「状态确认 + 有界重试」：只要接收器在跑、投放声音开着、目标静音态
 * 已确定，就用单遍 PowerShell 去读/设会话并**校验结果**；没确认就快速重试，
 * 确认后降到低频复核（防引擎中途换音频设备新建会话）。手机一连上约 1 秒生效。
 * 每次只做一遍枚举，不在 powershell 里睡，进程开销可控。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const diag = require('./diag');

const FAST_MS = 1200;      // 未确认 / 刚变化时
const ACTIVE_SLOW_MS = 2500; // 会话已建立但还没确认时的退避
const IDLE_MS = 8000;      // 还没人投屏时的慢速等待
const SETTLE_MS = 10000;   // 已确认后的低频复核（防新建会话）
const POKE_MS = 60;        // 合并同一拍里的多次状态变化

let scriptPath = '';
let engineActive = false;   // 接收器进程在跑
let sessionActive = false;  // iPhone 正在镜像（音频会话可能存在）
let castAudio = true;       // 「投放声音」开关
let desired = null;         // 目标静音状态；null = 尚未同步过
let hiddenMute = false;     // 浮窗收起导致的临时静音（覆盖 desired，优先级更高）
let confirmed = false;      // 目标状态是否已落到真实会话上
let busy = false;
let misses = 0;
let pollTimer = null;
let lastResult = '';

/** 真正要落到会话上的静音状态：用户静音 或 因隐藏而静音。 */
function wantMute() {
  return !!desired || hiddenMute;
}

/** asar 里的 .ps1 无法被 powershell.exe 直接读，先落到临时目录（保留 BOM）。 */
function script() {
  if (scriptPath) return scriptPath;
  try {
    const src = fs.readFileSync(path.join(__dirname, 'audio-session.ps1'), 'utf8');
    const out = path.join(os.tmpdir(), 'moyu-audio-session.ps1');
    fs.writeFileSync(out, src.charCodeAt(0) === 0xfeff ? src : `\ufeff${src}`, 'utf8');
    scriptPath = out;
    return out;
  } catch (_) {
    return '';
  }
}

function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!engineActive || !castAudio || (desired === null && !hiddenMute)) return;
  pollTimer = setTimeout(() => { pollTimer = null; tick(); }, ms);
  if (pollTimer.unref) pollTimer.unref();
}

/** 任何状态变化都重置确认标记，并把同一拍里的多次调用合并成一次探测。 */
function poke() {
  confirmed = false;
  misses = 0;
  schedule(POKE_MS);
}

function tick() {
  if (busy) { schedule(FAST_MS); return; }
  if (!engineActive || !castAudio || (desired === null && !hiddenMute) || process.platform !== 'win32') return;
  const file = script();
  if (!file) { schedule(IDLE_MS); return; }
  const want = wantMute() ? 'on' : 'off';
  busy = true;
  const t0 = Date.now();
  const args = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', file,
    '-ProcName', 'uxplay', '-SetMute', want,
    '-WaitSeconds', '0'     // 单遍枚举；等待/重试交给 Node 侧，避免 PS 进程常驻
  ];
  execFile('powershell.exe', args, {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 64 * 1024
  }, (err, stdout) => {
    busy = false;
    lastResult = err ? 'ERR' : String(stdout || '').trim();
    // 这条是本次排查的核心嫌疑之一：隐藏时会对**引擎自己的 WASAPI 会话**
    // 调 ISimpleAudioVolume::SetMute。若引擎侧因此卡住，video_process 不再
    // 被调用，vnet 就一帧都没有 —— 而手机仍显示投屏中。记下耗时与结果，
    // 和 winkow-diag.log 里同一秒的 `[vnet] sinceData` 一对，就能判定。
    diag.log('audio', `SetMute ${want} 耗时 ${Date.now() - t0}ms · ${lastResult.slice(0, 120) || 'no-output'}`);
    // 光「跑过脚本」不算生效：必须真的找到会话、且读回来的 mute 等于目标值。
    const m = /^OK\s+(\d+)\s+mute=(\d)$/.exec(lastResult);
    const ok = !!m && Number(m[1]) > 0 && Number(m[2]) === (wantMute() ? 1 : 0);
    confirmed = ok;
    misses = ok ? 0 : misses + 1;
    if (ok) schedule(SETTLE_MS);
    else schedule(misses < 6 ? FAST_MS : (sessionActive ? ACTIVE_SLOW_MS : IDLE_MS));
  });
}

/** 接收器启动 / 停止。 */
function setEngineActive(active) {
  const next = !!active;
  if (next === engineActive) return;
  engineActive = next;
  poke();
}

/** 手机开始 / 结束镜像：新会话会新建一条 WASAPI 音频会话，必须重新落静音。 */
function setSessionActive(active) {
  const next = !!active;
  if (next === sessionActive) return;
  sessionActive = next;
  if (next) poke();
  else { confirmed = false; schedule(IDLE_MS); }
}

/** 「投放声音」关掉时引擎用 fakesink，本来就没有音频会话，不必再跑脚本。 */
function setCastAudio(enabled) {
  const next = enabled !== false;
  if (next === castAudio) return;
  castAudio = next;
  poke();
}

/**
 * 浮窗收起 / 恢复时的临时静音。
 *
 * 收起时必须把投屏声音一起压住，但这条静音不是用户设置里那个「静音」开关：
 * 恢复时得回到用户原本的选择。单独立一个覆盖位，desired 保持「用户意图」不变，
 * 轮询按 wantMute() 取合并后的结果 —— 否则收起后最多 10 秒，那次 SETTLE 复核
 * 就会按 desired=false 把会话又放开，声音在后台自己响起来。
 */
function setHiddenMute(on) {
  const next = !!on;
  if (next === hiddenMute) return;
  hiddenMute = next;
  poke();
}

/**
 * 静音状态同步。force 用于「状态没变但会话换了一条」的场景（手机重新镜像 /
 * 开关投放声音），否则只有状态真正变化才重新确认，避免拖动滑块时刷进程。
 */
function applyEngineMute(muted, opts = {}) {
  const want = !!muted;
  if (desired === want && !opts.force) return;
  desired = want;
  poke();
}

function status() {
  return { engineActive, sessionActive, castAudio, desired, hiddenMute, confirmed, busy, lastResult };
}

module.exports = {
  setEngineActive, setSessionActive, setCastAudio, applyEngineMute, setHiddenMute, status
};
