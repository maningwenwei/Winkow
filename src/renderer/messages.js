'use strict';

/**
 * 面向用户的文案：把主进程 / Chromium 抛出来的原始错误翻成人话。
 *
 * 为什么要单独一个文件：浮窗和设置页都要用同一套翻译，而两个页面是各自
 * 独立的渲染进程、都拿不到 require，只共享 <script> 全局。复制两份必然
 * 会走样 —— 以前就是浮窗说「画面断流」、设置说「引擎已退出」，同一次故障
 * 两种说法。
 *
 * 原则：原始 error 里有进程退出码、文件路径、组件名（uxplay.exe、GST_*）、
 * 磁盘权限这些只有排查时才需要的信息，界面上一个字都不出现；原文继续完整
 * 留在主进程日志（设置 → 投屏 → 高级选项，以及 %TEMP%/moyu-airplay-last.log）。
 */
(function () {
  /** 从「最具体」往「最笼统」判，先命中的那条才给得出可操作的建议。 */
  function airplayError(raw) {
    const t = String(raw || '');
    if (/未找到 AirPlay 引擎|未检测到接收引擎|airplay\s*文件夹/i.test(t)) {
      return '缺少投屏组件，建议重新安装 Winkow';
    }
    if (/机器级参数文件/.test(t)) return '投屏参数被其他程序占用了，重启电脑后再试一次';
    if (/EADDRINUSE|已被占用|in use/i.test(t)) return '投屏通道被别的投屏软件占用了，关掉它再试一次';
    if (/EACCES|EPERM|磁盘|临时目录/.test(t)) return '写入文件失败，请检查磁盘空间后重试';
    if (/防火墙|firewall/i.test(t)) return '投屏被系统防火墙挡住了，请在弹窗里选择「允许访问」';
    if (/引擎已退出|引擎无法运行|引擎启动失败|无法创建临时目录|无法写入引擎参数/i.test(t)) {
      return '投屏组件没能启动，请再试一次';
    }
    return '接收器没能启动，请再试一次；还不行就到设置 → 投屏里看看';
  }

  /** 网络类：Chromium 的 errorCode / errorDescription 只进控制台，不进界面。 */
  function pageError(desc) {
    const t = String(desc || '');
    if (/SSL|CERT|TUNNEL|CONNECTION_RESET/i.test(t)) return '打不开：内网或本地地址请写全 http://';
    return '这个网页没打开，检查一下网址和网络';
  }

  window.WinkowText = { airplayError, pageError };
})();
