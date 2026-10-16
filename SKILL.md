---
name: competitive-research
description: Conducts evidence-based competitive and growth-channel research on a product or company — building a channel map, harvesting first-party data with a logged-in browser, attributing content to its true source, and determining whether each channel creates or merely captures demand. This skill should be used when the user asks to research a competitor, map a product's growth channels, figure out where a product gets its users, verify whether reviews or posts are genuine versus paid, validate third-party traffic or engagement numbers, or produce a competitive landscape report. Triggers include 竞品研究, 竞品分析, 全渠道增长, 增长渠道拆解, 用户增长研究, 渠道归因, 来源归因, 声量分析, 舆情取证, 水军识别, 竞品报告, competitive analysis, growth channel research, competitor teardown, attribution study.
agent_created: true
---

# 竞品与增长渠道研究

用**一手证据**回答三个问题：**对手的用户从哪来、那些内容是谁发的、它的增长靠什么驱动。**

产出物是一份每个数字都标了口径与来源、且明确列出"拿不到什么"的研究报告 —— 而不是一堆二手数字的堆砌。

## 何时使用

- 要研究某个竞品 / 对标产品的增长打法与渠道结构
- 要判断某产品的内容生态是"真实口碑"还是"买来的"
- 要验证第三方工具给出的流量或互动数字是否可信
- 要为自家产品的渠道投入做优先级决策
- 要做投资或市场进入尽调时的产品侧取证

## 核心立场（决定了产出质量）

**宁可写"拿不到"，也不要估一个数填上。** 研究报告的价值来自可信度，不来自完整度。

三条不可违背的纪律：

1. **每个数字标注口径与来源。** 同一个"声量"指标在不同口径下能差 50 倍；不写口径的数字没有意义。
2. **区分"没发现证据"与"已证明为真"。** 平台不公开的数据要写成"无法验证"，不能写成"已确认"。
3. **主动找能证伪自己结论的证据。** 每得出一个结论，先问"什么数据会让它不成立"。

## 工作流程

按六阶段推进，**顺序不可乱**（跳步会得到看起来完整但站不住的报告）。详细步骤见 `references/workflow.md`。

| 阶段 | 做什么 | 产出 |
|---|---|---|
| **0** | 定义研究对象与口径（域名 / 品牌词变体 / 品类词 / 竞品词 / 官方账号 / 时间窗） | 填好 `scripts/config.js` |
| **1** | 公开检索建立渠道地图（不求精度，求覆盖） | 分类渠道清单 |
| **2** | **登录态取数**，把评论数 / 票数 / 成员数 / 播放量这些关键字段拿回来 | 逐渠道数据表 |
| **3** | **来源归因**：这些内容是谁发的 | 归因表（第一方 / 联盟 / 铺量 / 真实 UGC） |
| **4** | 讨论度：浏览 / 点赞 / 评论 / 转发 / **收藏** | 讨论度数据 |
| **5** | 交叉验证与归因修正（多源 / 时间 / 反向） | 修正后的结论 |
| **6** | **需求时序**：判断每个渠道是"造需求"还是"接需求" | 因果链结论 |

## 取数装置

关键字段几乎都需要登录态。`scripts/` 下是一套**带持久化登录的取数装置**：

```
scripts/
├── config.js          ← 唯一需要按项目修改的文件（研究对象参数）
├── platforms.js       ← 登录哪些平台（含登录态判断字段）
├── login-console.js   ← 可见浏览器 + 持久化 profile + 本地面板 + 取数守护进程
├── harvest.js         ← 抓取器库（17 个通用技术模板）
├── smoke.js           ← 环境冒烟测试
└── package.json
```

### 安装与启动

```bash
cd scripts
npm i playwright-core          # 仅一个包
npm run smoke                  # 先确认环境可用
npm run console                # 启动登录控制台（在窗口里手动登录一次）
```

浏览器窗口关闭即结束。Cookie 落在 profile 目录，**下次不用重复登录**。

### 取数

```bash
curl "http://127.0.0.1:8899/harvest-list"                       # 列出抓取器
curl "http://127.0.0.1:8899/harvest?id=probe_text&arg=<url>"     # 执行
```

多个参数用 `|` 分隔。**改 `harvest.js` 后不用重启**（每次调用重新载入）。

### 抓取器分类

**A. 基础设施**（摸清陌生站点，不依赖研究目标）

| 抓取器 | 用途 |
|---|---|
| `list_pages` | 列出所有标签页 —— **找真实入口最有效的手段** |
| `login_probe` | 打印指定域名全部 cookie（判断登录态 / 校准 `platforms.js`） |
| `entry_discover` | 列出页面的链接、按钮、输入框 |
| `discover_nav` | 依次点击导航项，记录跳转后的真实 URL（SPA 路由只能这样拿） |
| `probe_text` | 纯文本探针（一次 ≤ 5 个 URL） |
| `search_site` | 自适应站内搜索（候选 URL 全失败则自动找搜索框输入） |
| `scroll_harvest` | 无限滚动 / 虚拟列表累计去重抓取 |

**B. 技术模板**（可复用的取数模式）

| 抓取器 | 模板 |
|---|---|
| `json_via_goto` | `page.goto(JSON_URL)` → `innerText` → `JSON.parse`（无鉴权公开 API） |
| `json_via_fetch` | 页面内 fetch 同源 JSON（**能绕开域名级拦截**） |
| `sitemap_scan` | sitemap → URL 量 / 月度产出 / 语种分布 / hreflang（**查内容池时间线与 i18n 的最佳单一来源**） |
| `gtrends` | 搜索需求曲线（长历史）+ 相关查询 |
| `gtrends_cmp` | 品牌 vs 品类 vs 竞品对照曲线 |
| `dom_list_scrape` | 列表页结构化抓取（先用探针确认容器，不要猜选择器） |
| `similarweb` | 流量结构 |
| `reddit_search` / `reddit_user` | Reddit 枚举 + 账号级取证（含封禁判定） |
| `discord_invite` | 成员数 / 在线数 |

平台级的接口与坑见 `references/platform-recipes.md`。

## 判据库（本 skill 的核心价值）

**所有分析结论都必须过一遍 `references/verification-criteria.md`。** 它包含九组判据，每组都是"用一次错误换来的"：

1. **归因判据** —— 第一方 / 联盟 KOL / 平台备案商单 / 铺量号 / 真实 UGC 怎么区分
2. **"吐槽"是真用户还是引流号** —— 四步法（变现钩子 → 评论区 → 具体踩坑 vs 情绪词 → 跨作品看标题分布）
3. **操纵识别三条硬判据** —— 跨账号同类文本 / 账号被平台封禁 / 是否通用服务
4. **互动率指标必须先拿 cohort 定基线** —— 且要问"操纵会让它往哪走"
5. **流量与归因的四个陷阱** —— 帖子浏览量≠访问量 / IP 国别受 VPN 污染 / Direct 是垃圾桶 / 免费工具字段限制
6. **需求判断** —— 渠道是"造需求"还是"接需求"（看时序、品牌词 vs 品类词、品类线是否同步波动）
7. **口径纪律** —— 同指标差 50 倍的原因与防范
8. **选渠道 / 选号判据** —— 预估阅读 ÷ 预估粉丝
9. **检索手段的自我怀疑** —— "检索为空"往往是"检索方法不足"

## 操作雷区

**开工前先读 `references/pitfalls.md`。** 其中最贵的一条：

> 取数守护进程会**自动写入** `<outDir>/<id>.json`。用 `curl -o` 指向**同名文件**会覆盖它。
> 曾因此把唯一一份完整数据覆盖成限流版（全是 `- -`）。
> **规则：关键数据抓完立刻另存带时间戳的副本。**

其它必知项：HTTP 响应里的 `text` 是**截断副本**（大结果读文件）；单次 harvest 的 URL 数 ≤ 5（超时且不落盘）；改完 `harvest.js` 先 `node --check`；枚举类抓取器**必须回传 status**（否则限流被读成"没有数据"）。

## 交付物

报告的完整清单与每项的验收要求见 `references/workflow.md` 末节。**报告结尾必须有一张"数据缺口表"**，把拿不到的字段和已尝试的路径列明 —— 这是可信度的一部分，不是缺陷。

## 参考文件

| 文件 | 何时读 |
|---|---|
| `references/workflow.md` | 开工前 —— 六阶段详细步骤与交付物清单 |
| `references/verification-criteria.md` | 每次下结论前 —— 九组判据 |
| `references/platform-recipes.md` | 写具体平台抓取时 —— 接口路径与坑 |
| `references/pitfalls.md` | 开工前 + 交付前自查 |
