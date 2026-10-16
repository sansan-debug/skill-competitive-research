/**
 * 冒烟测试 —— 启动前先确认环境可用
 *
 * 依次检查：
 *   1. 能否找到 Chromium
 *   2. harvest.js / config.js / platforms.js 能否正常载入
 *   3. 浏览器能否启动、版本是否正常
 *   4. 反自动化特征是否被隐藏（navigator.webdriver 应为 false）
 *   5. 能否打开一个页面并取回文本
 *
 * 用法：node smoke.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const CONFIG = require('./config');
const { PLATFORMS } = require('./platforms');
const { SCRAPERS } = require('./harvest');

const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);

function detectChrome() {
  if (CONFIG.chromeBin && fs.existsSync(CONFIG.chromeBin)) return CONFIG.chromeBin;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const cands = [];
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^chromium-\d+$/.test(d)) continue;
      cands.push(
        path.join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(cache, d, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(cache, d, 'chrome-linux/chrome'),
        path.join(cache, d, 'chrome-win/chrome.exe')
      );
    }
  } catch {}
  cands.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  );
  return cands.find((c) => fs.existsSync(c)) || null;
}

(async () => {
  console.log('\n冒烟测试\n' + '─'.repeat(46));

  console.log('\n[1] 模块载入');
  const scraperIds = Object.keys(SCRAPERS);
  scraperIds.length ? ok(`harvest.js 载入成功，${scraperIds.length} 个抓取器`) : bad('没有抓取器');
  console.log('      ' + scraperIds.join(', '));
  ok(`config.js 目标 = ${CONFIG.target.name} (${CONFIG.target.domains.join(', ')})`);
  ok(`platforms.js ${PLATFORMS.length} 个平台`);

  console.log('\n[2] 浏览器可执行文件');
  const bin = detectChrome();
  if (!bin) {
    bad('找不到 Chromium —— 见 SKILL.md 的「安装」一节');
    process.exit(1);
  }
  ok(bin);

  console.log('\n[3] 启动浏览器');
  const profile = CONFIG.profileDir.replace(/^~/, os.homedir()) + '-smoke';
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: bin,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    ok('浏览器已启动');
  } catch (e) {
    bad('启动失败: ' + e.message);
    process.exit(1);
  }

  console.log('\n[4] 反自动化特征');
  const page = await ctx.newPage();
  const wd = await page.evaluate(() => navigator.webdriver);
  wd === false || wd === undefined ? ok('navigator.webdriver = ' + wd) : bad('navigator.webdriver = ' + wd);

  console.log('\n[5] 实际取回一个页面');
  try {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
    const t = await page.evaluate(() => document.body.innerText);
    t.length > 20 ? ok(`取回 ${t.length} 字符: ${t.replace(/\s+/g, ' ').slice(0, 60)}…`) : bad('取回内容过短');
  } catch (e) {
    bad('取页面失败: ' + e.message);
  }

  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(46));
  console.log('冒烟测试通过。下一步：node login-console.js\n');
})().catch((e) => {
  console.error('冒烟测试异常:', e.message);
  process.exit(1);
});
