#!/usr/bin/env node
'use strict';

/**
 * test-airplay-vnet.js —— 没有手机、没有 Electron 的情况下，验证「生产代码」里
 * 引擎 → 主进程收流 → 帧事件 这条链路是通的。
 *
 * 做法：
 *   1. 把 `electron` 模块换成一份最小 stub（app / dialog / desktopCapturer），
 *      这样 src/main/airplay.js 能被直接 require；
 *   2. 用 tools/vnet-replay.js 在 127.0.0.1:7788 冒充引擎的 -vnet 端口；
 *   3. 断言 renderMode 判定为 'vnet'、_engineEnv 里 GST_PLUGIN_PATH 指对了、
 *      VnetSource 收到帧且首帧是 SPS。
 *
 * 这些都不是「看起来对」，而是 POC 里最容易出错的三处：路径推导、参数拼装、
 * 帧边界解析。真机只差最后一步「手机连上来」。
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

// ---- 1. electron stub ------------------------------------------------------
const stubPath = path.join(__dirname, '_electron-stub.js');
fs.writeFileSync(stubPath, `
module.exports = {
  app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  desktopCapturer: { getSources: async () => [] }
};
`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stubPath;
  return origResolve.call(this, request, ...rest);
};

const AirPlay = require(path.join(__dirname, '..', 'src', 'main', 'airplay.js'));
const { VnetSource } = require(path.join(__dirname, '..', 'src', 'main', 'vnet.js'));

const PORT = 7788;
const fails = [];
const oks = [];
const check = (name, cond, detail) => (cond ? oks.push(name) : fails.push(name + (detail ? ' -> ' + detail : '')));

(async () => {
  // ---- 2. 起一个「假引擎」 -------------------------------------------------
  const replay = require('child_process').spawn(process.execPath, [
    path.join(__dirname, 'vnet-replay.js'),
    path.join(__dirname, '..', '..', 'poc-build', 'vnet-out.h264'),
    String(PORT), '30', '1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  replay.stdout.on('data', () => {});
  replay.stderr.on('data', (d) => console.error('[replay]', d.toString().trim()));

  // ---- 3. 真实 AirPlay 实例（不 start 引擎，只测判定与收流） ----------------
  const cfg = {
    airplayRender: 'vnet',
    airplayVnetPort: PORT,
    airplayBasePort: 7000,
    airplayResolution: '720x1560',
    airplayFps: 30,
    airplayNoPin: false,
    airplayCastAudio: false,
    airplayEnginePath: ''
  };
  const ap = new AirPlay({ config: { get: () => cfg, set: () => {} } });
  // relay / 中继在真实应用里由 index.js 组装；这里只需要 status() 不炸
  ap.relay = ap.relay || { status: () => ({ paused: false }) };
  ap.name = 'WinkowTest';
  ap.pin = '5676';
  ap.tmpDir = path.join(require('os').tmpdir(), 'winkow-vnet-test');
  try { fs.mkdirSync(ap.tmpDir, { recursive: true }); } catch (_) {}

  // 找引擎：airplay/ 里现在有 uxplay-cli.exe
  ap.engineFile = ap.findEngine();
  ap.engineKind = ap.engineFile ? ap.engineType(ap.engineFile) : '';
  check('findEngine 找到 uxplay-cli.exe', /uxplay-cli\.exe$/i.test(ap.engineFile || ''), ap.engineFile);
  check('engineType 判为 cli', ap.engineKind === 'cli', ap.engineKind);

  const mode = ap._resolveRenderMode();
  check("renderMode = 'vnet'", mode === 'vnet', mode);

  const args = ap._buildArgs();
  // vnet 通道不再用 fakesink：fakesink 仍会把每帧喂进 GStreamer（解码 + 按 PTS
  // 同步），那条管线跟收流无关，却是引擎里唯一可能反压 AirPlay 接收线程的地方。
  // 传 0 之后 use_video=false，video_process 里只剩非阻塞的 vnet 发送。
  check("参数含 -vs 0（不建视频管线）", args.join(' ').indexOf('-vs 0') >= 0, args.join(' '));
  check('video sink 就是 0', args[args.indexOf('-vs') + 1] === '0', args[args.indexOf('-vs') + 1]);
  check('参数含 -vnet 7788', args.join(' ').indexOf('-vnet 7788') >= 0, args.join(' '));

  const env = ap._engineEnv(ap.engineFile);
  const wantPlugins = path.join(path.dirname(ap.engineFile), 'lib', 'gstreamer-1.0');
  check('GST_PLUGIN_PATH 指向发行包插件目录', env.GST_PLUGIN_PATH === wantPlugins, env.GST_PLUGIN_PATH);
  check('GST_REGISTRY 落在会话临时目录', !!env.GST_REGISTRY && env.GST_REGISTRY.indexOf(ap.tmpDir) === 0, env.GST_REGISTRY);
  check('PATH 首位是引擎目录', (env.PATH || '').split(';')[0] === path.dirname(ap.engineFile), (env.PATH || '').slice(0, 80));

  // ---- 4. 收流 -------------------------------------------------------------
  const frames = [];
  let first = null;
  await new Promise((resolve) => {
    ap.on('vnetFrame', (buf, ts) => {
      if (!first) first = { len: buf.length, ts, head: buf.subarray(0, 4).toString('hex') };
      frames.push(ts);
      if (frames.length >= 40) resolve();
    });
    ap._startVnet(cfg);
    setTimeout(resolve, 12000);
  });

  check('收到 vnet 帧', frames.length > 0, 'frames=' + frames.length);
  check('首帧以 Annex-B 起始码开头', !!first && /^000001|^00000001/.test(first.head), first && first.head);
  const hdr = first ? parseInt(first.head.slice(-2), 16) : -1;
  check('首帧是 SPS (NAL type 7)', ((hdr & 0x1f) === 7), 'nal=' + (hdr & 0x1f));
  const st = ap.vnet ? ap.vnet.status() : {};
  check('VnetSource 无坏帧', (st.badFrames || 0) === 0, JSON.stringify(st));

  /* ---- 5. 显隐不能碰任何窗口 / PowerShell -------------------------------
   *
   * 用户报的「浮窗收起几秒再唤出，画面就没了，手机上还显示正在投屏」就是这里：
   * vnet 通道下 setHidden / rearm 只要退化到同步 PowerShell（一次 400~700ms），
   * 主进程就会停止读 socket，引擎那头 send 停顿累计 1s 便把连接关掉；新连接在
   * 会话中途拿不到 SPS/PPS，画面再也起不来。
   * 断言方式：把两条窗口通道换成计数桩，要求「一次都不许调」。
   */
  let psCalls = 0, hostCalls = 0, ticks = 0;
  ap._ps = () => { psCalls += 1; return null; };
  ap._hostSend = () => { hostCalls += 1; return Promise.resolve(null); };
  ap._windowTick = async () => { ticks += 1; return null; };
  ap.phase = 'running';

  const hid = ap.setHidden(true);
  check('vnet 隐藏不调窗口通道', psCalls === 0 && hostCalls === 0, `ps=${psCalls} host=${hostCalls}`);
  check('vnet 隐藏仍标记 hidden', hid && hid.hidden === true, JSON.stringify(hid && hid.hidden));
  ap.setHidden(false);
  ap.rearm('test');
  ap._onSessionStart();
  check('vnet 下 rearm / 会话开始不探测窗口', ticks === 0, 'ticks=' + ticks);

  /* ---- 6. 断流看门狗 ---------------------------------------------------- */
  const fake = {
    connected: true,
    frames: 100,
    reconnected: 0,
    reconnect() { fake.reconnected += 1; },
    status: () => ({ port: PORT, connected: true, frames: 100 })
  };
  ap.vnet = fake;
  ap.session = true;
  ap.sessionLost = false;
  ap._startDiag();
  await new Promise((r) => setTimeout(r, 6500));
  clearInterval(ap.diagTimer);
  check('断流 5 秒后重建收流连接', fake.reconnected === 1, 'reconnect=' + fake.reconnected);
  check('断流原因写进日志', (ap.log || []).some((l) => l.indexOf('没有收到任何帧') >= 0),
    (ap.log || []).slice(-3).join(' | '));
  ap.session = false;

  /* ---- 6b. 隐藏期间绝不主动断开 -----------------------------------------
   * 用户的明确要求：「隐藏不要断开投屏连接和画面」。看门狗在隐藏态必须
   * 一次都不重连、不重启引擎，只把零帧时长记在账上；重新显示时若确实一直
   * 零帧（引擎/手机那边真出过事），才补一次重连 —— 引擎会补发 SPS/PPS 与
   * 最近 IDR，画面立刻回来。
   */
  fake.frames = 200;            // 帧数冻住 = 隐藏后零帧
  fake.reconnected = 0;
  ap.session = true;
  ap.sessionLost = false;
  ap.hidden = false;
  ap.phase = 'running';
  ap._startDiag();
  ap.setHidden(true);
  await new Promise((r) => setTimeout(r, 6500));
  const hiddenReconnects = fake.reconnected;
  clearInterval(ap.diagTimer);
  check('隐藏期间看门狗不重建连接', hiddenReconnects === 0, 'reconnect=' + hiddenReconnects);
  check('隐藏期间零帧时长被记账', (ap._vnetHiddenStall || 0) >= 4, 'stall=' + ap._vnetHiddenStall);
  ap.setHidden(false);
  check('重新显示时补一次重连', fake.reconnected === 1, 'reconnect=' + fake.reconnected);
  ap.session = false;

  // ---- 7. 清理 -------------------------------------------------------------
  ap._stopVnet();
  try { replay.kill(); } catch (_) {}
  try { fs.unlinkSync(stubPath); } catch (_) {}

  console.log('');
  oks.forEach((n) => console.log('  OK   ' + n));
  fails.forEach((n) => console.log('  FAIL ' + n));
  console.log('');
  console.log('VnetSource status:', JSON.stringify(st));
  console.log('首帧:', JSON.stringify(first));
  console.log('');
  console.log(fails.length ? '[FAIL] ' + fails.length + ' 项未通过' : '[PASS] 主进程链路全部通过 (' + oks.length + ' 项)');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { fs.unlinkSync(stubPath); } catch (_) {}
  process.exit(1);
});
