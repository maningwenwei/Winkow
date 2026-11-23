(function () {
  'use strict';
  const api = window.moyu;
  const $ = (id) => document.getElementById(id);
  // 面向用户的文案集中在 messages.js，浮窗与设置页共用一套（见那里的注释）
  const TXT = window.WinkowText || {
    airplayError: () => '出错了，请再试一次',
    pageError: () => '这个网页没打开，检查一下网址和网络'
  };
  const view = $('view');
  const cap = $('cap');
  const webBar = $('webBar');
  const webHot = $('webHot');

  let config = null;
  let mirror = null;
  let currentMode = 'idle';
  let currentUrl = '';
  /** 上一次由主进程下发的网页地址：用来区分「真的要换页」和配置广播的重复调用 */
  let lastWebUrl = '';
  let noticeTimer = null;
  let zoom = 1;
  let pure = false;
  let resizeState = null;
  let dragState = null;
  /** 纯净模式浏览条的自动缩回计时器；barPinned 在拖窗口 / 按鼠标期间钉住不收 */
  let barHideTimer = 0;
  let barPinTimer = 0;
  let barPinned = false;
  /** 最近一次 AirPlay 状态：PID 面板、中央等待卡、顶部胶囊都由它渲染 */
  let apStatus = null;
  let apBusy = false;

  // ---- 浏览器收藏 / 历史 ----
  let browserData = { bookmarks: [], history: [], remember: false };
  let listTab = 'bookmarks';
  let historyTimer = 0;
  let pendingHistory = null;
  /** 列表懒加载：一次只渲染一页，滚动到底 / 点「加载更多」再续一页，
   *  避免几百条历史一次性建 DOM 把小窗渲染线程拖住。 */
  const LIST_PAGE = 30;
  let listItems = [];
  let listRendered = 0;
  let listLastDay = '';

  const clampZoom = (v) => Math.min(2.5, Math.max(0.5, Number(v) || 1));

  // 去掉 Electron / 嵌入式客户端特征，降低被网页识别的概率
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  try { if (typeof view.setUserAgent === 'function') view.setUserAgent(CHROME_UA); } catch (_) {}

  // ---- 网页标签页 ----
  // 每个标签页一条独立 <webview>：前进后退历史、滚动位置、登录态互不干扰，
  // 切回来就是原来的样子。投屏观看页仍然用上面那条 #view，两条链路互不打扰。
  const tabViewsHost = $('tabViews');
  const tabStrip = $('tabStrip');
  const tabs = [];
  let activeTabId = 0;
  let tabSeq = 0;
  const MAX_TABS = 8;

  /**
   * guest 兜底：把脚本里的 window.open 改写成同标签跳转。
   *
   * 实测（scripts/probe-web-click.js / probe-web-click-real.js）：Electron 33 的
   * <webview> 里，即使加了 allowpopups，页面脚本调用 window.open 也**不会**触发
   * 主进程的 setWindowOpenHandler —— 点击有真实用户手势也一样。结果是页面里
   * 「在新窗口打开」类按钮点了毫无反应。这里牺牲「新标签」换「一定打得开」；
   * a[target=_blank] 链接仍由主进程接管成新标签，两条路互不影响。
   */
  const OPEN_HOOK = `(() => {
    if (window.__moyuOpenHooked) return 'hooked';
    window.__moyuOpenHooked = true;
    const raw = window.open;
    window.open = function (url) {
      let abs = '';
      try { abs = url ? new URL(String(url), location.href).href : ''; } catch (_) {}
      if (/^https?:/i.test(abs)) { location.href = abs; return null; }
      try { return raw.apply(window, arguments); } catch (_) { return null; }
    };
    return 'ok';
  })()`;

  const activeTab = () => tabs.find((t) => t.id === activeTabId) || null;
  const activeTabView = () => { const t = activeTab(); return t ? t.view : null; };

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  /** 地址栏输入 → 网址：带协议照用；像域名的补 https；其余当搜索词。 */
  function toUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (/^(https?|file):\/\//i.test(raw)) return raw;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw) && !/\s/.test(raw)) return `https://${raw}`;
    return `https://www.baidu.com/s?wd=${encodeURIComponent(raw)}`;
  }

  /** 同步地址栏与前进/后退可用状态。 */
  let navSeq = 0;
  function syncNav() {
    const tab = activeTab();
    const v = tab ? tab.view : null;
    let url = '';
    try { url = (v && v.getURL && v.getURL()) || ''; } catch (_) {}
    if (!url || url === 'about:blank') url = tab ? tab.url : '';
    const input = $('navUrl');
    if (document.activeElement !== input) input.value = url === 'about:blank' ? '' : url;
    $('navReload').disabled = !v;
    // 星标必须在这次导航/切标签里刷新，且要在下面两个 early return 之前 ——
    // 新标签页的 webview 常拿不到 webContentsId，旧代码在那里提前返回，
    // 星标就残留在上一页的点亮状态（「切到新标签还是已收藏」）。
    renderStar();
    if (!v) { $('navBack').disabled = true; $('navFwd').disabled = true; return; }
    // webview 自带的 canGoBack() 在这版 Electron 上恒为 false（历史其实存在，
    // 主进程读到的 activeIndex 是 1/2），所以改用主进程的 navigationHistory 判定。
    let id = 0;
    try { id = v.getWebContentsId(); } catch (_) {}
    if (!id) return;
    const token = ++navSeq;
    try {
      api.webNav(id, 'state').then((st) => {
        if (!st || token !== navSeq) return;   // 已经切到别的标签，丢弃过期结果
        $('navBack').disabled = !st.canBack;
        $('navFwd').disabled = !st.canFwd;
      }).catch(() => {});
    } catch (_) {}
  }

  /** 前进 / 后退 / 刷新：都走主进程，成功后补一次状态刷新。 */
  function navAction(action) {
    const v = activeTabView();
    if (!v) return;
    let id = 0;
    try { id = v.getWebContentsId(); } catch (_) {}
    if (!id) return;
    try { api.webNav(id, action).then(() => setTimeout(syncNav, 80)).catch(() => {}); } catch (_) {}
  }

  function renderTabStrip() {    tabStrip.textContent = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `tab${tab.id === activeTabId ? ' active' : ''}`;
      el.title = tab.url && tab.url !== 'about:blank' ? tab.url : '新标签页';

      const label = document.createElement('span');
      label.className = 'tab-title';
      label.textContent = tab.title || hostOf(tab.url) || '新标签页';
      el.appendChild(label);

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.textContent = '×';
      close.title = '关闭标签页';
      close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(tab.id); });
      el.appendChild(close);

      el.addEventListener('click', () => activateTab(tab.id));
      tabStrip.appendChild(el);
    }
    const active = tabStrip.querySelector('.tab.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    document.body.classList.toggle('single-tab', tabs.length <= 1);
    updateChip();
  }

  /** 网页区域当前该显示什么：空标签页 → 地址输入卡；否则显示当前标签的 webview。 */
  function applyWebDisplay() {
    const tab = activeTab();
    const empty = !tab || !tab.url || tab.url === 'about:blank';
    $('webEmpty').hidden = !(currentMode === 'web' && empty);
    if (currentMode === 'web') $('idle').hidden = true;
    for (const t of tabs) {
      t.view.classList.toggle('active', t.id === activeTabId && !empty);
    }
  }

  function navigateTab(tab, url) {
    if (!tab || !url) return;
    tab.url = url;
    tab.title = '';
    if (tab.view.getAttribute('src') === url) { try { tab.view.reload(); } catch (_) {} return; }
    tab.view.setAttribute('src', url);
    renderTabStrip();
  }

  function createTab(url, opts) {
    const options = opts || {};
    if (tabs.length >= MAX_TABS) {
      toast(`最多同时开 ${MAX_TABS} 个标签页`, 'warn');
      return null;
    }
    const v = document.createElement('webview');
    const tab = { id: ++tabSeq, view: v, url: url || 'about:blank', title: '', ready: false };
    v.className = 'tabview';
    v.setAttribute('partition', 'persist:moyu-content');
    // 网页里的 Ctrl+滚轮要在 guest 内部才截得住（事件不冒泡到宿主）。
    // 这个 preload 只做一件事：把 Ctrl+滚轮翻译成缩放请求。
    try { if (api.guestPreload) v.setAttribute('preload', api.guestPreload); } catch (_) {}
    // allowpopups 决定「页面里的 target=_blank / window.open 有没有机会被我们接管」：
    // 不设时 Chromium 直接吞掉请求，连 setWindowOpenHandler 都不会触发，用户看到的就是
    // 点了链接毫无反应。窗口本身仍由主进程 deny + 转成新标签页。
    v.setAttribute('allowpopups', '');
    tabViewsHost.appendChild(v);
    tabs.push(tab);
    try { if (typeof v.setUserAgent === 'function') v.setUserAgent(CHROME_UA); } catch (_) {}

    v.addEventListener('did-start-loading', () => {
      if (tab.id === activeTabId) $('loading').hidden = false;
    });
    v.addEventListener('did-stop-loading', () => {
      if (tab.id === activeTabId) { $('loading').hidden = true; syncNav(); }
      renderTabStrip();
    });
    v.addEventListener('did-fail-load', (event) => {
      if (tab.id === activeTabId) $('loading').hidden = true;
      // 子框架（广告 / 埋点）失败不吭声；-3 = ERR_ABORTED，正常跳转会触发
      if (event.errorCode === -3 || event.isMainFrame === false) return;
      if (tab.id !== activeTabId) return;
      const desc = String(event.errorDescription || '');
      const ssl = /SSL|CERT|TUNNEL|CONNECTION_RESET/i.test(desc);
      // 错误码（-105、ERR_NAME_NOT_RESOLVED 之类）对用户没有意义，只往控制台留一份
      if (!ssl) console.warn('[moyu] 页面加载失败', event.errorCode, desc);
      toast(TXT.pageError(desc), 'warn');
    });
    v.addEventListener('dom-ready', () => {
      tab.ready = true;
      try { v.setAudioMuted(!config || config.muted); } catch (_) {}
      try { v.setZoomFactor(clampZoom(zoom)); } catch (_) {}
      try { api.webviewReady(v.getWebContentsId()); } catch (_) {}
      // window.open 兜底（详见 OPEN_HOOK 注释）：必须在用户点击之前装好
      try { v.executeJavaScript(OPEN_HOOK).catch(() => {}); } catch (_) {}
      if (tab.id === activeTabId) syncNav();
    });
    v.addEventListener('did-navigate', (event) => {
      if (event.url && event.isMainFrame !== false) {
        tab.url = event.url;
        recordHistory(event.url, tab.title);
      }
      if (tab.id === activeTabId) { syncNav(); applyWebDisplay(); }
      renderTabStrip();
    });
    v.addEventListener('did-navigate-in-page', (event) => {
      if (event.url && event.isMainFrame !== false) {
        tab.url = event.url;
        recordHistory(event.url, tab.title);
      }
      if (tab.id === activeTabId) syncNav();
    });
    v.addEventListener('page-title-updated', (event) => {
      tab.title = String(event.title || '');
      // 跳转那一刻标题还没到，用最终标题再把同一条历史润色一次（500ms 合并）
      if (tab.url) recordHistory(tab.url, tab.title);
      renderTabStrip();
    });

    if (url && url !== 'about:blank') v.setAttribute('src', url);
    if (options.activate !== false) activateTab(tab.id);
    else renderTabStrip();
    return tab;
  }

  function activateTab(id) {
    if (!tabs.some((t) => t.id === id)) return;
    activeTabId = id;
    applyWebDisplay();
    renderTabStrip();
    syncNav();
    const tab = activeTab();
    if (tab && tab.ready) {
      try { tab.view.setZoomFactor(clampZoom(zoom)); } catch (_) {}
    }
  }

  function closeTab(id) {
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [tab] = tabs.splice(index, 1);
    try { tab.view.remove(); } catch (_) {}
    if (activeTabId === id) {
      const next = tabs[Math.min(index, tabs.length - 1)];
      if (next) activateTab(next.id);
      else {
        activeTabId = 0;
        // 最后一个标签关掉了：留一个空白页，接着输地址就行，不用退出网页模式
        createTab('', { activate: true });
      }
    } else {
      renderTabStrip();
    }
    applyWebDisplay();
  }

  /** 按地址切到某个标签页：优先复用当前空标签 / 已有相同地址的标签。 */
  function ensureTabForUrl(url) {
    const target = toUrl(url);
    const tab = activeTab();
    if (!target) {
      if (!tabs.length) createTab('', { activate: true });
      else { applyWebDisplay(); renderTabStrip(); }
      return;
    }
    if (tab && (!tab.url || tab.url === 'about:blank')) { navigateTab(tab, target); return; }
    if (tab && tab.url === target) { applyWebDisplay(); return; }
    const same = tabs.find((t) => t.url === target);
    if (same) { activateTab(same.id); return; }
    createTab(target, { activate: true });
  }

  function navigateActive(input) {
    const url = toUrl(input);
    if (!url) return;
    const tab = activeTab() || createTab('', { activate: true });
    if (!tab) return;
    navigateTab(tab, url);
    applyWebDisplay();
  }

  /* ---- 收藏 / 历史：UI 层 ------------------------------------------------
   * 数据全部放在主进程的独立小文件里（见 browser-data.js），这里只负责
   * 展示与发 op。地址栏里刚敲进去、还没回车的地址不算「访问过」。 */
  /** 当前页。strict=true 时只读 webview 的真实地址，不回退到地址栏输入框 ——
   *  星亮点灭必须用真实地址判断，否则新标签页输入框残留的旧网址会让星标误亮。 */
  function currentPage(strict) {
    const tab = activeTab();
    let url = '';
    try { url = (tab && tab.view && tab.view.getURL && tab.view.getURL()) || ''; } catch (_) {}
    if (!url || url === 'about:blank') url = (tab && tab.url) || '';
    if (!strict && (!url || url === 'about:blank')) {
      const typed = $('navUrl').value.trim();
      if (typed) { try { url = new URL(typed).href; } catch (_) { url = ''; } }
    }
    return { url: url === 'about:blank' ? '' : url, title: (tab && tab.title) || '' };
  }

  function displayHost(url) {
    let u;
    try { u = new URL(url); } catch (_) { return url; }
    const tail = (u.pathname || '') + (u.search || '');
    return (u.hostname || '') + (tail.length > 40 ? `${tail.slice(0, 40)}…` : tail);
  }

  function loadBrowserData() {
    if (!api.browserData) return Promise.resolve(browserData);
    return api.browserData('get').then((data) => {
      if (data) browserData = data;
      renderStar();
      if (!$('webListPop').hidden) renderList();
      return browserData;
    }).catch(() => browserData);
  }

  function renderStar() {
    // 严格模式：只认当前标签的真实地址。新标签页 / 未收藏页面一律不亮星标。
    const url = currentPage(true).url;
    const on = !!url && browserData.bookmarks.some((it) => it.url === url);
    $('navStar').classList.toggle('on', on);
    $('mMoreStar').textContent = on ? '取消收藏' : '收藏本页';
  }

  function toggleStar() {
    const page = currentPage();
    if (!/^(https?:|file:)/i.test(page.url)) { toast('这个页面还不能收藏', 'warn'); return; }
    if (!api.browserData) return;
    api.browserData('bookmark', page).then((data) => {
      if (data) browserData = data;
      renderStar();
      renderList();
      toast(browserData.bookmarks.some((it) => it.url === page.url) ? '已加入收藏' : '已取消收藏');
    }).catch(() => {});
  }

  /** 合并连续跳转：500ms 内只写最后一条，不让 IPC 与磁盘 IO 打扰网页加载。 */
  function recordHistory(url, title) {
    if (!/^(https?:|file:)/i.test(String(url || '')) || !api.browserData) return;
    pendingHistory = { url, title: title || '' };
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      const item = pendingHistory;
      pendingHistory = null;
      if (!item) return;
      api.browserData('history', item).then((data) => {
        if (data) browserData = data;
        if (!$('webListPop').hidden && listTab === 'history') renderList();
      }).catch(() => {});
    }, 500);
  }

  function closeWebPops() {
    $('morePop').hidden = true;
    $('webListPop').hidden = true;
  }

  /** 历史按本地日历日分组：今天 / 昨天 / 三天前 / 更早。
   *  用「今天 0 点」作基准，跨月跨年也对；at 缺失或损坏时归到「更早」。 */
  function dayGroup(at) {
    const t = Number(at) || 0;
    if (!t) return '更早';
    const d = new Date(t);
    const now = new Date();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((today0 - day0) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff <= 3) return '三天前';
    return '更早';
  }

  /** 造一行列表项（收藏 / 历史共用），删除与打开的 handler 同前。 */
  function makeListItem(item) {
    const row = document.createElement('div');
    row.className = 'wlp-item';
    const main = document.createElement('span');
    main.className = 'wlp-main';
    const title = document.createElement('span');
    title.className = 'wlp-title';
    title.textContent = item.title || item.url;
    const sub = document.createElement('span');
    sub.className = 'wlp-url';
    sub.textContent = displayHost(item.url);
    main.appendChild(title);
    main.appendChild(sub);
    const del = document.createElement('button');
    del.className = 'wlp-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = '从列表移除';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      const op = listTab === 'bookmarks' ? 'removeBookmark' : 'removeHistory';
      if (!api.browserData) return;
      api.browserData(op, item.url).then((data) => {
        if (data) browserData = data;
        renderList();
        renderStar();
      }).catch(() => {});
    });
    row.appendChild(main);
    row.appendChild(del);
    row.addEventListener('click', () => {
      closeWebPops();
      barOpen();
      navigateActive(item.url);
    });
    return row;
  }

  /** 渲染列表。reset=true 时从头重新渲染并重置分页；滚动到底时传 false 追加下一页。 */
  function renderList(reset) {
    const body = $('webListBody');
    if (reset !== false) {
      listItems = listTab === 'bookmarks' ? browserData.bookmarks : browserData.history;
      listRendered = 0;
      listLastDay = '';
      body.textContent = '';
    }
    const items = listItems;
    document.querySelectorAll('.wlp-tab').forEach((b) => b.classList.toggle('active', b.dataset.list === listTab));
    $('webListClear').textContent = listTab === 'bookmarks' ? '清空收藏' : '清空历史';
    $('webListTip').textContent = listTab === 'history' && !browserData.remember
      ? '仅本次运行可见' : `${items.length} 条`;
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'wlp-empty';
      empty.textContent = listTab === 'bookmarks'
        ? '还没有收藏。点地址栏旁边的星标即可加入。'
        : (browserData.remember ? '还没有访问记录。' : '历史只在设置里打开「记住网址」后才会长期保存。');
      body.appendChild(empty);
      return;
    }
    const end = Math.min(listRendered + LIST_PAGE, items.length);
    for (let i = listRendered; i < end; i++) {
      const item = items[i];
      if (listTab === 'history') {
        const g = dayGroup(item.at);
        if (g !== listLastDay) {
          const sep = document.createElement('div');
          sep.className = 'wlp-day';
          sep.textContent = g;
          body.appendChild(sep);
          listLastDay = g;
        }
      }
      body.appendChild(makeListItem(item));
    }
    listRendered = end;

    // 底部：还有更多则是「加载更多」按钮；全部渲染完则换成计数提示。
    let more = $('wlpMore');
    if (more && more.parentNode !== body) more = null;
    if (!more) {
      more = document.createElement('button');
      more.id = 'wlpMore';
      more.type = 'button';
      more.addEventListener('click', () => renderList(false));
    }
    if (listRendered < items.length) {
      more.className = 'wlp-more';
      more.textContent = `加载更多（还有 ${items.length - listRendered} 条）`;
    } else {
      more.className = 'wlp-more done';
      more.textContent = `已显示全部 ${items.length} 条`;
    }
    body.appendChild(more);
  }

  function openList(tab) {
    listTab = tab === 'history' ? 'history' : 'bookmarks';
    closeWebPops();
    $('webListPop').hidden = false;
    barOpen();
    loadBrowserData().then(renderList);
  }

  function toast(text, tone) {
    const el = $('notice');
    el.textContent = text;
    el.className = `notice show${tone === 'warn' ? ' warn' : ''}`;
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      el.className = `notice${tone === 'warn' ? ' warn' : ''}`;
      setTimeout(() => { el.hidden = true; }, 220);
    }, 3400);
  }

  function setIdleText(title, desc) {
    const card = $('idle');
    card.querySelector('.idle-title').textContent = title;
    card.querySelector('.idle-desc').textContent = desc;
  }

  function applyMute() {
    const muted = !config || config.muted;
    try { if (typeof view.setAudioMuted === 'function') view.setAudioMuted(muted); } catch (_) {}
    // 每个标签页都是独立的 guest，静音要逐个下发，否则切标签就会冒出声音
    for (const tab of tabs) {
      try { if (typeof tab.view.setAudioMuted === 'function') tab.view.setAudioMuted(muted); } catch (_) {}
    }
    $('btnMute').classList.toggle('muted', !!muted);
  }

  // 缩放作用在 webview 的 guest 上：网页与投屏查看页共用同一套缩放，
  // 且窗口尺寸变化时 Chromium 会按新的视口重新排版，内容始终自适应。
  function applyZoom() {
    const value = clampZoom(zoom);
    try { if (typeof view.setZoomFactor === 'function') view.setZoomFactor(value); } catch (_) {}
    for (const tab of tabs) {
      try { if (typeof tab.view.setZoomFactor === 'function') tab.view.setZoomFactor(value); } catch (_) {}
    }
    const text = `${Math.round(value * 100)}%`;
    $('zoomLabel').textContent = text;
    $('pZoomLabel').textContent = text;
    $('mZoomLabel').textContent = text;
  }

  function applyPure() {
    const next = !!pure;
    const was = document.body.classList.contains('pure');
    document.body.classList.toggle('pure', next);
    const pop = $('zoomPop');
    if (next) pop.hidden = true;
    if (!next) {
      // 退出纯净模式：浏览条回到正常占位排版，残留的 peek 状态要清掉，
      // 否则下次进纯净模式会「一进来就是展开的」并且计时器还在跑。
      clearTimeout(barHideTimer);
      webBar.classList.remove('peek');
      return;
    }
    if (!was && currentMode === 'web') {
      // 刚切进纯净模式：让浏览条露个脸再缩回去。否则它一进来就消失，
      // 用户既看不到网址也不知道「鼠标贴顶部能叫出来」。
      barOpen();
      barScheduleHide(2600);
    }
  }

  function setZoom(value) {
    zoom = Math.round(clampZoom(value) * 100) / 100;
    applyZoom();
    try { api.setZoom(zoom).catch(() => {}); } catch (_) {}
  }

  function nudgeZoom(delta) { setZoom(zoom + delta); }

  function updateChip() {
    const chip = $('modeChip');
    chip.classList.remove('pin', 'live', 'warn');
    if (currentMode === 'web') {
      chip.textContent = tabs.length > 1 ? `网页 · ${tabs.length}` : '网页';
      return;
    }
    if (currentMode !== 'mirror') { chip.textContent = '待机'; return; }
    const s = apStatus || {};
    if (s.phase === 'error') {
      chip.classList.add('warn');
      chip.textContent = '投屏 · 启动失败';
      return;
    }
    if (!s.running) { chip.textContent = '投屏 · 未开启'; return; }
    if (vnetLive || capStream || s.windowReady) {
      chip.classList.add('live');
      chip.textContent = '投屏 · 已连接';
      return;
    }
    // 手机端结束了投屏：胶囊先说清楚「断了」，PIN 在下面的等待卡里一样看得见
    if (s.sessionLost) {
      chip.classList.add('warn');
      chip.textContent = s.reconnecting ? '投屏 · 重连中' : '投屏 · 已断开';
      return;
    }
    // 手机还没连上：把 PIN 直接印在胶囊上，不用打开任何面板
    if (!s.noPin && /^\d{4}$/.test(String(s.pin || ''))) {
      chip.classList.add('pin');
      chip.textContent = `PIN ${s.pin}`;
    } else {
      chip.textContent = '等待连接';
    }
  }

  /**
   * 投屏相关的三类界面一起刷新：
   * 顶部胶囊（PIN / 已连接）、投屏面板（开关 + PIN + 设置入口）、中央等待卡。
   * 全部由主进程推来的状态驱动，浮窗上不再需要「去设置里看一眼 PIN」。
   */
  function renderAirplay() {
    const s = apStatus || {};
    const running = !!s.running;
    const pin = String(s.pin || '');
    const hasPin = running && !s.noPin && /^\d{4}$/.test(pin);
    const connected = running && (!!s.windowReady || !!capStream || vnetLive);
    // 手机端主动结束了投屏（锁屏 / 切换音频设备 / 走远）：不是坏，而是断开了，
    // 主进程会自动重启接收器（PIN 不变），这里只需要说清楚「怎么连回来」。
    const lost = running && !connected && !!s.sessionLost;

    const badge = $('castBadge');
    badge.className = 'cast-badge';
    if (s.phase === 'error') { badge.classList.add('warn'); badge.textContent = '启动失败'; }
    else if (!running) badge.textContent = '未开启';
    else if (connected) { badge.classList.add('live'); badge.textContent = '已连接'; }
    else if (lost) { badge.classList.add('warn'); badge.textContent = s.reconnecting ? '已断开 · 重连中' : '已断开'; }
    else if (s.phase === 'starting') badge.textContent = '正在启动…';
    else if (hasPin) { badge.classList.add('pin'); badge.textContent = '等待输入 PIN'; }
    else { badge.classList.add('pin'); badge.textContent = '等待连接'; }

    $('castPin').hidden = !(running && (hasPin || s.noPin));
    $('castPinText').textContent = hasPin ? pin : '免 PIN';
    $('castDevice').textContent = s.name || 'Winkow';

    $('castHelp').textContent = s.phase === 'error'
      ? TXT.airplayError(s.error)
      : !running
        ? '点「开始接收」，再用 iPhone 控制中心 → 屏幕镜像连接。'
        : connected
          ? '已连接，手机画面会自动铺满小窗。'
          : lost
            ? (s.reconnecting
              ? '正在自动重连，稍等两秒再点一次「屏幕镜像」。'
              : '手机上切换声音输出会断开投屏，这是 iOS 的行为。点一次「屏幕镜像」就能接回来；想一直不断，用耳机连电脑听声音，别动手机的音频输出。')
            : hasPin
              ? `控制中心 → 屏幕镜像 → 选「${s.name || 'Winkow'}」，输入上面的 PIN。`
              : '控制中心 → 屏幕镜像 → 选本机即可（免 PIN）。';

    const toggle = $('castToggle');
    toggle.textContent = running ? '停止接收' : '开始接收';
    toggle.disabled = apBusy;

    const title = $('waitTitle');
    if (title) {
      title.textContent = !running ? 'iOS 投屏未开启'
        : connected ? '正在接收画面…'
          : lost ? '投屏已断开'
            : '等待 iPhone 连接';
    }
    const desc = $('waitDesc');
    if (desc) {
      desc.textContent = !running
        ? '点「开始接收」，iPhone 控制中心 → 屏幕镜像'
        : connected
          ? '画面马上出来，稍等一下'
          : lost
            ? (s.reconnecting
              ? '接收器正在重启，两秒后再点一次「屏幕镜像」'
              : '在 iPhone 控制中心点一次「屏幕镜像」，选本机就能接回来')
            : hasPin
              ? `控制中心 → 屏幕镜像 → 选「${s.name || 'Winkow'}」，输入下方 PIN`
              : '控制中心 → 屏幕镜像 → 选本机（免 PIN）';
    }
    const row = $('pinRow');
    if (row) {
      row.hidden = !(running && hasPin && !connected);
      if (!row.hidden) {
        const digits = row.querySelectorAll('.pin-d');
        for (let i = 0; i < digits.length; i += 1) digits[i].textContent = pin[i] || '·';
      }
    }
    const start = $('waitStart');
    const copy = $('waitCopy');
    const stop = $('waitStop');
    if (start) start.hidden = running;
    if (copy) copy.hidden = !(running && !connected);
    if (stop) stop.hidden = !running;

    updateChip();
  }

  async function refreshAirplay() {
    try {
      const s = await api.airplayStatus();
      if (s) { apStatus = s; renderAirplay(); }
    } catch (_) {}
  }

  async function airplayToggle() {
    if (apBusy) return;
    apBusy = true;
    renderAirplay();
    const wasRunning = !!(apStatus && apStatus.running);
    try {
      const s = await api.airplayAction(wasRunning ? 'stop' : 'start');
      if (s) apStatus = s;
      if (s && s.error) {
        // 详细原因留在设置页的日志里，浮窗只给一句人话
        console.warn('[moyu] 投屏启动失败', s.error);
        toast(TXT.airplayError(s.error), 'warn');
      } else if (!wasRunning) {
        // 待机时开投屏：先把画面切过去，PIN 立刻摆在画面中央。
        // 正在看网页就不抢画面，等引擎就绪后由主进程切（停止时还能回到网页）。
        if (currentMode === 'idle') api.setMode('mirror');
        toast(s && s.noPin ? '接收器已开启（免 PIN）' : `接收器已开启 · PIN ${(s && s.pin) || '----'}`);
      } else {
        toast('已停止接收');
      }
    } catch (err) {
      // IPC 失败（主进程忙 / 超时）对用户没有可读信息量，只记一笔
      console.warn('[moyu] 投屏操作失败', err);
      toast('操作没成功，请再试一次', 'warn');
    } finally {
      apBusy = false;
      renderAirplay();
      refreshAirplay();
    }
  }

  async function copyPin(text) {
    const value = String(text || '');
    if (!value || !/^\d{4}$/.test(value)) { toast('当前没有 PIN 可复制', 'warn'); return; }
    try {
      await navigator.clipboard.writeText(value);
      toast(`PIN ${value} 已复制`);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(`PIN ${value} 已复制`); }
      catch (e) { toast(`PIN 是 ${value}`, 'tip'); }
      ta.remove();
    }
  }

  // ---- 投屏画面：捕获引擎自己解码出来的视频窗口 ----
  //
  // 为什么不走「引擎导出 H264 → ffmpeg 解码」：实测引擎写出的 dump 里
  // CABAC 数据是坏的（首帧只有顶部几行是真内容），画面必然花屏；而同一时刻
  // 引擎自己渲染的那扇窗口是正常的。所以直接把那扇窗口捕获进来。
  let capStream = null;
  let windowReady = false;
  let capOnResize = null;

  // ---- vnet 直通画面（1.0.44 起的默认通道）----
  //
  // 引擎用 -vnet 把**解密后的 H264 裸码流**推到本地 TCP，主进程拆帧后逐帧
  // 转到这里，由 vnet-decoder.js 用 WebCodecs 解码、直接画到 #vnet 这块
  // canvas 上。跟上面那条捕获链路的关系是「二选一」：
  //
  //   捕获链路：引擎解码 → 独立视频窗口 → getDisplayMedia 抓窗口
  //             （要摆窗口、要防鼠标被吸进画面、隐藏会冻帧）
  //   vnet   ：引擎只解密 → TCP → WebCodecs 解码 → canvas
  //             （没有窗口，上面那些问题一个都不存在）
  //
  // 两种通道共用同一套外层 UI：谁先拿到画面，谁就算「已连接」。
  const vnetEl = $('vnet');
  let vnetDecoder = null;
  let vnetLive = false;        // 已经解出过至少一帧
  let vnetSize = { w: 0, h: 0 };
  let vnetReported = '';       // 已上报给主进程的尺寸，避免重复调窗口
  let vnetStats = null;        // 主进程侧的链路统计（连通性 / 码率）
  let vnetLastFrameAt = 0;     // 最后收到一帧的时刻（做「停更」兜底）

  /** 解出首帧或分辨率变化（手机旋转）时，把浮窗调成同一比例。 */
  function onVnetSize(w, h) {
    if (w > 0 && h > 0) vnetSize = { w: w, h: h };
    if (!vnetLive) {
      vnetLive = true;
      applyMirrorDisplay();
      updateChip();
      renderAirplay();
    }
    const key = w + 'x' + h;
    if (!w || !h || vnetReported === key) return;
    vnetReported = key;
    // 复用捕获回执那条通道：主进程拿到尺寸会 setVideoSize + tryFit 把浮窗
    // 调成手机比例。vnet 模式下 engineBox / 窗口摆位那些分支本来就跳过。
    try { api.airplayCapture(true, w, h, viewportRect()); } catch (_) {}
  }

  function ensureVnetDecoder() {
    if (vnetDecoder) return vnetDecoder;
    if (!window.VnetDecoder) return null;
    vnetDecoder = new window.VnetDecoder({
      canvas: vnetEl,
      onSize: onVnetSize,
      onFrame: function () {
        /* 停帧兜底（下面的 3 秒定时器）会把 vnetLive 收成 false 换成「等待设备」。
         * 恢复时尺寸通常没变，onSize 不会触发 —— 只靠它，画面就再也回不来了。
         * 这里每解出一帧确认一次，已经显示时立刻返回。 */
        if (vnetLive) return;
        vnetLive = true;
        applyMirrorDisplay();
        updateChip();
        renderAirplay();
      },
      onState: function (state) {
        if (state === 'unsupported') {
          toast('这台电脑暂时显示不了投屏画面，更新显卡驱动后重启 Winkow 试试', 'warn');
        }
      }
    });
    return vnetDecoder;
  }

  /** 手机断开 / 停止接收：清掉解码状态，回到「等待设备」。 */
  function resetVnet() {
    if (vnetDecoder) vnetDecoder.reset();
    vnetLive = false;
    vnetSize = { w: 0, h: 0 };
    vnetReported = '';
    if (vnetEl) vnetEl.hidden = true;
  }


  /**
   * 画面区域（.viewport）在窗口内容区里的矩形，单位换算成 DIP（乘页面缩放）。
   *
   * 主进程把引擎的视频窗口摆在这块矩形里 —— 只按整个窗口矩形摆的话，卡片
   * 外面那一圈 padding / 阴影 / 圆角是透明的，背后那扇窗口就会从缝里露出来，
   * 看上去像「浮窗后面还叠着一份投屏画面」。
   */
  function viewportRect() {
    const vp = document.querySelector('.viewport');
    if (!vp) return null;
    // 不能用 getBoundingClientRect：.shell 上有显隐动画的 transform: scale()，
    // 那段时间量到的是「缩放后的屏幕盒子」—— 0.86 的时候 139px 会量成 120px，
    // 引擎视频窗口按它摆就会比卡片小一圈，画面四周冒出黑边/透明缝。
    // offsetWidth / offsetLeft 量的是布局尺寸，完全不受 transform 影响。
    const w = vp.offsetWidth;
    const h = vp.offsetHeight;
    if (!w || !h) return null;
    let x = 0;
    let y = 0;
    let node = vp;
    while (node && node !== document.body) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    const z = zoom || 1;
    return {
      x: Math.round(x * z),
      y: Math.round(y * z),
      w: Math.round(w * z),
      h: Math.round(h * z)
    };
  }

  /** 窗口尺寸变了（用户拖边、切换模式）：重新告诉主进程画面区域在哪 */
  let rectTimer = null;
  const reportViewport = () => {
    clearTimeout(rectTimer);
    rectTimer = setTimeout(() => {
      if (!capStream) return;
      const r = viewportRect();
      if (!r) return;
      try { api.airplayCapture(true, cap.videoWidth || 0, cap.videoHeight || 0, r); } catch (_) {}
    }, 180);
  };
  window.addEventListener('resize', reportViewport);

  /**
   * 浮窗是否收起。隐藏时**不停**捕获流：实测同一条 WGC 流在 SW_HIDE→SW_SHOW
   * 后会自己续上实时帧，掐掉再重建反而会永远回不来。这个标记只用来：
   *   - 隐藏期间不新建流（引擎窗口被一起 SW_HIDE，此刻新建必然失败）；
   *   - 不拿隐藏期间的冻帧去做「黑屏」判定。
   */
  let windowHidden = false;
  /** 捕获流的序号：异步启动期间被叫停（或换了窗口）时，靠它把迟到的流丢掉 */
  let capSeq = 0;
  let capStarting = false;
  /** 当前捕获源 id：主进程换窗口时靠它判断要不要重建捕获流 */
  let capSourceId = '';
  /** 黑帧采样的定时器与重试次数 */
  let capBlackTimer = null;
  let capBlackTries = 0;

  function stopBlackWatch() {
    clearInterval(capBlackTimer);
    capBlackTimer = null;
  }

  /**
   * 抓到了窗口 ≠ 抓到了画面。
   *
   * 引擎进程树里混着 PyInstaller 引导窗口这类杂项窗口，绑上去时捕获会「成功」，
   * 但拿到的是一张纯黑 —— 它不会报错、不会 ended，肉眼只能看到黑屏。所以这里
   * 隔 500ms 采一次样，连续几次都是黑的就请求主进程重新找窗口。
   *
   * 重试有上限：手机锁屏、暂停推流时画面本来就是黑的，无限重找只会空转。
   */
  function watchBlackFrames() {
    stopBlackWatch();
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx2d) return;
    let samples = 0;
    let peak = 0;
    capBlackTimer = setInterval(() => {
      if (!capStream) { stopBlackWatch(); return; }
      if (windowHidden) return;   // 隐藏期间本来就是冻帧，别误判成黑屏去重找窗口
      if (!cap.videoWidth || !cap.videoHeight) return;   // 元数据还没到，别急着判黑
      samples += 1;
      peak = 0;
      try {
        ctx2d.drawImage(cap, 0, 0, canvas.width, canvas.height);
        const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < data.length; i += 4) {
          const v = Math.max(data[i], data[i + 1], data[i + 2]);
          if (v > peak) peak = v;
          if (peak > 12) break;
        }
      } catch (_) { stopBlackWatch(); return; }
      if (peak > 12) { capBlackTries = 0; stopBlackWatch(); return; }   // 有内容，正常
      if (samples < 5) return;                                          // 约 2.5s 全黑才算
      stopBlackWatch();
      if (capBlackTries >= 2) return;
      capBlackTries += 1;
      stopCapture();
      applyMirrorDisplay();
      updateChip();
      try { api.airplayReprobe(); } catch (_) {}
      toast('画面没有出来，正在自动恢复…', 'warn');
    }, 500);
  }

  async function startCapture() {
    if (capStream) return true;
    // 浮窗藏着、引擎窗口也被 SW_HIDE 时新建流必然失败（实测 Could not start
    // video source）；已有的流则完全保留，唤出后由主进程的一次轻确认接上。
    if (windowHidden || capStarting) return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return false;
    const token = ++capSeq;
    capStarting = true;
    try {
      // 主进程已用 setDisplayMediaRequestHandler 把捕获源绑到引擎的视频窗口上，
      // 这里不会再弹系统选择器，拿到的就是那扇窗口的实时画面。
      //
      // cursor:'never' 很关键：Windows 的窗口捕获默认会把鼠标指针一起合成进
      // 画面，而引擎窗口就贴在浮窗背后 —— 鼠标一移到小窗的画面上，指针就被
      // 画进帧里，看起来像「指针被吸进了投屏画面」。
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'never', frameRate: { ideal: 30, max: 30 } },
        audio: false
      });
      // 启动期间浮窗被藏起来 / 换了窗口 / 被叫停：这条流已经过期，直接扔掉，
      // 否则会留下一条没人释放的捕获（既占资源又可能让下一次捕获拿不到画面）
      if (token !== capSeq || windowHidden) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        return false;
      }
      capStream = stream;
      cap.srcObject = capStream;
      try { await cap.play(); } catch (_) {}
      // 画面是几比几只能从这条流里读：等元数据到了才有 videoWidth/Height。
      // 主进程拿它调浮窗比例（引擎窗口还没被搬动时才是自然尺寸，见 setVideoSize）。
      if (!cap.videoWidth) {
        await new Promise((res) => {
          const done = () => { cap.removeEventListener('loadedmetadata', done); res(); };
          cap.addEventListener('loadedmetadata', done);
          setTimeout(done, 1500);
        });
      }
      const reportSize = () => {
        const w = cap.videoWidth || 0;
        const h = cap.videoHeight || 0;
        if (w > 16 && h > 16) {
          try { api.airplayCapture(true, w, h, viewportRect()); } catch (_) {}
          return true;
        }
        return false;
      };
      // 手机旋转时引擎可能原地改尺寸（不重建窗口）——这种情况靠 resize 事件补报
      capOnResize = reportSize;
      cap.addEventListener('resize', capOnResize);
      // 用户在系统层面停掉共享、或引擎重建窗口（手机旋转）都会走到这里
      const track = capStream.getVideoTracks()[0];
      if (track) track.addEventListener('ended', () => {
        if (!capStream) return;   // 是我们自己 stopCapture() 停的，不算异常
        stopCapture();
        applyMirrorDisplay();
        updateChip();
        try { api.airplayReprobe(); } catch (_) {}
      });
      cap.hidden = false;
      applyMirrorDisplay();
      updateChip();
      // 告诉主进程「抓到了」+ 真实像素尺寸：它才会按手机比例调窗口，
      // 并把引擎窗口藏到小窗背后（失败时不藏）
      if (!reportSize()) { try { api.airplayCapture(true, 0, 0, viewportRect()); } catch (_) {} }
      // 捕获「成功」也可能全是黑的（绑错了窗口），这里补一层像素采样
      watchBlackFrames();
      return true;
    } catch (_) {
      capStream = null;
      // 隐藏 / 换窗口导致的失败不用惊动用户：他这会儿根本看不到浮窗，
      // 而且把引擎窗口挪到屏幕中间兜底会在桌面上泄漏手机画面。
      if (!windowHidden && token === capSeq) {
        try { api.airplayCapture(false); } catch (_) {}
        toast('画面没能显示出来，点一下画面可以重试', 'warn');
      }
      return false;
    } finally {
      capStarting = false;
    }
  }

  function stopCapture() {
    // 标记「主动停止」，这样收尾时的 track ended 不会又把状态刷回去；
    // capSeq 自增同时让还在路上的 startCapture() 把迟到的流丢掉。
    capSeq += 1;
    const stream = capStream;
    capStream = null;
    stopBlackWatch();
    if (capOnResize) { try { cap.removeEventListener('resize', capOnResize); } catch (_) {} capOnResize = null; }
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    cap.srcObject = null;
    cap.hidden = true;
  }

  /** 投屏模式下的显示优先级：捕获流 > 等待卡（PIN） > 网页视图 > 空状态。 */
  function applyMirrorDisplay() {
    const mirrorMode = currentMode === 'mirror';
    // 显示优先级：vnet（默认通道）> 窗口捕获（回退）> 等待卡（PIN）> 网页 > 空态。
    // vnet 有画面时绝不显示捕获流：两条链路同时存在只可能是切换过程中的一瞬，
    // 让 canvas 压在上面即可，不需要额外去停捕获。
    const useVnet = mirrorMode && vnetLive;
    const useCap = mirrorMode && !useVnet && !!capStream;
    const useFrame = useVnet || useCap;
    if (vnetEl) vnetEl.hidden = !useVnet;
    cap.hidden = !useCap;
    // 没有外部视频源时，投屏的空状态就是「等手机连」：把 PIN 摆在画面位置，
    // 省掉「去设置里找 PIN」这一步。有外部 MJPEG 源时不动它，那是用户自己的画面。
    const external = !!(config && config.mirrorSource);
    const wait = $('mirrorWait');
    if (wait) wait.hidden = !(mirrorMode && !useFrame && !external);
    if (useFrame) {
      view.style.display = 'none';
      $('idle').hidden = true;
      $('webEmpty').hidden = true;
      $('loading').hidden = true;
      // 有画面时不再需要中继观看页：留着它只会白跑一条永不结束的 MJPEG 请求
      const src = view.getAttribute('src');
      if (src && src !== 'about:blank') { try { view.setAttribute('src', 'about:blank'); } catch (_) {} }
    }
    renderAirplay();
  }

  function setMode(mode, url, muted) {
    const prevMode = currentMode;
    currentMode = mode;
    currentUrl = url || '';
    if (typeof muted === 'boolean' && config) config.muted = muted;
    document.body.classList.toggle('mode-web', mode === 'web');
    // 纯净模式下浏览条平时是缩在画面上方的：刚进网页模式先让它露个脸，
    // 相当于「告诉你地址栏还在，鼠标贴顶部就能叫回来」。
    if (mode === 'web' && prevMode !== 'web') {
      barOpen();
      barScheduleHide(2600);
    }
    // 引擎的视频窗口已经出现时，投屏模式不再加载中继观看页：那条 MJPEG 流在这套
    // 链路上没有数据，只会白跑一条永不结束的请求，还会先闪一帧空页面。
    // 没有外部视频源时也不加载它，投屏只有「窗口捕获」一条链路。
    // 网页模式不再用 #view：每个标签页有自己的 webview（见 createTab）。
    const external = !!(config && config.mirrorSource);
    // vnet 通道下没有引擎窗口，windowReady 永远是 false —— 判定要同时认画面
    const capMode = mode === 'mirror' && (windowReady || vnetLive);
    const showView = !capMode && mode === 'mirror' && external && !!currentUrl;

    // 只能用 flex / none：block 会破坏 Electron 内部 iframe 的高度撑满（见 float.css）
    view.style.display = showView ? 'flex' : 'none';
    $('idle').hidden = false;
    $('webEmpty').hidden = true;
    setIdleText('待机中', '选一个内容，或者就这样发个呆');

    if (mode === 'idle') {
      $('idle').hidden = false;
    } else if (mode === 'web') {
      $('idle').hidden = true;
      // 只在「刚进网页模式」或「主进程给了新地址」时动标签页：
      // 配置广播（改静音、改缩放）会反复调到这里，不能把用户正在看的页面顶掉。
      const fresh = prevMode !== 'web' || (url && url !== lastWebUrl);
      if (fresh) {
        ensureTabForUrl(url || '');
        lastWebUrl = url || '';
      } else if (!tabs.length) {
        ensureTabForUrl('');
      }
      applyWebDisplay();
      renderTabStrip();
      syncNav();
    } else if (mode === 'mirror' && !(config && config.mirrorSource)) {
      // 投屏无外部源：空状态交给等待卡接管（PIN 大字 + 开始/停止），不用一张无操作的待机卡
      $('idle').hidden = true;
    } else {
      $('idle').hidden = true;
      if (view.getAttribute('src') !== currentUrl) view.setAttribute('src', currentUrl);
    }

    if (mode !== 'web') {
      $('webEmpty').hidden = true;
    }

    if (!showView && view.getAttribute('src') && view.getAttribute('src') !== 'about:blank') {
      // 卸载后台内容：不留下历史、不继续跑视频解码
      try { view.setAttribute('src', 'about:blank'); } catch (_) {}
    }
    // 离开投屏就停掉捕获：留着会让桌面捕获一直跑，白白占用一份合成带宽
    if (mode !== 'mirror') stopCapture();
    applyMute();
    applyMirrorDisplay();
    updateChip();
    // 切到投屏且引擎窗口已就绪：立刻建立捕获，不用等下一次状态推送
    if (mode === 'mirror' && windowReady && !capStream) startCapture();
  }

  // --- webview 生命周期 ---
  view.addEventListener('did-start-loading', () => {
    if (view.style.display !== 'none') $('loading').hidden = false;
  });
  view.addEventListener('did-stop-loading', () => { $('loading').hidden = true; });
  view.addEventListener('did-fail-load', (event) => {
    $('loading').hidden = true;
    // 子框架（广告/埋点）失败不该弹提示；-3 = ERR_ABORTED，正常跳转会触发
    if (event.errorCode === -3 || !currentUrl || event.isMainFrame === false) return;
    const desc = String(event.errorDescription || '');
    const ssl = /SSL|CERT|TUNNEL|CONNECTION_RESET/i.test(desc);
    if (!ssl) console.warn('[moyu] 页面加载失败', event.errorCode, desc);
    toast(TXT.pageError(desc), 'warn');
  });
  view.addEventListener('dom-ready', () => {
    applyMute();
    applyZoom(); // 换页 / 重载后 guest 会重置缩放，需要重新应用
    try { api.webviewReady(view.getWebContentsId()); } catch (_) {}
  });

  // --- 控制条 ---
  $('btnMode').addEventListener('click', () => {
    const order = ['idle', 'web', 'mirror'];
    api.setMode(order[(order.indexOf(currentMode) + 1) % order.length]);
  });
  $('btnMute').addEventListener('click', () => api.setMuted(!(config && config.muted)));
  $('btnSettings').addEventListener('click', () => api.openSettings('general'));
  // 纯净模式开关：以前只能从托盘/设置里切，浮窗边框上给一个直接入口。
  // 纯净模式那条迷你条里的「边框」按钮负责切回来，两边同一个配置项。
  $('btnPure').addEventListener('click', () => {
    api.setConfig({ pureMode: !pure }).catch(() => {});
  });
  $('btnHide').addEventListener('click', () => api.hide('manual'));

  // ---- 投屏面板：一个入口搞定开关 / PIN / 设置 ----
  $('modeChip').addEventListener('click', (event) => {
    event.stopPropagation();
    const pop = $('castPop');
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { renderAirplay(); refreshAirplay(); }
  });
  $('castToggle').addEventListener('click', () => airplayToggle());
  $('castMore').addEventListener('click', () => {
    $('castPop').hidden = true;
    api.openSettings('content');
  });
  const copyCurrentPin = () => copyPin(apStatus && apStatus.pin);
  $('castPin').addEventListener('click', copyCurrentPin);
  $('pinRow').addEventListener('click', copyCurrentPin);
  $('waitCopy').addEventListener('click', copyCurrentPin);
  $('waitStart').addEventListener('click', () => airplayToggle());
  $('waitStop').addEventListener('click', () => airplayToggle());
  document.addEventListener('pointerdown', (event) => {
    const pop = $('castPop');
    if (pop.hidden || pop.contains(event.target) || $('modeChip').contains(event.target)) return;
    pop.hidden = true;
  });

  // ---- 缩放控件（普通模式面板 + 纯净模式迷你条共用同一套逻辑） ----
  $('btnZoom').addEventListener('click', () => {
    const pop = $('zoomPop');
    pop.hidden = !pop.hidden;
  });
  $('zoomOut').addEventListener('click', () => nudgeZoom(-0.1));
  $('zoomIn').addEventListener('click', () => nudgeZoom(0.1));
  $('zoomReset').addEventListener('click', () => setZoom(1));
  $('pZoomOut').addEventListener('click', () => nudgeZoom(-0.1));
  $('pZoomIn').addEventListener('click', () => nudgeZoom(0.1));
  $('pChrome').addEventListener('click', () => api.setConfig({ pureMode: false }).catch(() => {}));
  $('pSettings').addEventListener('click', () => api.openSettings('content'));
  $('pHide').addEventListener('click', () => api.hide('manual'));
  document.addEventListener('pointerdown', (event) => {
    const pop = $('zoomPop');
    if (pop.hidden || pop.contains(event.target) || $('btnZoom').contains(event.target)) return;
    pop.hidden = true;
  });

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 「iOS 投屏」= 一键开始接收，不用先进设置里开引擎
      if (btn.dataset.mode === 'mirror' && !(apStatus && apStatus.running)) {
        airplayToggle();
        return;
      }
      api.setMode(btn.dataset.mode);
    });
  });

  function goWeb() {
    const value = $('webUrlInput').value.trim();
    if (!value) return;
    // 已经在网页模式：直接在当前标签里打开，不要再走一次模式切换
    if (currentMode === 'web') { navigateActive(value); return; }
    api.setMode('web', value);
  }
  $('webUrlGo').addEventListener('click', goWeb);
  $('webUrlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') goWeb();
    event.stopPropagation();
  });

  // ---- 纯净模式：浏览条平时缩在画面上方，要用了才滑出 ----
  // 纯净模式没有标题栏，浏览条是浮层。以前它常驻（opacity .66），网页顶部那一条
  // —— B 站顶栏、播放器控制条、GitHub header —— 永远被压着点不到；260×180 的小窗
  // 里它差不多占掉三分之一。现在默认移出画面（并在收起时 pointer-events:none，
  // 顶部点击直接穿透给网页），鼠标贴住窗口顶部 8px 才滑出，离开 2 秒自动缩回。
  function barOpen() {
    if (!pure || currentMode !== 'web') return;
    clearTimeout(barHideTimer);
    webBar.classList.add('peek');
  }

  function barScheduleHide(delay) {
    clearTimeout(barHideTimer);
    if (!pure || currentMode !== 'web') return;
    barHideTimer = setTimeout(() => {
      // 拖窗口 / 按住鼠标 / 地址栏有焦点 / 鼠标还停在条上：都不收
      if (barPinned || webBar.contains(document.activeElement)) return;
      if (webBar.matches(':hover')) return;
      webBar.classList.remove('peek');
    }, delay == null ? 2000 : delay);
  }

  // 鼠标贴到窗口顶部 → 滑出。webview 是独立渲染层，鼠标停在网页上时宿主页
  // 收不到 mousemove，只能靠顶部这层 8px 的 DOM 热区兜住这个动作。
  if (webHot) {
    webHot.addEventListener('mouseenter', () => {
      barOpen();
      barScheduleHide(2600);
    });
  }
  webBar.addEventListener('mouseenter', barOpen);
  webBar.addEventListener('mouseleave', () => barScheduleHide());
  // 按下就钉住：拖动窗口的过程会持续几秒，中途缩回等于把拖拽掐断。
  // 拖窗口时 mouseup 常常落在窗口外收不到，所以再给一个兜底计时，别让它永远钉住。
  webBar.addEventListener('mousedown', () => {
    barPinned = true;
    clearTimeout(barHideTimer);
    clearTimeout(barPinTimer);
    barPinTimer = setTimeout(() => {
      barPinned = false;
      barScheduleHide();
    }, 6000);
  });
  window.addEventListener('mouseup', () => {
    if (!barPinned) return;
    barPinned = false;
    clearTimeout(barPinTimer);
    barScheduleHide();
  });
  window.addEventListener('blur', () => {
    barPinned = false;
    clearTimeout(barPinTimer);
  });

  // ---- 浏览条：标签页 / 前进后退 / 刷新 / 地址栏 ----
  $('navBack').addEventListener('click', () => navAction('back'));
  $('navFwd').addEventListener('click', () => navAction('forward'));
  $('navReload').addEventListener('click', () => navAction('reload'));
  $('navNewTab').addEventListener('click', () => {
    const tab = createTab('', { activate: true });
    if (tab) $('navUrl').focus();
  });

  // ---- 收藏 / 历史 / 窄窗「更多」下拉 ----
  $('navStar').addEventListener('click', () => toggleStar());
  $('navLists').addEventListener('click', () => openList('bookmarks'));
  $('navMore').addEventListener('click', (event) => {
    event.stopPropagation();
    const pop = $('morePop');
    const open = pop.hidden;
    closeWebPops();
    pop.hidden = !open;
    if (open) { renderStar(); barOpen(); }
  });
  $('mMoreBookmarks').addEventListener('click', () => openList('bookmarks'));
  $('mMoreHistory').addEventListener('click', () => openList('history'));
  $('mMoreStar').addEventListener('click', () => { closeWebPops(); toggleStar(); });
  $('mMoreReload').addEventListener('click', () => { closeWebPops(); navAction('reload'); });
  $('mMoreNewTab').addEventListener('click', () => {
    closeWebPops();
    const tab = createTab('', { activate: true });
    if (tab) $('navUrl').focus();
  });
  $('mZoomOut').addEventListener('click', () => nudgeZoom(-0.1));
  $('mZoomIn').addEventListener('click', () => nudgeZoom(0.1));
  $('mZoomReset').addEventListener('click', () => setZoom(1));
  $('webListClose').addEventListener('click', () => closeWebPops());
  document.querySelectorAll('.wlp-tab').forEach((btn) => {
    btn.addEventListener('click', () => { listTab = btn.dataset.list; renderList(); });
  });
  let clearArmed = 0;
  $('webListClear').addEventListener('click', (event) => {
    const btn = event.currentTarget;
    const now = Date.now();
    if (now - clearArmed > 3000) {
      clearArmed = now;
      btn.textContent = listTab === 'bookmarks' ? '再点一次确认清空' : '再点一次确认清空';
      return;
    }
    clearArmed = 0;
    const op = listTab === 'bookmarks' ? 'clearBookmarks' : 'clearHistory';
    if (!api.browserData) return;
    // 收藏的清空走「逐条删」：避免为一次性操作再开一个 op
    const done = (data) => {
      if (data) browserData = data;
      renderList();
      renderStar();
      toast(listTab === 'bookmarks' ? '收藏已清空' : '历史已清空');
    };
    if (op === 'clearBookmarks') {
      Promise.all(browserData.bookmarks.map((it) => api.browserData('removeBookmark', it.url)))
        .then((list) => done(list && list[list.length - 1]))
        .catch(() => {});
    } else {
      api.browserData('clearHistory').then(done).catch(() => {});
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if ($('webListPop').hidden && $('morePop').hidden) return;
    const inside = $('webListPop').contains(event.target) || $('morePop').contains(event.target)
      || $('navMore').contains(event.target) || $('navLists').contains(event.target);
    if (!inside) closeWebPops();
  });
  // 列表滚动到底自动续一页：滚动条已隐藏，这一步是长列表翻页的主要入口
  $('webListBody').addEventListener('scroll', () => {
    const el = $('webListBody');
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24 && listRendered < listItems.length) {
      renderList(false);
    }
  });

  $('navUrl').addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Enter') return;
    const value = $('navUrl').value.trim();
    if (!value) return;
    navigateActive(value);
    $('navUrl').blur();
  });
  // 输入框获得焦点时全选，方便直接覆盖旧地址（和浏览器一致）
  $('navUrl').addEventListener('focus', () => {
    barOpen();
    try { $('navUrl').select(); } catch (_) {}
  });
  // 地址栏失焦（回车跳转 / 点了网页）：浏览条没有继续留着的理由，稍等就缩回
  $('navUrl').addEventListener('blur', () => barScheduleHide(600));

  // window.open / target=_blank：主进程拦下来，在这里开成新标签页
  api.onWebOpenTab((payload) => {
    const url = payload && payload.url;
    if (!url) return;
    if (currentMode !== 'web') { api.setMode('web', url); return; }
    // 标签开满时也别「点了没反应」：退化到当前标签打开，链接内容照样能看到
    if (tabs.length >= MAX_TABS) {
      const tab = activeTab();
      if (tab) { navigateTab(tab, url); toast('标签已满，已在当前标签打开', 'warn'); }
      return;
    }
    const created = createTab(url, { activate: true });
    if (!created) {
      const tab = activeTab();
      if (tab) navigateTab(tab, url);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { api.hide('manual'); return; }
    if (event.ctrlKey || event.metaKey) {
      if (event.key === '-' || event.key === '_') { event.preventDefault(); nudgeZoom(-0.1); }
      else if (event.key === '=' || event.key === '+') { event.preventDefault(); nudgeZoom(0.1); }
      else if (event.key === '0') { event.preventDefault(); setZoom(1); }
      else if (currentMode === 'web' && (event.key === 't' || event.key === 'T')) {
        event.preventDefault();
        createTab('', { activate: true });
        $('navUrl').focus();
      } else if (currentMode === 'web' && (event.key === 'w' || event.key === 'W')) {
        event.preventDefault();
        const tab = activeTab();
        if (tab) closeTab(tab.id);
      }       else if (currentMode === 'web' && (event.key === 'r' || event.key === 'R')) {
        event.preventDefault();
        navAction('reload');
      } else if (currentMode === 'web' && (event.key === 'd' || event.key === 'D')) {
        event.preventDefault();
        toggleStar();
      }
      return;
    }
    // Alt+← / Alt+→：浏览器通用的前进后退
    if (currentMode === 'web' && event.altKey) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); navAction('back'); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); navAction('forward'); }
    }
    if (currentMode === 'web' && event.key === 'F5') {
      event.preventDefault();
      navAction('reload');
    }
  }, true);

  // 外壳区域支持 Ctrl + 滚轮缩放。鼠标落在网页上时这里收不到事件
  // （webview 是独立渲染进程，滚轮不冒泡），那条路由 guest preload 送回
  // onZoomNudge —— 两条路最终都汇到 nudgeZoom，缩放只有一个真相。
  window.addEventListener('wheel', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    nudgeZoom(event.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });

  api.onZoomNudge((msg) => {
    const dir = msg && msg.dir === 'out' ? 'out' : 'in';
    nudgeZoom(dir === 'in' ? 0.1 : -0.1);
  });

  // 捕获失败后的兜底：点一下画面就是一次真实用户手势，Chromium 对
  // getDisplayMedia 的手势检查在个别版本上仍会拦，这里给一次手动重试的机会。
  document.querySelector('.viewport').addEventListener('click', () => {
    if (currentMode === 'mirror' && windowReady && !capStream) startCapture();
  });

  // --- 主进程推送 ---
  function acceptConfig(cfg) {
    config = cfg;
    zoom = clampZoom(cfg.zoom);
    pure = !!cfg.pureMode;
    document.body.classList.toggle('locked', cfg.resizable === false);
    $('hint').textContent = `${cfg.hotkey} 收起 · ${cfg.hideOnMouseLeave ? '移出自动隐藏' : '仅快捷键隐藏'}`;
    applyPure();
    applyMute();
    applyZoom();
    // 「记住网址」翻转时重读一次：关掉后主进程会立刻抹掉磁盘与内存里的历史
    if (browserData.remember !== !!cfg.rememberLastUrl) loadBrowserData();
    renderStar();
  }

  /**
   * 主题：主进程已经把「用户选的」翻译成「实际生效的」再推过来，
   * 这里只负责把结果挂到 <html data-theme>，剩下的全交给 CSS 变量。
   * 深色是 CSS 的默认值，所以只有 light 需要显式写出来。
   */
  function applyTheme(t) {
    const eff = t && t.effective === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    if (root.dataset.theme !== eff) root.dataset.theme = eff;
    // 跟随系统时，标题栏/滚动条等原生部分也跟着系统走（themeSource 已在主进程设好）
    if (t && t.mode) root.dataset.themeMode = t.mode;
  }

  /**
   * 显隐动画：主进程只告诉「到哪个状态、用多久」，插值全部交给合成层。
   *
   * 以前的动画是在主进程里逐帧 setBounds 改窗口尺寸。两个问题都出在
   * 「窗口真的在变大变小」上：尺寸要取整，中心对齐后位置每帧跳 1px，
   * 看起来像在颤；更麻烦的是 webview 的视口跟着变，网页会按新宽度重新
   * 排版 —— 动画过程中画面内容自己动了一下。
   *
   * 现在窗口一动不动，只缩放/平移/淡入这一层 shell（含 webview 的合成
   * 表面），既不会重排，也是 60/120Hz 的合成器在插值，丝滑得多。
   */
  api.onAnim((a) => {
    const shell = document.getElementById('shell');
    if (!shell || !a) return;
    const ms = Math.max(0, Number(a.ms) || 0);
    const scale = Number(a.scale);
    const dy = Number(a.dy) || 0;
    const alpha = Math.max(0, Math.min(1, Number(a.alpha)));
    const transform = `scale(${Number.isFinite(scale) ? scale : 1}) translateY(${dy}px)`;
    if (a.immediate || ms === 0) {
      shell.style.transition = 'none';
      shell.style.transform = transform;
      shell.style.opacity = String(alpha);
      // 把这一帧结算掉，否则它和下一次赋值会被合并成一次，动画直接跳到终点
      void shell.offsetWidth;
      shell.style.transition = '';
      return;
    }
    // 出现用带一点过冲的 ease-out（探头），消失用加速的 ease-in（钻出去）
    const easing = scale >= 1 ? 'cubic-bezier(.34,1.44,.64,1)' : 'cubic-bezier(.4,0,.72,.25)';
    shell.style.transition = `transform ${ms}ms ${easing}, opacity ${ms}ms ease-out`;
    shell.style.transform = transform;
    shell.style.opacity = String(alpha);
  });

  api.onTheme(applyTheme);
  // 主动补一次：窗口 ready 那一拍主进程可能已经把广播发完了，
  // 那时 onTheme 还没挂上，结果「用户选的是哪种」会一直空着。
  if (api.getTheme) api.getTheme().then(applyTheme).catch(() => {});
  api.onConfig((cfg) => acceptConfig(cfg));
  api.onState((snapshot) => {
    const hidden = snapshot.state === 'hidden' || snapshot.state === 'hiding';
    $('dot').classList.toggle('hidden-state', hidden);
    $('statusText').textContent = hidden ? '已藏好' : (currentMode === 'mirror' ? '正在投屏' : '轻松一下');
  });
  api.onMirror((status) => { mirror = status; updateChip(); });
  // 双保险：广播可能落在页面 ready 之前，所以也跟一次状态快照里的 windowReady
  api.onAirplay((st) => {
    if (!st) return;
    apStatus = st;
    renderAirplay();
    // 隐藏/显示只切换一个「别在隐藏期间动手」的标记，**绝不掐断已有流**。
    // 旧版在这里 stopCapture()，显示时又由 AIRPLAY_WINDOW 的 restart 再
    // stop+start 一次；两次异步调用互相把对方的流判成过期，结果恢复后
    // 一条流都没有 —— 用户看到的正是「窗口自动隐藏恢复后画面没有恢复」。
    const hidden = !!st.hidden;
    if (hidden !== windowHidden) {
      windowHidden = hidden;
      if (hidden) {
        stopBlackWatch();
      } else if (currentMode === 'mirror' && windowReady && !capStream) {
        startCapture();          // 隐藏期间窗口才出现、还没建过流的边缘情况
      } else if (capStream) {
        // 窗口隐藏久了 Chromium 可能把 <video> 挂起：唤出时补一次 play，
        // 让同一条流立刻把新帧画出来（不重建、不闪等待卡）。
        try { if (cap.paused) cap.play().catch(() => {}); } catch (_) {}
        cap.hidden = false;
        watchBlackFrames();      // 唤出后恢复黑帧监测
      }
    }
    // 手机端结束了投屏：把解码状态清干净。TCP 不会断（引擎还在跑），
    // 但画面必须收起来，否则用户会对着一张定格旧图以为还连着。
    if (st.sessionLost && vnetLive) { resetVnet(); applyMirrorDisplay(); updateChip(); }
    if (typeof st.windowReady !== 'boolean') return;
    if (st.windowReady === windowReady) return;
    windowReady = st.windowReady;
    // 新会话 / 新窗口：重新给「黑帧兜底」几次机会，否则上一次用完额度就再也不重试
    capBlackTries = 0;
    if (windowReady && currentMode === 'mirror' && !windowHidden && !capStream) startCapture();
    if (!windowReady) { stopCapture(); applyMirrorDisplay(); }
  });
  // vnet 直通：每帧一个 access unit 的 Annex-B 裸码流（首帧自带 SPS/PPS）。
  //
  // 这里**不按当前模式过滤**：H264 的 P 帧依赖前面的参考帧，跳过的帧数一多
  // 解码器就再也接不上，而 SPS/IDR 只在会话开始时来一次 —— 一停就只能等
  // 手机重新发起投屏。所以始终喂给解码器，只在非投屏模式下把 canvas 藏起来。
  api.onVnetFrame((payload) => {
    if (!payload || !payload.data) return;
    vnetLastFrameAt = Date.now();
    const d = ensureVnetDecoder();
    if (!d) return;
    d.push(payload.data, payload.ts);
  });
  api.onVnetStats((s) => { vnetStats = s; });

  api.onAirplayWindow((info) => {
    windowReady = !!(info && info.ready);
    if (windowReady) {
      // 主进程可能中途换窗口（进程树里先冒出来的杂项窗口被换成真的视频窗口）。
      // 换窗口必须重开捕获流，<video> 不会自己跳过去。
      const id = String((info && info.id) || '');
      if (id && capSourceId && id !== capSourceId) stopCapture();
      if (id) capSourceId = id;
      // 只有「换了窗口 / 明确要求重建」才停旧流；浮窗显示回来不带 restart，
      // 同一条流会自己续上实时帧，不需要任何重建。
      if (info && info.restart) { stopCapture(); capBlackTries = 0; }
      // 只有在投屏模式才去抓：否则等于在后台白白开一路桌面捕获
      if (currentMode === 'mirror' && !windowHidden) { if (!capStream) startCapture(); }
      else applyMirrorDisplay();
    } else {
      stopCapture();
      capSourceId = '';
      applyMirrorDisplay();
      updateChip();
    }
  });
  api.onMode((payload) => setMode(payload.mode, payload.url, payload.muted));
  api.onNotice((payload) => toast(payload.text, payload.tone));

  // 双保险：即便首帧广播在页面 load 前被丢弃，也主动拉一次配置
  api.getConfig().then((cfg) => acceptConfig(cfg)).catch(() => {});
  // 投屏状态：进入页面先拉一次（PIN / 胶囊要立刻正确），之后低频兜底
  refreshAirplay();
  setInterval(refreshAirplay, 5000);

  // ---- 8 向拖拽手柄：只把方向 + 相对位移交给主进程，避免渲染层直接改窗口 ----
  function endResize() {
    if (!resizeState) return;
    try { resizeState.el.releasePointerCapture(resizeState.pointerId); } catch (_) {}
    resizeState = null;
    document.body.classList.remove('resizing');
    api.resizeEnd();
  }

  document.querySelectorAll('.rz[data-dir]').forEach((el) => {
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (config && config.resizable === false)) return;
      event.preventDefault();
      event.stopPropagation();
      resizeState = {
        el, pointerId: event.pointerId,
        x: event.screenX, y: event.screenY
      };
      try { el.setPointerCapture(event.pointerId); } catch (_) {}
      document.body.classList.add('resizing');
      api.resizeStart(el.dataset.dir);
    });
    el.addEventListener('pointermove', (event) => {
      if (!resizeState || resizeState.el !== el) return;
      api.resizeMove(event.screenX - resizeState.x, event.screenY - resizeState.y);
    });
    el.addEventListener('pointerup', endResize);
    el.addEventListener('pointercancel', endResize);
    el.addEventListener('lostpointercapture', endResize);
  });

  // ---- 顶部横条拖动窗口 ----
  // 为什么不交给 -webkit-app-region:drag：透明窗口上它注册得时灵时不灵
  // （同一坐标改样式/重建节点能拖、重开窗口又拖不动，WM_NCHITTEST 恒为
  // HTCLIENT），用户实际就是「横条在那儿但按下去不动」。这里自己实现：
  // 横条所在层收 pointer 事件，按屏幕坐标算相对位移发给主进程改窗口位置。
  function endDrag() {
    if (!dragState) return;
    if (dragState.raf) cancelAnimationFrame(dragState.raf);
    try { dragState.el.releasePointerCapture(dragState.pointerId); } catch (_) {}
    dragState = null;
    document.body.classList.remove('dragging');
    api.dragEnd();
  }

  const dragStrip = document.querySelector('.drag-strip');
  if (dragStrip) {
    dragStrip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragState = {
        el: dragStrip, pointerId: event.pointerId,
        x: event.screenX, y: event.screenY
      };
      try { dragStrip.setPointerCapture(event.pointerId); } catch (_) {}
      document.body.classList.add('dragging');
      api.dragStart();
    });
    dragStrip.addEventListener('pointermove', (event) => {
      if (!dragState) return;
      dragState.dx = event.screenX - dragState.x;
      dragState.dy = event.screenY - dragState.y;
      if (dragState.raf) return;
      dragState.raf = requestAnimationFrame(() => {
        if (!dragState) return;
        dragState.raf = 0;
        // 用最新一帧的位移，不是第一次触发的那个
        api.dragMove(dragState.dx, dragState.dy);
      });
    });
    dragStrip.addEventListener('pointerup', endDrag);
    dragStrip.addEventListener('pointercancel', endDrag);
    dragStrip.addEventListener('lostpointercapture', endDrag);
  }

  // vnet 画面的「停更」兜底。手机结束投屏时 TCP 不会断（引擎还在跑，只是
  // 不再有帧），所以光看连接状态会以为还连着。3 秒没有新帧就把画面收起来。
  // 阈值给得宽松：iOS 静止画面时引擎仍会持续送帧（实测 30fps 不停），
  // 真正停帧只可能是会话结束了。
  //
  // 例外：手机那边**还认为自己在投屏**（session 仍 active、没有 sessionLost）
  // 却一帧都收不到 —— 那不是「用户停了投屏」，是收流链路断了。这时把画面
  // 换成「等待设备」卡很容易被当成「投屏自己没了」，所以额外说一句话，
  // 并提示唯一的出路（重新选一次「屏幕镜像」＝新会话重发 SPS/PPS）。
  setInterval(() => {
    if (!vnetLive) return;
    if (Date.now() - vnetLastFrameAt <= 3000) return;
    const phoneStillCasting = !!(apStatus && apStatus.session && !apStatus.sessionLost);
    vnetLive = false;
    applyMirrorDisplay();
    updateChip();
    renderAirplay();
    if (phoneStillCasting) {
      toast('画面停住了。如果几秒内没恢复，请在手机上重新选一次「屏幕镜像」', 'warn');
    }
  }, 1000);

  // 收藏 / 历史在启动时拉一次。广播可能早于监听挂好，所以用 invoke 主动取。
  loadBrowserData();

  api.ready();
})();
