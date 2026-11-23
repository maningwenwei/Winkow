#!/usr/bin/env node
'use strict';

/**
 * 浏览器模式 UI 端到端测试：用真实的 float.html / float.css / float.js（只把
 * Electron 桥换成桩），在 Chrome 里把视口切到 372 / 260 两档，验证：
 *   - 窄窗把低频按钮收进「更多」下拉，地址栏仍有足够宽度；
 *   - 收藏 / 历史面板能打开、能切换、能读到条目；
 *   - 缩放按钮的文字层在 hover 背景之上（z-index 可量化）；
 *   - 下拉里的缩放按钮真的会改缩放比例。
 * 同时留两张截图供肉眼复核。
 *
 * usage: node tools/make-browser-harness.js && node tools/test-browser-ui.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'src', 'renderer', '_browser-harness.html');
const PORT = 9341;
const TMP = path.join(process.env.TEMP || '.', `winkow-browser-ui-${process.pid}`);
const SHOT_NARROW = path.join(__dirname, 'browser-ui-narrow.png');
const SHOT_ZOOM = path.join(__dirname, 'browser-ui-zoom.png');
const SHOT_PURE = path.join(__dirname, 'browser-ui-pure.png');
const SHOT_CORNER = path.join(__dirname, 'browser-ui-pure-corner.png');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => p && fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oks = [];
const fails = [];
const check = (name, cond, detail) => (cond ? oks : fails).push(name + (cond ? '' : ` -> ${detail}`));

async function main() {
  if (!CHROME) { console.error('[FAIL] 找不到 Chrome'); process.exit(1); }
  if (!fs.existsSync(HARNESS)) { console.error('[FAIL] 先运行 tools/make-browser-harness.js'); process.exit(1); }

  const url = 'file:///' + HARNESS.replace(/\\/g, '/');
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
    '--allow-file-access-from-files', '--window-size=800,600',
    '--no-first-run', '--no-default-browser-check', url
  ], { stdio: 'ignore' });

  try {
    let targets = [];
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = await r.json();
        if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('file'))) break;
      } catch (_) {}
      await sleep(250);
    }
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('file'));
    if (!page) throw new Error('没有页面 target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const errors = [];
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
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text);
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');

    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception || {}).description);
      return r.result ? r.result.value : null;
    };
    const setWidth = (w, h) => send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false
    });

    for (let i = 0; i < 60; i++) { if (await ev('!!window.__ready')) break; await sleep(100); }
    await sleep(200);
    check('页面进入网页模式', await ev(`getComputedStyle(document.getElementById('webBar')).display`) === 'flex');

    // ---- 状态栏不再有「拖我」，拖拽柄换成圆点 SVG，左上角拖拽柄已去掉 ----
    const chromeBits = await ev(`(async () => {
      const hint = document.getElementById('hint');
      const dragCircles = (id) => document.querySelectorAll('#' + id + ' svg circle').length;
      const rz = getComputedStyle(document.querySelector('.rz-se'), '::after');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      /* 纯净模式临时加 class 量一下顶部横条是否可见、可拖、是否真的在壳外，再还原 */
      document.body.classList.add('pure');
      const strip = document.querySelector('.drag-strip');
      const ss = getComputedStyle(strip);
      const shellRect = document.querySelector('.shell').getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      const stageRect = document.querySelector('.stage').getBoundingClientRect();
      const bar = document.getElementById('webBar');
      /* 浏览条：收起态应藏在画面上边缘之上（透明不接收点击），展开态顶边应等于
         壳（画面）上边缘 —— 也就是从横条下方滑出，不能盖住横条。 */
      bar.classList.remove('peek');
      /* 鼠标可能正停在热区/浏览条上，页面会自己把 peek 加回来；这 400ms 内反复清掉，
         等价于「鼠标已经离开」，否则量到的是过渡中的中间帧。 */
      for (let i = 0; i < 8; i++) { await wait(50); bar.classList.remove('peek'); }
      await wait(200);
      const barClosedTop = Math.round(bar.getBoundingClientRect().top);
      /* 收/放动画在内层 .webbar-body 上：外层一旦上 clip，下拉面板会跟着被裁掉 */
      const barBody = bar.querySelector('.webbar-body');
      const barClosedOpacity = getComputedStyle(barBody).opacity;
      const barClosedClip = getComputedStyle(barBody).clipPath;
      const barOuterClip = getComputedStyle(bar).clipPath;
      bar.classList.add('peek');
      await wait(340);
      const barOpenTop = Math.round(bar.getBoundingClientRect().top);
      /* 横条不在浏览条覆盖范围里，展开时也必须保持可见可点（拖动把手） */
      const stripWhilePeek = {
        opacity: getComputedStyle(strip).opacity,
        pe: getComputedStyle(strip).pointerEvents
      };
      bar.classList.remove('peek');
      await wait(340);
      const stripAfter = {
        opacity: getComputedStyle(strip).opacity,
        pe: getComputedStyle(strip).pointerEvents
      };
      const pure = {
        stripDisplay: ss.display,
        stripRegion: ss.webkitAppRegion || ss.getPropertyValue('-webkit-app-region'),
        stripParent: strip.parentElement ? strip.parentElement.tagName : '',
        stripTop: Math.round(stripRect.top),
        stripHeight: Math.round(stripRect.height),
        stripBottom: Math.round(stripRect.bottom),
        stripBg: ss.backgroundColor,
        shellTop: Math.round(shellRect.top),
        stageTop: Math.round(stageRect.top),
        barClosedTop,
        barClosedOpacity,
        barClosedClip,
        barOuterClip,
        barOpenTop,
        stripWhilePeek,
        stripAfter,
        pureDragCircles: dragCircles('pureDrag')
      };
      document.body.classList.remove('pure');
      return {
        hintText: hint ? hint.textContent : '',
        hasResizeHint: !!document.querySelector('.resize-hint'),
        navDragExists: !!document.getElementById('navDrag'),
        rzBg: rz.backgroundImage,
        pure
      };
    })()`);
    check('右下角「拖我」提示已移除', !chromeBits.hasResizeHint && chromeBits.hintText.indexOf('拖我') < 0,
      JSON.stringify(chromeBits));
    check('左上角拖拽图标已移除（只剩迷你条一处）',
      !chromeBits.navDragExists && chromeBits.pure.pureDragCircles === 6, JSON.stringify(chromeBits));
    check('右下角缩放折角是圆弧 SVG（拐角 A4 4 真圆角，不是折线圆头）',
      /svg/.test(chromeBits.rzBg) && /A4 4/.test(chromeBits.rzBg) && /round/.test(chromeBits.rzBg),
      chromeBits.rzBg);
    check('折角方向正确：竖线在右的 ┘ 形（未左右翻转）',
      /M9 2\.8V5/.test(chromeBits.rzBg) && /H2\.8/.test(chromeBits.rzBg), chromeBits.rzBg);
    check('横条挂在 body 下（不在 .shell 合成层里），且不再用系统拖拽区',
      chromeBits.pure.stripParent === 'BODY' && chromeBits.pure.stripRegion === 'no-drag',
      JSON.stringify({ parent: chromeBits.pure.stripParent, region: chromeBits.pure.stripRegion }));
    check('纯净模式横条贴在窗口最顶端、整条落在壳外',
      chromeBits.pure.stripDisplay !== 'none'
      && chromeBits.pure.stripTop >= 0 && chromeBits.pure.stripTop <= 2
      && chromeBits.pure.stripHeight >= 18
      && chromeBits.pure.shellTop === 20
      && chromeBits.pure.stripBottom === chromeBits.pure.shellTop, JSON.stringify(chromeBits.pure));
    check('横条在壳外，所以是纯透明无玻璃底',
      /^rgba\([^)]*,\s*0(\.0+)?\)$/.test(chromeBits.pure.stripBg), chromeBits.pure.stripBg);
    check('画面不再给横条让位（webview 铺回壳顶）',
      chromeBits.pure.stageTop === chromeBits.pure.shellTop, JSON.stringify(chromeBits.pure));
    check('外层浏览条不做 clip（否则下拉面板会被一起裁掉）',
      chromeBits.pure.barOuterClip === 'none', String(chromeBits.pure.barOuterClip));
    check('浏览条收起时被裁成 0 高（顶边仍贴在画面上边缘）',
      chromeBits.pure.barClosedTop === chromeBits.pure.shellTop
      && chromeBits.pure.barClosedOpacity === '0'
      && /100%/.test(String(chromeBits.pure.barClosedClip)),
      `top=${chromeBits.pure.barClosedTop} shellTop=${chromeBits.pure.shellTop} opacity=${chromeBits.pure.barClosedOpacity} clip=${chromeBits.pure.barClosedClip}`);
    check('浏览条展开后顶边 = 画面上边缘（从横条下方滑出）',
      chromeBits.pure.barOpenTop === chromeBits.pure.shellTop,
      `barTop=${chromeBits.pure.barOpenTop} shellTop=${chromeBits.pure.shellTop}`);
    check('浏览条不再盖住横条（顶边不低于横条底边）',
      chromeBits.pure.barOpenTop >= chromeBits.pure.stripBottom,
      `barTop=${chromeBits.pure.barOpenTop} stripBottom=${chromeBits.pure.stripBottom}`);
    check('浏览条展开时横条保持可见可点（仍是拖动把手）',
      chromeBits.pure.stripWhilePeek.opacity === '1' && chromeBits.pure.stripWhilePeek.pe === 'auto',
      JSON.stringify(chromeBits.pure.stripWhilePeek));
    check('浏览条收起后横条恢复可拖',
      chromeBits.pure.stripAfter.opacity === '1' && chromeBits.pure.stripAfter.pe === 'auto',
      JSON.stringify(chromeBits.pure.stripAfter));

    // ---- 常规宽度 ----
    await setWidth(372, 300);
    await sleep(200);
    const wide = JSON.parse(await ev(`(() => {
      const g = (id) => document.getElementById(id);
      const d = (id) => getComputedStyle(g(id)).display;
      return JSON.stringify({ more: d('navMore'), star: d('navStar'), list: d('navLists'),
        reload: d('navReload'), newtab: d('navNewTab'), url: Math.round(g('navUrl').getBoundingClientRect().width) });
    })()`));
    check('372px：更多按钮隐藏', wide.more === 'none', JSON.stringify(wide));
    check('372px：收藏/历史/刷新/新标签直接可见',
      ['star', 'list', 'reload', 'newtab'].every((k) => wide[k] !== 'none'), JSON.stringify(wide));
    // 放大镜挪进导航栏后多占 24px + gap，地址栏从 ~174 降到 ~148；140 仍能看清域名
    check('372px：地址栏宽度足够', wide.url >= 140, String(wide.url));

    // 放大镜按钮已挪进浏览器导航栏，不再在浮窗顶栏 tools 里
    const zoomHome = JSON.parse(await ev(`JSON.stringify((() => {
      const z = document.getElementById('btnZoom');
      const bar = document.getElementById('webBar');
      return {
        inBar: !!bar && bar.contains(z),
        inTopTools: !!document.querySelector('header .tools #btnZoom'),
        parentClass: z.parentElement.className
      };
    })())`));
    check('放大镜在浏览器导航栏内', zoomHome.inBar, JSON.stringify(zoomHome));
    check('放大镜不在浮窗顶栏', !zoomHome.inTopTools, JSON.stringify(zoomHome));

    // ---- 260px 窄窗 ----
    await setWidth(260, 260);
    await sleep(250);
    const narrow = JSON.parse(await ev(`(() => {
      const g = (id) => document.getElementById(id);
      const d = (id) => getComputedStyle(g(id)).display;
      return JSON.stringify({ more: d('navMore'), star: d('navStar'), list: d('navLists'),
        reload: d('navReload'), newtab: d('navNewTab'), url: Math.round(g('navUrl').getBoundingClientRect().width) });
    })()`));
    check('260px：更多按钮出现', narrow.more !== 'none', JSON.stringify(narrow));
    check('260px：四个低频按钮被收起',
      ['star', 'list', 'reload', 'newtab'].every((k) => narrow[k] === 'none'), JSON.stringify(narrow));
    check('260px：地址栏仍可用', narrow.url >= 80, String(narrow.url));

    // ---- 更多下拉 ----
    await ev(`document.getElementById('navMore').click(); true`);
    await sleep(120);
    check('点开更多下拉', await ev(`!document.getElementById('morePop').hidden`));
    const more = JSON.parse(await ev(`(() => {
      const g = (id) => document.getElementById(id);
      const cs = (el) => getComputedStyle(el);
      return JSON.stringify({
        items: document.querySelectorAll('#morePop .more-item').length,
        zoomTextPos: cs(g('mZoomReset').querySelector('span')).position,
        zoomTextZ: cs(g('mZoomReset').querySelector('span')).zIndex,
        hoverLayerZ: getComputedStyle(g('mZoomReset'), '::before').zIndex
      });
    })()`));
    check('下拉里有 5 个功能项', more.items === 5, JSON.stringify(more));
    check('缩放文字被抬到 hover 背景之上', more.zoomTextPos === 'relative' && more.zoomTextZ === '1'
      && more.hoverLayerZ === '0', JSON.stringify(more));
    await ev(`document.getElementById('mZoomIn').click(); true`);
    check('下拉里的放大真的生效', await ev(`document.getElementById('mZoomLabel').textContent`) === '110%',
      await ev(`document.getElementById('mZoomLabel').textContent`));

    // ---- 收藏 / 历史面板 ----
    await ev(`document.getElementById('mMoreBookmarks').click(); true`);
    await sleep(200);
    const marks = JSON.parse(await ev(`(() => ({
      open: !document.getElementById('webListPop').hidden,
      rows: document.querySelectorAll('#webListBody .wlp-item').length,
      first: (document.querySelector('#webListBody .wlp-title') || {}).textContent || '',
      moreText: (document.getElementById('wlpMore') || {}).textContent || ''
    }))()`).then((v) => JSON.stringify(v)));
    check('收藏面板打开并有条目', marks.open && marks.rows >= 1 && marks.first === 'A 站', JSON.stringify(marks));
    check('收藏夹同样懒加载（首屏 30 条）',
      marks.rows === 30 && /还有 4 条/.test(marks.moreText), JSON.stringify(marks));
    await ev(`document.getElementById('wlpMore').click(); true`);
    await sleep(80);
    check('收藏夹加载更多后补齐 34 条',
      await ev(`document.querySelectorAll('#webListBody .wlp-item').length`) === 34,
      await ev(`document.querySelectorAll('#webListBody .wlp-item').length`));
    await ev(`Array.from(document.querySelectorAll('.wlp-tab')).find((b) => b.dataset.list === 'history').click(); true`);
    await sleep(80);
    const hist = JSON.parse(await ev(`JSON.stringify({
      rows: document.querySelectorAll('#webListBody .wlp-item').length,
      first: (document.querySelector('#webListBody .wlp-title') || {}).textContent || '',
      days: Array.from(document.querySelectorAll('#webListBody .wlp-day')).map((e) => e.textContent),
      moreText: (document.getElementById('wlpMore') || {}).textContent || '',
      scrollbar: getComputedStyle(document.getElementById('webListBody')).scrollbarWidth
    })`));
    check('切到历史能看到条目', hist.rows >= 1 && hist.first === 'B 站', JSON.stringify(hist));
    check('历史首屏只渲染一页（懒加载）', hist.rows === 30 && /还有 8 条/.test(hist.moreText), JSON.stringify(hist));
    check('历史有「今天/昨天/三天前/更早」分界线',
      ['今天', '昨天', '三天前', '更早'].every((d) => hist.days.indexOf(d) >= 0), JSON.stringify(hist.days));
    check('列表滚动条已隐藏', hist.scrollbar === 'none', String(hist.scrollbar));

    // 点「加载更多」后补齐剩余条目
    await ev(`document.getElementById('wlpMore').click(); true`);
    await sleep(80);
    const moreLoaded = JSON.parse(await ev(`JSON.stringify({
      rows: document.querySelectorAll('#webListBody .wlp-item').length,
      moreText: (document.getElementById('wlpMore') || {}).textContent || ''
    })`));
    check('加载更多后渲染全部 38 条', moreLoaded.rows === 38 && /已显示全部/.test(moreLoaded.moreText), JSON.stringify(moreLoaded));

    // ---- 星标严格模式：只认当前标签真实地址 ----
    // harness 初始进入 A 站（已收藏），星标应点亮
    check('已收藏页星标点亮', await ev(`document.getElementById('navStar').classList.contains('on')`));
    // 切到未收藏页：星标必须熄灭（旧 bug 是残留点亮）
    await ev(`window.__go('https://unbookmarked.test/'); true`);
    await sleep(80);
    check('切到未收藏页星标熄灭',
      !(await ev(`document.getElementById('navStar').classList.contains('on')`)),
      await ev(`document.getElementById('navUrl').value`));
    // 新建空标签页：星标同样熄灭
    await ev(`window.__newTab(); true`);
    await sleep(80);
    check('新建标签页星标熄灭',
      !(await ev(`document.getElementById('navStar').classList.contains('on')`)));
    // 导航到未收藏的可访问页，收藏后点亮
    await ev(`window.__go('https://fresh.test/'); true`);
    await sleep(80);
    check('切到未收藏页仍熄灭',
      !(await ev(`document.getElementById('navStar').classList.contains('on')`)));
    await ev(`document.getElementById('navStar').click(); true`);
    await sleep(100);
    check('收藏当前页后星标点亮', await ev(`document.getElementById('navStar').classList.contains('on')`));

    // ---- 点外面关闭下拉 ----
    await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
    check('点空白处关闭面板',
      await ev(`document.getElementById('morePop').hidden && document.getElementById('webListPop').hidden`));

    // ---- 截图：260px 下拉展开 + 372px hover 缩放键 ----
    await ev(`document.getElementById('navMore').click(); true`);
    await sleep(200);
    let shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_NARROW, Buffer.from(shot.data, 'base64'));

    await setWidth(372, 300);
    await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
    await ev(`document.getElementById('btnZoom').click(); true`);
    await sleep(150);
    const rect = JSON.parse(await ev(`JSON.stringify((() => {
      const r = document.getElementById('zoomReset').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })())`));
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await sleep(450);
    const top = JSON.parse(await ev(`(() => {
      const el = document.getElementById('zoomReset');
      const s = getComputedStyle(el.querySelector('span'));
      return JSON.stringify({ pos: s.position, z: s.zIndex, before: getComputedStyle(el, '::before').zIndex });
    })()`));
    check('主缩放面板的文字同样在背景之上', top.pos === 'relative' && top.z === '1' && top.before === '0',
      JSON.stringify(top));
    shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_ZOOM, Buffer.from(shot.data, 'base64'));
    // 单独放大缩放按钮那一块：面板已随放大镜挪到导航栏下方，用实际 rect 定位裁剪区
    const clip = JSON.parse(await ev(`JSON.stringify((() => {
      const p = document.getElementById('zoomPop').getBoundingClientRect();
      return { x: Math.max(0, p.left - 4), y: Math.max(0, p.top - 4),
               width: Math.ceil(p.width) + 8, height: Math.ceil(p.height) + 8 };
    })())`));
    shot = await send('Page.captureScreenshot', {
      format: 'png', clip: { ...clip, scale: 4 }
    });
    fs.writeFileSync(SHOT_ZOOM.replace('.png', '-crop.png'), Buffer.from(shot.data, 'base64'));

    // 纯净（隐藏边框）模式整屏截图：核对顶部横条 / 左下拖拽柄 / 右下圆角折角
    // 先把浏览条收回（真实纯净模式默认收起），否则 peek 状态会盖住顶部横条
    await ev(`(() => {
      document.body.classList.add('pure');
      document.getElementById('webBar').classList.remove('peek');
      document.getElementById('navUrl').blur();
      return true;
    })()`);
    await setWidth(372, 300);
    await sleep(300);
    shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_PURE, Buffer.from(shot.data, 'base64'));
    // 右下角折角放大裁剪：肉眼确认是圆角折线而不是死直角
    shot = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: 330, y: 262, width: 42, height: 38, scale: 8 }
    });
    fs.writeFileSync(SHOT_CORNER, Buffer.from(shot.data, 'base64'));

    check('页面没有脚本异常', errors.length === 0, errors.join(' | '));
    ws.close();
  } finally {
    child.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then(() => {
  oks.forEach((n) => console.log('  OK   ' + n));
  fails.forEach((n) => console.log('  FAIL ' + n));
  console.log('');
  console.log(fails.length ? `[FAIL] ${fails.length} 项未通过` : `[PASS] 浏览器模式 UI 全部通过 (${oks.length} 项)`);
  console.log('截图: ' + SHOT_NARROW + ' / ' + SHOT_ZOOM + ' / ' + SHOT_PURE);
  process.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
