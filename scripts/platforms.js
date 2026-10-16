/**
 * 平台注册表 —— 登录控制台据此监测「哪些平台已登录」
 *
 * 每个平台声明：
 *   id           唯一标识
 *   name         显示名
 *   group        分组（面板按此分节）
 *   loginUrl     点「打开登录页」时跳哪里
 *   homeUrl      用来读取 cookie 判断会话的页面（必须与登录域一致）
 *   authCookies  出现其中任意一个 → 视为已登录；空数组 → 标记为「无需登录」
 *   needLogin    是否必须登录才能取到有效数据
 *   dataWant     要取的指标（写给人看，报告里当口径说明）
 *
 * ⚠️ authCookies 是最容易过时的字段。若面板显示「未登录」但实际已登录，
 *    用 harvest.js 的 login_probe 打印该域真实 cookie 名，再回来改这里。
 */

const PLATFORMS = [
  // ---------- 海外：产品社区 ----------
  {
    id: 'producthunt', name: 'Product Hunt', group: '海外社区',
    loginUrl: 'https://www.producthunt.com/', homeUrl: 'https://www.producthunt.com/',
    authCookies: ['_producthunt_session', 'ph_session'],
    needLogin: false, dataWant: '日榜/周榜排名、票数、评论数、上传方',
  },
  {
    id: 'reddit', name: 'Reddit', group: '海外社区',
    loginUrl: 'https://www.reddit.com/', homeUrl: 'https://www.reddit.com/',
    authCookies: ['reddit_session', 'token_v2'],
    needLogin: true, dataWant: '全站提及帖与评论、发帖账号历史、封禁状态',
  },
  {
    id: 'discord', name: 'Discord', group: '海外社区',
    loginUrl: 'https://discord.com/app', homeUrl: 'https://discord.com/app',
    authCookies: ['token'],
    needLogin: true, dataWant: '官方服务器成员数、在线数、Boosts',
  },
  {
    id: 'hackernews', name: 'Hacker News', group: '海外社区',
    loginUrl: 'https://news.ycombinator.com/', homeUrl: 'https://news.ycombinator.com/',
    authCookies: ['user'],
    needLogin: false, dataWant: '提交记录、讨论热度',
  },

  // ---------- 海外：社交与视频 ----------
  {
    id: 'x', name: 'X / Twitter', group: '海外社交',
    loginUrl: 'https://x.com/', homeUrl: 'https://x.com/',
    authCookies: ['auth_token', 'ct0'],
    needLogin: true, dataWant: '单条帖浏览量/赞/转/评、全量时间线、KOL 帖',
  },
  {
    id: 'youtube', name: 'YouTube', group: '海外视频',
    loginUrl: 'https://www.youtube.com/', homeUrl: 'https://www.youtube.com/',
    authCookies: ['SID', '__Secure-3PSID', 'SAPISID', 'LOGIN_INFO'],
    needLogin: true, dataWant: '订阅数、视频数、单条播放量、Shorts 表现',
  },
  {
    id: 'linkedin', name: 'LinkedIn', group: '海外社交',
    loginUrl: 'https://www.linkedin.com/', homeUrl: 'https://www.linkedin.com/feed/',
    authCookies: ['li_at'],
    needLogin: true, dataWant: '公司页关注数、员工规模、发帖互动',
  },
  {
    id: 'medium', name: 'Medium', group: '海外图文',
    loginUrl: 'https://medium.com/', homeUrl: 'https://medium.com/',
    authCookies: ['sid', 'uid'],
    needLogin: false, dataWant: '相关文章数、claps',
  },

  // ---------- 国内：社区与图文 ----------
  {
    id: 'zhihu', name: '知乎', group: '国内社区',
    loginUrl: 'https://www.zhihu.com/', homeUrl: 'https://www.zhihu.com/',
    authCookies: ['z_c0'],
    needLogin: true, dataWant: '问题浏览、回答赞同、教程型 UGC',
  },
  {
    id: 'juejin', name: '掘金', group: '国内社区',
    loginUrl: 'https://juejin.cn/', homeUrl: 'https://juejin.cn/',
    authCookies: ['sessionid', 'sessionid_ss'],
    needLogin: false, dataWant: '文章数、阅读量',
  },
  {
    id: 'xiaohongshu', name: '小红书', group: '国内图文',
    loginUrl: 'https://www.xiaohongshu.com/', homeUrl: 'https://www.xiaohongshu.com/',
    authCookies: ['web_session', 'a1'],
    needLogin: true, dataWant: '笔记标题/作者/赞数；搜索联想词',
  },
  {
    id: 'weibo', name: '微博', group: '国内社交',
    loginUrl: 'https://weibo.com/', homeUrl: 'https://weibo.com/',
    authCookies: ['SUB', 'SUBP'],
    needLogin: true, dataWant: '搜索结果、转发/评论/赞',
  },

  // ---------- 国内：视频 ----------
  {
    id: 'bilibili', name: 'B站', group: '国内视频',
    loginUrl: 'https://www.bilibili.com/', homeUrl: 'https://www.bilibili.com/',
    authCookies: ['SESSDATA', 'bili_jct'],
    needLogin: true, dataWant: '视频数、播放/点赞/收藏、是否商单、UP 主主页',
  },
  {
    id: 'douyin', name: '抖音', group: '国内视频',
    loginUrl: 'https://www.douyin.com/', homeUrl: 'https://www.douyin.com/',
    authCookies: ['sessionid', 'sessionid_ss', 'passport_csrf_token'],
    needLogin: true, dataWant: '官方号粉丝/获赞、站内搜索可见视频',
  },

  // ---------- 第三方数据工具（都需要付费/登录；免费版普遍锁关键字段）----------
  {
    id: 'similarweb', name: 'SimilarWeb', group: '数据工具',
    loginUrl: 'https://www.similarweb.com/', homeUrl: 'https://www.similarweb.com/',
    authCookies: [],
    needLogin: false, dataWant: '月访问量、全球排名、渠道结构、国家分布、关键词',
  },
  {
    id: 'gtrends', name: 'Google Trends', group: '数据工具',
    loginUrl: 'https://trends.google.com/', homeUrl: 'https://trends.google.com/',
    authCookies: [],
    needLogin: false, dataWant: '搜索需求曲线（长历史）、相关查询、品牌 vs 品类对照',
  },
  {
    id: 'socialblade', name: 'SocialBlade', group: '数据工具',
    loginUrl: 'https://socialblade.com/', homeUrl: 'https://socialblade.com/',
    authCookies: ['cf_clearance'],
    needLogin: false, dataWant: 'YouTube / X 增长曲线',
  },
  {
    id: 'chanmama', name: '蝉妈妈', group: '数据工具',
    loginUrl: 'https://www.chanmama.com/', homeUrl: 'https://www.chanmama.com/',
    authCookies: ['LOGIN-TOKEN-FORSNS', 'Authorization-By-CAS'],
    needLogin: true, dataWant: '抖音「文案+话题」全文口径视频、达人粉丝/点赞/评论',
  },
  {
    id: 'feigua', name: '飞瓜', group: '数据工具',
    loginUrl: 'https://dy.feigua.cn/app/', homeUrl: 'https://dy.feigua.cn/app/',
    authCookies: ['GuoJiSessionId', 'FEIGUADY2'],
    needLogin: true, dataWant: '抖音「标题」口径视频；传播指数/分享/收藏；电商痕迹',
  },
  {
    id: 'newrank', name: '新榜', group: '数据工具',
    loginUrl: 'https://www.newrank.cn/', homeUrl: 'https://www.newrank.cn/',
    authCookies: ['token'],
    needLogin: true, dataWant: '公众号榜单；有赚的「预估阅读 ÷ 预估粉丝」',
  },
  {
    id: 'qiangua', name: '千瓜', group: '数据工具',
    loginUrl: 'https://www.qian-gua.com/', homeUrl: 'https://www.qian-gua.com/',
    authCookies: ['User', 'UserId'],
    needLogin: true, dataWant: '小红书笔记数据（免费版常无权限）',
  },
];

module.exports = { PLATFORMS };
