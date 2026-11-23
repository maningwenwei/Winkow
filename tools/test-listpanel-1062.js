/* 收藏夹 / 历史记录面板可见性验证。
 *
 * 背景：1.0.61 为了让浏览条「从画面上边缘往下长出来」，给 .webbar 加了
 * clip-path: inset(0 0 0 0)。clip-path 会把超出元素自身盒子的子元素一起裁掉，
 * 而收藏/历史面板（.web-list-pop）和「更多」下拉都是 top:calc(100% + 6px)，
 * 整块落在浏览条盒子外面 —— 于是打开后什么都看不到。
 *
 * 这里真启动应用、真点按钮，量面板 rect + elementFromPoint 命中：
 * 面板必须「在窗口内、被算作可见、且中心点命中的是它自己」。
 *
 * 用法：node tools/test-listpanel-1062.js [shot.png]
 *      设 WINKOW_EXE=... 可测打包后的 Winkow.exe
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const EXE = process.env.WINKOW_EXE || ELECTRON;
const ARGS = process.env.WINKOW_EXE ? [] : ['.'];
const PORT = 9467;
const SHOT = process.argv[2] || '';
const SHOT_NORMAL = process.argv[3] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`PASS ${name}${extra ? ` (${extra})` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};

async function target(re) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.find((t) => t.type === 'page' && re.test(t.url)) || null;
}

function connect(t) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });
}

function send(ws, id, method, params) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('cdp timeout ' + method)), 20000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (m.error) rej(new Error(m.error.message));
      else res(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalFloat(expr) {
  const t = await target(/float\.html/);
  if (!t) throw new Error('NO_FLOAT_TARGET');
  const ws = await connect(t);
  try {
    const r = await send(ws, 1, 'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.value;
  } finally { try { ws.close(); } catch (_) {} }
}

async function shotFloat(file) {
  const t = await target(/float\.html/);
  if (!t) throw new Error('NO_FLOAT_TARGET');
  const ws = await connect(t);
  try {
    const r = await send(ws, 1, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  } finally { try { ws.close(); } catch (_) {} }
}

async function until(fn, ms) {
  const t = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch (_) {}
    if (Date.now() - t > ms) return false;
    await sleep(200);
  }
}

/** 量一个弹层：rect、hidden、clip 祖先、中心点命中。 */
const probe = (id) => `(() => {
  const el = document.getElementById('${id}');
  if (!el) return JSON.stringify({ missing: true });
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  const bar = document.getElementById('webBar');
  const cs = bar ? getComputedStyle(bar) : null;
  return JSON.stringify({
    hidden: el.hidden,
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    left: Math.round(r.left), right: Math.round(r.right),
    w: Math.round(r.width), h: Math.round(r.height),
    inWindow: r.top >= 0 && r.bottom <= window.innerHeight + 1
      && r.left >= 0 && r.right <= window.innerWidth + 1,
    hit: hit ? (hit.id || hit.className || hit.tagName) : null,
    hitSelf: !!(hit && (hit === el || el.contains(hit))),
    barClip: cs ? cs.clipPath : null,
    vw: window.innerWidth, vh: window.innerHeight,
    items: el.querySelectorAll('.wlp-item').length,
    empty: !!el.querySelector('.wlp-empty'),
    emptyText: (el.querySelector('.wlp-empty') || {}).textContent || ''
  });
})()`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winkow-list-'));
  fs.writeFileSync(path.join(tmp, 'moyu-config.json'), JSON.stringify({
    configVersion: 7,
    mode: 'idle',
    pureMode: true,
    hideOnMouseLeave: false,
    rememberHistory: true,
    firstRun: false,
    window: { x: 260, y: 180, width: 460, height: 340 }
  }, null, 2), 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MOYU_SMOKE;

  const child = spawn(EXE, [...ARGS, `--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, stdio: 'ignore' });

  try {
    const ready = await until(async () => !!(await target(/float\.html/)), 25000);
    ok('浮窗渲染层就绪', ready);

    await evalFloat(`window.moyu.setMode('web', 'https://example.com')`);
    const isWeb = await until(async () => (await evalFloat(
      `document.body.classList.contains('mode-web')`)) === true, 12000);
    ok('已切到网页模式（body.mode-web）', isWeb);
    await sleep(1500);

    // 展开浏览条：点按钮前它会自己缩回去，这里先顶住 peek
    await evalFloat(`document.getElementById('webBar').classList.add('peek')`);
    await sleep(320);

    // 点「收藏夹 / 历史记录」按钮（走真实 click handler）
    await evalFloat(`document.getElementById('navLists').click()`);
    await sleep(500);
    await evalFloat(`document.getElementById('webBar').classList.add('peek')`);

    const list = JSON.parse(await evalFloat(probe('webListPop')));
    console.log('列表面板 ' + JSON.stringify(list));
    ok('列表面板已打开（hidden=false）', list.hidden === false, `hidden=${list.hidden}`);
    ok('列表面板有实际尺寸', list.w > 100 && list.h > 60, `${list.w}x${list.h}`);
    ok('列表面板整块落在窗口内（没被裁到窗外）', list.inWindow === true,
      `top=${list.top} bottom=${list.bottom} vh=${list.vh}`);
    ok('列表面板中心点命中它自己（没有被 clip 裁掉）', list.hitSelf === true, `hit=${list.hit}`);
    ok('面板内确实有渲染内容（条目或空态文案）',
      list.items > 0 || list.empty === true,
      `items=${list.items} empty=${list.emptyText}`);

    // 切到「历史」页签
    await evalFloat(`document.querySelector('.wlp-tab[data-list="history"]').click()`);
    await sleep(400);
    await evalFloat(`document.getElementById('webBar').classList.add('peek')`);
    const hist = JSON.parse(await evalFloat(probe('webListPop')));
    console.log('历史页签 ' + JSON.stringify(hist));
    ok('历史页签可切换、面板仍可见', hist.hidden === false && hist.hitSelf === true,
      `hit=${hist.hit} hidden=${hist.hidden}`);
    ok('历史页签有内容或明确空态文案', hist.items > 0 || hist.empty === true,
      `items=${hist.items} empty=${hist.emptyText}`);

    if (SHOT) {
      await shotFloat(SHOT);
      console.log('SHOT ' + SHOT);
    }

    // 「更多」下拉同样是 top:calc(100%+6px)，一起验
    await evalFloat(`document.getElementById('webListClose').click()`);
    await sleep(300);
    await evalFloat(`document.getElementById('webBar').classList.add('peek')`);
    await evalFloat(`document.getElementById('navMore').click()`);
    await sleep(400);
    await evalFloat(`document.getElementById('webBar').classList.add('peek')`);
    const more = JSON.parse(await evalFloat(probe('morePop')));
    console.log('更多下拉 ' + JSON.stringify(more));
    ok('「更多」下拉可见且中心点命中自己',
      more.hidden === false && more.hitSelf === true && more.inWindow === true,
      `hidden=${more.hidden} hit=${more.hit} top=${more.top} bottom=${more.bottom}`);

    // 非纯净模式：浏览条参与正常布局（padding 也不同），面板同样不能被裁、不能压住导航条
    await evalFloat(`document.getElementById('navMore').click()`);
    await evalFloat(`window.moyu.setConfig({ pureMode: false })`);
    await sleep(1200);
    await evalFloat(`document.getElementById('navLists').click()`);
    await sleep(500);
    const normal = JSON.parse(await evalFloat(probe('webListPop')));
    const barRect = JSON.parse(await evalFloat(`(() => {
      const b = document.getElementById('webBar').getBoundingClientRect();
      return JSON.stringify({ top: Math.round(b.top), bottom: Math.round(b.bottom) });
    })()`));
    console.log('非纯净模式 ' + JSON.stringify(normal) + ' bar=' + JSON.stringify(barRect));
    ok('非纯净模式：列表面板可见且中心点命中自己',
      normal.hidden === false && normal.hitSelf === true, `hit=${normal.hit}`);
    ok('非纯净模式：面板从浏览条下边缘往下展开（不压住导航条）',
      normal.top >= barRect.bottom - 1,
      `panel.top=${normal.top} bar.bottom=${barRect.bottom}`);
    ok('非纯净模式：面板整块在窗口内',
      normal.inWindow === true, `top=${normal.top} bottom=${normal.bottom} vh=${normal.vh}`);
    ok('非纯净模式：面板有内容（条目或空态）',
      normal.items > 0 || normal.empty === true, `items=${normal.items}`);
    if (SHOT_NORMAL) {
      await shotFloat(SHOT_NORMAL);
      console.log('SHOT_NORMAL ' + SHOT_NORMAL);
    }
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(fail === 0 ? `[PASS] 列表面板 ${pass}/${pass}` : `[FAIL] ${fail} 项不符（共 ${pass + fail}）`);
  process.exit(fail === 0 ? 0 : 1);
})();
