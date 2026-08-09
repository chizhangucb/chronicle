# コントリビューション

開発環境のセットアップ方法、コードベースが従っている規約、そして変更の検証方法を説明します。内部構造にはじめて触れる方は、まず[アーキテクチャ概要](architecture/overview.md)を読んでください。

## 開発環境のセットアップ

```bash
npm install
npm run dev        # Vite dev server + API in one process → http://localhost:4173
```

`npm run dev` が最速のループです。Express API は Vite の開発サーバーの中にマウントされるため、React の UI とサーバーモジュールの両方が、1 つのプロセス・1 つのポートでホットリロードされます。3 つの実行モード（`dev`、`desktop`、`standalone`）がいずれも同じ Express アプリを提供する理由は、[概要](architecture/overview.md)を参照してください。

パッケージ版と同等の体験を試すには次を使います。

```bash
npm run desktop    # production build + Electron shell (port 41730, tray)
npm run standalone # headless production server (UI + /api + /share)
```

Chronicle はすべてのデータを `~/.chronicle/` 以下に書き込みます（`CHRONICLE_DATA_DIR` で上書き可能）。開発中に行うどの操作も、元のログやプロジェクトのリポジトリには触れません。Chronicle は外部データに対して厳密に読み取り専用です。ディレクトリ構成と環境変数の全体像は[設定](reference/configuration.md)を参照してください。

## 規約

- **新しいエンドポイントは既存の Express アプリ**（`server/api.js`、`server/shares.js`）**に置きます。** これらのアプリは 3 つの実行モードすべてにマウントされているため、そこに追加したルートは dev、desktop、standalone のいずれでも追加作業なしに動作します。
- **素の React と 1 つの `styles.css`。** UI フレームワークもチャートライブラリもありません。チャートは手作りの SVG/CSS（ポリラインと conic-gradient のドーナツ）です。このスタイルに合わせてください。
- **重い処理はすべてヒューリスティックかつローカル。** 因果関係、秘匿化、コスト計算は LLM 呼び出しなしで完全にデバイス上で動作します。このオフライン保証を守ってください。コア機能にネットワーク依存を追加してはいけません。
- **外部システムに対しては読み取り専用。** SQLite ソースは開く前に（`-wal`/`-shm` ファイルを含めて）一時領域へコピーされます。元のログやリポジトリに書き込むことはありません。
- **長寿命の状態は `globalThis` に置きます**（例: `__chronicleLive`）。これにより、Vite の SSR モジュールリロードがウォッチャーや子プロセスを孤児化させません。
- **共有語彙の情報源は 1 か所に。** チャット種別のラベルは `src/kinds.js` のみに、モデルごとのコンテキストウィンドウと価格は `src/models.js` のみに置きます。新しい文言や数値はそこに追加し、決してインラインに書かないでください。
- **クライアント側の新しい npm 依存は `devDependencies` に入れます。** `dependencies` ではありません。Vite はクライアントライブラリを `dist/` にバンドルする一方、electron-builder は `dependencies` の中身をすべてアプリに同梱します。本物のサーバーランタイム依存（`express`、`electron-updater`）だけが `dependencies` に属します。
- **破壊的またはユーザーに影響する操作は、先にバックアップを取り**（`~/.chronicle/backups/` 以下）、明示的なクリックを必要とします。秘匿化は一方向であり、リプレイはサンドボックス内で実行されます。

## ブランチと PR のワークフロー

自明とはいえない変更には、ブランチとプルリクエストを使います。`fix/…` または `feat/…` ブランチを作成してプッシュし、`gh pr create` を実行します。単独作業でも同様です。`main` への直接コミットは、自明で合意済みの単発の変更に限ります。PR がマージされたら、ローカルのチェックアウトを `main` に戻してください。

```bash
git checkout main && git pull && git fetch --prune && git branch -D <branch>
```

UI のプロジェクトカードにある **Git ピル**は、`/api/projects` の呼び出しごとにチェックアウトの現在のブランチを読み取ります（キャッシュなし）。マージ後にフィーチャーブランチが表示されている場合、チェックアウトがまだそのブランチにあるということです。`main` に切り替えてください。

## 変更の検証

ユニットテストランナーは組み込まれていません。パーサーは `test/fixtures/` のフィクスチャに対して検証され、機能は実データに対してエンドツーエンドで検証されます。最速のエンドツーエンド確認は、**Chronicle 自身の Claude Code セッションを取り込んで操作してみること**です。タイムトラベル、因果関係、リプレイのすべてが、Chronicle 自身の構築履歴に対して動作します。

各機能は、このリポジトリ自身のセッション、`~/health-analyst` リポジトリ（234 コミット）、そして Cursor・Codex・Gemini・Copilot・OpenCode-live のフィクスチャデータベース／JSON に対して検証されてきました。モックよりもこの方法を優先してください。実際の取り込みは、パイプライン全体（スキャン → パース → スナップショット → レンダリング）を一度に検証します。

新しいソースツールを追加する際は、[パーサーと取り込み](architecture/parsers-and-ingestion.md#howto-add-a-new-source)の手順に従い、PR を開く前にフィクスチャと実セッションの両方で検証してください。

## コードの所在

[アーキテクチャ](architecture/overview.md)のセクションがコードベースを詳細にマッピングしています。要約すると次のとおりです。

```
server/     Express API + parsers + Git engine + live/replay/security/shares
src/        React UI (Vite) — plain React + one styles.css
electron/   Desktop shell (tray, single instance, auto-sync, auto-update)
docs/       This documentation set
```

## 関連

- [アーキテクチャ概要](architecture/overview.md) — システム設計と実行モード
- [パーサーと取り込み](architecture/parsers-and-ingestion.md) — 新しいソースツールの追加
- [API リファレンス](architecture/api-reference.md) — 開発の対象となるすべてのルート
