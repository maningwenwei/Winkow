/* 截一张「常规」设置的图：验证 1.0.59 删掉「隐藏时静音」、暂停播放写明仅浏览器。
 * usage: node tools/shot-settings-1059.js [out.png] */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = process.argv[2] || path.join(ROOT, 'tools', 'settings-1059.png');
const TAB = process.argv[3] || 'general';
const PORT = 9463;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalIn(port, urlPart, expr) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && urlPart.test(t.url));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const out = await new Promise((res) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m.result); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  try { ws.close(); } catch (_) {}
  return out;
}

async function shot(port, urlPart, file) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && urlPart.test(t.url));
  if (!page) throw new Error('no target ' + urlPart);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const data = await new Promise((res) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1 && m.result && m.result.data) res(m.result.data);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: true } }));
  });
  try { ws.close(); } catch (_) {}
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winkow-shot-'));
  fs.writeFileSync(path.join(tmp, 'moyu-config.json'), JSON.stringify({ configVersion: 7, mode: 'idle', firstRun: false, window: { x: 260, y: 200, width: 372, height: 268 } }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { await sleep(400); try { if (await evalIn(PORT, /float\.html/, '1+1')) { ready = true; break; } } catch (_) {} }
    if (!ready) throw new Error('app not ready');
    await evalIn(PORT, /float\.html/, `window.moyu.openSettings(${JSON.stringify(TAB)})`);
    await sleep(2200);
    const rows = await evalIn(PORT, /settings\.html/, `JSON.stringify({
      muteOnHide: !!document.querySelector('[data-key="muteSystemOnHide"]'),
      pause: !!document.querySelector('[data-key="pauseOnHide"]'),
      pauseText: (document.querySelector('[data-key="pauseOnHide"]')||{}).closest ? document.querySelector('[data-key="pauseOnHide"]').closest('.row').querySelector('small').textContent : '',
      switches: document.querySelectorAll('#panel-general .switch input').length
    })`);
    console.log('DOM ' + (rows && rows.result && rows.result.value));
    await evalIn(PORT, /settings\.html/, (TAB === 'general' ? 'document.getElementById(\'content\').scrollTop = 100000' : '1'));
    await sleep(400);
    await shot(PORT, /settings\.html/, OUT);
    console.log('SHOT ' + OUT);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
