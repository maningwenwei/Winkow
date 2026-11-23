'use strict';

/**
 * check-webcodecs-electron.js —— 在**项目自带的 Electron** 里检查 WebCodecs
 * 到底支不支持 avc1（H.264）。
 *
 * 为什么必须单独查：之前的解码验证全在系统 Chrome（新版）里跑的，而 Winkow
 * 打包用的是 Electron 20 / Chromium 104。WebCodecs 早期版本只保证 VP8/VP9/AV1，
 * H.264 是后补的，且和平台解码器有关。如果这里返回 false，整条 vnet 链路在
 * 生产里就是黑的 —— 跟 harness 里跑得多漂亮无关。
 *
 * 用法（必须用项目的 electron 跑，不能用 node）：
 *   ./node_modules/.bin/electron tools/check-webcodecs-electron.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.whenReady().then(async () => {
  /* 必须用 file:// 加载。WebCodecs 的 VideoDecoder 是 SecureContext 接口，
   * 而 data: URL 属于不透明来源 → 不是安全上下文 → VideoDecoder 直接不存在，
   * 会得到一个"这个 Electron 不支持 H.264"的假结论。file: 在 Chromium 里被
   * 视为 potentially trustworthy，才是生产环境的真实情形（浮窗就是 file://）。 */
  const probeHtml = path.join(os.tmpdir(), 'winkow-webcodecs-probe.html');
  fs.writeFileSync(probeHtml, '<!doctype html><meta charset="utf-8"><title>probe</title><body>probe</body>', 'utf8');

  const win = new BrowserWindow({ show: false, width: 320, height: 240 });
  await win.loadFile(probeHtml);

  const script = `(async () => {
    const out = {
      ua: navigator.userAgent,
      hasVideoDecoder: typeof VideoDecoder !== 'undefined',
      hasEncodedChunk: typeof EncodedVideoChunk !== 'undefined',
      hasVideoFrame: typeof VideoFrame !== 'undefined'
    };
    if (!out.hasVideoDecoder) return out;
    const tryCfg = async (name, cfg) => {
      try {
        const s = await VideoDecoder.isConfigSupported(cfg);
        out[name] = !!s.supported;
      } catch (e) { out[name] = 'throw:' + (e && e.message ? e.message : e); }
    };
    await tryCfg('avc1_640020', { codec: 'avc1.640020' });
    await tryCfg('avc1_42E01E', { codec: 'avc1.42E01E' });
    await tryCfg('avc1_with_geom', { codec: 'avc1.640020', codedWidth: 718, codedHeight: 1560 });
    await tryCfg('vp8', { codec: 'vp8' });
    await tryCfg('vp09', { codec: 'vp09.00.10.08' });
    await tryCfg('av01', { codec: 'av01.0.04M.08' });
    // 真正 configure 一次带 avcC 的 H.264，比 isConfigSupported 更能说明问题
    try {
      const avcC = new Uint8Array([1,0x64,0,0x20,0xff,0xe1,0,0x12,0x27,0x64,0,0x20,0xac,0x13,0x14,0x50,0x2d,0x03,0x17,0xa9,0x66,0xe0,0x21,0xa0,0x20,0x40,0x01,0,0x04,0x28,0xee,0x3c,0xb0]);
      const dec = new VideoDecoder({ output: () => {}, error: () => {} });
      dec.configure({ codec: 'avc1.640020', description: avcC, optimizeForLatency: true });
      out.realConfigure = 'ok:' + dec.state;
      dec.close();
    } catch (e) { out.realConfigure = 'throw:' + (e && (e.name + ':' + e.message)); }
    return out;
  })()`;

  try {
    const r = await win.webContents.executeJavaScript(script, true);
    console.log(JSON.stringify(r, null, 2));
    const ok = r && r.hasVideoDecoder && (r.avc1_640020 === true || (typeof r.realConfigure === 'string' && r.realConfigure.indexOf('ok:') === 0));
    console.log('');
    console.log(ok ? '[PASS] 这个 Electron 支持 avc1 的 WebCodecs 解码' : '[FAIL] 这个 Electron 不支持 avc1 的 WebCodecs 解码');
    app.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('[probe error]', e);
    app.exit(2);
  }
});
