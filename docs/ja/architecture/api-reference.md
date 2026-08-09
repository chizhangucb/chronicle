# HTTP API リファレンス

Chronicle は 1 つのローカルポート上で 2 つのマウントを公開します。`/api`（REST API）と `/share`（公開用のリダクション済みページ）です。このページは、コントリビューターや、稼働中のインスタンスに対してスクリプトを書く人のための、ルートレベルのリファレンスです。

すべては単一のオリジンから配信されます — dev（`npm run dev`）では `http://localhost:4173`、desktop/standalone では `http://localhost:41730` — そして 3 つの実行モードすべてをまったく同じ Express アプリが支えています（[アーキテクチャ概要](overview.md) を参照）。リクエストはローカルのみで、standalone サーバーは `127.0.0.1` にバインドします。

> **データベースを直接読みますか？** 外部のコンシューマーは、これらのルートではなく、バージョン管理された `contract_*` SQL ビューを読むべきです — [メトリクスとコントラクトビュー](metrics-and-contract.md) を参照してください。

## マウント

| マウント | ソース | 配信するもの |
| --- | --- | --- |
| `/api` | `server/api.js` | REST API — 特記なき限り以下のすべてのルート |
| `/share` | `server/shares.js` | 公開・リダクション済み・トークン化されたセッションページ（HTML） |

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
| `GET` | `/search` | `messages.text` + `tool_input` に対する全文検索（FTS5 の `MATCH`、FTS テーブルがなければ `LIKE` へフォールバック）。セッション単位でグルーピング（空クエリ → 最近のセッション） |

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
- [メトリクスとコントラクトビュー](metrics-and-contract.md) — 外部リーダーのためのバージョン管理された `contract_*` ビューと、`/search` の背後にある FTS5 インデックス。
- [データモデル](data-model.md) — これらのルートの背後にある SQLite スキーマと正規化イベントモデル。
