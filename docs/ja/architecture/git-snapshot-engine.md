# Git スナップショットエンジン

タイムトラベルが機能するのは、Chronicle が **Git 履歴をコードの状態についての信頼できる唯一の情報源**として扱うからです。`server/git.js` は、メッセージのタイムスタンプをコミットに対応づけ、そのコミットからファイルを読み出すことで「このメッセージの時点でコードはどう見えていたか」を再構築します — 読み取り専用で、`git` を呼び出し、別のスナップショットストアも現在のディスクも使いません。

このページでは、エンジンの関数群、選択したメッセージがどのようにレンダリング済みのスナップショットや差分になるか、そしてコードが処理してくれるおかげであなたが気にせずに済む 2 つのエッジケース — マージコミットと、リポジトリの最初のコミット以前のタイムスタンプ — を扱います。

## 構造的に読み取り専用

すべての関数は、プロジェクトディレクトリで `execFileSync` を使って `git` を実行する 1 つのヘルパーを経由します。

```js
// server/git.js
function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}
```

libgit2 もなく、プロセス内の git 実装もありません。ここから 2 つの帰結が導かれ、どちらも意図的なものです。

- **開発者がすでに持っている `git` をそのまま使う** — 彼らが信頼している、同じバージョン・同じ設定・同じサブモジュール構成 — plumbing を再実装するのではなく。
- **構造的に読み取り専用である。** すべての呼び出しはクエリ（`rev-list`、`ls-tree`、`show`、`diff-tree`、`rev-parse`、`log`）です。チェックアウトも reset も書き込みもしません。履歴を閲覧してもワーキングツリーを乱すことはできず、これが「外部システムに対して読み取り専用」の要点です。

## 関数群

| 関数 | Git plumbing | 戻り値 |
| --- | --- | --- |
| `isGitRepo(dir)` | `rev-parse --is-inside-work-tree` | boolean |
| `repoInfo(dir)` | `rev-list --count HEAD`、`rev-parse --abbrev-ref HEAD` | `{ isRepo, commitCount, branch }` |
| `commitsBetween(dir, from, to)` | `log --all --since --until`（±10 分パディング） | タイムラインの目盛り用コミット（古い順） |
| `commitAt(dir, ts)` | `rev-list -1 --before=ts --all` | `ts` 以前で最も近いコミット |
| `treeAt(dir, commit)` | `ls-tree -r --name-only` | そのコミットのファイルパス |
| `fileAt(dir, commit, file)` | `show commit:file`（+ 以前のバージョン） | `{ content, previous, prevCommit, changedInCommit }` |
| `changedFiles(dir, commit)` | `diff-tree -m --first-parent` | そのコミットで変更されたファイル |

このうち 2 つには、特筆すべき設計判断があります。

**`repoInfo()` はキャッシュしません。** `/api/projects` の呼び出しごとに `git` を実行します。これは意図的です。プロジェクトカードの **git ピル**（ブランチ + コミット数）が常にライブで正確になるからです — ブランチを切り替えれば、次のレンダリングでそれが表示されます。裏を返せば既知の落とし穴でもあります。PR がマージされた後にピルがフィーチャーブランチを表示している場合、ピルは*正しく*、ワーキングツリーが単にまだそのブランチ上にあるだけです。修正はピルをいじることではなく、チェックアウトを `main` に戻すことです。

**`commitAt()` はタイムスタンプ以前で最も近いコミットを選びます**が、フォールバックがあります。

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

`--before` は*メッセージが送信された瞬間に存在していた*最新のコミット — AI が実際に見ていたコードの状態 — を返します。あるメッセージがリポジトリの最初のコミットより前である場合（プロジェクトが Git 管理下に入る前からインポートされたログ）、それ以前には何もないため、エンジンは**最も古い**コミットにフォールバックし、UI が「これはどのコミットよりも前です」と表示できるよう `beforeHistory: true` を設定します。

`commitsBetween()` は**範囲を ±10 分パディングします**。これにより、セッションの端付近にあるタイムラインの目盛りでも、そのセッションを挟むコミットを表示できます。最後のメッセージの 1 分後に着地したコミットを切り落とすことはありません。

## メッセージからスナップショットへ

タイムトラベルのデータフローを端から端まで示します。

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

API はこれを `GET /api/git/at`（タイムスタンプをコミットに解決）、`GET /api/git/tree`（ツリー）、`GET /api/git/file`（ファイルとその以前のバージョン）として公開します。UI はツリーを描画し、変更されたファイルについては `previous` → `content` の左右並列差分を表示します。`fileAt()` は `rev-list -1 <commit>~1 -- <file>` で以前のバージョンを見つけます — このコミットより前にそのファイルに触れた最後のコミットです — そのため差分は、そのファイルをまったく変更していないかもしれない直前のコミットに対してではなく、実際の以前の状態に対して取られます。

状態は常に履歴から再構築されるため、スナップショットは**その時点でコミットされていたもの**に忠実です — 現在ディスク上にあるものにでも、Chronicle が取ったスナップショットにでもありません。このトレードオフは正直なもので、ドキュメントで明言する価値があります。すなわち、**忠実度はコミット頻度に追随します。** 2 つのコミットの間の未コミットの作業はエンジンからは見えず、コミットが頻繁であるほどタイムトラベルの粒度が細かくなります。サブモジュールは、基盤となる `git` が解決する範囲でサポートされます。

## マージコミット

マージコミットは、素朴な `diff-tree` が嘘をつく唯一の場所です。マージに対して、デフォルトオプションの `diff-tree` は*空の*差分を生成し、これはマージが何も変更していないように見せてしまいます。`fileAt()` と `changedFiles()` はどちらも `-m --first-parent` を渡し、差分が第 1 親 — マージ前のメインライン — に対して計算されるようにするため、変更ファイルのリストが正しく出力されます。

```js
git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r',
          '-m', '--first-parent', commit]);
```

これは重要なところではすでにすべて処理済みです。この注記がここにあるのは、将来の差分ロジックの変更が、空のマージ差分をこっそり再導入しないようにするためです。

## 関連ページ
- [タイムトラベル](../guide/time-travel.md) — これらの関数が支える Playback 体験（スナップショット、差分、タイムライン）。
- [API リファレンス](api-reference.md) — `/api/git/*` ルートとそのパラメータ。
- [アーキテクチャ概要](overview.md) — git エンジンの位置づけと、「Git が信頼できる唯一の情報源」の原則。
