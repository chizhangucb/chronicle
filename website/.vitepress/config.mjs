import { defineConfig } from 'vitepress';

const GH = 'https://github.com/chizhangucb/chronicle';

// Per-locale labels for the nav + sidebar. Product/proper nouns stay in English.
const L = {
  en: {
    getStarted: 'Get started', features: 'Features', reference: 'Reference',
    architecture: 'Architecture', more: 'More',
    quickstart: 'Quickstart', installation: 'Installation', importing: 'Importing sessions',
    timeTravel: 'Time travel', search: 'Search & filtering', insights: 'Session insights',
    refine: 'Refine mode', replay: 'Replay mode', projects: 'Project management',
    causality: 'Context causality', live: 'Live streaming', mcp: 'MCP Hub',
    skills: 'Skills Hub', security: 'Security & sharing',
    shortcuts: 'Keyboard shortcuts', compat: 'Compatibility', config: 'Configuration',
    privacy: 'Privacy & data',
    overview: 'Overview', dataModel: 'Data model', parsers: 'Parsers & ingestion',
    gitEngine: 'Git snapshot engine', mcpInternals: 'MCP & Skills internals',
    secInternals: 'Security, live & replay', api: 'API reference', desktop: 'Desktop & packaging',
    changelog: 'Changelog', docsHome: 'Docs home', contributing: 'Contributing',
    navHome: 'Home', navGuide: 'Guide', navRef: 'Reference', navArch: 'Architecture', navChangelog: 'Changelog',
  },
  zh: {
    getStarted: '快速上手', features: '功能', reference: '参考',
    architecture: '架构', more: '更多',
    quickstart: '快速开始', installation: '安装', importing: '导入会话',
    timeTravel: '时间旅行', search: '搜索与筛选', insights: '会话洞察',
    refine: '精炼模式', replay: '回放模式', projects: '项目管理',
    causality: '上下文因果', live: '实时流式', mcp: 'MCP Hub',
    skills: 'Skills Hub', security: '安全与分享',
    shortcuts: '键盘快捷键', compat: '兼容性', config: '配置',
    privacy: '隐私与数据',
    overview: '概览', dataModel: '数据模型', parsers: '解析器与导入',
    gitEngine: 'Git 快照引擎', mcpInternals: 'MCP 与 Skills 内部原理',
    secInternals: '安全、实时与回放', api: 'API 参考', desktop: '桌面端与打包',
    changelog: '更新日志', docsHome: '文档首页', contributing: '贡献指南',
    navHome: '首页', navGuide: '指南', navRef: '参考', navArch: '架构', navChangelog: '更新日志',
  },
  ja: {
    getStarted: 'はじめに', features: '機能', reference: 'リファレンス',
    architecture: 'アーキテクチャ', more: 'その他',
    quickstart: 'クイックスタート', installation: 'インストール', importing: 'セッションのインポート',
    timeTravel: 'タイムトラベル', search: '検索とフィルタ', insights: 'セッション分析',
    refine: 'リファインモード', replay: 'リプレイモード', projects: 'プロジェクト管理',
    causality: 'コンテキスト因果', live: 'ライブストリーミング', mcp: 'MCP Hub',
    skills: 'Skills Hub', security: 'セキュリティと共有',
    shortcuts: 'キーボードショートカット', compat: '互換性', config: '設定',
    privacy: 'プライバシーとデータ',
    overview: '概要', dataModel: 'データモデル', parsers: 'パーサーとインジェスト',
    gitEngine: 'Git スナップショットエンジン', mcpInternals: 'MCP と Skills の内部構造',
    secInternals: 'セキュリティ・ライブ・リプレイ', api: 'API リファレンス', desktop: 'デスクトップとパッケージング',
    changelog: '変更履歴', docsHome: 'ドキュメントホーム', contributing: 'コントリビュート',
    navHome: 'ホーム', navGuide: 'ガイド', navRef: 'リファレンス', navArch: 'アーキテクチャ', navChangelog: '変更履歴',
  },
};

// p = locale path prefix ('' for English root, '/zh', '/ja'). Links are srcDir-relative;
// VitePress prepends base ('/docs/') automatically.
const sidebar = (p, t) => [
  { text: t.getStarted, items: [
    { text: t.quickstart, link: `${p}/guide/quickstart` },
    { text: t.installation, link: `${p}/guide/installation` },
    { text: t.importing, link: `${p}/guide/importing-sessions` },
  ] },
  { text: t.features, items: [
    { text: t.timeTravel, link: `${p}/guide/time-travel` },
    { text: t.search, link: `${p}/guide/search-and-filtering` },
    { text: t.insights, link: `${p}/guide/session-insights` },
    { text: t.refine, link: `${p}/guide/refine-mode` },
    { text: t.replay, link: `${p}/guide/replay-mode` },
    { text: t.projects, link: `${p}/guide/project-management` },
    { text: t.causality, link: `${p}/guide/context-causality` },
    { text: t.live, link: `${p}/guide/live-streaming` },
    { text: t.mcp, link: `${p}/guide/mcp-hub` },
    { text: t.skills, link: `${p}/guide/skills-hub` },
    { text: t.security, link: `${p}/guide/security-and-sharing` },
  ] },
  { text: t.reference, items: [
    { text: t.shortcuts, link: `${p}/reference/keyboard-shortcuts` },
    { text: t.compat, link: `${p}/reference/compatibility` },
    { text: t.config, link: `${p}/reference/configuration` },
    { text: t.privacy, link: `${p}/reference/privacy-and-data` },
  ] },
  { text: t.architecture, items: [
    { text: t.overview, link: `${p}/architecture/overview` },
    { text: t.dataModel, link: `${p}/architecture/data-model` },
    { text: t.parsers, link: `${p}/architecture/parsers-and-ingestion` },
    { text: t.gitEngine, link: `${p}/architecture/git-snapshot-engine` },
    { text: t.mcpInternals, link: `${p}/architecture/mcp-and-skills-internals` },
    { text: t.secInternals, link: `${p}/architecture/security-live-replay` },
    { text: t.api, link: `${p}/architecture/api-reference` },
    { text: t.desktop, link: `${p}/architecture/desktop-packaging` },
  ] },
  { text: t.more, items: [
    { text: t.changelog, link: `${p}/changelog` },
    { text: t.docsHome, link: `${p}/` },
    { text: t.contributing, link: `${p}/contributing` },
  ] },
];

const nav = (p, t) => [
  { text: t.navHome, link: 'https://getchronicle.dev' },
  { text: t.navGuide, link: `${p}/guide/quickstart`, activeMatch: `${p}/guide/` },
  { text: t.navRef, link: `${p}/reference/keyboard-shortcuts`, activeMatch: `${p}/reference/` },
  { text: t.navArch, link: `${p}/architecture/overview`, activeMatch: `${p}/architecture/` },
  { text: t.navChangelog, link: `${p}/changelog` },
];

export default defineConfig({
  title: 'Chronicle',
  description: 'A local-first time machine for AI coding sessions.',
  base: '/docs/',
  srcDir: 'docs',
  appearance: 'dark',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  head: [
    ['meta', { name: 'theme-color', content: '#0e1116' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Chronicle Docs' }],
  ],

  // Shared theme config; nav/sidebar are set per-locale below.
  themeConfig: {
    siteTitle: 'Chronicle Docs',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: GH }],
    editLink: { pattern: `${GH}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: { message: 'Released under the MIT License.', copyright: '© 2026 Chi Zhang · Local-first, no cloud, no LLM calls.' },
  },

  locales: {
    root: {
      label: 'English', lang: 'en-US',
      themeConfig: { nav: nav('', L.en), sidebar: sidebar('', L.en) },
    },
    zh: {
      label: '简体中文', lang: 'zh-Hans', link: '/zh/',
      themeConfig: {
        nav: nav('/zh', L.zh), sidebar: sidebar('/zh', L.zh),
        outline: { label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '主题', lightModeSwitchTitle: '切换到浅色模式', darkModeSwitchTitle: '切换到深色模式',
        sidebarMenuLabel: '菜单', returnToTopLabel: '返回顶部', langMenuLabel: '切换语言',
        lastUpdated: { text: '最后更新' },
        editLink: { pattern: `${GH}/edit/main/docs/:path`, text: '在 GitHub 上编辑此页' },
      },
    },
    ja: {
      label: '日本語', lang: 'ja', link: '/ja/',
      themeConfig: {
        nav: nav('/ja', L.ja), sidebar: sidebar('/ja', L.ja),
        outline: { label: 'このページの内容' },
        docFooter: { prev: '前へ', next: '次へ' },
        darkModeSwitchLabel: 'テーマ', lightModeSwitchTitle: 'ライトモードに切り替え', darkModeSwitchTitle: 'ダークモードに切り替え',
        sidebarMenuLabel: 'メニュー', returnToTopLabel: 'トップへ戻る', langMenuLabel: '言語',
        lastUpdated: { text: '最終更新' },
        editLink: { pattern: `${GH}/edit/main/docs/:path`, text: 'GitHub でこのページを編集' },
      },
    },
  },
});
