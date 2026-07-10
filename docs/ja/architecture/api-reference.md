# HTTP API リファレンス

Chronicle は 1 つのローカルポート上で 3 つのマウントを公開します。`/api`（REST API）、`/share`（公開用のリダクション済みページ）、`/mcp`（集約型 MCP サーバー）です。このページは、コントリビューターや、稼働中のインスタンスに対してスクリプトを書く人のための、ルートレベルのリファレンスです。

すべては単一のオリジンから配信されます — dev（`npm run dev`）では `http://localhost:4173`、desktop/standalone では `http://localhost:41730` — そして 3 つの実行モードすべてをまったく同じ Express アプリが支えています（[アーキテクチャ概要](overview.md) を参照）。リクエストはローカルのみで、standalone サーバーは `127.0.0.1` にバインドします。

## マウント

| マウント | ソース | 配信するもの |
| --- | --- | --- |
| `/api` | `server/api.js` | REST API — 特記なき限り以下のすべてのルート |
| `/share` | `server/shares.js` | 公開・リダクション済み・トークン化されたセッションページ（HTML） |
| `/mcp` | `server/mcp/hub.js` | 集約型 MCP サーバー（Streamable HTTP、JSON-RPC） |

> **注意:** `/mcp`（MCP プロトコルのエンドポイント）は、`/api/mcp/*` ルート（サービスを一覧しテイクオーバーを駆動する管理用 REST API）とは**別物**です。下流の MCP クライアントは `/mcp` と話し、Chronicle UI は `/api/mcp/*` と話します。[MCP と Skills の内部](mcp-and-skills-internals.md) を参照してください。

以下の表のすべてのパスは `/api` からの相対です — 例えば `GET /projects` は `GET http://localhost:41730/api/projects` です。

## インポートとスキャン

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/scan` | 6 つのツール全体でインポート可能なセッションを発見する（論理プロジェクト単位でグルーピング） |
| `POST` | `/import` | 選択されたセッションを SQLite ストアにインポートする（セッションごとに `replaceSession`） |

## プロジェクト

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/projects` | ライブの git ピル情報とともにプロジェクトを一覧する（`repoInfo` が呼び出しごとに `git` を実行） |
| `GET` | `/projects/:id` | プロジェクト分析ホーム。時間範囲を絞る **`?days=N`** を受け付ける |
| `PATCH` | `/projects/:id` | プロジェクトをリネームする |
| `DELETE` | `/projects/:id` | プロジェクトとそのセッションを Chronicle から削除する |
| `POST` | `/projects/:id/associate` | 仮想（例: Gemini）プロジェクトを実リポジトリのパスに関連付ける |
| `POST` | `/projects/:id/sync` | プロジェクトのすべてのセッションを再スキャン・再インポートする |
| `POST` | `/projects/:id/unlink` | 関連付けを取り消す |

## セッション

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/sessions/:id/messages` | セッションの完全なメッセージリスト |
| `PATCH` | `/sessions/:id` | セッションをリネームする（ユーザーの `name` 上書きを設定） |
| `DELETE` | `/sessions/:id` | セッションの Chronicle コピーを削除する |
| `DELETE` | `/sessions/:id/source-file` | 基盤となるソースログを削除する（1 ファイル = 1 セッションの場合のみ） |
| `POST` | `/sessions/:id/sync` | このセッションだけを再インポートする（UI では `⇧⌘U`） |
| `GET` | `/sessions/:id/causality` | read→change の因果関係分析（`analyzeCausality`） |
| `GET` | `/sessions/:id/live` | **SSE ストリーム** — ライブメッセージの追尾（下記参照） |
| `GET` | `/sessions/:id/security-check` | セッションをスキャンして秘密情報を探す（`scanSession` のペイロード） |
| `GET` | `/sessions/:id/export-redacted` | セッションをリダクション済み Markdown としてエクスポートする |
| `POST` | `/sessions/:id/share` | 共有トークンを発行する（作成時に凍結されたリダクション済みコピー） |
| `GET` | `/sessions/:id/replay-plan` | リプレイのステッププランを構築する（`buildPlan`） |

### ライブ SSE ストリーム

`GET /api/sessions/:id/live` は JSON では**ありません** — `text/event-stream` にアップグレードし、`data:` フレームをプッシュします。フレームは `{ type: 'status', status: 'live' | 'stopped', ... }` か `{ type: 'messages', events: [...] }` のいずれかです。ウォッチャーは接続が閉じると自動停止します。[セキュリティ、ライブ、リプレイの内部](security-live-replay.md) を参照してください。

## Git

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/git/at` | タイムスタンプ以前で最も近いコミット（`commitAt`） |
| `GET` | `/git/tree` | あるコミットでのファイルツリー（`treeAt`） |
| `GET` | `/git/file` | あるコミットでのファイル内容 + 差分用のその以前のバージョン（`fileAt`） |

これらは `server/git.js` に対する読み取り専用のラッパーで、`git` を呼び出します。[Git スナップショットエンジン](git-snapshot-engine.md) を参照してください。

## 検索

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/search` | `messages.text` + `tool_input` に対する `LIKE` ベースの全文検索。セッション単位でグルーピング（空クエリ → 最近のセッション） |

## ライブ

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/live/status` | アクティブなライブウォッチャーを一覧する（`liveStatus`） |

## セキュリティ

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/security/rules` | リダクション/許可ルールを一覧する |
| `POST` | `/security/rules` | カスタムルールを追加する |
| `PATCH` | `/security/rules/:id` | ルールを有効化/無効化する |
| `DELETE` | `/security/rules/:id` | ルールを削除する |
| `GET` | `/security/interceptions` | 最近の pre-tool-use インターセプト記録 |
| `POST` | `/security/pretooluse` | ツール呼び出しをスキャンする。`{ decision: 'allow' \| 'block', ... }` を返す（フックから呼ばれる） |
| `POST` | `/security/install-hook` | Claude Code の PreToolUse フックをインストールする（まず設定をバックアップ） |

## Skills

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/skills` | 中央 skills を一覧する（ツールごとのリンク状態付き） |
| `GET` | `/skills/scan` | ツールのディレクトリをスキャンし、importable/managed/duplicate/broken な skills を探す |
| `POST` | `/skills/import` | スキャンされた skill を中央ストアにインポートする |
| `POST` | `/skills/github` | 公開 GitHub リポジトリから skills をインポートする（浅いクローン、SHA を記録） |
| `GET` | `/skills/:id` | skill の詳細 + `SKILL.md` の内容 |
| `PATCH` | `/skills/:id` | ローカルメタデータ（タグ、評価）を更新する |
| `DELETE` | `/skills/:id` | skill を削除する（中央ファイルも削除するには `?removeFiles=1`） |
| `POST` | `/skills/:id/link` | skill をツールのディレクトリにシンボリックリンクする |
| `POST` | `/skills/:id/unlink` | Chronicle が作成したシンボリックリンクを削除する |
| `GET` | `/skills/:id/snapshots` | バージョンスナップショットを一覧する |
| `POST` | `/skills/:id/restore` | スナップショットを復元する |
| `POST` | `/skills/:id/check-upstream` | 記録された SHA をリモートの tip と比較する（`ls-remote`） |

## MCP 管理

これらはレジストリを管理し、ハブを駆動します。`/mcp` プロトコルエンドポイントとは別物です。

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/mcp/services` | 登録されたサービスを一覧する（秘密情報はマスク済み） |
| `POST` | `/mcp/services` | サービスを追加/更新する |
| `PATCH` | `/mcp/services/:id` | サービスを更新する（有効化、スコープ、クレデンシャル、ツールポリシー） |
| `DELETE` | `/mcp/services/:id` | サービスを削除する |
| `GET` | `/mcp/scan` | ツールの設定をスキャンし、New/Updated/Conflict/Unchanged に分類する |
| `POST` | `/mcp/takeover` | スキャンされたサービスをインポートする（まずソース設定をバックアップ） |
| `GET` | `/mcp/status` | ハブのステータス（プロトコルバージョン、サービス/セッション数） |
| `GET` | `/mcp/tools` | 集約されたツールリスト（`aggregateTools('*')`） — インスペクター |
| `POST` | `/mcp/call` | 名前空間付きの `service__tool` を呼び出す — インスペクター |
| `GET` | `/mcp/log` | ハブの JSON-RPC リングバッファログ — インスペクター |

## リプレイ

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/replay/preview` | 来たるべきステップの差分をサンドボックス状態に対してプレビューする |
| `POST` | `/replay/start` | セッション開始スナップショットからサンドボックスを作成/シードする |
| `POST` | `/replay/step` | 1 ステップを実行する（Bash には `{ confirmCommand }` が必須） |
| `POST` | `/replay/open` | サンドボックスを OS のファイルブラウザで開く |

## フィードバック

| メソッド | パス | 目的 |
| --- | --- | --- |
| `POST` | `/feedback` | `~/.chronicle/feedback.log` に追記し、ホスト型リレーに転送する |

## 共有の管理

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/shares` | 共有トークンを一覧する（閲覧数、有効期限） |
| `DELETE` | `/shares/:id` | 共有を失効させる |

そして `/share` マウント上:

| メソッド | パス | 目的 |
| --- | --- | --- |
| `GET` | `/share/:token` | 公開のリダクション済み HTML ページ（有効期限切れ/失効すると 404） |

## データ形状

メッセージ行とセッション行は正規化イベントモデルに従います — SQLite スキーマ、`kind` 列挙（`user \| assistant \| thinking \| tool_use \| tool_result`、加えて `note`）、そして `replaceSession()` がユーザー設定の `name` を保持しつつインポートを冪等にする仕組みについては [データモデル](data-model.md) を参照してください。

ここで特筆すべき形状が 1 つあります。セッションごとの `sessions.usage` カラムは、モデルをキーとし、キャッシュ書き込みのバケットが分割された JSON です。

```json
{
  "claude-opus-4-8": {
    "input": 12000,
    "output": 3400,
    "cacheWrite5m": 800,
    "cacheWrite1h": 0,
    "cacheRead": 45000
  }
}
```

コストはこれから `src/models.js`（静的な価格表）によってローカルで計算されます — ログはトークンを保持するのであって、ドルは保持しません。

## 関連ページ
- [アーキテクチャ概要](overview.md) — シングルプロセス・シングルポート、実行モード、コンポーネントマップ。
- [MCP と Skills の内部](mcp-and-skills-internals.md) — `/mcp` エンドポイントと `/api/mcp/*` の区別。
- [データモデル](data-model.md) — これらのルートの背後にある SQLite スキーマと正規化イベントモデル。
