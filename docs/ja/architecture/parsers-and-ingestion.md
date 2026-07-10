# パーサーとインジェスト

インジェストは、6 つの異なるツールの固有ログを 1 つの正規化イベントストリームに変換します。処理は 2 つのフェーズ — **スキャン**（インポート可能なものを一覧する）と**インポート**（選択されたログをパースして書き込む） — で実行され、ソースログやプロジェクトリポジトリに書き込むことは決してありません。

このページでは、スキャン → インポートのパイプライン、各パーサーが隠すツールごとの癖（SQLite の WAL コピー、cwd の解決、Claude Code のノイズフィルター）、そして 7 つ目のソースを追加する具体的な手順を説明します。これらのパーサーが出力する行の形状を知りたい場合は、まず [データモデル](data-model.md) を読んでください。

## パイプライン: まずスキャン、次にインポート

各パーサーは `server/parsers/<tool>.js` に置かれ、同じ 2 種類の関数をエクスポートします。

- **`scan<Tool>Projects()`** — 安価で読み取り専用。メッセージ本文をパースせずに、インポート可能なプロジェクトとそのセッションをサイズの見積もり付きで一覧します。インポートウィザードが描画するのはこれです。
- **パース関数** — セッションの固有ログを読み、`{ session, events }` を返します。ここで `events` は [データモデル](data-model.md) で説明した正規化行です。

現在配線されている 6 つのパーサー:

| ツール | ソースキー | ファイル / ディレクトリ（環境変数での上書き） | 形式 | スキャン / パースのエクスポート |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/`（`CLAUDE_PROJECTS_DIR`） | JSONL | `scanClaudeProjects()`、`parseClaudeSession()`（+ `parseClaudeLine()`） |
| Codex | `codex` | `~/.codex/sessions/`（`CODEX_SESSIONS_DIR`） | JSONL | `scanCodexProjects()`、`parseCodexSession()` |
| Cursor | `cursor` | workspaceStorage（`cursorUserDir()`、`CHRONICLE_CURSOR_DIR`） | SQLite | `scanCursorProjects()`、`parseCursorWorkspace()` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db`（`OPENCODE_DB`） | SQLite | `scanOpencodeProjects()`、`parseOpencodeSessions()` |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/`（`GEMINI_TMP`） | JSON | `scanGeminiProjects()`、`parseGeminiProject()` |
| Copilot Chat | `copilot-chat` | VS Code `workspaceStorage/<hash>/chatSessions/`（`vscodeUserDirs()`、`CHRONICLE_VSCODE_DIR`） | JSON | `scanCopilotProjects()`、`parseCopilotWorkspace()` |

`server/api.js` は 6 つすべてにファンアウトします。`GET /api/scan` は各 `scan…Projects()` を呼び出し、どのプロジェクト/セッションがすでにインポート済みかを注釈します。`POST /api/import` は選択されたソースを `gatherParsed()` 経由で適切なパース関数にルーティングし、各 `{ session, events }` を `replaceSession()` に渡します。

```js
// server/api.js — scan fans out to every source
api.get('/scan', (req, res) => {
  res.json({
    'claude-code': annotateScan(scanClaudeProjects()),
    codex:         annotateScan(scanCodexProjects()),
    cursor:        annotateScan(scanCursorProjects()),
    opencode:      annotateScan(scanOpencodeProjects()),
    'gemini-cli':  annotateScan(scanGeminiProjects()),
    'copilot-chat':annotateScan(scanCopilotProjects()),
  });
});
```

同じ `scanners` マップは手動の「ディレクトリを選択」スキャン（`?source=&dir=` を渡す）も支え、`POST /api/projects/:id/sync` はそれを再利用して、あるプロジェクトのパスにマッピングされるすべてのソースの場所を再インポートします。

> **常に読み取り専用。** スキャンとインポートはソースログを読むだけです。インジェストの書き込み側は、Chronicle 自身の `~/.chronicle/chronicle.db` 以外には一切触れません。

## ツールごとの注意点

正規化モデルはツール間の実際の違いを隠します。興味深いエンジニアリングはパーサーの中にあります。

### Claude Code JSONL — ノイズをフィルターする

`server/parsers/claudeCode.js` の `parseClaudeLine()` は意図的により好みが激しく作られています。生のままインポートすると機械的な雑音で埋まってしまうからです。

- **`isSidechain` エントリをスキップ。** サブエージェントのターンは別のコンテキストであり、含めるとメインスレッドを汚染します。
- **`<command-name>` / `<local-command…>` のユーザー文字列をスキップ** — スラッシュコマンドの足場であり、本物のプロンプトではありません。
- **`<system-reminder>` のテキストブロックをスキップ** — 注入されたコンテキストであり、会話ではありません。
- **`tool_use` / `tool_result` を id でペアにする。** `tool_result` ブロックは `tool_use_id` を持ち、その呼び出しを行った `tool_use` に対応づけられます。

セッションの自動タイトルは `{"type":"custom-title","customTitle":…}` の行から来ます — `/rename` のタイトルであり、**最後のものが勝ちます**（セッションは何度でもリネームできます）。それが `sessions.summary` になります。実際のログには実質的に `type:"summary"` の行が存在しないため、`custom-title` が唯一の自動タイトルのソースです（レガシーの `summary` 行はフォールバックとしてのみ残されています）。同じパースパスは、モデルごとのトークン使用量と `message.usage` からの実際の `context_tokens` も集計します。

### Cursor と OpenCode — WAL をコピーし、ライブでは決して開かない

どちらもチャットを SQLite データベースに保存しており、実行中のエディターがまだ書き込んでいる可能性があります。Chronicle は開く前に、DB を **`-wal` および `-shm` のサイドカーファイルも含めて**一時ディレクトリにコピーし、読み取り専用で開きます。

```js
// server/parsers/opencode.js — copy sidecars or you get an EMPTY database
fs.copyFileSync(dbPath, copy);
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
}
```

これが回避する巧妙なバグ: WAL モードでは最新の書き込みは `.db` ではなく `-wal` ファイルに存在します。`.db` だけをコピーすると、最近の（時にはすべての）行が欠けたスナップショットを開いてしまいます。サイドカーもコピーすることで、ライブデータベースに触れることも（ロックすることも）なく、一貫した特定時点の読み取りが得られます。

### Gemini CLI — 仮想パスと「関連付けが必要」

Gemini のログは作業ディレクトリを記録しないため、プロジェクトのキーにできる物理的な `cwd` がありません。`scanGeminiProjects()` は仮想パス `gemini-project:<hash>` を割り当て、そのプロジェクトに `needsAssociation: true` のフラグを立てます。UI は**「関連付けが必要（Needs association）」**のバナーを表示します。関連付け（`POST /api/projects/:id/associate`）を行うと、パスの一致に基づいて仮想プロジェクトが実プロジェクトにマージされ、そのセッションが同じディレクトリで他ツールの作業と並んで表示されます。

### cwd の解決 — 最新が勝ち、祖先へ畳み込む

論理プロジェクトはログ内の物理的な `cwd` をキーにしますが、単一のセッションが複数の cwd を記録することがあります。2 つのルールでこれらを整合させます。

- **最新の `cwd` が勝つ。** リポジトリの移動後に再開されたセッションは、初期の記録に*古い*パスを保持しています。最新の cwd こそ、リポジトリ（とその Git 履歴）が現在存在する場所です。スキャナーは各 JSONL ファイルの**先頭と末尾の 64 KB** を嗅ぎ回って安価にそれを見つけ、パーサーは最後に見た cwd を追跡します。
- **`reduceCwd()` はサブディレクトリを畳み込む。** あるセッションが `<repo>/server` と `<repo>` の両方を記録した場合、グルーピングはリポジトリのルートに落ち着くべきです。`reduceCwd(pick, seen)` は、あるプロジェクトのすべてのセッションが一緒にグルーピングされるよう、最も短い既知の祖先まで遡ります。

## HOWTO: 新しいソースを追加する

7 つ目のツールを追加するのは、自己完結した 4 ステップの変更です。`newtool` というツールを追加するとしましょう。

**1. `server/parsers/newtool.js` を書く。** 2 つの関数をエクスポートします。

```js
// scan<Tool>Projects() — cheap listing for the import wizard
export function scanNewtoolProjects(baseDir = NEWTOOL_DIR) {
  // return [{ source: 'newtool', name, physicalPath, sessionCount,
  //           messageEstimate, sessions: [{ id, file, label, modifiedAt, messageEstimate }] }]
}

// parse fn → { session, events } where each event is a normalized row:
//   { ts, kind, text?, tool_name?, tool_input?, tool_use_id?, uuid?, model? }
// kind ∈ user | assistant | thinking | tool_use | tool_result
export async function parseNewtoolSession(file) {
  return {
    session: { id, source: 'newtool', file_path: file, cwd,
               started_at, ended_at, first_prompt, summary, context_tokens, usage },
    events,
  };
}
```

セッションに `cwd` を設定して物理プロジェクトにキーづけられるようにします（または仮想の `newtool-project:<hash>` パスを返し、Gemini のように `needsAssociation` を設定します）。ソースが WAL SQLite DB の場合は、Cursor/OpenCode とまったく同じように `-wal`/`-shm` のサイドカーを一時ディレクトリにコピーします — ライブファイルを決して開かないでください。

**2. `server/api.js` に配線する。** 2 つの関数を import し、`newtool` を `scanners` マップと `GET /scan` のレスポンスに追加し、`POST /import` があなたのパース関数にルーティングされるよう `gatherParsed()` にブランチを追加します。（`sync` および セッション単位の sync マップに追加すれば、Sync Update が自動的に手に入ります。）

**3. `src/ImportWizard.jsx` の `SOURCES` に追加する** ことで、ウィザードのタイルとして表示されます。

```js
{ key: 'newtool', label: 'New Tool', hint: '~/.newtool/…', icon: '◆' }
```

`key` は `/api/scan` で使用したソースキーと一致する必要があります。

**4. フィクスチャで検証し、次に実データで検証する。** 小さなサンプルログを `test/fixtures/` に置き（リポジトリにはすでに `codex-sessions/`、`cursor-user/`、`gemini-tmp/`、`oc-live.db`、`vscode-user/` があります）、スキャンがそれを一覧し、インポートが妥当な正規化行を生成することを確認します。次にエンドツーエンドで実行します。実際のセッションをインポートし、開き、その中をタイムトラベルします。最速の完全チェックは、Chronicle 自身の Claude Code セッションをインポートしてあちこちクリックしてみることです。

これで対象範囲はすべてです。すべてのモードが同じ Express アプリを配信するため、`/api/scan` と `/api/import` に配線されたパーサーは、追加の配管なしで dev・desktop・standalone で動作します。

## 関連ページ
- [データモデル](data-model.md) — あなたのパーサーが出力すべき正規化イベント行と `kind` ラベル。
- [互換性](../reference/compatibility.md) — 6 ツールの完全なマトリクスとログの場所。
- [コントリビューション](../contributing.md) — セットアップ、ワークフロー、検証の習慣。
