# Git 快照引擎

时间旅行之所以可行，是因为 Chronicle 把 **Git 历史当作代码状态的唯一真相来源**。`server/git.js` 通过将消息的时间戳匹配到一次提交、并从中读取文件，来重建「这条消息发生时代码长什么样」——只读，通过 shell 调用 `git`，绝不使用单独的快照存储，也绝不使用当前磁盘。

本页涵盖该引擎的各个函数、一条被选中的消息如何变成一份渲染出来的快照或差异，以及代码替你处理的两个边界情形：合并提交，以及早于仓库首次提交的时间戳。

## 天生只读

每个函数都经过同一个辅助函数，它用 `execFileSync` 在项目目录里运行 `git`：

```js
// server/git.js
function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}
```

没有 libgit2，没有进程内的 git 实现。由此得出两个后果，两者都是刻意为之：

- **它使用开发者本已拥有的那个 `git`** —— 同一个版本、同一份配置、他们信任的同一套子模块设置——而不是重新实现底层管道。
- **它在结构上就是只读的。** 每一次调用都是一次查询（`rev-list`、`ls-tree`、`show`、`diff-tree`、`rev-parse`、`log`）。没有任何东西会检出、重置或写入。查看历史不会扰动工作树，这正是「对外部系统只读」的要义。

## 各个函数

| 函数 | Git 底层管道 | 返回 |
| --- | --- | --- |
| `isGitRepo(dir)` | `rev-parse --is-inside-work-tree` | 布尔值 |
| `repoInfo(dir)` | `rev-list --count HEAD`、`rev-parse --abbrev-ref HEAD` | `{ isRepo, commitCount, branch }` |
| `commitsBetween(dir, from, to)` | `log --all --since --until`（±10 分钟填充） | 用于时间轴刻度的提交（最旧的在前） |
| `commitAt(dir, ts)` | `rev-list -1 --before=ts --all` | 位于 `ts` 处或之前、最接近的提交 |
| `treeAt(dir, commit)` | `ls-tree -r --name-only` | 该提交中的文件路径 |
| `fileAt(dir, commit, file)` | `show commit:file`（+ 上一个版本） | `{ content, previous, prevCommit, changedInCommit }` |
| `changedFiles(dir, commit)` | `diff-tree -m --first-parent` | 该提交中变更的文件 |

其中有两个函数承载着值得点明的设计决策。

**`repoInfo()` 不做缓存。** 它在每一次 `/api/projects` 调用时都运行 `git`。这是刻意的：项目卡片上的 **git 药丸**（分支 + 提交数）由此总是实时且准确的——如果你切换了分支，下一次渲染就会显示出来。反面则是一个已知的暗坑：如果一个 PR 合并后药丸仍显示某个特性分支，那药丸是*对的*，只是工作树仍处在那个分支上。修法是把检出切回 `main`，而不是去动药丸。

**`commitAt()` 挑选位于时间戳处或之前、最接近的那次提交**，并带有一个兜底：

```js
// server/git.js
export function commitAt(dir, ts) {
  if (!isGitRepo(dir)) return null;
  const hash = git(dir, ['rev-list', '-1', `--before=${ts}`, '--all']).trim();
  if (hash) return describeCommit(dir, hash);
  // ts precedes all history → oldest commit, flagged
  const oldest = git(dir, ['rev-list', '--max-parents=0', '--all']).trim().split('\n')[0];
  return oldest ? { ...describeCommit(dir, oldest), beforeHistory: true } : null;
}
```

`--before` 给出的是*在消息被发送的那一刻*就已存在的最近一次提交——即 AI 当时真正看到的代码状态。当一条消息早于仓库的首次提交时（导入的日志来自项目纳入 Git 之前），此刻或之前并无任何提交，于是引擎兜底到**最旧**的那次提交，并置 `beforeHistory: true`，好让 UI 能说「这早于任何一次提交」。

`commitsBetween()` 会把范围**上下各填充 10 分钟**，好让会话边缘附近的时间轴刻度仍能显示夹住它的那些提交，而不至于把一个在最后一条消息之后一分钟才落地的提交裁掉。

## 从消息到快照

时间旅行的数据流，从头到尾：

```
select a message
   │  (message.ts)
   ▼
commitAt(dir, ts)        → nearest commit at-or-before the timestamp
   │
   ├─▶ treeAt(dir, hash)              → the file list at that commit  (file tree)
   │
   └─▶ fileAt(dir, hash, file)        → content at that commit
                                        + previous committed version   (diff view)
                                        + changedInCommit flag          (badge/highlight)
```

API 把这一切暴露为 `GET /api/git/at`（把时间戳解析为一次提交）、`GET /api/git/tree`（那棵树）和 `GET /api/git/file`（一个文件外加它的上一个版本）。UI 渲染那棵树，并对一个变更过的文件，把 `previous` → `content` 展示为并排差异。`fileAt()` 用 `rev-list -1 <commit>~1 -- <file>`——即在此之前最后一次触及该文件的提交——来找到上一个版本，因此差异是针对真正的先前状态，而不是针对紧邻的上一次提交（后者可能压根没改过那个文件）。

因为状态总是从历史重建，快照忠实于**那一时刻被提交了什么**——而不是磁盘上现在有什么，也不是 Chronicle 拍下的某张快照。这个权衡是诚实的，值得在文档里写明：**保真度随提交频率变化。** 两次提交之间未提交的工作对引擎不可见；提交越频繁，时间旅行的粒度就越细。对子模块的支持程度，取决于底层 `git` 能在多大程度上解析它们。

## 合并提交

合并提交是天真的 `diff-tree` 会说谎的唯一场合。针对一次合并，采用默认选项的 `diff-tree` 会产出一个*空*差异，这会让一次合并看起来什么都没改。`fileAt()` 和 `changedFiles()` 都传入 `-m --first-parent`，使差异针对第一父提交——即合并之前的主线——来计算，于是变更文件列表就出来正确了：

```js
git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r',
          '-m', '--first-parent', commit]);
```

这在所有要紧的地方都已处理妥当；这条备注放在此处，是为了让将来对差异逻辑的改动，不会悄悄地把空的合并差异重新引入。

## 相关

- [时间旅行](../guide/time-travel.md) —— 这些函数所驱动的回放体验（快照、差异、时间轴）。
- [API 参考](api-reference.md) —— `/api/git/*` 路由及其参数。
- [架构总览](overview.md) —— git 引擎所处的位置，以及「Git 是真相来源」这条原则。
