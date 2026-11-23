// 打包产物契约校验：直接读 dist/win-unpacked/resources/app.asar，
// 确认打进包里的 CSS / HTML / 主进程配置与源码一致（视觉 + 品牌 + 行为开关）。
// 用法：node scripts/probe-pack.js
const asar = require('@electron/asar');

const F = 'dist/win-unpacked/resources/app.asar';
let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
};

// 归档内条目用 \ 分隔（Windows 打包机），统一成 / 后再取
const g = (p) => asar.extractFile(F, p.split('/').join('\\')).toString('utf8');

// asar 内的 package.json 已被 electron-builder 剥掉 build 段，只留运行所需字段；
// 打包配置（appId / nsis / extraFiles）要回源码 package.json 里核对。
const pkg = JSON.parse(g('package.json'));
const srcPkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
const floatCss = g('src/renderer/float.css');
const settingsCss = g('src/renderer/settings.css');
const floatHtml = g('src/renderer/float.html');
const settingsHtml = g('src/renderer/settings.html');
const mainJs = g('src/main/index.js');

console.log('\n== 版本与品牌 ==');
ok('version = 1.0.40', pkg.version === '1.0.40', pkg.version);
ok('productName = Winkow', pkg.productName === 'Winkow', pkg.productName);
ok('内部 name 仍是 moyu-float（配置兼容）', pkg.name === 'moyu-float', pkg.name);
ok('appId 仍是 com.moyufloat.float', srcPkg.build && srcPkg.build.appId === 'com.moyufloat.float');
ok('nsis 快捷方式名 = Winkow', srcPkg.build.nsis && srcPkg.build.nsis.shortcutName === 'Winkow');
ok('安装包产物名为 Winkow', srcPkg.build.nsis && /Winkow-\$\{version\}-Setup/.test(srcPkg.build.nsis.artifactName));
ok('extraFiles 带 airplay 引擎', JSON.stringify(srcPkg.build.extraFiles) === '[{"from":"airplay","to":"airplay"}]', JSON.stringify(srcPkg.build.extraFiles));
ok('包内 airplay 引擎目录存在（与 exe 同级）', require('fs').existsSync('dist/win-unpacked/airplay') &&
  require('fs').readdirSync('dist/win-unpacked/airplay').length > 100,
  (require('fs').existsSync('dist/win-unpacked/airplay') ? require('fs').readdirSync('dist/win-unpacked/airplay').length + ' 项' : '缺失'));

console.log('\n== 窗口无阴影 ==');
const shell = floatCss.slice(floatCss.indexOf('.shell {'), floatCss.indexOf('.shell::before'));
const win = settingsCss.slice(settingsCss.indexOf('.win {'), settingsCss.indexOf('.win::before'));
ok('浮窗外壳 box-shadow: none', shell.includes('box-shadow: none;'));
ok('设置窗外壳 box-shadow: none', win.includes('box-shadow: none;'));
const dark = /rgba\(\s*(?:0,\s*0,\s*0|9,\s*6,\s*34|14,\s*9,\s*48)/;
ok('float.css 无黑色/深色投影', !dark.test(floatCss));
ok('settings.css 无黑色/深色投影', !dark.test(settingsCss));
ok('float.css 留 inset 白色高光', floatCss.includes('inset 0 1px 0 rgba(255, 255, 255'));
ok('settings.css 留 inset 白色高光', settingsCss.includes('inset 0 1px 0 rgba(255, 255, 255'));

console.log('\n== 现代渐变风 ==');
ok('深靛底 #1e1b4b 在两套样式里都有', floatCss.includes('#1e1b4b') && settingsCss.includes('#1e1b4b'));
ok('三色渐变含紫 #7c3aed', floatCss.includes('#7c3aed') && settingsCss.includes('#7c3aed'));
ok('三色渐变含品红 #ec4899', floatCss.includes('#ec4899') && settingsCss.includes('#ec4899'));
ok('渐变过渡多级中间色标', floatCss.includes('#bd4ad9') && floatCss.includes('#d946c5'));
ok('按钮渐变 200% 宽并滑到另一端', /background-size:\s*200% 100%/.test(floatCss) && /background-position:\s*100% 50%/.test(floatCss));
ok('玻璃卡片 10% 白填充', /--glass:\s*rgba\(255,\s*255,\s*255,\s*\.10\)|--glass:\s*rgba\(255,\s*255,\s*255,\s*0?\.1\)/.test(floatCss));
ok('玻璃卡片 20% 白描边', /--line:\s*rgba\(255,\s*255,\s*255,\s*\.20\)|--line:\s*rgba\(255,\s*255,\s*255,\s*0?\.2\)/.test(floatCss));
ok('hover 紫色光晕变量 --aura', /--aura:[^;]*rgba\(168,\s*85,\s*247/.test(floatCss));
ok('动效 500ms ease-out', /--ease:\s*500ms ease-out/.test(floatCss) && /--ease:\s*500ms ease-out/.test(settingsCss));
// 1.0.40：hover 只上浮不缩放，否则带 backdrop-filter 的层会被按 1x 纹理
// 重采样，小字发虚。设置页仅滑块拇指（纯图形）还留着 scale。
ok('hover 只上浮、不缩放（文字不发虚）',
  /translateY\(-3px\)/.test(floatCss) && !/scale\(1\.0/.test(floatCss) &&
  (settingsCss.match(/scale\(1\.0/g) || []).length <= 1);

console.log('\n== 把手与小狐狸 ==');
ok('float.html 有 drag-strip 把手', floatHtml.includes('drag-strip'));
ok('float.html 没有旧的小耳朵 ears', !floatHtml.includes('class="ears"') && !floatHtml.includes('ears'));
ok('float.css 里 ears 已清空', !floatCss.includes('.ears'));
ok('待机大图用 fox-full.png', floatHtml.includes('fox-full.png'));
ok('头像/logo 用 fox-logo.png', floatHtml.includes('fox-logo.png'));
ok('标题是 Winkow', /<title>Winkow<\/title>/.test(floatHtml));
ok('设置页 1.0.40 版本记录存在', settingsHtml.includes('1.0.40') && settingsHtml.includes('1.0.39'));
ok('设置页无「投影只用纯黑」旧文案', !settingsHtml.includes('投影只用纯黑'));

console.log('\n== 行为开关不变 ==');
ok('隐藏暂停逻辑随包发布（playback.js / pauseOnHide）', /pauseOnHide/.test(g('src/main/playback.js')));
ok('userData 钉回旧目录 + customUserData 守卫', mainJs.includes('摸鱼小窗') && mainJs.includes('customUserData'));
ok('托盘/设备名 Winkow', floatHtml.includes('>Winkow<'));

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAIL') + ': ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
