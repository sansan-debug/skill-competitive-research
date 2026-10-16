/**
 * 研究目标配置 —— 整个 skill 唯一需要按项目修改的文件
 *
 * 所有 scraper 都从这里读参数，不在脚本里硬编码品牌名。
 * 复制这个文件为 config.local.js 后修改，或将本文件直接改掉。
 */

module.exports = {
  /** 研究对象 */
  target: {
    name: 'ExampleProduct',
    /** 主域名（用于 SimilarWeb / sitemap / 外链归因） */
    domains: ['example.com'],
    /** 品牌词的写法变体（用于 Trends、搜索、正文匹配去重） */
    aliases: ['exampleproduct', 'example product', 'example app'],
    /** 品类词（用于「品牌词 vs 品类词」对照，见 references/verification-criteria.md） */
    category: 'example category term',
    /** 竞品词（用于对照曲线） */
    competitors: ['competitor1', 'competitor2'],
    /** 官方账号（用于第一方归因：账号名 = 品牌/创始人） */
    handles: {
      x: '@exampleapp',
      youtube: '@ExampleApp',
      github: 'example-org',
      douyin: 'exampleapp',
    },
  },

  /** 取数输出目录（相对 scripts/） */
  outDir: process.env.CR_OUT_DIR || 'out',

  /** 本地面板端口（可用环境变量或 --port 覆盖，避免与已有进程撞端口） */
  port: +(process.env.CR_PORT || 8899),

  /** 浏览器 profile 目录：登录一次后长期复用 */
  profileDir: process.env.CR_PROFILE_DIR || '~/.workbuddy-ai/browser-profiles/competitive-research',

  /**
   * 可选：显式指定 Chromium 可执行文件。
   * 留空则自动探测（Playwright 缓存目录 / 系统 Chrome / Chrome for Testing）。
   */
  chromeBin: '',

  /** 抓取默认参数：改大更稳，改小更快 */
  defaults: {
    /** 页面加载后的固定等待（毫秒）。数据站多为 SPA，等待不足会静默取空 */
    wait: 6000,
    /** 滚动次数，用于触发懒加载 */
    scroll: 3,
    /** 单次 harvest 的 HTTP 响应里 text 字段截断长度；完整结果始终落盘 */
    responseTextLimit: 12000,
  },
};
