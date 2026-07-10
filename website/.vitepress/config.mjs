import { defineConfig } from 'vitepress';

const GH = 'https://github.com/chizhangucb/chronicle';

// The docs are served under /docs on getchronicle.dev; the site root (/) is the
// static download landing page (../index.html), combined at build time by
// scripts/assemble.mjs. Hence base '/docs/' and srcDir 'docs'.
export default defineConfig({
  title: 'Chronicle',
  description: 'A local-first time machine for AI coding sessions — replay, control, and secure your Claude Code, Codex, Cursor, OpenCode, Gemini, and Copilot sessions.',
  lang: 'en-US',
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
    ['meta', { property: 'og:description', content: 'Documentation for Chronicle — a local-first time machine for AI coding sessions.' }],
  ],

  themeConfig: {
    siteTitle: 'Chronicle Docs',

    nav: [
      { text: 'Home', link: 'https://getchronicle.dev' },
      { text: 'Guide', link: '/guide/quickstart', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/keyboard-shortcuts', activeMatch: '/reference/' },
      { text: 'Architecture', link: '/architecture/overview', activeMatch: '/architecture/' },
      { text: 'Changelog', link: '/changelog' },
    ],

    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Importing sessions', link: '/guide/importing-sessions' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Time travel', link: '/guide/time-travel' },
          { text: 'Search & filtering', link: '/guide/search-and-filtering' },
          { text: 'Session insights', link: '/guide/session-insights' },
          { text: 'Refine mode', link: '/guide/refine-mode' },
          { text: 'Replay mode', link: '/guide/replay-mode' },
          { text: 'Project management', link: '/guide/project-management' },
          { text: 'Context causality', link: '/guide/context-causality' },
          { text: 'Live streaming', link: '/guide/live-streaming' },
          { text: 'MCP Hub', link: '/guide/mcp-hub' },
          { text: 'Skills Hub', link: '/guide/skills-hub' },
          { text: 'Security & sharing', link: '/guide/security-and-sharing' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Keyboard shortcuts', link: '/reference/keyboard-shortcuts' },
          { text: 'Compatibility', link: '/reference/compatibility' },
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Privacy & data', link: '/reference/privacy-and-data' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture/overview' },
          { text: 'Data model', link: '/architecture/data-model' },
          { text: 'Parsers & ingestion', link: '/architecture/parsers-and-ingestion' },
          { text: 'Git snapshot engine', link: '/architecture/git-snapshot-engine' },
          { text: 'MCP & Skills internals', link: '/architecture/mcp-and-skills-internals' },
          { text: 'Security, live & replay', link: '/architecture/security-live-replay' },
          { text: 'API reference', link: '/architecture/api-reference' },
          { text: 'Desktop & packaging', link: '/architecture/desktop-packaging' },
        ],
      },
      {
        text: 'More',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Docs home', link: '/' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],

    search: { provider: 'local' },

    socialLinks: [{ icon: 'github', link: GH }],

    editLink: {
      pattern: `${GH}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: '© 2026 Chi Zhang · Local-first, no cloud, no LLM calls.',
    },
  },
});
