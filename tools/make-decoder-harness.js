#!/usr/bin/env node
'use strict';

/**
 * make-decoder-harness.js —— 用真实录制的码流驱动 src/renderer/vnet-decoder.js，
 * 生成一个自包含页面，用来在没有手机的情况下验证「WebCodecs 解码 + canvas」。
 *
 * 与 make-player.js 的区别：那个测的是「AVCC + avcC 能不能喂进 VideoDecoder」，
 * 这个测的是 **Winkow 真正会用的那个模块**（Annex-B 输入、自己拆包/拼 avcC），
 * 所以它验证的是产品代码，不是验证代码。
 *
 * usage: node tools/make-decoder-harness.js <file.h264> [out.html] [maxFrames]
 */

const fs = require('fs');
const path = require('path');

function splitAU(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push(i); i += 2; }
  }
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let e = end;
    while (e > s + 3 && buf[e - 1] === 0) e--;
    if (s + 3 < e) nals.push(buf.subarray(s, e));
  }
  const aus = [];
  let pending = [];
  for (const n of nals) {
    const type = n[3] & 0x1f;
    if (type === 1 || type === 5) { aus.push(Buffer.concat(pending.concat([n]))); pending = []; }
    else pending.push(n);
  }
  if (pending.length) aus.push(Buffer.concat(pending));
  return aus;
}

const file = process.argv[2];
const outFile = process.argv[3] || 'decoder-harness.html';
const maxFrames = parseInt(process.argv[4] || '300', 10);
if (!file) { console.error('usage: node tools/make-decoder-harness.js <file.h264> [out.html] [frames]'); process.exit(2); }

const aus = splitAU(fs.readFileSync(file)).slice(0, maxFrames);
const payload = Buffer.concat(aus);
/* 把 AU 边界显式传过去。在页面里再按起始码切一遍是错的 —— 那样切出来的是
 * NAL 而不是 AU，SPS / PPS 会被各自当成一帧喂给解码器，PPS 当图像解会直接报错。 */
const lengths = aus.map((a) => a.length);
const decoderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'vnet-decoder.js'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>VnetDecoder harness</title>
<style>
  body{margin:0;background:#0b0d10;color:#e8eaed;font:13px/1.5 system-ui,"Segoe UI","PingFang SC",sans-serif;
       display:flex;gap:24px;padding:20px;align-items:flex-start}
  canvas{height:70vh;width:auto;border-radius:16px;background:#000;box-shadow:0 16px 40px rgba(0,0,0,.6)}
  .p{width:260px}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #ffffff10}
  .k{color:#8b939e}.v{font-variant-numeric:tabular-nums;font-weight:500}
</style></head><body>
<canvas id="v"></canvas>
<div class="p">
  <div style="font-weight:600;margin-bottom:10px">VnetDecoder 实测</div>
  <div class="row"><span class="k">状态</span><span class="v" id="st">init</span></div>
  <div class="row"><span class="k">已解码</span><span class="v" id="dec">0</span></div>
  <div class="row"><span class="k">尺寸</span><span class="v" id="sz">-</span></div>
  <div class="row"><span class="k">解码帧率</span><span class="v" id="fps">-</span></div>
  <div class="row"><span class="k">丢帧</span><span class="v" id="drop">0</span></div>
  <div class="row"><span class="k">错误</span><span class="v" id="err">0</span></div>
  <div class="row"><span class="k">队列</span><span class="v" id="q">0</span></div>
  <div class="row"><span class="k">codec</span><span class="v" id="codec">-</span></div>
</div>
<script>${decoderSrc}</script>
<script>
const B64 = "${payload.toString('base64')}";
const COUNT = ${aus.length};
const cv = document.getElementById('v');
const set = (id, v) => { document.getElementById(id).textContent = v; };

const dec = new VnetDecoder({
  canvas: cv,
  onSize: (w, h) => { set('sz', w + 'x' + h); window.__size = w + 'x' + h; },
  onState: (s) => { set('st', s); },
  onStats: (o) => {
    set('dec', o.decoded); set('fps', o.fps); set('drop', o.dropped);
    set('err', o.errors); set('q', o.queue); set('codec', o.codec);
    window.__stats = o;
  }
});

// 从 base64 还原字节，再按显式传进来的 AU 长度切片
const bin = atob(B64);
const all = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) all[i] = bin.charCodeAt(i);
const LENS = ${JSON.stringify(lengths)};
const frames = [];
let off = 0;
for (let k = 0; k < LENS.length; k++) { frames.push(all.subarray(off, off + LENS[k])); off += LENS[k]; }

let i = 0;
const t0 = performance.now();
(function pump() {
  const want = Math.min(COUNT, Math.floor((performance.now() - t0) / 33.3) + 1);
  while (i < want && i < frames.length) { dec.push(frames[i], i * 33); i++; }
  if (i < COUNT) setTimeout(pump, 16);
  else { window.__done = true; set('st', 'done'); }
})();
window.__moduleLoaded = true;
</script></body></html>`;

fs.writeFileSync(outFile, html);
console.log('wrote', outFile, (fs.statSync(outFile).size / 1048576).toFixed(2) + ' MB', '| AUs:', aus.length);
