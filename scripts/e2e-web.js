'use strict';

/**
 * 真实应用端到端回归：预置配置里的 webUrl -> 启动应用 -> 观察 webview guest
 * 是否 did-finish-load。只访问本机回环 HTTP，不依赖外网。
 *
 *   node scripts/e2e-web.js                                  # 源码模式
 *   node scripts/e2e-web.js dist/win-unpacked/Winkow.exe  # 打包后的目录版 exe
 *
 * 用独立的 --user-data-dir，因此不会碰用户的真实配置，也不会与用户正在运行的
 * 实例争抢单实例锁（否则新进程会启动即退出）。临时目录在结束时清理。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `moyu-e2e-${process.pid}`);
const USER_DATA = path.join(TMP, 'userData');
const logFile = path.join(TMP, 'smoke.log');
const cfgFile = path.join(USER_DATA, 'moyu-config.json');
const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const target = process.argv[2] ? path.resolve(process.argv[2]) : DEV_ELECTRON;
const packaged = path.resolve(target) !== path.resolve(DEV_ELECTRON);

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head>' +
  '<body style="background:#ffe9a8"><h1>E2E-WEB-OK</h1></body></html>';

let finished = false;

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

if (!fs.existsSync(DEV_ELECTRON)) {
  process.stderr.write('[e2e] 需要先安装 Electron\n');
  process.exit(1);
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/e2e`;

  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({
      mode: 'web', webUrl: url, firstRun: false, muted: true,
      trayVisible: false, autoStart: false, contentProtection: false
    }, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[e2e] 预置配置失败: ${err.message}\n`);
    cleanup();
    server.close();
    process.exit(1);
  }

  const env = { ...process.env, MOYU_SMOKE: '1', MOYU_SMOKE_LOG: logFile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const args = packaged ? [`--user-data-dir=${USER_DATA}`] : ['.', `--user-data-dir=${USER_DATA}`];
  const child = spawn(target, args, { cwd: ROOT, env, windowsHide: true });
  let output = '';
  const collect = (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const timer = setTimeout(() => {
    if (!finished) {
      process.stderr.write('[e2e] 超时，终止应用\n');
      try { child.kill(); } catch (_) {}
    }
  }, 30000);

  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    cleanup();
    process.stderr.write(`[e2e] 无法启动: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();

    try { output += fs.readFileSync(logFile, 'utf8'); } catch (_) {}
    const ready = /\[moyu-smoke\] float ready/.test(output);
    const loaded = /\[moyu-smoke\] webview loaded/.test(output);
    const failed = /\[moyu-smoke\] webview failed/.test(output);
    const full = /\[moyu-smoke\] viewport[^\n]*FULL/.test(output);
    const clipped = /\[moyu-smoke\] viewport[^\n]*CLIPPED/.test(output);
    const landscape = /\[moyu-smoke\] webfit[^\n]*LANDSCAPE/.test(output);
    const ok = ready && loaded && !failed && full && !clipped && landscape && code === 0;
    process.stdout.write(`[e2e] target=${path.basename(target)} ready=${ready} loaded=${loaded} ` +
      `failed=${failed} viewportFull=${full} clipped=${clipped} webLandscape=${landscape} exit=${code} url=${url}\n`);
    if (!ok) process.stdout.write(`[e2e] captured output:\n${output}\n`);
    process.stdout.write(ok
      ? 'E2E PASS: 配置 -> 广播 -> 标签页 webview 完整加载、视口铺满且窗口为横屏\n'
      : 'E2E FAIL: 网页加载 / 视口铺满 / 横屏适配校验未通过\n');
    cleanup();
    process.exitCode = ok ? 0 : 1;
  });
});
