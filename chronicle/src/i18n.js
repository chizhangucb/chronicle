// Lightweight i18n (NFR-9): dictionary lookup with English fallback.
// Language persists in localStorage; toggling reloads to re-render everything.

const zh = {
  'AI Session Time Machine': 'AI 会话时光机',
  'Projects': '项目',
  'MCP Hub': 'MCP 中心',
  'Skills': '技能',
  'Security': '安全',
  '+ Import Sessions': '+ 导入会话',
  'Welcome to Chronicle': '欢迎使用 Chronicle',
  'Import your first project': '导入第一个项目',
  'Sessions': '会话',
  'Messages': '消息',
  'Active days': '活跃天数',
  'Tool call distribution': '工具调用分布',
  'Activity': '活动',
  'Playback': '回放',
  'Refine': '精炼',
  'Replay': '重放',
  'Security Check': '安全检查',
  'Conversation': '对话',
  'Tool': '工具',
  'Thinking': '思考',
  'Clear filter': '清除筛选',
  'Search messages…  ⌘F': '搜索消息…  ⌘F',
  'Import sessions': '导入会话',
  'Import': '导入',
  'Re-import': '重新导入',
  'Loading…': '加载中…',
  'Rename': '重命名',
  'Services': '服务',
  'Config takeover': '配置接管',
  'Inspector': '检查器',
  'Library': '技能库',
  'Scan & import': '扫描并导入',
  'Search skills…': '搜索技能…',
  'Interception records': '拦截记录',
  'Share management': '分享管理',
  'Real-time protection setup': '实时防护设置',
  'Export Markdown': '导出 Markdown',
  'Export as Prompt': '导出为提示词',
  'Export redacted copy': '导出脱敏副本',
  'Create share link': '创建分享链接',
  'Enabled': '已启用',
  'Disabled': '已禁用',
  'No messages match the current filter.': '没有匹配当前筛选的消息。',
};

export function lang() {
  return localStorage.getItem('chronicle-lang') || 'en';
}

export function t(s) {
  return lang() === 'zh' ? (zh[s] ?? s) : s;
}

export function toggleLang() {
  localStorage.setItem('chronicle-lang', lang() === 'en' ? 'zh' : 'en');
  location.reload();
}
