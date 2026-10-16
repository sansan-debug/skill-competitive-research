# 平台取数配方

每条配方都包含：**怎么取** + **坑在哪**。踩过的坑比成功路径更值得记。

---

## 通用技巧（先看这节）

### 三种取 JSON 的方式，按可靠性排序

| 方式 | 适用 | 抓取器 |
|---|---|---|
| **`page.goto(JSON_URL)` → 读 `document.body.innerText` → `JSON.parse`** | 无鉴权的公开 API | `json_via_goto` |
| **页面上下文内 `fetch(path, {credentials:'include'})`** | 同源接口、需带 Cookie；**能绕开域名级拦截** | `json_via_fetch` |
| 直接 curl | 只对完全开放的静态资源可行 | — |

> **为什么"页面内 fetch"更强**：有些站只挡 curl 和无头请求，但放行**由页面自身发起**的请求。Discord 的成员数就是这么拿到的。

### 虚拟列表 / 无限滚动

**⚠️ 不能用 DOM 元素数判断是否滚到底** —— 虚拟列表的 DOM 数量会到平台期，导致提前停止。

**正确做法**：每滚一屏就把条目累积进一个 **`Map` 去重**，**连续 N 屏（实测 14 屏）数量不变**才算到底。用 `scroll_harvest`。

### 时间戳从 ID 里解，不要解析文本

社交平台的帖子 ID 常是**雪花 ID**，内嵌精确时间戳：

```
毫秒时间戳 = (id >> 22) + 1288834974657
```

比解析 "Jul 9" 这类相对时间可靠得多，**也不用猜年份**。

### 数据站的入口要用"列标签页"找

数据站的导航**常是纯动态渲染**（改 hash 不换内容），硬编码路由会静默取空。
最可靠的方法：**列出浏览器当前打开的所有标签页**（`list_pages`），用户登录时用过的 URL 就是真实入口。

---

## Google Trends

```
GET /trends/api/explore?hl=en-US&tz=0&req=<encodeURIComponent(JSON)>
   req = { comparisonItem:[{keyword, geo:'', time}], category:0, property:'' }
   → 返回 widgets[]，其中 id==='TIMESERIES' 的对象里带 token
GET /trends/api/widgetdata/multiline?hl=en-US&tz=0&req=<widget.request>&token=<widget.token>
   → {default:{timelineData:[{formattedTime, value:[n]}]}}
GET /trends/api/widgetdata/relatedsearches?req=<rq.request>&token=<rq.token>
   → {default:{rankedList:[{rankedKeyword:[{query,value}]}, ...]}}   # [0]=top, [1]=rising
```

**⚠️ 解析坑**：响应体前缀是 `)]}',` —— **`)],'` 后面还有一个逗号**。

`replace(/^\)\]\}'\s*/,'')` **剥不掉那个逗号**，会报 `Unexpected token ','`。

**正确做法**：
```js
JSON.parse(raw.slice(raw.indexOf('{')))   // 直接定位第一个 {，别用正则剥前缀
```

（explore 和 widgetdata 两个接口的前缀逗号表现不一致，所以更要统一用 slice 法。）

**必须先访问 `trends.google.com` 建立 cookie**，再用 `page.evaluate(fetch(...))`。

**两个查询的尺度关系**：把品牌词和品类词放进**同一个 comparisonItem** 才是可比尺度（联合归一化 0–100）；分别查各自的 100 分不是同一个基准。

---

## Reddit

```
/search.json?q=<kw>&type=link|comment&sort=new|top|relevance|comments&t=all|year&limit=100
/user/<name>/submitted.json?limit=100
/user/<name>/comments.json?limit=100
<permalink>.json?limit=500&sort=old        # 完整评论树
```
全部可在 reddit.com 页面上下文里 fetch（同源 + 带 Cookie）。

**⚠️ 两个坑**：
1. **429 限流会返回非 200 且 body 为空** → 必须把 `status` 一并回传给调用方，否则会把限流静默读成"没有数据"。查询之间留 **5 秒**间隔。
2. **`type=comment` + `t=year` 实测行为不一致**（会返回帖子 t3），不要依赖这个组合。

**封禁判定**：账号页 HTTP 200，但 `document.title` 退化成通用站名，正文含 `This account has been banned`。正常账号标题是 `XXX (u/name) - Reddit`。`submitted.json` 返回 **403** 也是封号信号。

用 `reddit_search`（枚举）+ `reddit_user`（账号级取证）配套使用。

---

## X / Twitter

**站内搜索通常不可用**（`/search?q=` 返回报错）→ 只能靠**主页时间线滚动**。

- 用 `scroll_harvest`，选择器 `a[href*="/status/"]`，靠"累计去重集合大小"判断到底（见通用技巧）
- **时间戳从 status ID 解**，不要解析 "Jul 9"

**⚠️ 帖子卡片里的成员数是动态的**：如果帖子里嵌了 Discord/社群的邀请卡片，卡片显示的是**渲染时的实时数字**，**不能反推发布当天的数值**。

**浏览量 ≠ 访问量**：见 `verification-criteria.md` 第 5.1 节。

---

## B站（Bilibili）

在浏览器里 `page.goto` JSON URL 然后读 `innerText` 再 `JSON.parse` —— **比在页面里 fetch 更稳（无 CORS 问题）**。

```
https://api.bilibili.com/x/web-interface/view?bvid=BVxxx        # stat 全字段 + desc + owner.mid
https://api.bilibili.com/x/v2/reply?type=1&oid=<aid>&sort=2&ps=20&pn=1
https://search.bilibili.com/all?keyword=X&order=click          # HTML 页，抓 .bili-video-card
https://space.bilibili.com/<mid>/video                          # 频道页
```

**⚠️ 频道页的 `a[title]` 抓不到标题** → 改读 `document.body.innerText`。

**付费商单字段**：`stat` 之外，视频 JSON 里有 `is_union_video`（1 = 平台备案商单）。**注意：它只标平台备案的商单，私下软广不标。**

**判断"标题是不是账号风格模板"必须抓 UP 主主页** —— 单看一条视频永远会误判。

---

## Product Hunt

```
https://www.producthunt.com/leaderboard/daily/YYYY/M/D    # 日榜
https://www.producthunt.com/products/<slug>               # 产品页
```

**⭐ 日榜页直接给出每个产品的「评论数 + 票数」** —— 这是拿 cohort 基线**最快的途径**，比逐个抓产品页高效得多。

**DOM 结构**：条目容器是 `section.group.relative.isolate`，`innerText` 结构为
```
N. 产品名
tagline
分类…
评论数
票数
```
末尾两个纯数字即 评论数 → 票数。用 `dom_list_scrape`，选择器传 `section.group.relative.isolate`。

**⚠️ 产品页的 maker 选择器会混入"评审人"**：`a[href^="/@"]` 会把 review 作者一起抓进来。区分方法：maker 名前通常紧跟品牌名，评审人后跟 "N reviews"。

**⚠️ 评论是分页的**，控件是 `<a href="...?page=N#comments">` → **用 URL 参数导航，比点 Next 稳**。

**平台机制**：排名由 **upvote 驱动，评论不进排序**。这与国内打榜平台（评论计入排序）不同 —— 影响"水军会买什么"的判断。

---

## SimilarWeb

```
https://www.similarweb.com/website/<domain>/
```

**⚠️ 三个坑**：
1. **`#geography` 之类的锚点会打断 SPA 渲染** → 用 plain URL + 慢滚动。
2. **免费额度会被打满**，之后所有指标显示 `- -`，`__NEXT_DATA__` 也没数据 → **首次抓取就要把结果存全**。
3. **直连 curl 在沙箱内常被阻断** → 必须走浏览器。

**免费版字段限制**：只给**第 1 名的百分比** + **前 3 名的排名**。
页面原文可作判定依据：`Only showing top 3 marketing channels. Start free trial to see the full breakdown.`

`data.similarweb.com/api/v1/data` 端点**已不可用**。

---

## sitemap.xml（查内容池时间线 + i18n）

```
https://<domain>/sitemap.xml
```

**这是查"站点内容时间线"和"是否做了 i18n"的最佳单一来源**，比翻博客列表页可靠得多。

用 `sitemap_scan`，它输出：
- URL 总量 / 带 `<lastmod>` 的数量
- **月度新增分布**（判断内容池的节奏与空档）
- **语种分布**（按路径首段；自动剔除 `/kb/` `/go/` `/api/` 这类伪语种并单列）
- `hreflang` 列表
- 最早 / 最新日期

**⚠️ 两个坑**：
1. **`<lastmod>` 是"最后修改"不是"首次发布"** → **同一天出现大批量日期要警惕站点迁移造成的假日期**。
2. **两字母路径段不一定是语种** → `/kb/`（knowledge base）、`/go/`、`/api/` 都是。用 `/ja/` 存在**只能证明"在做 i18n"**，不能证明"该市场有真实需求"。

**副作用提示**：批量做的本地化页面**本身就会带来对应语种 IP 的自然搜索流量**（真实用户 + 爬虫），会污染国别归因。

---

## Discord

```
/api/v10/invites/<code>?with_counts=true
   → { guild:{name}, approximate_member_count, approximate_presence_count }
```

**必须在 `discord.com` 的页面上下文里 fetch**（`json_via_fetch`，宿主页 `https://discord.com/`，路径传 `/api/v10/invites/<code>?with_counts=true`）。直接 curl 会被拦。

---

## GitHub

```
https://api.github.com/repos/<owner>/<repo>          # stars / 语言 / 时间
https://api.github.com/orgs/<org>/repos?per_page=100
https://api.github.com/search/repositories?q=<kw>&sort=stars
```

**⚠️ 免鉴权有严格的 IP 限流**（`API rate limit exceeded`）。大量调用需要在页面里带 token，或换其他来源。

**用途**：查对手的开发者生态时间线（何时落地 MCP、何时出现第三方衍生项目），以及**第三方是否在用它的名字命名项目**（说明"入口地位"被同行承认）。

---

## 微信公众号 / 视频号

**⚠️ 文章级阅读量基本拿不到。** 实测路径：
- 老牌关键词搜索入口已下线（302 回首页）
- 主流数据平台的产品线多为**企业级申请制**（登录态正常但入口是"申请试用"）
- 公开榜单站只有**账号级**排行，没有文章级搜索

**可用的替代判据**（做选号投放时更实用）：部分平台的选号库会公开
**「预估活跃粉丝 / 头条预估阅读」** → **两者相除得真实触达率**，见 `verification-criteria.md` 第八节。

**视频号生态封闭**（需客户端内查看），无法自动化。

---

## 小红书

**⚠️ 详情页在 Web 端被拦**：返回 `error_code=300031` / "请打开小红书 App 扫码查看"，302→404。**正文与评论拿不到。**

可拿到的：**搜索页**的标题 / 作者 / 日期 / 点赞数，以及**搜索联想词**（最能暴露用户真实关注点，例如"收费吗 / 和 XX 哪个好 / 官网进不去"）。

**⚠️ 因此：小红书上的负面笔记"无法判定性质"** —— 既不能证明是真实用户，也不能证明是引流号。**报告里必须写明这个局限，不要强行下结论。**

---

## 抖音

**站内搜索可见量远小于真实声量** → 需要第三方工具，且**必须标注口径**：

| 工具 | 口径 | 说明 |
|---|---|---|
| **蝉妈妈** `awemeRank/?keyword=X&time=90d` | **文案 + 话题标签**全文 | 直接访问该 URL，无需操作搜索框。**不给播放量**；分页参数常无效 |
| **飞瓜** `#/video/library/all?keyword=X&keywordType=0&mSearchType=2&tab=1` | **标题** | 独有字段：**传播指数 / 分享 / 收藏**；列表模式需商家版 |

**飞瓜的三个"零"比数字更有信息量**：直播 0 / 商品 0 / 品牌小店 0 → **完全没进带货生态**。对一个纯工具产品这是正常的，也是一个可选项。

**⚠️ 第三方达人库有收录门槛** → 官方号可能查不到（说明其数据权重低于收录线）。**"查不到"本身是信号。**

---

## 微博 / 知乎

微博：搜索结果页可拿互动数（转/评/赞），**负面比例常较高**，适合做话题传播而非沉淀。

知乎：可用"精选内容"聚合页拿**问题级浏览**；单篇赞同数普遍偏低。**有价值的内容通常是"安装教程"型 UGC**（安装链路复杂的产品尤其如此）。

---

## 数据站通用：绕过"权限"与"登录"的混淆

**⚠️ "登录成功" ≠ "有权限"。**
- 看页头有没有账号名 → 判断**登录态**
- 看功能入口是不是"申请试用/申请演示" → 判断**权限**

两者是独立的事。页头有账号但功能要申请，是很常见的状态。

**若某路径猜不到**：用 `list_pages` 看用户登录时实际打开过哪些 URL —— 那是唯一可靠的入口来源。
