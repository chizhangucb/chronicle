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
  // Import wizard
  'Import Logs': '导入日志',
  'Select Source': '选择来源',
  'Select Files': '选择文件',
  'Importing': '导入中',
  'Complete': '完成',
  'Local': '本地',
  'sessions': '个会话',
  'projects': '个项目',
  'selected': '已选',
  'imported': '已导入',
  'entries': '条记录',
  'messages': '条消息',
  'Imported': '已导入',
  'Partial': '部分',
  'Scanning local sources…': '正在扫描本地来源…',
  'No local AI tool logs found.': '未找到本地 AI 工具日志。',
  "Chronicle scans each tool's standard log location. Importing is read-only — your original logs are never modified.":
    'Chronicle 扫描各工具的标准日志位置。导入是只读的——不会修改你的原始日志。',
  'Rescan': '重新扫描',
  'Rescanning…': '重新扫描中…',
  'Select Directory Manually': '手动选择目录',
  'Search projects or sessions': '搜索项目或会话',
  'Absolute path to a log directory…': '日志目录的绝对路径…',
  'Scan': '扫描',
  'No importable sessions found in that directory': '该目录中未找到可导入的会话',
  'No projects match.': '没有匹配的项目。',
  'Select All New': '全选新增',
  'Clear': '清除',
  'Invert': '反选',
  'Back': '返回',
  'Start Import': '开始导入',
  'Import Complete': '导入完成',
  'All selected sessions were imported successfully': '所有选中的会话均已成功导入',
  'Some files failed to import, please check the error messages': '部分文件导入失败，请查看错误信息',
  'Successfully Imported': '成功导入',
  'Import Failed': '导入失败',
  'Just Imported': '刚刚导入',
  'Created new project': '创建了新项目',
  'Updated existing project': '更新了已有项目',
  'The following projects have all empty sessions': '以下项目的会话全部为空',
  'Nothing importable was found in their logs (only noise or empty sessions)': '其日志中没有可导入内容（仅噪音或空会话）',
  'Imported message counts are lower than scan estimates: raw log entries such as subagent chatter, system reminders and command echoes are filtered out.':
    '导入的消息数低于扫描估算值：子代理对话、系统提醒、命令回显等原始日志噪音已被过滤。',
  'Estimated raw log entries — imported message counts are lower after noise filtering':
    '估算的原始日志条数——过滤噪音后实际导入的消息数会更低',
  'Import more': '继续导入',
  'Done': '完成',
  // Project card menu
  'Project options': '项目选项',
  'Sync Update': '同步更新',
  'View Details': '查看详情',
  'Remove from Chronicle': '从 Chronicle 移除',
  "(won't delete source project)": '（不会删除源项目）',
  'Remove': '移除',
  'from Chronicle? Your source logs and project folder are not touched.': '从 Chronicle 移除？不会改动你的源日志和项目文件夹。',
  'New display name (folder is not touched):': '新的显示名称（不改动文件夹）：',
  // Session overview
  'Overview': '总览',
  'Session Statistics': '会话统计',
  'Total Duration': '总时长',
  'Tool Calls': '工具调用',
  'Errors': '错误',
  'Call Timeline': '调用时间线',
  'Tool Distribution': '工具分布',
  'Call Details': '调用详情',
  'events': '个事件',
  'calls': '次调用',
  'Total': '共',
  'No tool calls recorded.': '没有记录到工具调用。',
  'Source file': '源文件',
  'Delete source file': '删除源文件',
  'Confirm delete': '确认删除',
  'Cancel': '取消',
  'Deleting…': '删除中…',
  'Source file deleted.': '源文件已删除。',
  'The imported copy stays in Chronicle.': 'Chronicle 中的导入副本会保留。',
  'Permanently delete the original log file from disk? This cannot be undone. The imported copy stays in Chronicle.':
    '永久删除磁盘上的原始日志文件？此操作不可撤销。Chronicle 中的导入副本会保留。',
  'Delete everywhere': '彻底删除',
  'Delete from Chronicle': '从 Chronicle 删除',
  'Permanently delete the original log file AND the imported copy in Chronicle? This cannot be undone.':
    '永久删除原始日志文件以及 Chronicle 中的导入副本？此操作不可撤销。',
  'Delete the imported copy from Chronicle? The original log stays on disk and can be re-imported later.':
    '从 Chronicle 删除导入副本？原始日志仍保留在磁盘上，之后可以重新导入。',
  'This source keeps all sessions in shared storage — its file cannot be deleted per-session.':
    '该来源的所有会话存放在共享存储中——无法按会话删除文件。',
  'Session is live — deletion is disabled while the log is being written.':
    '会话正在直播——日志写入期间禁止删除。',
};

export function lang() {
  return localStorage.getItem('chronicle-lang') || 'en';
}

export function t(s) {
  return lang() === 'zh' ? (zh[s] ?? s) : s;
}

export function setLang(next) {
  if (next === lang()) return;
  localStorage.setItem('chronicle-lang', next);
  location.reload();
}

export function toggleLang() {
  setLang(lang() === 'en' ? 'zh' : 'en');
}
