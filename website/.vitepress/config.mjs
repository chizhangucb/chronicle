import { defineConfig } from 'vitepress';

const GH = 'https://github.com/chizhangucb/chronicle';

const sidebar = [
  { text: 'Get started', items: [
    { text: 'Quickstart', link: '/guide/quickstart' },
    { text: 'Installation', link: '/guide/installation' },
  ] },
  { text: 'Reference', items: [
    { text: 'Supported tools', link: '/reference/supported-tools' },
    { text: 'Privacy & data', link: '/reference/privacy-and-data' },
  ] },
  { text: 'Architecture', items: [
    { text: 'How it works', link: '/architecture/how-it-works' },
  ] },
  { text: 'More', items: [
    { text: 'Changelog', link: '/changelog' },
    { text: 'Docs home', link: '/' },
    { text: 'Contributing', link: '/contributing' },
  ] },
];

const nav = [
  { text: 'Home', link: 'https://getchronicle.dev' },
  { text: 'Guide', link: '/guide/quickstart', activeMatch: '/guide/' },
  { text: 'Reference', link: '/reference/supported-tools', activeMatch: '/reference/' },
  { text: 'Architecture', link: '/architecture/how-it-works', activeMatch: '/architecture/' },
  { text: 'Changelog', link: '/changelog' },
];

export default defineConfig({
  title: 'Chronicle',
  description: 'A local-first session manager and Insights analytics console for AI coding sessions.',
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

  themeConfig: {
    siteTitle: 'Chronicle Docs',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: GH }],
    editLink: { pattern: `${GH}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: { message: 'Released under the Apache License 2.0.', copyright: '© 2026 Chi Zhang · Local-first, no cloud, no LLM calls.' },
    nav,
    sidebar,
  },
});
