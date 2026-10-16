/**
 * 抓取器库 —— 由 login-console.js 在**同一进程内**调用（复用已登录的浏览器 context）
 *
 * 设计原则
 *   1. 不猜选择器。每个抓取器返回 { url, title, text, links, extra }，
 *      由调用方读文本后自行提取数字 —— 避免选择器失效导致**静默取空**。
 *   2. 参数通过 query string 传入，多个参数用 | 分隔：
 *        /harvest?id=probe_text&arg=https%3A%2F%2Fa.com%7Chttps%3A%2F%2Fb.com
 *   3. 完整结果由守护进程写入 out/<id>.json；HTTP 响应里的 text 是截断副本。
 *
 * 抓取器分两类
 *   A. 基础设施 —— 不依赖研究目标，用于"摸清一个陌生站点的入口与结构"
 *   B. 技术模板 —— 演示可复用的取数模式（JSON 接口、sitemap、Trends、榜单页…）
 *
 * 新增抓取器：在 SCRAPERS 里加一个 async (ctx, arg) => {...} 即可，
 * 不需要重启守护进程（每次调用都会 delete require.cache 重新载入）。
 */

const CONFIG = require('./config');
const T = (ms) => new Promise((r) => setTimeout(r, ms));
const { wait: WAIT, scroll: SCROLL } = CONFIG.defaults;
const HOME = require('os').homedir();

/** 取目标域名的常用变体，便于写匹配规则 */
const TARGET = CONFIG.target;
const DOMAIN = TARGET.domains[0];

/** 抓取页面上的所有链接 */
const LINKS_FN = () => {
  const seen = new Set();
  const res = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.href;
    const t = (a.innerText || '').trim().slice(0, 90);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    res.push({ href: h, text: t });
    if (res.length >= 500) break;
  }
  return res;
};

/** 通用抓取：标题 + 正文 + 外链 + 可选自定义提取 */
async function grab(context, url, opts = {}) {
  const { wait = WAIT, scroll = SCROLL, extra = null, match = null, headers = null } = opts;
  const page = await context.newPage();
  const out = { url, finalUrl: '', title: '', text: '', links: [], extra: null, error: null };
  try {
    if (headers) await page.setExtraHTTPHeaders(headers).catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await T(wait);
    for (let i = 0; i < scroll; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9)).catch(() => {});
      await T(1100);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await T(600);
    out.finalUrl = page.url();
    out.title = await page.title().catch(() => '');
    out.text = (await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => ''))
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 40000);
    out.links = await page.evaluate(LINKS_FN).catch(() => []);
    if (extra) out.extra = await extra(page).catch((e) => ({ error: String(e.message).slice(0, 140) }));
    if (match) out.matched = out.links.filter((l) => match.test(l.href) || match.test(l.text)).slice(0, 80);
  } catch (e) {
    out.error = String(e.message).slice(0, 200);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

/**
 * 自适应站内搜索：先试候选 URL，全失败则打开首页、找到搜索框、自己输入。
 * 数据站的搜索路径经常改版，硬编码 URL 会静默取空 —— 所以要有兜底。
 */
async function searchSite(context, { home, keyword, candidates = [] }) {
  const out = { url: home, finalUrl: '', title: '', text: '', links: [], extra: { tried: [] }, error: null };
  const page = await context.newPage();
  const harvest = async () => {
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9)).catch(() => {});
      await T(1100);
    }
    out.finalUrl = page.url();
    out.title = await page.title().catch(() => '');
    out.text = (await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => ''))
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 40000);
    out.links = await page.evaluate(LINKS_FN).catch(() => []);
  };
  try {
    for (const c of candidates) {
      try {
        await page.goto(c, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await T(WAIT + 3000);
        const t = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        out.extra.tried.push({ url: c, len: t.length, finalUrl: page.url() });
        if (t.length > 700 && !/(404|not found|页面不存在|出错了)/i.test(t.slice(0, 400))) {
          await harvest();
          out.extra.hit = c;
          return out;
        }
      } catch (e) {
        out.extra.tried.push({ url: c, error: String(e.message).slice(0, 90) });
      }
    }
    // 兜底：首页找搜索框
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await T(WAIT);
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map((el, i) => ({
        i, type: el.type, ph: el.placeholder || '', name: el.name || '',
        cls: String(el.className || '').slice(0, 70),
      }))
    ).catch(() => []);
    out.extra.inputs = inputs;
    const idx = inputs.findIndex(
      (x) => /搜索|search/i.test(x.ph) || x.type === 'search' || /search|keyword|query/i.test(x.name) || /search|keyword|query/i.test(x.cls)
    );
    if (idx >= 0) {
      const handles = await page.$$('input');
      await handles[idx].click().catch(() => {});
      await handles[idx].fill(keyword).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await T(WAIT + 5000);
      await harvest();
      out.extra.usedInput = inputs[idx];
    }
  } catch (e) {
    out.error = String(e.message).slice(0, 200);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

/** 解析 Trends 的 )]}', 前缀：直接定位第一个 {，不要用正则剥前缀 */
const stripTrends = (raw) => JSON.parse(raw.slice(raw.indexOf('{')));

const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** "Feb 8 – 14, 2026" → "2026-02"；跨月取结束月 */
function weekLabelToMonth(label) {
  const m = String(label || '').match(/([A-Z][a-z]{2}) (\d{1,2})/g);
  const y = String(label || '').match(/(20\d\d)/g);
  if (!m || !y) return null;
  const last = m[m.length - 1].split(' ')[0];
  return `${y[y.length - 1]}-${String(MON[last] || 0).padStart(2, '0')}`;
}

const SCRAPERS = {
  // ═══════════════════════════════════════════════════════════
  // A. 基础设施 —— 摸清一个陌生站点的入口与结构
  // ═══════════════════════════════════════════════════════════

  /**
   * 列出当前浏览器打开的所有标签页。
   * ⭐ 找"真实入口"最有效的手段：用户登录时用过的 URL 就是入口。
   * 数据站的 nav 常是纯动态渲染（改 hash 不换内容），靠猜路由完全无效。
   */
  list_pages: async (ctx) => {
    const out = { url: 'list_pages', finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    const pages = ctx.pages();
    out.extra = await Promise.all(
      pages.map(async (p, i) => ({
        i, url: p.url(), title: await p.title().catch(() => ''),
      }))
    );
    out.text = out.extra.map((p) => `[${p.i}] ${p.title}\n    ${p.url}`).join('\n');
    return out;
  },

  /**
   * 打印指定域名下的全部 cookie。
   * ⭐ 用途：① 判断是否真的登录（比猜 authCookies 可靠）
   *        ② platforms.js 里 authCookies 过时时，用这个查出真实 cookie 名
   * arg: 域名，如 https://www.example.com/（多个用 | 分隔）
   */
  login_probe: async (ctx, arg) => {
    const urls = (arg || TARGET.domains.map((d) => 'https://' + d + '/')).split('|');
    const out = { url: 'login_probe', finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    for (const u of urls) {
      try {
        const cookies = await ctx.cookies(u);
        out.extra[u] = {
          count: cookies.length,
          names: cookies.map((c) => c.name),
          sample: cookies.slice(0, 30).map((c) => `${c.name}=${String(c.value).slice(0, 24)}`),
        };
      } catch (e) {
        out.extra[u] = { error: String(e.message).slice(0, 100) };
      }
    }
    out.text = JSON.stringify(out.extra, null, 2);
    return out;
  },

  /**
   * 列出一个页面的所有链接与按钮文本 —— 快速看清站点结构。
   * arg: 页面 URL
   */
  entry_discover: async (ctx, arg) => {
    const url = arg || `https://${DOMAIN}/`;
    const out = await grab(ctx, url, {
      scroll: 2,
      extra: async (page) => {
        const btns = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"], a[class*="btn"]'))
            .map((el) => (el.innerText || '').trim().slice(0, 50))
            .filter(Boolean)
        );
        const inputs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input')).map((el) => ({
            type: el.type, ph: el.placeholder || '', name: el.name || '',
          }))
        );
        return { buttons: [...new Set(btns)].slice(0, 80), inputs };
      },
    });
    out.text = (out.text || '') + '\n\n--- buttons ---\n' + JSON.stringify(out.extra?.buttons || [], null, 1)
      + '\n--- inputs ---\n' + JSON.stringify(out.extra?.inputs || [], null, 1);
    return out;
  },

  /**
   * 依次点击页面上的导航项，记录跳转后的 URL。
   * ⭐ 用途：SPA 站点的真实路由只能在点击后才知道。
   * arg: 页面 URL | 导航文本1,导航文本2,...
   */
  discover_nav: async (ctx, arg) => {
    const [url, navPart] = (arg || `https://${DOMAIN}/|`).split('|');
    const navs = (navPart || '').split(',').map((s) => s.trim()).filter(Boolean);
    const out = { url, finalUrl: '', title: '', text: '', links: [], extra: { steps: [] }, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 });
      await T(WAIT + 2000);
      out.extra.landed = page.url();
      for (const nav of navs) {
        try {
          const el = page.getByText(nav, { exact: false }).first();
          if ((await el.count()) === 0) { out.extra.steps.push({ nav, miss: true }); continue; }
          await el.click({ timeout: 6000 });
          await T(6000);
          const tabs = ctx.pages();
          const cur = tabs.length ? tabs[tabs.length - 1] : page;
          out.extra.steps.push({ nav, url: cur.url(), title: await cur.title().catch(() => '') });
        } catch (e) {
          out.extra.steps.push({ nav, error: String(e.message).slice(0, 80) });
        }
      }
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    out.text = JSON.stringify(out.extra, null, 2);
    return out;
  },

  /**
   * 纯文本探针：只 dump 页面正文。
   * arg: URL1|URL2|...（⚠️ 单次不要超过 4–5 个：子域名挂起会把整体拖超时，且不落盘）
   */
  probe_text: async (ctx, arg) => {
    const urls = (arg || `https://${DOMAIN}/`).split('|');
    const out = { url: urls[0], finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    for (const u of urls) {
      try {
        await page_grab_to(ctx, u, out);
      } catch (e) {
        out.extra[u] = { error: String(e.message).slice(0, 140) };
      }
      await T(1200);
    }
    out.text = Object.entries(out.extra)
      .map(([k, v]) => `### ${k}\n${v.text || v.error || ''}`)
      .join('\n\n')
      .slice(0, 30000);
    return out;
  },

  /**
   * 自适应站内搜索。
   * arg: 首页 URL | 关键词 | 候选URL1,候选URL2（候选可省）
   */
  search_site: async (ctx, arg) => {
    const [home, keyword, cands] = (arg || `https://${DOMAIN}/|${TARGET.aliases[0]}|`).split('|');
    return searchSite(ctx, {
      home,
      keyword,
      candidates: (cands || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  },

  /**
   * 无限滚动 / 虚拟列表累计抓取。
   * ⭐ 核心教训：虚拟列表页**不能用 DOM 元素数判断加载进度**（会到平台期假死），
   *    必须把每屏的条目累积进一个 Map 去重，连续 N 屏数量不变才算到底。
   * arg: URL | 条目链接选择器 | 最多滚动屏数（默认 60）
   */
  scroll_harvest: async (ctx, arg) => {
    const [url, sel = 'a[href*="/status/"]', maxScroll = '60'] = (arg || '').split('|');
    const out = { url, finalUrl: '', title: '', text: '', links: [], extra: null, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await T(WAIT + 3000);
      const res = await page.evaluate(
        async ({ sel, maxScroll }) => {
          const seen = new Map();
          let stale = 0;
          for (let i = 0; i < maxScroll && stale < 14; i++) {
            const before = seen.size;
            for (const el of document.querySelectorAll(sel)) {
              const h = el.href || el.getAttribute('href') || '';
              if (!h) continue;
              const key = h.replace(/[?#].*$/, '').split('/').pop() || h;
              if (!seen.has(key)) {
                const card = el.closest('article, li, div[data-testid], section') || el;
                seen.set(key, {
                  href: h,
                  text: (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
                });
              }
            }
            window.scrollBy(0, window.innerHeight * 1.6);
            await new Promise((r) => setTimeout(r, 1600));
            stale = seen.size === before ? stale + 1 : 0;
          }
          return { n: seen.size, items: [...seen.values()] };
        },
        { sel, maxScroll: +maxScroll }
      );
      out.extra = res;
      out.text = `n=${res.n}\n\n` + res.items.map((x) => `${x.href}\n  ${x.text.slice(0, 200)}`).join('\n');
      out.finalUrl = page.url();
      out.title = await page.title().catch(() => '');
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  // ═══════════════════════════════════════════════════════════
  // B. 技术模板 —— 可复用的取数模式
  // ═══════════════════════════════════════════════════════════

  /**
   * 【模板 1】page.goto 直开 JSON 接口 → innerText → JSON.parse
   * ⭐ 比在页面里 fetch 更稳：不受 CORS 限制，也不会被页面的路由拦。
   *    适合无鉴权的公开 API（例：api.bilibili.com/x/web-interface/view?bvid=xxx）。
   * arg: JSON 接口 URL（多个用 | 分隔）
   */
  json_via_goto: async (ctx, arg) => {
    const urls = (arg || '').split('|').filter(Boolean);
    const out = { url: urls[0] || '', finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    const page = await ctx.newPage();
    try {
      for (const u of urls) {
        try {
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await T(1500);
          const raw = await page.evaluate(() => document.body.innerText);
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch {}
          out.extra[u] = { ok: !!parsed, raw: raw.slice(0, 20000), parsed };
        } catch (e) {
          out.extra[u] = { error: String(e.message).slice(0, 140) };
        }
      }
      out.text = JSON.stringify(out.extra, null, 2).slice(0, 30000);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 2】在页面上下文里 fetch 同源 JSON（带 cookie）
   * ⭐ 能绕开域名级拦截：有些站只挡 curl/无头，但放行"页面内发起的请求"。
   *    例：discord.com/api/v10/invites/<code>?with_counts=true → 成员数
   * arg: 宿主页面 URL | 要 fetch 的路径1,路径2,...
   */
  json_via_fetch: async (ctx, arg) => {
    const [host, paths] = (arg || '').split('|');
    const list = (paths || '').split(',').filter(Boolean);
    const out = { url: host, finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto(host, { waitUntil: 'domcontentloaded', timeout: 50000 });
      await T(WAIT);
      out.extra = await page.evaluate(async (paths) => {
        const res = {};
        for (const p of paths) {
          try {
            const r = await fetch(p, { credentials: 'include' });
            const txt = await r.text();
            let j = null;
            try { j = JSON.parse(txt); } catch {}
            res[p] = { status: r.status, ok: r.ok, len: txt.length, parsed: j, raw: j ? null : txt.slice(0, 3000) };
          } catch (e) {
            res[p] = { error: String(e.message).slice(0, 140) };
          }
        }
        return res;
      }, list);
      out.text = JSON.stringify(out.extra, null, 2).slice(0, 30000);
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 3】sitemap.xml 分析：URL 总量 + 月度产出 + 多语种分布
   * ⭐ 查"内容池时间线"和"是否做了 i18n"的**最快单一来源**，比翻列表页可靠得多。
   *    注意 lastmod 是"最后修改"不是"首次发布"，同一天出现大批量日期要警惕站点迁移造成的假日期。
   * arg: sitemap URL（默认 https://<主域名>/sitemap.xml）
   */
  sitemap_scan: async (ctx, arg) => {
    const url = arg || `https://${DOMAIN}/sitemap.xml`;
    const out = { url, finalUrl: url, title: 'sitemap_scan', text: '', links: [], extra: null, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const xml = await page.evaluate(() => document.body.innerText);
      const entries = [];
      const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
      for (const b of blocks) {
        const loc = (b.match(/<loc>([\s\S]*?)<\/loc>/) || [])[1];
        const mod = (b.match(/<lastmod>([\s\S]*?)<\/lastmod>/) || [])[1];
        if (loc) entries.push({ loc: loc.trim(), mod: (mod || '').trim().slice(0, 10) });
      }
      // 语种：按路径首段识别
      // ⚠️ 两字母路径段不一定是语种 —— /kb/ /go/ /api/ /en/ 混在一起。
      //    用 ISO 639-1 白名单 + 常见非语种段黑名单，降低误判并把可疑项单列出来。
      const NOT_LOCALE = new Set(['kb', 'go', 'api', 'id', 'my', 'on', 'to', 'up', 'us', 'tv', 'pr', 'db', 'ui', 'ai']);
      const locale = {};
      const suspicious = {};
      for (const e of entries) {
        const m = e.loc.replace(/^https?:\/\/[^/]+/, '').match(/^\/([a-z]{2}(?:-[a-z]{2,4})?)\//i);
        const seg = m ? m[1].toLowerCase() : null;
        if (!seg) { locale['default(en)'] = (locale['default(en)'] || 0) + 1; continue; }
        if (NOT_LOCALE.has(seg)) { suspicious[seg] = (suspicious[seg] || 0) + 1; continue; }
        locale[seg] = (locale[seg] || 0) + 1;
      }
      // 月度
      const byMonth = {};
      for (const e of entries) {
        if (!/^\d{4}-\d{2}/.test(e.mod)) continue;
        const k = e.mod.slice(0, 7);
        byMonth[k] = (byMonth[k] || 0) + 1;
      }
      const hreflang = [...new Set((xml.match(/hreflang="([^"]+)"/g) || []).map((s) => s.split('"')[1]))];
      out.extra = {
        xmlLen: xml.length,
        totalUrls: entries.length,
        withLastmod: entries.filter((e) => e.mod).length,
        localeCount: locale,
        /** 疑似语种但被排除的两字母路径段（需人工确认，例 /kb/ 是 knowledge base 不是语言） */
        excludedSegments: suspicious,
        byMonth,
        /** 本地化占比：只按 locale 映射算，排除掉被剔除的非语种路径段 */
        localisedShare: (() => {
          const localised = Object.entries(locale)
            .filter(([k]) => k !== 'default(en)')
            .reduce((s, [, v]) => s + v, 0);
          const denom = Object.values(locale).reduce((s, v) => s + v, 0);
          return denom ? +(100 * localised / denom).toFixed(1) : 0;
        })(),
        hreflang,
        earliest: entries.filter((e) => e.mod).map((e) => e.mod).sort()[0] || null,
        newest: entries.filter((e) => e.mod).map((e) => e.mod).sort().pop() || null,
        sample: entries.slice(0, 40),
      };
      out.text = JSON.stringify(out.extra, null, 2).slice(0, 30000);
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 4】Google Trends 搜索需求曲线（长历史）+ 相关查询
   * ⭐ 判断"需求是什么时候出现的"唯一独立来源 —— 站方自述和渠道占比都做不到。
   *    解析坑见 stripTrends()（响应前缀是 )]}', 带逗号，正则剥不掉）。
   * arg: 时间窗（默认 2023-06-01 2026-10-16）
   */
  gtrends: async (ctx, arg) => {
    const time = arg || '2023-06-01 ' + new Date().toISOString().slice(0, 10);
    const TERMS = [
      [TARGET.aliases[0], time],
      [TARGET.category, time],
    ].filter((t) => t[0]);
    const out = { url: 'https://trends.google.com/', finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto('https://trends.google.com/trends/explore?hl=en-US', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await T(7000);
      for (const [term, t] of TERMS) {
        try {
          const data = await page.evaluate(async ({ term, t }) => {
            const req0 = encodeURIComponent(JSON.stringify({
              comparisonItem: [{ keyword: term, geo: '', time: t }], category: 0, property: '',
            }));
            const ex = await fetch(`/trends/api/explore?hl=en-US&tz=0&req=${req0}`, { credentials: 'include' });
            const exRaw = await ex.text();
            const exJson = JSON.parse(exRaw.slice(exRaw.indexOf('{')));
            const widgets = exJson.widgets || [];
            const ts = widgets.find((w) => w.id === 'TIMESERIES');
            const rq = widgets.find((w) => w.id === 'RELATED_QUERIES');
            const o = { exploreStatus: ex.status, widgets: widgets.map((w) => w.id), timeline: null, top: null, rising: null, notes: [] };
            if (ts) {
              const rr = await fetch(
                `/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(ts.request))}&token=${ts.token}`,
                { credentials: 'include' }
              );
              const rrRaw = await rr.text();
              const rj = JSON.parse(rrRaw.slice(rrRaw.indexOf('{')));
              o.timeline = ((rj.default && rj.default.timelineData) || []).map((p) => ({ t: p.formattedTime, v: (p.value || [])[0] }));
              o.tlStatus = rr.status;
            }
            if (rq) {
              const rr = await fetch(
                `/trends/api/widgetdata/relatedsearches?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(rq.request))}&token=${rq.token}`,
                { credentials: 'include' }
              );
              const rrRaw = await rr.text();
              const rj = JSON.parse(rrRaw.slice(rrRaw.indexOf('{')));
              const arr = (rj.default && rj.default.rankedList) || [];
              o.top = ((arr[0] && arr[0].rankedKeyword) || []).map((k) => ({ q: k.query, v: k.value }));
              o.rising = ((arr[1] && arr[1].rankedKeyword) || []).map((k) => ({ q: k.query, v: k.value, f: k.formattedValue }));
              o.rqStatus = rr.status;
            }
            return o;
          }, { term, t });
          out.extra[term] = data;
        } catch (e) {
          out.extra[term] = { error: String(e.message).slice(0, 200) };
        }
        await T(4000);
      }
      out.text = Object.entries(out.extra)
        .map(([k, v]) => `### ${k}\n` + (v.timeline ? v.timeline.map((p) => `${p.t} :: ${p.v}`).join('\n') : JSON.stringify(v).slice(0, 600)))
        .join('\n\n')
        .slice(0, 30000);
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 5】Trends 对照曲线：品牌 vs 品类( vs 竞品)
   * ⭐ 判断「破圈是品牌层的还是市场层的」——两次破圈如果品类线纹丝不动，
   *    说明这个渠道创造的是品牌认知，不是品类需求。
   * arg: 时间窗
   */
  gtrends_cmp: async (ctx, arg) => {
    const time = arg || '2025-01-01 ' + new Date().toISOString().slice(0, 10);
    const SETS = [
      ['brand_vs_category', [TARGET.aliases[0], TARGET.category].filter(Boolean)],
      ['vs_competitors', [TARGET.aliases[0], ...(TARGET.competitors || [])].filter(Boolean)],
    ].filter((s) => s[1].length >= 2);
    const out = { url: 'https://trends.google.com/', finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto('https://trends.google.com/trends/explore?hl=en-US', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await T(7000);
      for (const [label, terms] of SETS) {
        try {
          const data = await page.evaluate(async ({ terms, time }) => {
            const items = terms.map((k) => ({ keyword: k, geo: '', time }));
            const req0 = encodeURIComponent(JSON.stringify({ comparisonItem: items, category: 0, property: '' }));
            const ex = await fetch(`/trends/api/explore?hl=en-US&tz=0&req=${req0}`, { credentials: 'include' });
            const exRaw = await ex.text();
            const exJson = JSON.parse(exRaw.slice(exRaw.indexOf('{')));
            const ts = (exJson.widgets || []).find((w) => w.id === 'TIMESERIES');
            const o = { terms, series: null };
            if (ts) {
              const rr = await fetch(
                `/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(ts.request))}&token=${ts.token}`,
                { credentials: 'include' }
              );
              const rrRaw = await rr.text();
              const rj = JSON.parse(rrRaw.slice(rrRaw.indexOf('{')));
              o.series = ((rj.default && rj.default.timelineData) || []).map((p) => ({ t: p.formattedTime, v: p.value }));
              o.tlStatus = rr.status;
            }
            return o;
          }, { terms, time });
          out.extra[label] = data;
        } catch (e) {
          out.extra[label] = { error: String(e.message).slice(0, 200) };
        }
        await T(4500);
      }
      out.text = Object.entries(out.extra)
        .map(([k, v]) => `### ${k} | ${(v.terms || []).join(' vs ')}\n`
          + (v.series ? v.series.map((p) => `${p.t} :: ${(p.v || []).join(' | ')}`).join('\n') : JSON.stringify(v).slice(0, 500)))
        .join('\n\n')
        .slice(0, 30000);
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 6】列表页结构化抓取（DOM 而非文本）
   * ⭐ 用于"每天重复的榜单/列表"这类可预测结构的页面。
   *    比 grab() 的纯文本可靠：直接拿到字段，不用再正则。
   *    前提：先用探针确认真实容器选择器（不要猜）。
   * arg: URL | 条目容器选择器 | 最多条数
   */
  dom_list_scrape: async (ctx, arg) => {
    const [url, sel, max = '60'] = (arg || '').split('|');
    const out = { url, finalUrl: '', title: '', text: '', links: [], extra: null, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await T(WAIT + 2000);
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9)).catch(() => {});
        await T(1100);
      }
      const items = await page.evaluate(({ sel, max }) => {
        const res = [];
        for (const el of document.querySelectorAll(sel)) {
          const txt = (el.innerText || '').replace(/\r/g, '');
          const nums = [];
          const lines = txt.split('\n').map((s) => s.trim()).filter((s) => s && s !== '•');
          let i = lines.length - 1;
          while (i >= 0 && /^\d+$/.test(lines[i]) && nums.length < 2) { nums.unshift(+lines[i]); i--; }
          const a = el.querySelector('a[href]');
          res.push({
            text: lines.join(' | ').slice(0, 300),
            nums,
            href: a ? a.href : null,
          });
          if (res.length >= max) break;
        }
        return res;
      }, { sel, max: +max });
      out.extra = { count: items.length, items };
      out.text = JSON.stringify(out.extra, null, 2).slice(0, 30000);
      out.finalUrl = page.url();
      out.title = await page.title().catch(() => '');
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 7】SimilarWeb 流量结构
   * ⚠️ 两个坑：① #geography 之类的锚点会打断 SPA 渲染 → 用 plain URL + 慢滚动
   *           ② 免费额度会被打满，之后所有指标显示 "- -" 且拿不到数据
   *              → 首次抓取就要把结果存全，不要指望复测
   * arg: 域名
   */
  similarweb: async (ctx, arg) => {
    const domain = arg || DOMAIN;
    return grab(ctx, `https://www.similarweb.com/website/${domain}/`, { wait: 12000, scroll: 10 });
  },

  /**
   * 【模板 8】Reddit 站内 JSON 枚举（同源 + 带 cookie，可在页面上下文里 fetch）
   * ⭐ 关键坑：429 限流会返回非 200 且 body 为空 —— **必须把 status 一并回传**，
   *    否则会把限流静默读成"没有数据"。查询之间要留间隔。
   * arg: 关键词（默认取目标品牌名）
   */
  reddit_search: async (ctx, arg) => {
    const q = arg || TARGET.aliases[0];
    const out = { url: 'https://www.reddit.com/', finalUrl: '', title: '', text: '', links: [], extra: null, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 50000 });
      await T(3000);
      const queries = [
        `/search.json?q=${encodeURIComponent(q)}&type=link&sort=new&t=all&limit=100`,
        `/search.json?q=${encodeURIComponent(q)}&type=link&sort=top&t=all&limit=100`,
        `/search.json?q=${encodeURIComponent(q)}&type=link&sort=relevance&t=all&limit=100`,
        `/search.json?q=${encodeURIComponent(q)}&type=comment&sort=new&t=all&limit=100`,
        `/search.json?q=${encodeURIComponent(q)}&type=comment&sort=top&t=all&limit=100`,
      ];
      const results = {};
      for (const p of queries) {
        results[p] = await page.evaluate(async (p) => {
          try {
            const r = await fetch(p, { credentials: 'include' });
            const txt = await r.text();
            if (!r.ok) return { status: r.status, err: 'HTTP ' + r.status, n: 0, items: [] };
            const j = JSON.parse(txt);
            const ch = (j.data && j.data.children) || [];
            return {
              status: r.status,
              n: ch.length,
              items: ch.map((c) => {
                const d = c.data || {};
                return {
                  id: d.id, sub: d.subreddit, title: d.title, author: d.author,
                  score: d.score, num_comments: d.num_comments,
                  created: d.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : null,
                  permalink: d.permalink ? 'https://www.reddit.com' + d.permalink : null,
                  selftext: (d.selftext || d.body || '').slice(0, 400),
                };
              }),
            };
          } catch (e) {
            return { status: 0, err: String(e.message).slice(0, 140), n: 0, items: [] };
          }
        }, p);
        await T(5000); // ⚠️ 必须留间隔，否则 429
      }
      // 去重
      const seen = new Map();
      for (const v of Object.values(results)) {
        for (const it of v.items || []) if (it.id && !seen.has(it.id)) seen.set(it.id, it);
      }
      out.extra = { perQuery: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { status: v.status, n: v.n, err: v.err }])), items: [...seen.values()] };
      out.text = `去重后 ${seen.size} 条\n\n` + JSON.stringify(out.extra, null, 2).slice(0, 28000);
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 9】Reddit 账号级取证（判断铺量号 / 是否被封）
   * ⭐ 封禁判定：账号页 HTTP 200，但 document.title 退化成通用站名，
   *    且正文含 "This account has been banned"。正常账号标题是 "XXX (u/name) - Reddit"。
   *    submitted.json 返回 403 也是封号信号。
   * arg: 用户名1,用户名2,...
   */
  reddit_user: async (ctx, arg) => {
    const users = (arg || '').split(',').map((s) => s.trim()).filter(Boolean);
    const out = { url: 'reddit_user', finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 50000 });
      await T(2500);
      for (const u of users) {
        const r = await page.evaluate(async (u) => {
          const o = { user: u };
          try {
            const sub = await fetch(`/user/${u}/submitted.json?limit=100`, { credentials: 'include' });
            o.submittedStatus = sub.status;
            if (sub.ok) {
              const j = JSON.parse(await sub.text());
              const ch = (j.data && j.data.children) || [];
              o.postCount = ch.length;
              o.subs = [...new Set(ch.map((c) => c.data && c.data.subreddit).filter(Boolean))].slice(0, 20);
              o.recent = ch.slice(0, 12).map((c) => ({
                sub: c.data.subreddit, title: c.data.title, score: c.data.score,
                date: c.data.created_utc ? new Date(c.data.created_utc * 1000).toISOString().slice(0, 10) : null,
              }));
            } else {
              o.bannedSignal = 'submitted.json 返回 ' + sub.status;
            }
          } catch (e) { o.submittedError = String(e.message).slice(0, 120); }
          return o;
        }, u);
        out.extra[u] = r;
        // 账号页 HTML —— 拿 title 判封禁
        try {
          await page.goto(`https://www.reddit.com/user/${u}/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
          await T(2500);
          out.extra[u].pageTitle = await page.title().catch(() => '');
          const body = await page.evaluate(() => (document.body ? document.body.innerText : ''));
          out.extra[u].banned = /This account has been banned/i.test(body);
          out.extra[u].bodyHead = body.replace(/\s+/g, ' ').slice(0, 300);
        } catch (e) {
          out.extra[u].pageError = String(e.message).slice(0, 120);
        }
        await T(3000);
      }
      out.text = JSON.stringify(out.extra, null, 2).slice(0, 30000);
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  /**
   * 【模板 10】Discord 邀请信息（成员数 / 在线数）
   * ⭐ 必须在 discord.com 的页面上下文里 fetch：直接 curl 会被拦。
   * arg: 邀请码1,邀请码2,...
   */
  discord_invite: async (ctx, arg) => {
    const codes = (arg || '').split(',').map((s) => s.trim()).filter(Boolean);
    const out = { url: 'https://discord.com/', finalUrl: '', title: '', text: '', links: [], extra: {}, error: null };
    const page = await ctx.newPage();
    try {
      await page.goto('https://discord.com/', { waitUntil: 'domcontentloaded', timeout: 50000 });
      await T(4000);
      out.extra = await page.evaluate(async (codes) => {
        const res = {};
        for (const c of codes) {
          try {
            const r = await fetch(`/api/v10/invites/${c}?with_counts=true`, { credentials: 'include' });
            const j = await r.json();
            res[c] = {
              status: r.status,
              guild: j.guild && j.guild.name,
              members: j.approximate_member_count,
              online: j.approximate_presence_count,
            };
          } catch (e) {
            res[c] = { error: String(e.message).slice(0, 140) };
          }
        }
        return res;
      }, codes);
      out.text = JSON.stringify(out.extra, null, 2);
    } catch (e) {
      out.error = String(e.message).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },
};

/** probe_text 内部用：把单个 URL 抓进 out.extra */
async function page_grab_to(ctx, url, out) {
  const g = await grab(ctx, url, { scroll: 2 });
  out.extra[url] = {
    title: g.title,
    finalUrl: g.finalUrl,
    len: (g.text || '').length,
    text: (g.text || '').slice(0, 15000),
    error: g.error,
  };
}

module.exports = { SCRAPERS, grab, searchSite, T, CONFIG, weekLabelToMonth, stripTrends };
