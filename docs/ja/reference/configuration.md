# 設定

Chronicle がデータを保存する場所、読み取る環境変数、そして上書きできる数少ない項目について説明します。

Chronicle にはほとんど設定が不要です。お使いのツールのデフォルトのログの場所に対してそのまま動作し、すべてをホームフォルダー内の単一のディレクトリに保存します。このページでは、そのディレクトリ、アプリの各部が読み取る環境変数、任意の `config.json`、そしてポートについて説明します。設定用のサーバーもアカウントもありません。上書きはファイルと環境変数のみで行います。

## `~/.chronicle/` ディレクトリ

Chronicle が書き込むものはすべて 1 つのベースディレクトリ（デフォルトは `~/.chronicle`。後述の `CHRONICLE_DATA_DIR` を参照）の下に置かれます。初回起動時に冪等に作成されます。

| パス | 保持する内容 |
| --- | --- |
| `chronicle.db` | SQLite データベース — すべてのプロジェクト、セッション、メッセージ。`node:sqlite`（`DatabaseSync`）経由で開かれ、ネイティブコンパイルは不要 |
| `skills/` | 中央 Skills Hub ストア（`CENTRAL_SKILLS`）。各ツールの skills ディレクトリへシンボリックリンクで展開される |
| `snapshots/` | スキルのバージョン履歴（インポート時のスナップショットと、デバウンスされたファイルシステム変更のスナップショット） |
| `backups/mcp/` | ワンクリックのテイクオーバー前に取得される MCP 設定のバックアップ（ソースがその場で書き換えられることはない） |
| `replay/<id>/` | 実行ごとの Replay サンドボックス。セッション開始時の Git スナップショットからシードされる |
| `feedback.log` | すべてのフィードバック送信。ネットワーク送信の *前に* ローカルへ追記される |
| `config.json` | 任意のユーザー上書き（後述） |

> **注意:** `backups/` は、その他の破壊的またはユーザーに影響する操作（フック導入、リストア）が最初にバックアップを取る場所でもあります。Chronicle は、見落とす可能性のあるものを変更する前に、常にバックアップを書き込みます。

## 環境変数

各変数は特定のファイルによって読み取られ、最後の列に示しています。未設定の変数は、示されているデフォルトにフォールバックします。

| 変数 | デフォルト | 目的 | 読み取り元 |
| --- | --- | --- | --- |
| `CHRONICLE_DATA_DIR` | `~/.chronicle` | データベースおよび上記のすべての状態のベースディレクトリ | `server/db.js`（DB パス）と `server/api.js`（フィードバックログ、`config.json`） |
| `CHRONICLE_FEEDBACK_RELAY` | `relay.getchronicle.dev` | ホスト型フィードバックリレーの URL を上書きする | `server/api.js` |
| `CHRONICLE_CURSOR_DIR` | Cursor の VS Code `workspaceStorage` | Cursor パーサーを標準外の場所に向ける | `server/parsers/cursor.js` |
| `CHRONICLE_VSCODE_DIR` | VS Code / Insiders / VSCodium のユーザーディレクトリ | Copilot Chat パーサーを標準外の VS Code ユーザーディレクトリに向ける | `server/parsers/copilot.js` |
| `CHRONICLE_URL` | `http://localhost:4173` | pre-tool-use ガードフックがスキャンリクエストを POST する先 | `hooks/chronicle-guard.mjs` |
| `PORT` | `41730` | ヘッドレスの standalone サーバーのポート | `server/standalone.js` |

> **注意:** `CHRONICLE_DATA_DIR` は、データディレクトリに関する唯一の環境変数です。`server/api.js` の内部では、その解決済みの値が `CHRONICLE_DIR` という名前の定数に保持されています。これは内部的な名前であり、2 つ目の変数ではありません。したがって `CHRONICLE_DATA_DIR` を設定すれば、データベースとフィードバックログの両方がそれに従います。

## `config.json` による上書き

環境変数を使わずに永続的な上書きを設定するには、データディレクトリに `config.json` を置いてください。現在サポートされているキーはフィードバックリレーの 1 つのみです。

```json
{
  "feedbackRelay": "https://relay.example.com/feedback"
}
```

リレー URL の優先順位は次のとおりです: `CHRONICLE_FEEDBACK_RELAY` 環境変数 → `config.json` 内の `feedbackRelay` → 組み込みのデフォルト（`relay.getchronicle.dev`）。フィードバックは常にまずローカルの `feedback.log` へ追記されるため、リレーに到達できなくても失われるものはありません。

## ポートとバインド

3 つの実行モードはいずれも同じ Express アプリ（`/api`、`/share`、`/mcp`）を提供します。異なるのはポートとシェルだけです。

| モード | ポート | バインド |
| --- | --- | --- |
| `npm run dev` | `http://localhost:4173` | localhost |
| `npm run desktop`（Electron） | `41730` | ループバック |
| `npm run standalone` | `41730`（`PORT` で上書き可） | `127.0.0.1` |

standalone サーバーは明示的に `127.0.0.1` にバインドするため、自分のマシンからのみ到達可能です。Chronicle が公開インターフェースで待ち受けることはありません。

> **単一インスタンスロック:** 1 台のマシンで実行できる Chronicle は 1 つだけです。Electron シェルは単一インスタンスロックを取得し、ポート `41730` を保持するため、2 つ目の起動（パッケージ済みアプリ、`electron .`、または古い `standalone.js`）は二重にバインドするのではなく静かに終了します。UI が予期せず 404 を返す場合は、古いサーバーがポートを保持している可能性があります。`lsof -iTCP:41730` を確認してください。

## 関連

- [インストール](../guide/installation.md) — インストールパス、実行モード、要件。
- [プライバシーとデータ](./privacy-and-data.md) — ローカルに保存される内容の詳細と、外部への通信の短いリスト。
- [アーキテクチャ概要](../architecture/overview.md) — なぜ 1 つのプロセスと 1 つのポートですべてのモードに対応できるのか。
