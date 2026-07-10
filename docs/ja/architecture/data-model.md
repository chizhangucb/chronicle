# データモデル

Chronicle はすべてを単一のローカル SQLite データベースに格納します — 3 つのテーブル（`projects`、`sessions`、`messages`）です。そして各パーサーは、ツール固有のログを 1 つの正規化されたイベント形状にフラット化するため、UI はセッションがどこから来たのかを気にする必要がありません。

このページでは、データストア（`server/db.js`）、3 つのテーブルとそのマイグレーション用カラム、6 つのパーサーすべてが共有する正規化イベントモデル、そして `replaceSession()` — ユーザーが手で入力する唯一のものを静かに保持する、冪等なインポートトランザクション — を扱います。

## データストア

データベースは `~/.chronicle/chronicle.db` にあり、Node 組み込みの SQLite を通して開かれます。

```js
// server/db.js
import { DatabaseSync } from 'node:sqlite';
const dataDir = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
export const db = new DatabaseSync(path.join(dataDir, 'chronicle.db'));
```

ここでは 2 つの判断が重要です。

- **better-sqlite3 ではなく `node:sqlite`。** Node に同梱されているため、プラットフォームごとにコンパイルや再ビルドが必要なネイティブモジュールがありません。これはツールチェーン不要のビルドにとって必須要件です。データディレクトリは `CHRONICLE_DATA_DIR` で上書きできます（テストや使い捨てのインスタンスに便利です）。
- **スキーマはモジュールロード時に冪等に作成される。** `db.exec()` はモジュールがロードされるたびに完全な `CREATE TABLE IF NOT EXISTS …` ブロックを実行し、スキーマの変更はベストエフォートのマイグレーションとして適用されます。

```js
// Idempotent migrations — safe to run on every boot
try { db.exec('ALTER TABLE sessions ADD COLUMN context_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN name TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN usage TEXT'); } catch {}
```

マイグレーションフレームワークもバージョンテーブルもありません。新しいカラムは `try { ALTER TABLE … } catch {}` の 1 行です。アップグレード後の最初の起動でそれが追加され、以降の起動はすべて `catch` で何もしません。スキーマは小さく、増える一方なので、これで十分です。そして「とにかく実行すれば動く」という性質を保ちます — 忘れがちな別のマイグレーション手順が不要です。

## 3 つのテーブル

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,          -- physical cwd (or a gemini-project:<hash> virtual path)
  name TEXT NOT NULL,                 -- basename(path), shown on the project card
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- the tool's own session id
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,              -- claude-code | codex | cursor | opencode | gemini-cli | copilot-chat
  file_path TEXT NOT NULL,          -- source log this session was parsed from
  started_at TEXT, ended_at TEXT,
  message_count INTEGER DEFAULT 0,
  first_prompt TEXT
  -- migration columns: context_tokens, name, summary, usage
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,             -- 0-based order within the session
  uuid TEXT, ts TEXT,
  kind TEXT NOT NULL,               -- user|assistant|thinking|tool_use|tool_result|note
  text TEXT,
  tool_name TEXT, tool_input TEXT,  -- tool_input is a JSON string
  tool_use_id TEXT,                 -- pairs a tool_use with its tool_result
  model TEXT
);

CREATE INDEX idx_messages_session ON messages(session_id, seq);
CREATE INDEX idx_sessions_project ON sessions(project_id);
```

**`projects`** は `path`（ログに記録された物理的な `cwd`。ツールが cwd を記録しない場合は仮想の `gemini-project:<hash>`）をキーにします。1 つの物理ディレクトリは、何個のツールがそこで作業したかに関わらず、1 つの論理プロジェクトです。`upsertProject(physicalPath)` はユニークな `path` に対して insert-or-ignore を行い、その行を返します。

**`sessions`** は識別情報とサマリのフィールドを保持します。基本カラムは元のスキーマで、4 つの**マイグレーションカラム**は後から追加されました。これがまさに、それらが `CREATE` の一部ではなく `ALTER TABLE` である理由です。

| カラム | 取得元 | マイグレーションである理由 |
| --- | --- | --- |
| `context_tokens` | メインチェーンの最後の API 呼び出しのプロンプト側 | コンテキストウィンドウのバーが出荷された際に追加。**インポート時にのみ設定される** — アップグレード後にバックフィルするには再インポートまたは Sync Update を実行 |
| `name` | Chronicle でユーザーが入力したリネーム | インライン・リネームが出荷された際に追加。このテーブルで唯一ユーザーが作成するフィールド |
| `summary` | パースされたツールのタイトル（Claude Code の `custom-title`、最後のものが勝つ） | 自動タイトルが出荷された際に追加。インポートごとに再導出される |
| `usage` | モデルごとのトークン合計を JSON で | Cost & Usage パネルが出荷された際に追加。インポートごとに再導出される |

`usage` JSON の形状は `{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}` です — 5 分キャッシュ書き込みと 1 時間キャッシュ書き込みは課金レートが異なるため、分けて保持されます（[セッションインサイト](../guide/session-insights.md) を参照）。

**`messages`** はセッション内で `seq` によって順序づけられた正規化イベントストリームです。`(session_id, seq)` インデックスこそが、ウィンドウ化された再生（playback）を安価にするものです。UI は選択箇所の周辺約 400 行をレンダリングするため、6,000 メッセージのセッションを DOM にロードするのではなく、`seq` でスライスします。

## 正規化イベントモデル

各パーサーの仕事は、ツール固有のログを 1 つの形状の行のフラットなリストに変換することです。その形状は、インジェストとその下流のすべて — playback、refine、因果関係、検索、共有 — の間の契約です。これらはすべて同じ行を読みます。

**kind（種別）**:

| `kind` | 意味 | ラベル（`src/kinds.js`） |
| --- | --- | --- |
| `user` | 人間のプロンプト、または挿入されたユーザーのターン | User |
| `assistant` | モデルの文章 | Assistant |
| `thinking` | 拡張思考（extended-thinking）ブロック | Thinking |
| `tool_use` | ツール呼び出し（`tool_name`、`tool_input`、`tool_use_id` を持つ） | Tool Call |
| `tool_result` | ツールの出力（`tool_use_id` を持つ） | Tool Result |
| `note` | Refine で挿入された注釈 | Inserted |

各イベント行は次のうちの一部を埋めます: `ts`、`kind`、`text`、`tool_name`、`tool_input`（JSON *文字列*なので、任意のツールスキーマが 1 カラムに収まる）、`tool_use_id`、`uuid`、`model`。`tool_use_id` は結合キーです。`tool_use` とそれが生んだ `tool_result` は同じ id を持ち、これによって UI は、間に他のメッセージが挟まっていても呼び出しとその出力をペアにできます。

> **ラベルの信頼できる唯一の情報源。** 各 kind の人間可読な名前とアイコンは `src/kinds.js`（`KIND_LABEL` / `KIND_ICON`）にのみ存在します。Playback（`SessionView`）と Refine（`RefineMode`）の両方がそれらを import するため、用語がずれることはありません — 以前のバージョンでは Playback が「You」/「AI」と表示する一方で Refine が「USER」/「ASSISTANT」と表示していました。新しい表現はインラインではなく、必ずそこに置いてください。

モデルが正規化されているため、6 つのツール間の違いは「あるパーサーがどのフィールドを埋めるか」に収束します。Cursor のツール呼び出しと Claude Code のツール呼び出しは、データベースに到達する頃には同じ行になっています — 各ツールがどのようにマッピングされるかは [パーサーとインジェスト](parsers-and-ingestion.md) を参照してください。

## `replaceSession()` — 冪等なインポート

インポートは行ごとの upsert ではありません。**1 つのセッションをトランザクション内でまるごと削除して再挿入する**処理です。同じログを再インポートすると同じ行が生成されるため、Sync Update と再インポートは繰り返し実行しても安全です。

```js
// server/db.js — abridged
export function replaceSession(session, events) {
  db.exec('BEGIN');
  try {
    const prev = db.prepare('SELECT name FROM sessions WHERE id = ?').get(session.id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    db.prepare(`INSERT INTO sessions (..., name, summary, usage) VALUES (..., ?, ?, ?)`)
      .run(/* … */ session.name ?? prev?.name ?? null,
                   session.summary ?? null, session.usage ?? null);
    // reinsert every event with seq = its index
    events.forEach((e, i) => ins.run(session.id, i, /* … */));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
```

巧妙な部分は、トランザクション内の最初の行です。行はこれから削除されるため、素朴に再挿入すればユーザーが入力したリネームが消えてしまいます。そこで `replaceSession` は**まず `prev.name` を読み、それにフォールバックします**（`session.name ?? prev?.name ?? null`）。結果は次のとおりです。

- **`name` は再インポートを生き延びる** — Chronicle のリネームはユーザーが作成したものであり、ログを再パースすることで上書きされてはなりません。
- **`summary`、`usage`、`context_tokens` はインポートごとに再導出される** — これらはログ由来なので、最新のパース結果が勝ちます。

> **注意 — 古いビルドはタイトルを消しうる。** `name` カラム以前の古いパッケージ版アプリが同じ `~/.chronicle/chronicle.db` を共有している場合、そのアプリは `name` を保持すべきことを知らず、いずれかの同期でリネームを消してしまいます。「リネームが消えた」という報告をデバッグする前に、迷子のインスタンスを終了させてください。

これはまた、インポートの順序と冪等性がきれいに合成できる唯一の理由でもあります。セッション全体が 1 つのアトミックな入れ替えなので、インポート途中のクラッシュはロールバックされ、セッションが半分だけ残ることはありません。

## 関連ページ
- [パーサーとインジェスト](parsers-and-ingestion.md) — 各ツールのログがこれらの正規化行になる仕組みと、ソースを追加する HOWTO。
- [セッションのインポート](../guide/importing-sessions.md) — ユーザー向けのインポートウィザードと読み取り専用の保証。
- [アーキテクチャ概要](overview.md) — データストアがシステム全体のどこに位置するか。
