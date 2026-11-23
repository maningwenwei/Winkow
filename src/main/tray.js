'use strict';

/** 系统托盘：左键切换浮窗；右键菜单含「设置」入口。 */
const { Tray, Menu, app, clipboard } = require('electron');
const { TRAY_IMAGE } = require('./windows');
const { MODE } = require('../shared/constants');

class TrayManager {
  constructor(config, controller, actions) {
    this.config = config;
    this.controller = controller;
    this.actions = actions;
    this.tray = null;
  }

  init() {
    const cfg = this.config.get();
    if (!cfg.trayVisible) return; // 完全静默模式：只靠全局快捷键
    if (this.tray && !this.tray.isDestroyed()) return this.refresh();
    const icon = TRAY_IMAGE;
    if (!icon || icon.isEmpty()) return;
    this.tray = new Tray(icon);
    this.tray.setToolTip('Winkow');
    this.tray.on('click', () => this.controller.toggle('tray'));
    this.refresh();
  }

  _menu() {
    const cfg = this.config.get();
    const snapshot = this.controller.snapshot();
    const hidden = this.controller.isHidden();
    const boss = cfg.hotkey || '未设置';
    const mode = cfg.mode;
    const ap = this.actions.airplayStatus ? this.actions.airplayStatus() : null;
    const apPin = ap && ap.running && !ap.noPin && /^\d{4}$/.test(String(ap.pin || '')) ? String(ap.pin) : '';
    const apItems = [
      {
        label: ap && ap.running ? `停止 iOS 屏幕镜像${apPin ? `  (PIN ${apPin})` : ''}` : '开始 iOS 屏幕镜像',
        click: () => this.actions.airplayToggle && this.actions.airplayToggle()
      }
    ];
    // 托盘的 PIN 也能直接复制：不打开任何窗口就能拿到
    if (apPin) {
      apItems.push({ label: `复制 PIN  ${apPin}`, click: () => clipboard.writeText(apPin) });
    }
    return Menu.buildFromTemplate([
      { label: hidden ? `显示浮窗  (${boss})` : `隐藏到托盘  (${boss})`, click: () => this.controller.toggle('tray') },
      { type: 'separator' },
      {
        label: '显示内容',
        submenu: [
          { label: '待机', type: 'radio', checked: mode === MODE.IDLE, click: () => this.actions.setMode(MODE.IDLE) },
          { label: '网页', type: 'radio', checked: mode === MODE.WEB, click: () => this.actions.setMode(MODE.WEB) },
          { label: 'iOS 投屏', type: 'radio', checked: mode === MODE.MIRROR, click: () => this.actions.setMode(MODE.MIRROR) }
        ]
      },
      ...apItems,
      { label: '静音', type: 'checkbox', checked: cfg.muted, click: (item) => this.actions.setMuted(item.checked) },
      { label: '纯净模式（只显示内容）', type: 'checkbox', checked: cfg.pureMode,
        click: (item) => this.config.set({ pureMode: item.checked }) },
      {
        label: '内容缩放',
        submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => ({
          label: `${Math.round(z * 100)}%`, type: 'radio', checked: Math.abs(Number(cfg.zoom) - z) < 0.01,
          click: () => this.config.set({ zoom: z })
        }))
      },
      { type: 'separator' },
      { label: '设置…', click: () => this.actions.openSettings('general') },
      { label: '清空浏览痕迹', click: () => this.actions.clearTraces() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]);
  }

  refresh() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.setContextMenu(this._menu());
  }

  applyConfig() {
    const visible = this.config.get().trayVisible;
    if (visible && !this.tray) this.init();
    else if (!visible && this.tray) {
      if (!this.tray.isDestroyed()) this.tray.destroy();
      this.tray = null;
    } else this.refresh();
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = TrayManager;
