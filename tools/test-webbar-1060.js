/* 浏览条下拉位置验证：必须从浮窗画面上边缘（横条下方）滑出，不能盖住横条。
 *
 * 只看源码不够 —— 这条是定位 + 合成层 + 过渡三者叠加的结果，必须真启动量 rect。
 * 做法：起应用 → 切成网页模式 → 量横条与浏览条在展开/收起两态的 getBoundingClientRect，
 * 再用 elementFromPoint 确认横条那条 20px 带子仍然点得到（没被浏览条/网页层吃掉）。
 *
 * 用法：node tools/test-webbar-1060.js [shot.png]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
// 设 WINKOW_EXE 可以直接测打包后的 Winkow.exe（asar 版），不设则跑源码
const EXE = process.env.WINKOW_EXE || ELECTRON;
const ARGS = process.env.WINKOW_EXE ? [] : ['.'];
const PORT = 9466;
const SHOT = process.argv[2] || '';
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

const MEASURE = `(() => {
  const d = document.querySelector('.drag-strip');
  const b = document.getElementById('webBar');
  const dr = d ? d.getBoundingClientRect() : null;
  const br = b ? b.getBoundingClientRect() : null;
  const cs = b ? getComputedStyle(b) : null;
  /* 收/放动画在 .webbar-body 上（外层的 clip 会把下拉面板一起裁掉，已改） */
  const wb = b ? b.querySelector('.webbar-body') : null;
  const cw = wb ? getComputedStyle(wb) : null;
  const hitTop = document.elementFromPoint(Math.round(window.innerWidth / 2), 10);
  return JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    drag: dr ? { top: Math.round(dr.top), bottom: Math.round(dr.bottom), h: Math.round(dr.height) } : null,
    bar: br ? { top: Math.round(br.top), bottom: Math.round(br.bottom), h: Math.round(br.height) } : null,
    barCssTop: cs ? cs.top : null,
    barOpacity: cw ? cw.opacity : null,
    barClip: cw ? cw.clipPath : null,
    bodyHasInner: !!wb,
    barTransform: cs ? cs.transform : null,
    peek: b ? b.classList.contains('peek') : null,
    dragOpacity: d ? getComputedStyle(d).opacity : null,
    dragPE: d ? getComputedStyle(d).pointerEvents : null,
    dragPEs: d ? getComputedStyle(d).paddingTop : null,
    hitTop: hitTop ? (hitTop.className || hitTop.tagName) : null,
    hitInDrag: !!(hitTop && d && (d === hitTop || d.contains(hitTop))),
    bodyPadTop: getComputedStyle(document.body).paddingTop
  });
})()`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winkow-webbar-'));
  fs.writeFileSync(path.join(tmp, 'moyu-config.json'), JSON.stringify({
    configVersion: 7,
    mode: 'idle',
    pureMode: true,
    hideOnMouseLeave: false,
    firstRun: false,
    window: { x: 260, y: 180, width: 420, height: 300 }
  }, null, 2), 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MOYU_SMOKE;

  const child = spawn(EXE, [...ARGS, `--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, stdio: 'ignore' });

  try {
    const ready = await until(async () => !!(await target(/float\.html/)), 25000);
    ok('浮窗渲染层就绪', ready);

    // 走真实接口切网页模式（主进程会回推 SET_MODE，渲染层加 body.mode-web）
    await evalFloat(`window.moyu.setMode('web', 'https://example.com')`);
    const isWeb = await until(async () => (await evalFloat(
      `document.body.classList.contains('mode-web')`)) === true, 12000);
    ok('已切到网页模式（body.mode-web）', isWeb);

    // 等 webview 挂上并稳定一帧；顺手把可能被热区触发的 peek 清掉，保证量的是收起态
    await sleep(1500);
    await evalFloat(`document.getElementById('webBar').classList.remove('peek')`);
    await sleep(500);

    const closed = JSON.parse(await evalFloat(MEASURE));
    console.log('收起态 ' + JSON.stringify(closed));
    ok('横条在窗口最顶端 20px 带内',
      !!closed.drag && closed.drag.top === 0 && closed.drag.h === 20,
      closed.drag ? `top=${closed.drag.top} h=${closed.drag.h}` : 'no drag');
    ok('壳从 20px 起（横条下方留给画面）', closed.bodyPadTop === '20px', `body padding-top=${closed.bodyPadTop}`);
    ok('收起时浏览条顶边仍在画面顶（20px），靠内层裁切变成 0 高',
      !!closed.bar && closed.bar.top === 20 && closed.barOpacity === '0'
      && /100%/.test(String(closed.barClip)),
      closed.bar ? `top=${closed.bar.top} opacity=${closed.barOpacity} clip=${closed.barClip}` : 'no bar');
    ok('裁剪动画挂在内层 .webbar-body 上（外层不做 clip，面板才不会被裁）',
      closed.bodyHasInner === true, `inner=${closed.bodyHasInner}`);

    // 展开。页面自己的 barScheduleHide 定时器还在跑（它会 remove peek），
    // 一边反复补齐 class（等价于「鼠标一直停在条上」），一边等过渡落位。
    let open = null;
    for (let i = 0; i < 25; i++) {
      await evalFloat(`document.getElementById('webBar').classList.add('peek')`);
      await sleep(150);
      open = JSON.parse(await evalFloat(MEASURE));
      if (open.peek && open.bar && Math.abs(open.bar.top - 20) <= 1) break;
    }

    console.log('展开态 ' + JSON.stringify(open));
    ok('展开后浏览条顶边 = 浮窗画面上边缘（20px）',
      !!open.bar && Math.abs(open.bar.top - 20) <= 1, open.bar ? `bar.top=${open.bar.top}` : 'no bar');
    ok('浏览条完全在横条下方，不再盖住横条',
      !!open.bar && !!open.drag && open.bar.top >= open.drag.bottom - 0.5,
      open.bar && open.drag ? `drag.bottom=${open.drag.bottom} bar.top=${open.bar.top}` : 'n/a');
    ok('展开时横条仍然可见（没有被让位规则隐藏）',
      open.dragOpacity === '1' && open.dragPE !== 'none',
      `opacity=${open.dragOpacity} pointer-events=${open.dragPE}`);
    ok('横条 20px 带子仍可点（elementFromPoint 命中 drag-strip）',
      open.hitInDrag === true, `hit=${open.hitTop}`);

    // 动画逐帧采样：以前用 translateY(-100%) 收起，展开的第一帧是从横条上方
    // 滑下来的（顶边 <20）。现在顶边固定 20、只靠 clip 往下长 —— 每帧都不能越过。
    const frames = JSON.parse(await evalFloat(`new Promise((res) => {
      const b = document.getElementById('webBar');
      b.classList.remove('peek');
      const out = [];
      const t0 = performance.now();
      requestAnimationFrame(() => {
        b.classList.add('peek');
        const tick = () => {
          out.push(Math.round(b.getBoundingClientRect().top));
          if (performance.now() - t0 < 420) requestAnimationFrame(tick);
          else res(JSON.stringify(out));
        };
        tick();
      });
    })`));
    const minTop = Math.min(...frames);
    ok('展开动画每一帧的顶边都 >= 横条底边（不再从横条上方弹出）',
      frames.length >= 5 && minTop >= 20,
      `min=${minTop} frames=${frames.length} 前几帧=${frames.slice(0, 6).join(',')}`);

    if (SHOT) {
      await shotFloat(SHOT);
      console.log('SHOT ' + SHOT);
    }

    // 收起：位置回到画面上方，且不再拦截点击
    await evalFloat(`document.getElementById('webBar').classList.remove('peek')`);
    await sleep(600);
    const back = JSON.parse(await evalFloat(MEASURE));
    console.log('再收起 ' + JSON.stringify(back));
    ok('收起后浏览条内层重新被裁成 0 高（顶边仍是画面顶）',
      !!back.bar && back.bar.top === 20 && back.barOpacity === '0' && /100%/.test(String(back.barClip)),
      back.bar ? `top=${back.bar.top} opacity=${back.barOpacity} clip=${back.barClip}` : 'no bar');
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(fail === 0 ? `[PASS] 浏览条位置 ${pass}/${pass}` : `[FAIL] ${fail} 项不符（共 ${pass + fail}）`);
  process.exit(fail === 0 ? 0 : 1);
})();
