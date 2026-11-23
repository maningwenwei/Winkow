#!/usr/bin/env node
'use strict';

/**
 * 真实 Electron 浮窗截图诊断：预置 pureMode + web，连 CDP 截宿主页面，
 * 并用 elementFromPoint 量化顶部中心到底哪个元素盖在最上层。
 * 只访问本机回环 HTTP，独立 userDataDir，不碰用户真实配置。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9347;
const TMP = path.join(os.tmpdir(), `winkow-real-pure-${process.pid}`);
const USER_DATA = path.join(TMP, 'userData');
const SHOT = path.join(__dirname, 'pure-evidence-v2.png');
const DEV_ELECTRON = process.env.WINKOW_EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PACKED = !!process.env.WINKOW_EXE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>PureProbe</title></head>' +
  '<body style="margin:0;background:#dde6ff;color:#111;font:20px sans-serif">' +
  '<h1 style="padding:40px">PURE PROBE 页面内容</h1></body></html>';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/probe`;
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'moyu-config.json'), JSON.stringify({
    mode: 'web', webUrl: url, firstRun: false, muted: true,
    pureMode: true, trayVisible: false, autoStart: false, contentProtection: false
  }, null, 2), 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(DEV_ELECTRON, PACKED
    ? [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`]
    : ['.', `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`],
  { cwd: ROOT, env, windowsHide: true });

  let output = '';
  child.stdout.on('data', (c) => { output += c.toString(); });
  child.stderr.on('data', (c) => { output += c.toString(); });

  const done = (code) => {
    try { child.kill('SIGKILL'); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(code);
  };
  // 硬超时：无论卡在哪里，40 秒后强制退出，绝不挂起
  const guard = setTimeout(() => {
    console.error('ERROR global timeout');
    done(2);
  }, 40000);
  guard.unref();

  try {
    let targets = [];
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = await r.json();
        if (targets.some((t) => t.type === 'page' && /float\.html/.test(t.url))) break;
      } catch (_) {}
      await sleep(250);
    }
    const page = targets.find((t) => t.type === 'page' && /float\.html/.test(t.url));
    if (!page) throw new Error('没找到浮窗 target。targets=' + JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url }))));

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    };
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result ? r.result.value : null;
    };

    await sleep(2500); // 等页面导航 + webview 加载
    // 模拟用户真实观感：webbar 收起态（真实场景默认收起，:focus-within 才滑出）
    await ev(`(() => {
      const bar = document.getElementById('webBar');
      if (bar) bar.classList.remove('peek');
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return true;
    })()`);
    await sleep(500);
    const info = await ev(`JSON.stringify((() => {
      const ds = document.getElementById('dragStrip') || document.querySelector('.drag-strip');
      const i = ds ? ds.querySelector('i') : null;
      const r = ds ? ds.getBoundingClientRect() : null;
      const cs = ds ? getComputedStyle(ds) : null;
      const is = i ? getComputedStyle(i) : null;
      const cx = r ? Math.round(r.left + r.width / 2) : 10;
      const cy = r ? Math.round(r.top + r.height / 2) : 10;
      const top = document.elementFromPoint(cx, cy);
      return {
        pure: document.body.classList.contains('pure'),
        modeWeb: document.body.classList.contains('mode-web'),
        dragStripFound: !!ds,
        rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
        display: cs ? cs.display : null,
        visibility: cs ? cs.visibility : null,
        opacity: cs ? cs.opacity : null,
        zIndex: cs ? cs.zIndex : null,
        iDisplay: is ? is.display : null,
        iOpacity: is ? is.opacity : null,
        iWidth: is ? is.width : null,
        iBackground: is ? is.backgroundImage.slice(0, 60) : null,
        topAtCenter: top ? (top.tagName + (top.id ? '#' + top.id : '') + (top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\\s+/).join('.') : '')) : null,
        barPeek: (() => { const b = document.getElementById('webBar'); return b ? b.classList.contains('peek') : null; })(),
        barTransform: (() => { const b = document.getElementById('webBar'); return b ? getComputedStyle(b).transform : null; })(),
        /* 关键三组数：壳从窗口顶部下移多少；横条底边是否正好等于壳顶（=整条在壳外）；
           画面（.viewport）是否回到壳顶、不再为横条让位。 */
        shellTop: (() => { const s = document.querySelector('.shell'); return s ? Math.round(s.getBoundingClientRect().top) : null; })(),
        stripBottom: (() => { const d = document.querySelector('.drag-strip'); return d ? Math.round(d.getBoundingClientRect().bottom) : null; })(),
        stripBg: (() => { const d = document.querySelector('.drag-strip'); return d ? getComputedStyle(d).backgroundColor : null; })(),
        stripInShell: (() => {
          const s = document.querySelector('.shell'); const d = document.querySelector('.drag-strip');
          if (!s || !d) return null;
          return Math.round(d.getBoundingClientRect().bottom) <= Math.round(s.getBoundingClientRect().top);
        })(),
        stageTop: (() => { const s = document.querySelector('.stage'); return s ? Math.round(s.getBoundingClientRect().top) : null; })(),
        viewportRect: (() => { const v = document.querySelector('.viewport'); if (!v) return null; const q = v.getBoundingClientRect(); return { y: Math.round(q.top), h: Math.round(q.height) }; })(),
        viewportZ: (() => { const v = document.querySelector('.viewport'); return v ? getComputedStyle(v).zIndex : null; })(),
        viewZ: (() => { const v = document.getElementById('view'); return v ? getComputedStyle(v).zIndex : null; })()
      };
    })())`);
    console.log('DIAG ' + info);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('SHOT ' + SHOT);
    // 顶部 30px 放大裁剪
    const clip = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width: 372, height: 30, scale: 5 }
    });
    fs.writeFileSync(SHOT.replace('.png', '-top.png'), Buffer.from(clip.data, 'base64'));
    console.log('SHOT ' + SHOT.replace('.png', '-top.png'));
    // 右下角放大裁剪：真实 Electron 里确认折角是圆弧（harness 截图不算数）
    const vp = await ev('JSON.stringify({w: innerWidth, h: innerHeight})');
    const { w, h } = JSON.parse(vp || '{"w":440,"h":275}');
    const corner = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: w - 34, y: h - 34, width: 34, height: 34, scale: 8 }
    });
    fs.writeFileSync(SHOT.replace('.png', '-corner.png'), Buffer.from(corner.data, 'base64'));
    console.log('SHOT ' + SHOT.replace('.png', '-corner.png'));
    done(0);
  } catch (e) {
    console.error('ERROR ' + e.message);
    console.error(output.slice(-1500));
    done(1);
  }
});
