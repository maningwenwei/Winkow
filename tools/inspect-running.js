#!/usr/bin/env node
'use strict';

/**
 * inspect-running.js —— 连上一个**已在运行**的 Electron/Chromium 的调试端口，
 * 在真实页面里求值，并把 console 消息收下来。
 *
 * 用途：验证打包后的 Winkow.exe 里渲染层到底有没有起来、预加载有没有注入、
 * 浮窗 UI 有没有画出来。cdp-probe 是自己拉浏览器，这个正好相反——挂到现成的进程上。
 *
 * usage: node tools/inspect-running.js [port] [waitMs]
 */

const PORT = parseInt(process.argv[2] || '9333', 10);
const WAIT_MS = parseInt(process.argv[3] || '3000', 10);
// 第三个参数可给一个表达式覆盖默认探针（用于在打包进程里问被测 API 要真实返回）
const CUSTOM = process.argv[4] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = `(() => {
  const q = (s) => !!document.querySelector(s);
  const out = {
    readyState: document.readyState,
    url: location.href,
    title: document.title,
    hasMoyu: !!window.moyu,
    moyuKeys: window.moyu ? Object.keys(window.moyu).sort() : [],
    hasVideoDecoder: typeof window.VideoDecoder !== 'undefined',
    secureContext: window.isSecureContext,
    bodyChildren: document.body.children.length,
    bodyHTMLHead: (document.body.innerHTML || '').slice(0, 300),
    hasCanvas: q('canvas'),
    canvasSize: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
    hasCard: q('.card') || q('#card'),
    visibility: document.visibilityState,
    err: window.__bootError || null
  };
  return out;
})()`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  if (!pages.length) { console.log('[FAIL] 没有 page 目标'); process.exit(1); }
  const page = pages[0];
  console.log('[target]', page.title, '|', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0;
  const pending = new Map();
  const logs = [];

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : a.description).join(' ');
      logs.push(`[console.${msg.params.type}] ${args}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${d.text} ${d.exception && d.exception.description || ''}`);
    }
    if (msg.method === 'Log.entryAdded') {
      logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`);
    }
  };
  const send = (method, params) => {
    const id = ++mid;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => pending.set(id, res));
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await sleep(WAIT_MS);

  const expr = CUSTOM ? `(async () => { return (${CUSTOM}); })()` : EXPR;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const val = r.result && r.result.result && (r.result.result.value !== undefined ? r.result.result.value : r.result.result.description);
  console.log('[eval]', typeof val === 'string' ? val : JSON.stringify(val, null, 2));
  if (r.result && r.result.exceptionDetails) console.log('[eval-error]', JSON.stringify(r.result.exceptionDetails, null, 2));

  if (logs.length) { console.log('--- console/log (' + logs.length + ') ---'); logs.slice(0, 40).forEach((l) => console.log(l)); }
  else console.log('--- console/log: (无) ---');

  ws.close();
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1); });
