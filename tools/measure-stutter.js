#!/usr/bin/env node
'use strict';

/**
 * measure-stutter.js —— 在**真实运行的 Winkow** 里量「画面更新」的节奏抖动。
 *
 * 为什么要单独做这个工具：
 *   「规律地一秒卡一下」这种描述只能落到数字上才有意义 —— 是**到达**间隔在抖，
 *   还是**绘制**间隔在抖，还是两者都抖但成因不同。三者对应三条完全不同的链路：
 *     到达（onVnetFrame）  : 主进程 recv → IPC → 渲染进程
 *     绘制（ctx.drawImage）: rAF 调度 → 合成
 *
 * 做法：在页面脚本跑起来**之前**注入探针（Page.addScriptToEvaluateOnNewDocument），
 * 包住 window.moyu.onVnetFrame 和 CanvasRenderingContext2D.drawImage，记下每次
 * 时间戳；然后拉起假引擎 + 重放服务器，跑一段时间后统计间隔分布。
 *
 * 判读：
 *   - gap 里出现 ~900~1100ms 的尖峰、且周期规律 → 有 1Hz 的阻塞源
 *   - 到达不抖、只有绘制抖 → 渲染进程自己卡（DOM 更新 / rAF 被抢）
 *   - 两者同时抖 → 主进程被阻塞，IPC 成批投递
 *
 * usage: node tools/measure-stutter.js [port] [seconds]
 */

const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.argv[2] || '9336', 10);
const SEC = parseInt(process.argv[3] || '20', 10);
const H264 = path.join(process.env.TEMP || '.', 'moyu-airplay-sample.h264');
const REPLAY = path.join(__dirname, 'vnet-replay.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const rec = { arrive: [], draw: [], raf: [] };
  window.__probe = rec;
  const wrapHook = () => {
    if (!(window.moyu && window.moyu.onVnetFrame)) return false;
    const orig = window.moyu.onVnetFrame;
    window.moyu.onVnetFrame = function (cb) {
      return orig.call(this, function (payload) {
        rec.arrive.push(performance.now());
        return cb(payload);
      });
    };
    return true;
  };
  if (!wrapHook()) {
    let n = 0;
    const t = setInterval(() => { if (wrapHook() || ++n > 400) clearInterval(t); }, 5);
  }
  const P = CanvasRenderingContext2D.prototype;
  const od = P.drawImage;
  P.drawImage = function () {
    rec.draw.push(performance.now());
    return od.apply(this, arguments);
  };
  const loop = (t) => { rec.raf.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})()`;

const SUMMARY = `(() => {
  const p = window.__probe || { arrive: [], draw: [], raf: [] };
  const gaps = (a) => {
    const g = [];
    for (let i = 1; i < a.length; i++) g.push(a[i] - a[i - 1]);
    return g;
  };
  const stat = (a) => {
    const g = gaps(a);
    if (!g.length) return { n: a.length, gaps: 0 };
    const s = g.slice().sort((x, y) => x - y);
    const pct = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))] * 10) / 10;
    const over = (ms) => g.filter((x) => x > ms).length;
    // >80ms 的「大空档」按秒分桶，规律性 1Hz 阻塞会集中在同一秒偏移上
    const bigAt = [];
    for (let i = 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      if (d > 80) bigAt.push(Math.round(a[i] - a[0]));
    }
    return {
      n: a.length,
      mean: Math.round((g.reduce((x, y) => x + y, 0) / g.length) * 10) / 10,
      p50: pct(0.5), p95: pct(0.95), max: Math.round(s[s.length - 1] * 10) / 10,
      over80: over(80), over200: over(200),
      bigAt: bigAt.slice(0, 40)
    };
  };
  return {
    spanMs: Math.round((p.raf[p.raf.length - 1] || 0) - (p.raf[0] || 0)),
    arrive: stat(p.arrive),
    draw: stat(p.draw),
    raf: stat(p.raf)
  };
})()`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('[FAIL] 没有 page 目标'); process.exit(1); }
  console.log('[target]', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => {
    const id = ++mid;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => pending.set(id, res));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  console.log('[page] reloaded with probe');

  // 假引擎不监听端口，vnet 端口留给重放服务器
  const started = await send('Runtime.evaluate', {
    expression: `window.moyu.airplayAction('start').then(s => ({render:s.render, alive:s.engineAlive}))`,
    awaitPromise: true, returnByValue: true
  });
  console.log('[start]', JSON.stringify(started.result.result.value));

  const args = [REPLAY, H264, '7788', '30', '1'];
  console.log('[replay]', H264);
  const rep = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  rep.stdout.on('data', (d) => process.stdout.write('[replay] ' + d));
  rep.stderr.on('data', (d) => process.stderr.write('[replay!] ' + d));

  await sleep(SEC * 1000);

  const r = await send('Runtime.evaluate', { expression: SUMMARY, returnByValue: true });
  console.log(JSON.stringify(r.result.result.value, null, 2));

  rep.kill();
  await send('Runtime.evaluate', { expression: `window.moyu.airplayAction('stop')`, awaitPromise: true });
  ws.close();
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1); });
