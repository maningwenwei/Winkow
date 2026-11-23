(function () {
  'use strict';
  const api = window.moyu;
  const $ = (id) => document.getElementById(id);
  const TXT = window.WinkowText || { airplayError: () => '出错了，请再试一次' };
  const bindings = Array.from(document.querySelectorAll('[data-key]'));
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const panels = Array.from(document.querySelectorAll('.panel'));
  const caps = Array.from(document.querySelectorAll('[data-hotkey]'));

  let config = null;
  let capture = null;
  let pushCommand = '';
  let msgTimer = null;

  const UNIT = {
    animationMs: 'ms', mouseLeaveDelay: 'ms', peekDelay: 'ms', showGraceMs: 'ms',
    blurDelay: 'ms', pollInterval: 'ms', mousePadding: 'px', peekWidth: 'px'
  };

  function flash(text, warn) {
    const el = $('msg');
    el.textContent = text;
    // 走 CSS 变量而不是写死颜色：浅色主题下 #d8b4fe 这种亮紫压在白底上
    // 对比度只有 1.6:1，提示等同于隐形。
    el.style.color = warn ? 'var(--tone-danger)' : 'var(--tone-info)';
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { el.textContent = ''; }, 3200);
  }

  function updateOutput(el) {
    const out = el.parentElement.querySelector('output');
    if (!out) return;
    const v = Number(el.value);
    const key = el.dataset.key;
    out.textContent = (key === 'opacity' || key === 'zoom')
      ? `${Math.round(v * 100)}%`
      : `${v}${UNIT[key] || ''}`;
  }

  function fill(cfg) {
    config = cfg;
    bindings.forEach((el) => {
      const key = el.dataset.key;
      const value = cfg[key];
      if (el.type === 'checkbox') el.checked = !!value;
      else if (el.type === 'radio') el.checked = value === el.value;
      else if (el.type === 'range' || el.type === 'number') { el.value = value; updateOutput(el); }
      else el.value = value;
    });
    if (document.activeElement !== $('webUrl')) $('webUrl').value = cfg.webUrl || '';
    if (document.activeElement !== $('mirrorSource')) $('mirrorSource').value = cfg.mirrorSource || '';
    if (!capture || capture.key !== 'hotkey') $('capHotkey').textContent = cfg.hotkey || '未设置';
    if (!capture || capture.key !== 'settingsHotkey') $('capSettings').textContent = cfg.settingsHotkey || '未设置';
  }

  // ---- 通用配置绑定 ----
  bindings.forEach((el) => {
    const key = el.dataset.key;
    if (el.type === 'range') {
      el.addEventListener('input', () => updateOutput(el));
      el.addEventListener('change', () => api.setConfig({ [key]: Number(el.value) }));
      return;
    }
    el.addEventListener('change', () => {
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'radio') { if (!el.checked) return; value = el.value; }
      else if (el.type === 'number') value = Number(el.value);
      else value = el.value;
      api.setConfig({ [key]: value });
      // 这两项只在引擎启动时生效，不说一句用户会以为「选了没反应」
      if (key === 'airplayCastAudio' || key === 'airplayTrace') {
        flash('已保存，重新点一次「开始接收」后生效');
      }
    });
  });

  // ---- 标签页 ----
  function switchTab(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    $('content').scrollTop = 0;
  }
  tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  // ---- 快捷键录制 ----
  const KEY_MAP = {
    ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    '[': '[', ']': ']', '-': '-', '=': '=', '`': 'Backtick', ' ': 'Space',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Return', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert'
  };

  function buildAccelerator(event) {
    if (!(event.ctrlKey || event.altKey || event.metaKey)) return '';
    let key = event.key;
    if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
    else if (!/^([0-9]|F([1-9]|1[0-2]))$/.test(key)) key = KEY_MAP[key] || '';
    if (!key) return '';
    const parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(key);
    return parts.join('+');
  }

  function stopCapture() {
    if (!capture) return;
    const { btn, original } = capture;
    btn.classList.remove('capturing');
    btn.textContent = original;
    api.hotkeyCaptureStop();
    capture = null;
  }

  caps.forEach((btn) => {
    btn.addEventListener('click', () => {
      stopCapture();
      capture = { btn, key: btn.dataset.hotkey, role: btn.dataset.role, original: btn.textContent };
      btn.classList.add('capturing');
      btn.textContent = '请按下组合键…';
      api.hotkeyCaptureStart();
    });
  });

  window.addEventListener('keydown', (event) => {
    if (!capture) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return stopCapture();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    const accelerator = buildAccelerator(event);
    if (!accelerator) { flash('需要带上 Ctrl 或 Alt 修饰键', true); return; }
    const { btn, key, role } = capture;
    api.testHotkey(accelerator, role).then((result) => {
      stopCapture();
      if (result.ok) {
        api.setConfig({ [key]: accelerator });
        btn.textContent = accelerator;
        flash(`已设置 ${accelerator}`);
      } else {
        flash(result.reason || '组合键不可用', true);
      }
    });
  }, true);

  // ---- 内容页 ----
  $('btnWeb').addEventListener('click', () => {
    const url = $('webUrl').value.trim();
    if (url) api.setMode('web', url);
    else flash('先填一个网址', true);
  });
  $('btnMirror').addEventListener('click', () => api.setMode('mirror', $('mirrorSource').value.trim()));

  async function refreshMirror() {
    try {
      const info = await api.getMirrorInfo();
      $('pushUrl').textContent = info.online ? info.pushUrl : '中继未启动';
      $('relayToken').textContent = info.token || '-';
      $('relayState').textContent = info.online
        ? `运行中 · ${info.clients} 连接 · ${info.frames} 帧`
        : '未启动（可改用外部视频源）';
      pushCommand = `node tools/ffmpeg-pusher.js --input <视频源> --port ${info.port} --token ${info.token}`;
      $('pushCmd').textContent = pushCommand;
    } catch (_) {
      $('relayState').textContent = '读取失败';
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flash('已复制')).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); flash('已复制'); } catch (_) { flash('复制失败，请手动选中', true); }
      ta.remove();
    }
  }
  $('btnCopy').addEventListener('click', () => copyText(pushCommand));

  // ---- iOS 屏幕镜像（AirPlay 接收引擎） ----
  let airplayBusy = false;

  function shortPath(file) {
    const parts = String(file || '').split(/[\\/]/);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(file || '');
  }

  function renderAirplay(s) {
    if (!s) return;
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const PHASE = { idle: '未启动', starting: '正在启动…', running: '接收中', error: '启动失败' };
    const label = PHASE[s.phase] || s.phase;
    const pinOk = s.running && !s.noPin && /^\d{4}$/.test(String(s.pin || ''));

    // 大字 PIN：这是「连手机时唯一要看的东西」，放在卡片最上面
    set('apPinBig', s.running ? (pinOk ? s.pin : (s.noPin ? '免PIN' : '----')) : '----');
    const state = $('apState');
    if (state) {
      state.textContent = s.running
        ? (s.sessionLost
          ? (s.reconnecting ? '已断开 · 正在重启接收器…' : '已断开 · 接收器在线，手机上点一次「屏幕镜像」即可')
          : s.hidden ? `${label} · 已隐藏` : label)
        : label;
      state.classList.toggle('warn', s.phase === 'error');
    }
    set('apPair', s.name || '—');
    set('apEngine', s.engineFound
      ? `${s.engineKind === 'gui' ? 'UxPlay 便携版 (GUI)' : 'UxPlay CLI'} · ${shortPath(s.enginePath)}`
      : '未找到：解压引擎组件到 airplay/ 或手动指定');
    const engine = $('apEngine');
    if (engine) engine.classList.toggle('warn', !s.engineFound);
    // 逐段诊断：哪一段停在 0，就说明画面卡在那里
    set('apChain', s.running
      ? `引擎${s.engineAlive ? '✓' : '✗'}`
        + ` → 视频窗口 ${s.windowReady ? (s.windowName || '已出现') : '等待'}`
        + ` → 浮窗捕获${s.windowPlaced ? '✓' : '…'}`
      : '—');
    const chain = $('apChain');
    if (chain) chain.classList.toggle('warn', !!s.running && !s.windowPlaced);
    // 画面比例 = 捕获流的真实长宽比，浮窗就是按它定形状的
    set('apVideo', s.videoW && s.videoH
      ? `${s.videoW} × ${s.videoH}（${(s.videoH / s.videoW).toFixed(2)} 竖比）`
      : '—');
    const hint = $('apHint');
    if (hint) {
      const waiting = !!s.running && !s.windowReady;
      hint.hidden = !waiting;
      if (waiting) {
        hint.textContent = '接收器已就绪，正在等手机送画面：iPhone 控制中心 → 屏幕镜像 → 选本机并输入 PIN。'
          + '连不上先确认手机与电脑在同一 Wi-Fi。';
      }
    }
    const sample = $('apSample');
    if (sample) {
      sample.hidden = !s.samplePath;
      if (s.samplePath) sample.textContent = `已留存流样本：${s.samplePath}`;
    }
    $('btnAirplayStart').disabled = airplayBusy || s.running;
    $('btnAirplayStop').disabled = airplayBusy || !s.running;
    $('btnAirplayPick').disabled = airplayBusy || s.running;
    const lines = (s.log && s.log.length) ? s.log : [
      s.error || (s.engineFound
        ? '准备就绪：点「开始接收」，再在 iPhone 控制中心选这台电脑。'
        : '未检测到接收引擎，投屏功能暂不可用。')
    ];
    $('apLog').textContent = lines.join('\n');
    $('apLog').scrollTop = $('apLog').scrollHeight;
  }

  async function refreshAirplay() {
    try { renderAirplay(await api.airplayStatus()); } catch (_) {}
  }

  async function airplay(action) {
    if (airplayBusy) return;
    airplayBusy = true;
    $('btnAirplayStart').disabled = true;
    $('btnAirplayStop').disabled = true;
    try {
      const s = await api.airplayAction(action);
      renderAirplay(s);
      if (s && s.error) {
        // 详细原因只留日志，界面上给一句人话
        console.warn('[moyu] 投屏操作失败', s.error);
        flash(TXT.airplayError(s.error), true);
      }
      else flash(action === 'stop' ? '已停止接收' : '接收器已启动，PIN 就显示在上方');
    } catch (err) {
      console.warn('[moyu] 投屏操作失败', err);
      flash('操作没成功，请再试一次', true);
    } finally {
      airplayBusy = false;
      refreshAirplay();
    }
  }

  $('btnAirplayStart').addEventListener('click', () => airplay('start'));
  $('btnAirplayStop').addEventListener('click', () => airplay('stop'));
  $('btnAirplayPick').addEventListener('click', async () => {
    const file = await api.airplayPick().catch(() => '');
    if (file) flash('已指定引擎，点「开始接收」生效');
    refreshAirplay();
  });
  // 大字 PIN 点一下就复制，方便照着往手机上输
  const pinBig = $('apPinBig');
  if (pinBig) {
    pinBig.style.cursor = 'pointer';
    pinBig.title = '点击复制 PIN';
    pinBig.addEventListener('click', () => {
      const text = pinBig.textContent.trim();
      if (!/^\d{4}$/.test(text)) { flash('当前没有 PIN 可复制', true); return; }
      copyText(text);
    });
  }

  // ---- 底部操作 ----
  $('btnClear').addEventListener('click', () => {
    api.clearTraces().then(() => { refreshMirror(); flash('浏览痕迹已清空'); });
  });
  $('btnReset').addEventListener('click', () => {
    api.resetConfig().then((cfg) => { fill(cfg); flash('已恢复默认设置'); });
  });
  $('btnDone').addEventListener('click', () => api.closeSettings());
  $('btnClose').addEventListener('click', () => api.closeSettings());

  // 主题：只切 <html data-theme>，样式全部由 CSS 变量接管
  function applyTheme(t) {
    const eff = t && t.effective === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    if (root.dataset.theme !== eff) root.dataset.theme = eff;
    if (t && t.mode) root.dataset.themeMode = t.mode;
  }

  // ---- 主进程推送 ----
  api.onTheme(applyTheme);
  // 同上：广播可能比这个页面挂监听更早，主动拉一次才不会漏掉 mode
  if (api.getTheme) api.getTheme().then(applyTheme).catch(() => {});
  api.onConfig((cfg) => fill(cfg));
  api.onTab((tab) => switchTab(tab));
  api.onState((snapshot) => {
    const text = {
      visible: '显示中', hiding: '正在收起…', hidden: '已隐藏', showing: '正在出现…'
    }[snapshot.state] || snapshot.state;
    $('sideTip').textContent = `状态：${text}\n隐藏原因：${snapshot.reasons.length ? snapshot.reasons.join('、') : '无'}`;
  });
  api.onMirror((status) => {
    if (status.online) $('relayState').textContent = `运行中 · ${status.clients} 连接 · ${status.frames} 帧`;
  });
  api.onAirplay(renderAirplay);

  api.getConfig().then((cfg) => fill(cfg)).catch(() => {});
  // 版本号取自 package.json，页面里只留占位符：写死过一次，之后就再没跟上过
  if (api.appInfo) {
    api.appInfo().then((info) => {
      const el = $('appVersion');
      if (el && info && info.version) el.textContent = info.version;
    }).catch(() => {});
  }
  refreshMirror();
  refreshAirplay();
  const mirrorTimer = setInterval(refreshMirror, 5000);
  // 帧数 / 运行时长不触发状态广播，低频轮询补齐；状态变化仍由主进程实时推送
  const airplayTimer = setInterval(refreshAirplay, 3000);
  window.addEventListener('beforeunload', () => {
    clearInterval(mirrorTimer);
    clearInterval(airplayTimer);
  });
})();
