#!/usr/bin/env node
'use strict';

/**
 * probe-engine-bundle.js —— 用「生产环境的方式」启动 CLI 引擎，验证它能不能
 * 只靠发行包 airplay/ 自带的 DLL + 14 个 GStreamer 插件跑起来。
 *
 * 生产环境和 POC 脚本的关键差异，这里必须逐条对齐：
 *   1. cwd 是临时目录（POC 是 poc-build/）
 *   2. PATH 里**没有** msys2 ucrt64/bin（POC 有）
 *   3. GST_PLUGIN_PATH 指向 airplay/lib/gstreamer-1.0（POC 指向 msys64）
 *
 * usage: node tools/probe-engine-bundle.js [seconds]
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SEC = parseInt(process.argv[2] || '8', 10);
const AIRPLAY = path.join(__dirname, '..', 'airplay');
const EXE = path.join(AIRPLAY, 'uxplay-cli.exe');
const PLUGINS = path.join(AIRPLAY, 'lib', 'gstreamer-1.0');

if (!fs.existsSync(EXE)) { console.error('[FATAL] 引擎不在:', EXE); process.exit(2); }
console.log('exe    :', EXE);
console.log('plugins:', PLUGINS, '(' + (fs.existsSync(PLUGINS) ? fs.readdirSync(PLUGINS).length : 0) + ' 个)');

// 只留系统目录 + airplay/，把 msys2 彻底排除在外面
const winDir = process.env.SystemRoot || 'C:\\Windows';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-engine-'));
const cleanPath = [path.join(winDir, 'System32'), winDir, AIRPLAY, path.join(winDir, 'System32', 'Wbem')].join(';');

const env = {
  SystemRoot: process.env.SystemRoot,
  windir: process.env.windir,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  ProgramData: process.env.ProgramData,
  NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
  PATH: cleanPath
};
// GStreamer 会按 libgstreamer-1.0-0.dll 所在目录推 ../lib/gstreamer-1.0，
// 而发行包里 DLL 是平铺在 airplay/ 的，推出来的路径不存在 —— 必须显式指定。
env.GST_PLUGIN_PATH = PLUGINS;
env.GST_PLUGIN_SYSTEM_PATH = PLUGINS;
/* 关键：注册表默认缓存在 %LOCALAPPDATA%\...\registry.x86_64.bin，而
 * gst_registry_find_plugin() 命中缓存时**不校验 DLL 是否还在**。开发机上那份
 * 缓存里记的是 msys2 的插件，直接跑会得到一个漂亮的假阳性。所以强制用一份
 * 全新的注册表，逼 GStreamer 真的去扫 airplay/lib/gstreamer-1.0 里的 14 个 DLL。 */
env.GST_REGISTRY = path.join(tmp, 'gst-registry.bin');
env.GST_REGISTRY_UPDATE = 'yes';

const args = [
  '-n', 'WinkowProbe', '-nh', '-nohold', '-pin', '5676',
  '-p', '7100', '-s', '720x1560', '-fps', '30',
  '-vs', 'fakesink', '-as', '0', '-reset', '0',
  '-vnet', '7790'
];
console.log('cwd    :', tmp);
console.log('PATH   :', cleanPath);
console.log('args   :', args.join(' '));
console.log('');

const child = spawn(EXE, args, { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
child.on('error', (e) => { console.log('[spawn error]', e.message); });

setTimeout(() => {
  try { child.kill(); } catch (_) {}
}, SEC * 1000);

child.on('close', (code, sig) => {
  console.log('---- engine output ----');
  console.log(out.trim() || '(空)');
  console.log('-----------------------');
  console.log('exit code:', code, sig || '');

  const hasPluginFail = /no element|Failed to create|plugin|Could not|could not find/i.test(out);
  const hasListen = /Listen|listen|Initialized server socket|listening/i.test(out);
  const hasBonjourErr = /dnssd|Bonjour|libnotfound/i.test(out);

  console.log('');
  if (hasBonjourErr) console.log('[WARN] dnssd / Bonjour 相关报错，引擎注册不了设备名');
  if (hasListen && !hasPluginFail) console.log('[PASS] 引擎在干净 PATH 下起来了，GStreamer 插件加载正常');
  else if (hasListen) console.log('[WARN] 起来了但有插件/元素相关报错，见上方');
  else console.log('[FAIL] 引擎没起来');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});
