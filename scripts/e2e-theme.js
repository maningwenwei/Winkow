'use strict';

/**
 * 主题 e2e（真窗口，不是 mock）：
 *   1) 默认「跟随系统」时，浮窗挂到系统当前明暗
 *   2) 在设置页点「浅色」，浮窗与设置页必须同时变浅（不是只有设置页变）
 *   3) 选择落盘，重启后仍然是浅色（首帧就是浅的，不会先闪一帧深色）
 *
 * 做法：起真实应用（源码 + 临时 userData + 远端调试端口），用 CDP 直接读
 * 两个窗口的 <html data-theme>，并模拟点选设置页的三段单选。
 *
 *   node scripts/e2e-theme.js
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const USERDATA = path.join(os.tmpdir(), 'winkow-theme-e2e');
const CFG = path.join(USERDATA, 'moyu-config.json');
const PORT = 9333;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}${extra ? `  [${extra}]` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `  [${extra}]` : ''}`); }
};

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

/** 在某个 target 里执行表达式，拿回值。 */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('cdp timeout')); }, 9000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (msg.result && msg.result.exceptionDetails) {
        const d = msg.result.exceptionDetails;
        reject(new Error(`evaluate failed: ${d.text} ${(d.exception && d.exception.description) || ''}`));
        return;
      }
      resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp socket error')); });
  });
}

/**
 * 页面刚被 CDP 挂上时，document 可能还在导航、documentElement 为 null。
 * 这类失败不是逻辑错，重试几百毫秒就好。
 */
async function evaluateSafe(wsUrl, expression, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try { return await evaluate(wsUrl, expression); }
    catch (e) {
      if (i === tries - 1) throw e;
      await wait(350);
    }
  }
}

/** 等到某个页面出现（app 启动 + 窗口加载需要几秒）。 */
async function findPage(match, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await getJson('/json/list');
      const hit = list.find((t) => t.type === 'page' && t.url.includes(match));
      if (hit && hit.webSocketDebuggerUrl) return hit;
    } catch (_) {}
    await wait(350);
  }
  return null;
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
  } catch (_) {}
}

function seed(cfg) {
  fs.mkdirSync(USERDATA, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
}

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${USERDATA}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env, stdio: 'ignore', windowsHide: true
  });
  return child;
}

(async () => {
  // 干净起跑：不预置 theme，测「老配置没有这个键」的默认路径
  fs.rmSync(USERDATA, { recursive: true, force: true });
  seed({ configVersion: 4, animationMs: 170 });
  console.log('launch 1 …');

  let child = launch();
  child.on('error', (e) => console.error('[spawn error]', e.message));
  try {
    const floatPage = await findPage('float.html');
    if (!floatPage) throw new Error('浮窗没起来');
    console.log('float target:', floatPage.url);
    const floatTheme = () => evaluateSafe(floatPage.webSocketDebuggerUrl, 'document.documentElement.dataset.theme || "?"');
    // themeMode（用户选的是哪种）只能等主进程推过来：首帧脚本读的是
    // prefers-color-scheme，只知道「当前该多亮」，不知道用户选的是 system
    // 还是明确的 light。所以这里轮询等推送，不能用一次读取就判定。
    const floatMode = async () => {
      for (let i = 0; i < 14; i += 1) {
        const m = await evaluateSafe(floatPage.webSocketDebuggerUrl,
          'document.documentElement.dataset.themeMode || ""');
        if (m) return m;
        await wait(300);
      }
      return '';
    };

    // 老配置没 theme 键 -> 迁移补 system -> 跟随系统（本机系统是深色）
    const first = await floatTheme();
    ok('老配置缺 theme 键时，浮窗按「跟随系统」取到明暗', first === 'dark' || first === 'light', first);
    const sysIsDark = first === 'dark';
    ok('默认值确实落在 system 上（不是被当成 light/dark）',
      (await floatMode()) === 'system');

    // 打开设置页
    await evaluateSafe(floatPage.webSocketDebuggerUrl, "document.getElementById('btnSettings').click()");
    const setPage = await findPage('settings.html');
    if (!setPage) throw new Error('设置页没起来');

    // 点「浅色」
    await evaluateSafe(setPage.webSocketDebuggerUrl,
      "document.querySelector('input[name=theme][value=light]').click()");
    await wait(700);
    ok('在设置页点「浅色」后，浮窗真的跟着变浅',
      (await floatTheme()) === 'light', await floatTheme());
    ok('设置页自己也变浅',
      (await evaluateSafe(setPage.webSocketDebuggerUrl, 'document.documentElement.dataset.theme')) === 'light');
    ok('选择已落盘',
      JSON.parse(fs.readFileSync(CFG, 'utf8')).theme === 'light',
      JSON.parse(fs.readFileSync(CFG, 'utf8')).theme);

    // 点「深色」再确认一次（双向都得动）
    await evaluateSafe(setPage.webSocketDebuggerUrl,
      "document.querySelector('input[name=theme][value=dark]').click()");
    await wait(600);
    ok('再点「深色」浮窗也立即变深', (await floatTheme()) === 'dark', await floatTheme());

    // 回到「跟随系统」，此时应与系统一致
    await evaluateSafe(setPage.webSocketDebuggerUrl,
      "document.querySelector('input[name=theme][value=system]').click()");
    await wait(600);
    ok('点回「跟随系统」后与系统当前明暗一致',
      (await floatTheme()) === (sysIsDark ? 'dark' : 'light'), await floatTheme());

    // 落盘为 light 后重启：首帧就必须是浅的（不闪深色）
    await evaluateSafe(setPage.webSocketDebuggerUrl,
      "document.querySelector('input[name=theme][value=light]').click()");
    await wait(600);
  } finally {
    killTree(child.pid);
    await wait(1500);
  }

  child = launch();
  try {
    const page2 = await findPage('float.html');
    if (!page2) throw new Error('重启后浮窗没起来');
    // findPage 只保证「页面被 CDP 挂上」，不保证首帧内联脚本已经跑完。
    // 直接读一次会拿到 undefined（不是 dark，是还没写），那是探针竞态不是产品错。
    // 轮询等到 dataset 出现即可；若产品真错成 dark，这里照样会 FAIL。
    let t2 = '';
    for (let i = 0; i < 12; i += 1) {
      t2 = await evaluateSafe(page2.webSocketDebuggerUrl,
        'document.documentElement.dataset.theme || ""');
      if (t2) break;
      await wait(300);
    }
    ok('重启后仍是浅色（读的是配置，不是系统）', t2 === 'light', t2 || '(empty)');
    const mode2 = await evaluateSafe(page2.webSocketDebuggerUrl,
      'document.documentElement.dataset.themeMode || "?"');
    ok('重启后设置页三段仍选中「浅色」对应的 mode', mode2 === 'light', mode2);
  } finally {
    killTree(child.pid);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} pass / ${fail} fail`);
  if (fail) process.exitCode = 1;
})().catch((err) => {
  console.error('E2E ERROR:', err && err.message);
  process.exitCode = 1;
});
