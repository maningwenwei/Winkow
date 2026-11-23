#!/usr/bin/env node
'use strict';

/**
 * 收藏 / 历史存储的纯 Node 单测。不需要 Electron：BrowserData 只依赖 fs/path，
 * 在构造器里显式传 file 与 remember 回调即可。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const BrowserData = require('../src/main/browser-data');

const DIR = path.join(os.tmpdir(), `winkow-browser-data-test-${process.pid}`);
const FILE = path.join(DIR, 'moyu-browser.json');
let remember = false;
const store = () => new BrowserData({ file: FILE, remember: () => remember });

const oks = [];
const fails = [];
const check = (name, cond, detail) => (cond ? oks : fails).push(name + (cond ? '' : ` -> ${detail}`));

try {
  fs.mkdirSync(DIR, { recursive: true });
  try { fs.unlinkSync(FILE); } catch (_) {}

  check('过滤 javascript: 网址', BrowserData.cleanUrl('javascript:alert(1)') === '', '');
  check('过滤 chrome:// 网址', BrowserData.cleanUrl('chrome://settings') === '', '');
  check('去掉 # 片段后仍可用', BrowserData.cleanUrl('https://a.test/p#top') === 'https://a.test/p',
    BrowserData.cleanUrl('https://a.test/p#top'));

  // ---- 收藏：主动保存，永远落盘 ----
  let s = store();
  s.bookmark({ url: 'https://a.test/one', title: 'A 站' });
  s.bookmark({ url: 'https://b.test/two', title: 'B 站' });
  check('加入两条收藏', s.get().bookmarks.length === 2, JSON.stringify(s.get().bookmarks));
  check('收藏写入磁盘', JSON.parse(fs.readFileSync(FILE, 'utf8')).bookmarks.length === 2);
  s.bookmark({ url: 'https://a.test/one', title: 'A 站' });
  check('再点一次星标即取消', s.get().bookmarks.length === 1, JSON.stringify(s.get().bookmarks));
  s = store();
  check('换实例后收藏仍在', s.get().bookmarks.length === 1, JSON.stringify(s.get().bookmarks));

  // ---- 历史：默认「记住网址」关闭，本次可见但不落盘 ----
  s.historyAdd({ url: 'https://c.test/', title: 'C' });
  s.historyAdd({ url: 'https://d.test/', title: 'D' });
  check('关着开关也能在本次运行里看到历史', s.get().history.length === 2, JSON.stringify(s.get().history));
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  check('磁盘上没有历史', (onDisk.history || []).length === 0, JSON.stringify(onDisk.history));
  const reopened = store();
  check('重启后历史不残留', reopened.get().history.length === 0, JSON.stringify(reopened.get().history));

  // ---- 打开开关后开始记录，重复访问挪到最前 ----
  remember = true;
  s.historyAdd({ url: 'https://c.test/', title: 'C 改了标题' });
  s.historyAdd({ url: 'https://d.test/', title: 'D' });
  s.historyAdd({ url: 'https://c.test/', title: 'C 改了标题' });
  check('历史去重并置顶', s.get().history[0].url === 'https://c.test/' && s.get().history.length === 2,
    JSON.stringify(s.get().history));
  check('历史标题被更新', s.get().history[0].title === 'C 改了标题', s.get().history[0].title);
  check('打开开关后历史落盘', JSON.parse(fs.readFileSync(FILE, 'utf8')).history.length === 2);
  const withHistory = store();
  check('重启后历史仍在', withHistory.get().history.length === 2, JSON.stringify(withHistory.get().history));

  // ---- 关掉开关：内存与磁盘一起清掉，不会「关了又冒出来」 ----
  remember = false;
  check('关闭后 get 不再返回历史', withHistory.get().history.length === 0,
    JSON.stringify(withHistory.get().history));
  check('关闭后磁盘历史被抹掉', JSON.parse(fs.readFileSync(FILE, 'utf8')).history.length === 0);

  // ---- 单条删除 / 清空 ----
  remember = true;
  s = store();
  s.historyAdd({ url: 'https://c.test/', title: 'C' });
  s.historyAdd({ url: 'https://d.test/', title: 'D' });
  s.removeHistory('https://c.test/');
  check('删除单条历史', s.get().history.length === 1, JSON.stringify(s.get().history));
  s.clearHistory();
  check('清空历史但保留收藏', s.get().history.length === 0 && s.get().bookmarks.length === 1,
    JSON.stringify(s.get()));
  s.clearAll();
  check('清理痕迹连收藏一起清', s.get().bookmarks.length === 0 && s.get().history.length === 0,
    JSON.stringify(s.get()));
  check('清理结果已落盘', JSON.parse(fs.readFileSync(FILE, 'utf8')).bookmarks.length === 0);

  // ---- 上限 ----
  for (let i = 0; i < BrowserData.MAX_HISTORY + 20; i++) s.historyAdd({ url: `https://x.test/${i}`, title: 'x' });
  check('历史条数有上限', s.get().history.length === BrowserData.MAX_HISTORY,
    String(s.get().history.length));

  // ---- 历史只保留 7 天，收藏不受影响 ----
  s.clearAll();
  remember = true;
  s = store();
  s.bookmark({ url: 'https://keep.test/', title: '永久收藏' });
  // 直接写一份带时间的磁盘数据：1 天前 / 6 天前保留，8 天前 / 30 天前清掉
  fs.writeFileSync(FILE, JSON.stringify({
    bookmarks: [{ url: 'https://keep.test/', title: '永久收藏', at: Date.now() - 60 * 86400000 }],
    history: [
      { url: 'https://d1.test/', title: '1天', at: Date.now() - 1 * 86400000 },
      { url: 'https://d6.test/', title: '6天', at: Date.now() - 6 * 86400000 },
      { url: 'https://d8.test/', title: '8天', at: Date.now() - 8 * 86400000 },
      { url: 'https://d30.test/', title: '30天', at: Date.now() - 30 * 86400000 }
    ]
  }), 'utf8');
  const ttl = new BrowserData({ file: FILE, remember: () => true });
  const kept = ttl.get().history.map((h) => h.url).sort();
  check('加载时清掉超过 7 天的历史',
    kept.indexOf('https://d1.test/') >= 0 && kept.indexOf('https://d6.test/') >= 0
      && kept.indexOf('https://d8.test/') < 0 && kept.indexOf('https://d30.test/') < 0,
    JSON.stringify(kept));
  check('过期清理不影响收藏（收藏无期限）',
    ttl.get().bookmarks.some((b) => b.url === 'https://keep.test/'), JSON.stringify(ttl.get().bookmarks));
  check('7 天期限常量为 7*24h', BrowserData.HISTORY_TTL_MS === 7 * 24 * 60 * 60 * 1000,
    String(BrowserData.HISTORY_TTL_MS));
} catch (err) {
  fails.push('测试异常: ' + err.stack);
} finally {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
}

oks.forEach((n) => console.log('  OK   ' + n));
fails.forEach((n) => console.log('  FAIL ' + n));
console.log('');
console.log(fails.length ? `[FAIL] ${fails.length} 项未通过` : `[PASS] 收藏/历史存储全部通过 (${oks.length} 项)`);
process.exit(fails.length ? 1 : 0);
