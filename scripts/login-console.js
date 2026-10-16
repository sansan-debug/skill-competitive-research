/**
 * 登录控制台 + 取数守护进程
 *
 * 为什么要这个进程：Chrome 的 profile 目录同时只能被一个进程持有。
 * 如果「登录用的浏览器」和「取数脚本」是两个进程，必然抢锁。
 * 所以这里让**同一个进程**既持有 context、又对外提供取数接口。
 *
 * 架构：
 *   ┌─ 本进程持有 persistent context（用户可见窗口，手动登录一次）
 *   ├─ 本地面板 http://127.0.0.1:<port>    实时显示各平台登录状态
 *   └─ GET /harvest?id=<scraper>           在**进程内**执行 harvest.js 的抓取器
 *
 * 用法：
 *   node login-console.js                 # 打开面板，监测全部平台
 *   node login-console.js x reddit        # 只监测指定平台（并自动打开其登录页）
 *   node login-console.js --all           # 把所有平台的登录页都打开
 *   node login-console.js --headless      # 不开窗口，仅验证会话是否还有效
 *
 * 取数（另开终端）：
 *   curl "http://127.0.0.1:<port>/harvest-list"
 *   curl "http://127.0.0.1:<port>/harvest?id=<scraper>"
 *
 * ⚠️ 两个必须知道的行为：
 *   1. 每次 /harvest 都会把**完整**结果写入 <outDir>/<scraper>.json
 *      → 用 curl -o 指向**同名文件**会覆盖它。要么不传 -o，要么写到别的名字。
 *   2. HTTP 响应里的 text 字段会被截断（见 config.defaults.responseTextLimit），
 *      但落盘文件是完整的 → **大结果读 out/ 下的文件，不要读 HTTP 响应。**
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');
const { PLATFORMS } = require('./platforms');
const CONFIG = require('./config');

const HERE = __dirname;
const OUT_DIR = path.resolve(HERE, CONFIG.outDir);
const STATUS_FILE = path.join(HERE, 'login-status.json');
const HARVEST_FILE = path.join(HERE, 'harvest.js');
const PROFILE_DIR = CONFIG.profileDir.replace(/^~/, os.homedir());
// 端口可在下面由 --port 覆盖，所以用 let
let PORT = CONFIG.port;

/** 自动探测可执行 Chromium：显式配置 → Playwright 缓存 → 系统 Chrome */
function detectChrome() {
  if (CONFIG.chromeBin && fs.existsSync(CONFIG.chromeBin)) return CONFIG.chromeBin;

  // 1) Playwright 已下载的 Chromium（版本号会变，所以扫目录而不是写死）
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const candidates = [];
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^chromium-\d+$/.test(d)) continue;
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-win/chrome.exe',
      ]) {
        candidates.push(path.join(cache, d, rel));
      }
    }
  } catch {}

  // 2) 系统浏览器
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  );

  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/** 在守护进程内执行取数：复用已登录的 context，避开 profile 锁 */
let context = null;
async function runHarvest(id, arg) {
  delete require.cache[require.resolve(HARVEST_FILE)];
  const { SCRAPERS } = require(HARVEST_FILE);
  if (!SCRAPERS[id]) {
    throw new Error('没有这个 scraper: ' + id + '\n可用: ' + Object.keys(SCRAPERS).join(', '));
  }
  const t0 = Date.now();
  const data = await SCRAPERS[id](context, arg);
  data.scraper = id;
  data.elapsedMs = Date.now() - t0;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, id + '.json'), JSON.stringify(data, null, 2));
  return data;
}

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const headless = argv.includes('--headless');
const openAll = argv.includes('--all');
// --port 9000 覆盖 config（避免与已在运行的守护进程撞端口）
const portArg = argv.indexOf('--port');
if (portArg >= 0 && argv[portArg + 1]) {
  process.env.CR_PORT = argv[portArg + 1];
  PORT = +argv[portArg + 1];
  CONFIG.port = PORT;
}
const wanted = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--port');
const targets = wanted.length ? PLATFORMS.filter((p) => wanted.includes(p.id)) : PLATFORMS;
const autoOpen = openAll ? targets : wanted.length ? targets : [];

// ---------- 登录状态 ----------
const status = {};

async function refreshStatus() {
  if (!context) return;
  for (const p of targets) {
    try {
      const cookies = await context.cookies(p.homeUrl);
      const names = cookies.map((c) => c.name);
      const hit = (p.authCookies || []).filter((c) => names.includes(c));
      status[p.id] = {
        loggedIn: (p.authCookies || []).length === 0 ? null : hit.length > 0,
        hit,
        totalCookies: names.length,
        checkedAt: new Date().toLocaleTimeString('zh-CN'),
      };
    } catch (e) {
      status[p.id] = { loggedIn: false, hit: [], error: String(e.message).slice(0, 60) };
    }
  }
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), status }, null, 2));
  } catch {}
}

// ---------- 面板 ----------
function dashboardHtml() {
  const groups = [...new Set(targets.map((p) => p.group))];
  const rows = groups
    .map((g) => {
      const items = targets
        .filter((p) => p.group === g)
        .map(
          (p) => `
        <div class="row">
          <div class="name"><b>${p.name}</b><span class="want">${p.dataWant}</span></div>
          <div class="badge" id="b-${p.id}">检测中…</div>
          <button class="go" data-id="${p.id}">打开登录页</button>
        </div>`
        )
        .join('');
      return `<section><h3>${g}</h3>${items}</section>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>竞品研究 · 登录控制台</title>
<style>
  :root{--bg:#f7f7f5;--card:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e6e6e2;
        --ok:#0f7b4f;--okbg:#e8f5ee;--no:#a33;--nobg:#fdeceb;--accent:#2c5fd8}
  @media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1d1d1d;--fg:#ededed;
        --muted:#9a9a9a;--line:#2e2e2e;--ok:#5ecf9a;--okbg:#12301f;--no:#ef8a84;
        --nobg:#3a1d1b;--accent:#7aa2f7}}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 22px 60px;background:var(--bg);color:var(--fg);
       font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:880px;margin:0 auto}
  h1{font-size:20px;margin:0 0 6px;font-weight:650}
  .sub{color:var(--muted);font-size:13px;margin-bottom:22px}
  .sub code{background:var(--card);border:1px solid var(--line);padding:1px 6px;border-radius:5px;font-size:12px}
  h3{font-size:12px;letter-spacing:.08em;color:var(--muted);margin:26px 0 10px;font-weight:600}
  .row{display:flex;align-items:center;gap:14px;background:var(--card);border:1px solid var(--line);
       border-radius:10px;padding:12px 14px;margin-bottom:8px}
  .name{flex:1;min-width:0}
  .name b{display:block;font-size:14px;font-weight:600}
  .want{display:block;color:var(--muted);font-size:12px;margin-top:2px}
  .badge{font-size:12px;font-weight:600;padding:4px 10px;border-radius:20px;white-space:nowrap;
         background:var(--nobg);color:var(--no)}
  .badge.ok{background:var(--okbg);color:var(--ok)}
  .badge.idle{background:transparent;color:var(--muted);border:1px solid var(--line)}
  .go{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:7px;
      padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit}
  .go:hover{border-color:var(--accent);color:var(--accent)}
  footer{margin-top:30px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
  footer code{background:var(--card);border:1px solid var(--line);padding:1px 6px;border-radius:5px}
</style></head>
<body><div class="wrap">
  <h1>登录控制台</h1>
  <div class="sub">
    在这个窗口里登录一次即可，Cookie 会保存在 <code>${PROFILE_DIR}</code>，之后取数不用再登。<br>
    登录完成后可以直接关掉浏览器窗口，或告知「登好了」。
  </div>
  ${rows}
  <footer>
    状态每 2 秒刷新 · 面板 <code>http://127.0.0.1:${PORT}</code>
    · 取数 <code>curl "http://127.0.0.1:${PORT}/harvest?id=&lt;scraper&gt;"</code>
    <span id="ts"></span>
  </footer>
</div>
<script>
  async function poll(){
    try{
      const r = await fetch('/status'); const d = await r.json();
      for (const [id, s] of Object.entries(d.status||{})){
        const el = document.getElementById('b-'+id); if(!el) continue;
        el.className = 'badge';
        if (s.loggedIn === true){ el.classList.add('ok'); el.textContent = '已登录'; }
        else if (s.loggedIn === false){ el.textContent = '未登录'; }
        else { el.classList.add('idle'); el.textContent = '无需登录'; }
      }
      const t = document.getElementById('ts'); if (t) t.textContent = ' · ' + (d.updatedAt||'').slice(11,19);
    }catch(e){}
  }
  document.querySelectorAll('.go').forEach(b=>{ b.onclick = ()=> fetch('/open?id='+b.dataset.id).then(poll); });
  poll(); setInterval(poll, 2000);
</script>
</body></html>`;
}

// ---------- HTTP ----------
function startServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const json = (o) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(o));
    };

    if (u.pathname === '/status') return json({ updatedAt: new Date().toISOString(), status });

    if (u.pathname === '/harvest-list') {
      try {
        delete require.cache[require.resolve(HARVEST_FILE)];
        return json({ scrapers: Object.keys(require(HARVEST_FILE).SCRAPERS) });
      } catch (e) {
        return json({ error: 'harvest.js 载入失败: ' + e.message });
      }
    }

    if (u.pathname === '/harvest') {
      const id = u.searchParams.get('id');
      try {
        const data = await runHarvest(id, u.searchParams.get('arg'));
        return json({
          ok: true, scraper: id,
          finalUrl: data.finalUrl, title: data.title, error: data.error,
          textLen: (data.text || '').length, elapsedMs: data.elapsedMs,
          // ⚠️ 截断的是响应副本；完整结果已落盘 out/<id>.json
          text: (data.text || '').slice(0, CONFIG.defaults.responseTextLimit),
        });
      } catch (e) {
        return json({ ok: false, scraper: id, error: String(e.message) });
      }
    }

    if (u.pathname === '/open') {
      const p = targets.find((t) => t.id === u.searchParams.get('id'));
      if (p && context) {
        const page = await context.newPage();
        await page.goto(p.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
  });
  server.listen(PORT, '127.0.0.1');
  return server;
}

// ---------- 主流程 ----------
(async () => {
  const chromeBin = detectChrome();
  if (!chromeBin) {
    console.error(
      '找不到 Chromium。请任选其一：\n' +
      '  A) 在 scripts/ 下执行 npm i playwright-core 后运行 npx playwright install chromium\n' +
      '  B) 在 config.js 里把 chromeBin 指向本机 Chrome 的绝对路径'
    );
    process.exit(1);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const server = startServer();
  console.log(`面板已启动: http://127.0.0.1:${PORT}`);

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    executablePath: chromeBin,
    // 有头模式最大化窗口；无头模式必须给固定 viewport，
    // 否则 viewport:null + --start-maximized 会让 headless 直接退出
    viewport: headless ? { width: 1440, height: 900 } : null,
    args: headless
      ? ['--disable-blink-features=AutomationControlled']
      : ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // 诊断：context 意外关闭时说明原因，避免"守护进程悄悄死掉"
  context.on('close', () => console.log('[!] 浏览器 context 已关闭'));

  await refreshStatus();

  const dash = await context.newPage();
  await dash.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // 常驻页：headless 下若只剩 dashboard 一页且它被关闭，context 会跟着退。
  // 留一个 about:blank 兜底，保证任何模式下守护进程都不会因页面归零而退出。
  const keeper = await context.newPage();
  await keeper.goto('about:blank').catch(() => {});
  context.on('page', (p) => {
    // 用户把所有页面关掉时，重新补一个，避免 context 退出
    setTimeout(async () => {
      if (context.pages().length === 0) await context.newPage().catch(() => {});
    }, 500);
  });

  for (const p of autoOpen) {
    const page = await context.newPage();
    await page.goto(p.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }

  const timer = setInterval(refreshStatus, 3000);
  console.log(`已监测 ${targets.length} 个平台，请在浏览器窗口里登录。关闭窗口即结束。`);

  await new Promise((resolve) => context.on('close', resolve));
  clearInterval(timer);
  await refreshStatus();
  server.close();
  console.log('浏览器已关闭，登录状态写入 ' + STATUS_FILE);
  process.exit(0);
})().catch((e) => {
  console.error('启动失败:', e.message);
  process.exit(1);
});
