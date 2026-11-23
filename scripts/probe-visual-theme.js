'use strict';

/**
 * 1.0.39 视觉契约探针（纯 Node，不需要 Electron）：
 *   1) 深靛底 #1e1b4b 与「紫→品红」唯一光源，多级色标柔和过渡
 *   2) 窗口外壳与内部控件都不带黑色投影，只留 inset 高光与紫色光晕
 *   3) 顶部两个小耳朵已去掉，改成整条可拖的把手
 *   4) 按钮 200% 宽三色渐变、hover 滑到另一端
 *   5) 卡片 10% 白填充 + 20% 白描边、hover 提亮 + 紫色光晕
 *   6) 500ms ease-out + 上浮 + 1.02 放大
 *   7) 待机大图 / logo / 图标 / 观看页都来自用户给的两张小狐狸
 *   8) 品牌名统一为 Winkow，且功能契约（hidden / 纯净模式）没被改掉
 *
 *   node scripts/probe-visual-theme.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

/**
 * 取「行首的某条选择器」到它自己的 } 为止。
 * 不能用 indexOf('.shell {') 到 indexOf('.shell::before') 这种切片：一旦文件里
 * 出现 `html[data-theme="light"] .shell::before`（浅色覆盖块），结束锚点就会
 * 落在起始锚点前面，切出空串 —— 断言要么莫名 FAIL，要么因为空串而"假通过"。
 */
const ruleOf = (css, sel) => {
  const re = new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'm');
  const i = css.search(re);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i) + 1);
};

const floatCss = read('src/renderer/float.css');
const settingsCss = read('src/renderer/settings.css');
const floatHtml = read('src/renderer/float.html');
const settingsHtml = read('src/renderer/settings.html');
const mirrorHtml = read('src/renderer/mirror.html');
const pkg = JSON.parse(read('package.json'));

// ---- 1) 底色与唯一光源 ----
ok('两套样式都以 #1e1b4b 深靛压住画面',
  floatCss.includes('#1e1b4b') && settingsCss.includes('#1e1b4b'));
ok('唯一光源是紫 7c3aed → a855f7 → 品红 ec4899',
  ['#7c3aed', '#a855f7', '#ec4899'].every((c) => floatCss.includes(c) && settingsCss.includes(c)));
ok('渐变补了多级中间色标，过渡自然（8d4bef / bd4ad9 / d946c5）',
  ['#8d4bef', '#bd4ad9', '#d946c5'].every((c) => floatCss.includes(c) && settingsCss.includes(c)));
ok('底色与光晕都按多级色标柔和衰减',
  /linear-gradient\(165deg, #1e1b4b 0%, #211c53 26%, #241f5c 54%/.test(floatCss) &&
  /linear-gradient\(165deg, #1e1b4b 0%, #211c53 26%, #241f5c 54%/.test(settingsCss) &&
  /rgba\(124, 58, 237, \.27\) 32%/.test(floatCss) &&
  /rgba\(236, 72, 153, \.20\) 34%/.test(settingsCss));
ok('光晕有方向地缓慢漂移（lightDrift / beamSlide）',
  floatCss.includes('@keyframes lightDrift') && floatCss.includes('@keyframes beamSlide') &&
  settingsCss.includes('@keyframes lightDrift'));
// 光晕必须靠 background-position 漂移，不能靠 transform 放大位移：
// .shell::before 是 inset:0 的伪元素，一旦 translate/scale，左上与右下的
// 光团就会跑到 .shell 圆角外面（body 透明，肉眼直接看到光溢出）。
const driftKeys = floatCss.slice(floatCss.indexOf('@keyframes lightDrift'), floatCss.indexOf('@keyframes beamSlide'));
const shellBefore = ruleOf(floatCss, '.shell::before');
ok('光晕漂移用背景位移、不用 transform（不会溢出圆角）',
  !/transform/.test(driftKeys) && !/translate|scale\(/.test(driftKeys) &&
  /background-position/.test(driftKeys) &&
  /background-size:\s*\d+% \d+%/.test(shellBefore) &&
  /border-radius:\s*inherit/.test(shellBefore));

// ---- 2) 阴影：窗口外壳与内部控件全部去掉 ----
const shellShadow = ruleOf(floatCss, '.shell');
const winShadow = ruleOf(settingsCss, '.win');
ok('浮窗与设置窗外壳没有任何外投影',
  shellShadow.includes('box-shadow: none;') && winShadow.includes('box-shadow: none;') &&
  !/box-shadow:[^;]*rgba\(/.test(shellShadow) && !/box-shadow:[^;]*rgba\(/.test(winShadow));
// 黑色 / 近黑深色像素（含 filter: drop-shadow）一处都不留；
// inset 白色高光与紫 / 品红光晕属于「光」而不是投影，保留。
const darkShadow = /rgba\(\s*(?:0,\s*0,\s*0|9,\s*6,\s*34|14,\s*9,\s*48)/;
ok('两套样式与观看页里没有残留任何黑色 / 深色投影',
  !darkShadow.test(floatCss) && !darkShadow.test(settingsCss) && !darkShadow.test(mirrorHtml));
ok('只保留 inset 白色高光与紫色光晕',
  floatCss.includes('inset 0 1px 0 rgba(255, 255, 255') &&
  settingsCss.includes('inset 0 1px 0 rgba(255, 255, 255') &&
  /--aura:[^;]*rgba\(168,\s*85,\s*247/.test(floatCss) &&
  /--aura:[^;]*rgba\(168,\s*85,\s*247/.test(settingsCss));

// ---- 3) 去掉耳朵，顶部留把手 ----
ok('两个小耳朵（.ears）已从结构与样式中移除',
  !floatHtml.includes('class="ears"') && !/\.ears\b/.test(floatCss));
ok('顶部整条留白是可拖拽把手',
  floatHtml.includes('class="drag-strip"') &&
  /\.drag-strip\s*\{[^}]*-webkit-app-region:\s*drag[^}]*pointer-events:\s*auto/.test(floatCss) &&
  floatCss.includes('body.pure .drag-strip'));
ok('把手本身是 200% 渐变短横，hover 也会滑动',
  /\.drag-strip i\s*\{[^}]*background-size:\s*200%\s*100%/.test(floatCss) &&
  /\.drag-strip:hover i\s*\{[^}]*background-position:\s*100%\s*50%/.test(floatCss));

// ---- 4) 按钮：200% 宽三色渐变 + hover 滑到另一端 ----
for (const [name, css] of [['浮窗', floatCss], ['设置页', settingsCss]]) {
  ok(`${name}按钮是 200% 宽渐变`, /background-size:\s*200%\s*100%/.test(css));
  ok(`${name}按钮 hover 背景滑到另一端`,
    /\.pill:hover\s*\{[\s\S]*?background-position:\s*100%\s*50%/.test(css));
  ok(`${name}主按钮默认停在渐变起点`,
    /\.pill\s*\{[\s\S]*?background-position:\s*0%\s*50%/.test(css));
}
ok('小图标按钮也用同一条 200% 渐变（hover 从另一端滑入）',
  /\.tool::before\s*\{[\s\S]*?background-size:\s*200%\s*100%/.test(floatCss) &&
  /\.tool:hover::before\s*\{[^}]*background-position:\s*0%\s*50%/.test(floatCss));
ok('设置页侧栏选中态渐变也会滑动',
  /\.tab\.active:hover\s*\{[\s\S]*?background-position:\s*100%\s*50%/.test(settingsCss));

// ---- 5) 玻璃卡片 ----
// 1.0.41 起白玻璃走「通道」写法：--glass: rgba(var(--white), .10)，
// 深色下 --white 就是 255,255,255，观感与此前的字面量完全等价；
// 浅色主题只翻 --white 这一处，所有白玻璃 / 白描边一起反相。
ok('卡片填充是 10% 白（深色默认 --white = 255,255,255）',
  /--glass:\s*rgba\(var\(--white\),\s*\.10\)/.test(floatCss) &&
  /--glass:\s*rgba\(var\(--white\),\s*\.10\)/.test(settingsCss) &&
  /--white:\s*255,\s*255,\s*255/.test(floatCss) &&
  /--white:\s*255,\s*255,\s*255/.test(settingsCss));
ok('卡片描边是 20% 白（同一通道，随主题反相）',
  /--line:\s*rgba\(var\(--white\),\s*\.20\)/.test(floatCss) &&
  /--line:\s*rgba\(var\(--white\),\s*\.20\)/.test(settingsCss));
ok('hover 提亮填充并抬升描边',
  /\.card:hover\s*\{[\s\S]*?background:\s*var\(--glass-hi\)[\s\S]*?border-color:\s*var\(--line-hi\)/.test(settingsCss));
ok('hover 注入紫色光晕',
  /--aura:[^;]*rgba\(168,\s*85,\s*247,\s*\.3/.test(floatCss) &&
  /--aura:[^;]*rgba\(168,\s*85,\s*247,\s*\.3/.test(settingsCss) &&
  /\.card:hover\s*\{[\s\S]*?box-shadow:\s*var\(--aura\)/.test(settingsCss));

// ---- 6) 动效：500ms ease-out + 上浮（不用 scale，避免文字发虚） ----
ok('动效统一 500ms ease-out',
  /--ease:\s*500ms ease-out/.test(floatCss) && /--ease:\s*500ms ease-out/.test(settingsCss) &&
  (floatCss.match(/var\(--ease\)/g) || []).length >= 20 &&
  (settingsCss.match(/var\(--ease\)/g) || []).length >= 20);
// 带 backdrop-filter 的元素一旦 transform: scale()，就会被合成层按 1x 纹理
// 重采样，hover 时文字/图标发虚。所以交互元素一律只做位移，不缩放。
// 唯一保留 scale 的是设置页滑块拇指（纯图形、无文字、无 backdrop-filter）。
ok('hover 只做位移、不缩放（文字不再发虚）',
  /translateY\(-3px\)/.test(floatCss) && /translateY\(-3px\)/.test(settingsCss) &&
  !/scale\(1\.0/.test(floatCss) &&
  (settingsCss.match(/scale\(1\.0/g) || []).length <= 1);

// ---- 7) 两张用户给的小狐狸 ----
const pngExists = (f) => fs.existsSync(path.join(ROOT, 'assets', f)) && fs.statSync(path.join(ROOT, 'assets', f)).size > 1000;
ok('待机大图 / logo / 观看页内联版都已生成',
  ['fox-full.png', 'fox-logo.png', 'fox-inline.png'].every(pngExists));
ok('待机界面中间用的是第一张全身小狐狸',
  /class="fox-big" src="\.\.\/\.\.\/assets\/fox-full\.png"/.test(floatHtml));
ok('浮窗头像与设置页 logo 用的是第二张小狐狸',
  floatHtml.includes('src="../../assets/fox-logo.png"') &&
  settingsHtml.includes('src="../../assets/fox-logo.png"'));
const inlineB64 = fs.readFileSync(path.join(ROOT, 'assets', 'fox-inline.png'));
const inlineUri = 'data:image/png;base64,' + inlineB64.toString('base64');
ok('观看页内联的狐狸与 fox-inline.png 字节完全一致',
  mirrorHtml.includes(inlineUri) && mirrorHtml.includes('class="fox"') &&
  crypto.createHash('md5').update(inlineB64).digest('hex').length === 32);
ok('应用图标由第二张小狐狸合成',
  read('scripts/make-icon.js').includes("'fox-logo.png'") &&
  read('scripts/make-icon.js').includes('#1E1B4B'));
ok('PNG / ICO / 托盘图标都已生成',
  ['icon.png', 'icon.ico', 'tray.png'].every(pngExists));
ok('抠图脚本可复现，源图留在 fixtures（不进安装包）',
  read('scripts/prepare-fox-art.py').includes('fox-full-source.jpg') &&
  fs.existsSync(path.join(ROOT, 'scripts/fixtures/fox-logo-source.jpg')));

// ---- 8) 命名与功能契约 ----
// 版本号不写死：每次升版都来这儿改一个字，探针早晚会在「忘了同步关于页」时
// 假失败一次，久了就没人信它了。这里只锁「形如 x.y.z」，版本一致性交给下一条。
ok('应用名改为 Winkow', pkg.productName === 'Winkow' && pkg.build.productName === 'Winkow' &&
  pkg.build.nsis.shortcutName === 'Winkow' && /^\d+\.\d+\.\d+$/.test(pkg.version));
ok('界面标题 / 品牌 / 托盘 / 设备名都是 Winkow',
  floatHtml.includes('<title>Winkow</title>') && floatHtml.includes('<b>Winkow</b>') &&
  settingsHtml.includes('<title>Winkow · 设置</title>') && settingsHtml.includes('<b>Winkow</b>') &&
  read('src/main/tray.js').includes("setToolTip('Winkow')") &&
  read('src/shared/constants.js').includes("airplayName: 'Winkow'"));
ok('保留内部 name / appId，老配置目录在打包版被钉回',
  pkg.name === 'moyu-float' && pkg.build.appId === 'com.moyufloat.float' &&
  read('src/main/index.js').includes("'摸鱼小窗'") &&
  read('src/main/index.js').includes('app.isPackaged && !customUserData'));
ok('--user-data-dir 覆盖不被抢走',
  read('src/main/index.js').includes("a.startsWith('--user-data-dir=')"));
ok('[hidden] 兜底规则保留', /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(floatCss));
const pureBar = floatCss.slice(floatCss.indexOf('body.pure.mode-web .webbar {'),
  floatCss.indexOf('body.pure.mode-web .webbar.peek'));
ok('纯净模式浏览条仍默认移出画面且点击穿透',
  pureBar.includes('translateY(-100%)') && pureBar.includes('pointer-events: none') &&
  floatCss.includes('.webhot') && floatHtml.includes('id="webHot"'));
ok('纯净模式外壳仍无边框无圆角',
  /body\.pure \.shell\s*\{[^}]*border:\s*0[^}]*border-radius:\s*0/.test(floatCss));
ok(`设置页关于里记录的是当前版本 ${pkg.version}（且保留 1.0.39 历史）`,
  settingsHtml.includes(`<b>${pkg.version}</b>`) &&
  settingsHtml.includes(`Winkow · ${pkg.version} · Windows`) &&
  settingsHtml.includes('<b>1.0.39</b>'));

// ---- 9) 浅色 / 深色 / 跟随系统 ----
// 主题是「换色不换结构」：结构、间距、动效一处不动，只让 CSS 变量接管控色。
// 这里锁住三件事 —— 默认值合法、迁移兜底、两套样式都必须同时有深浅两份变量，
// 否则会出现「浮窗变浅了、设置页还是深色」这种半截状态。
const constSrc = read('src/shared/constants.js');
const mainSrc = read('src/main/index.js');
const configSrc = read('src/main/config.js');
const floatJs = read('src/renderer/float.js');
const settingsJs = read('src/renderer/settings.js');

// 配置版本会随每次默认值迁移递增，不能写死（1.0.41 是 5，1.0.43 已是 6）。
const cfgVersion = require(path.join(ROOT, 'src', 'main', 'config')).CONFIG_VERSION;
ok('默认主题跟随系统，IPC 频道已登记',
  /theme:\s*'system'/.test(constSrc) && /THEME:\s*'theme:changed'/.test(constSrc) &&
  new RegExp('CONFIG_VERSION = ' + cfgVersion).test(configSrc) && constSrc.includes('theme:'));
const mig4 = configSrc.slice(configSrc.indexOf('  4: (d) =>'),
  configSrc.indexOf('};', configSrc.indexOf('  4: (d) =>')));
ok('v4→v5 迁移把非法主题值兜底成 system',
  mig4.includes("d.theme = 'system'") &&
  /'light'/.test(mig4) && /'dark'/.test(mig4) && /'system'/.test(mig4));
// 这一段原来是直接在主进程里判「system 是深还是浅」的，1.0.41 起那套映射抽进了
// src/main/theme.js（纯模块、能脱离 Electron 单测），主进程只剩接线。
// 所以断言要跟着搬：映射规则在 theme.js，广播接线在 index.js，两边都要在。
const themeSrc = read('src/main/theme.js');
ok('主进程把 mode 翻译成 effective 再广播，并跟随系统更新',
  /nativeTheme\.themeSource = mode/.test(mainSrc) &&
  /systemIsDark \? 'dark' : 'light'/.test(themeSrc) &&
  mainSrc.includes('themeState(cfg, nativeTheme.shouldUseDarkColors)') &&
  /nativeTheme\.on\('updated'/.test(mainSrc));
ok('两套样式都有浅色覆盖块（不会一半浅一半深）',
  (floatCss.match(/html\[data-theme="light"\]/g) || []).length >= 2 &&
  (settingsCss.match(/html\[data-theme="light"\]/g) || []).length >= 2);
ok('浅色主题把 --white / --scrim 通道整体反相',
  /html\[data-theme="light"\]\s*\{[\s\S]*?--white:\s*58,\s*44,\s*110[\s\S]*?--scrim:\s*250,\s*247,\s*255/.test(floatCss) &&
  /html\[data-theme="light"\]\s*\{[\s\S]*?--white:\s*58,\s*44,\s*110[\s\S]*?--scrim:\s*250,\s*247,\s*255/.test(settingsCss));
ok('彩底文字 --on-accent 两个主题都保持纯白（紫底上不会变深紫）',
  /html\[data-theme="light"\]\s*\{[\s\S]*?--on-accent:\s*#ffffff/.test(floatCss) &&
  /html\[data-theme="light"\]\s*\{[\s\S]*?--on-accent:\s*#ffffff/.test(settingsCss));
ok('设置页有三段主题单选（浅色 / 深色 / 跟随系统）',
  /name="theme"/.test(settingsHtml) && /data-key="theme"/.test(settingsHtml) &&
  ['light', 'dark', 'system'].every((v) => settingsHtml.includes(`value="${v}"`)));
ok('两套 HTML 都在样式表之前预设首帧主题（不会先闪一帧深色）',
  [floatHtml, settingsHtml].every((h) => {
    const i = h.indexOf('dataset.theme');
    const css = h.indexOf('<link rel="stylesheet"');
    return i > 0 && css > i && h.includes('prefers-color-scheme: light');
  }));
ok('渲染层只挂 data-theme，颜色全交给 CSS 变量',
  floatJs.includes('dataset.theme') && settingsJs.includes('dataset.theme'));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
