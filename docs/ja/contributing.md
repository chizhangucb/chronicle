# コントリビューション

開発環境のセットアップ方法、コードベースが従っている規約、そして変更の検証方法を説明します。内部構造にはじめて触れる方は、まず[アーキテクチャ概要](architecture/overview.md)を読んでください。

## 開発環境のセットアップ

```bash
npm install
npm run dev        # Vite dev server + API in one process → http://localhost:4173
```

`npm run dev` が最速の開発ループです。Express API が Vite dev サーバーの内部にマウントされるため、React UI とサーバーモジュールの両方が、1 つのプロセス・1 つのポート上でホットリロードされます。3 つの実行モード（`dev`、`desktop`、`standalone`）がすべて同じ Express アプリを提供する理由については、[概要](architecture/overview.md)を参照してください。

パッケージ化された動作を試すには、次を実行します。

```bash
npm run desktop    # production build + Electron shell (port 41730, tray)
npm run standalone # headless production server (UI + /api + /share + /mcp)
```

Chronicle はすべてのデータを `~/.chronicle/` 配下に書き込みます（`CHRONICLE_DATA_DIR` で上書き可能）。開発中に行う操作が、あなたのソースログやプロジェクトリポジトリに触れることはありません——Chronicle は外部データに対して厳格に読み取り専用です。ディレクトリ構成の全体と環境変数については[設定](reference/configuration.md)を参照してください。

## 規約

- **新しいエンドポイントは既存の Express アプリ内に置く**（`server/api.js`、`server/shares.js`、`server/mcp/hub.js`）。これらのアプリは 3 つの実行モードすべてでマウントされるため、そこに追加したルートは dev・desktop・standalone のどれでも自動的に動作します。
- **素の React と 1 つの `styles.css`。** UI フレームワークもチャートライブラリもありません——チャートは手作りの SVG/CSS（折れ線と conic-gradient のドーナツ）です。そのスタイルに合わせてください。
- **重い処理はすべてヒューリスティックかつローカル。** 因果関係、秘匿化、コスト集計は、LLM を一切呼び出さずに完全にデバイス上で動作します。このオフラインの保証を守り、コア機能にネットワーク依存を決して追加しないでください。
- **外部システムに対しては読み取り専用。** SQLite ソースは、開く前に一時的な場所へコピーされます（`-wal`／`-shm` ファイルも含む）。元のログやリポジトリに書き込むことは決してありません。
- **長寿命の状態は `globalThis` 上に置く**（`__chronicleLive`、`__chronicleHub`、`__chronicleSkillWatch`）。これにより、Vite の SSR モジュール再読み込みによってウォッチャーや子プロセスが孤立しないようにします。
- **共有される語彙は単一の情報源で管理。** チャットの種類ラベルは `src/kinds.js` にのみ存在し、モデルごとのコンテキストウィンドウと価格は `src/models.js` にのみ存在します。新しい表現や数値はそこに追加し、インラインには決して書かないでください。
- **新しいクライアント側の npm 依存は `devDependencies` に入れる**——`dependencies` ではありません。Vite はクライアントライブラリを `dist/` にバンドルする一方、electron-builder は `dependencies` にあるすべてをアプリ内に同梱します。真にサーバー実行時に必要な依存（`express`、`electron-updater`）だけが `dependencies` に属します。
- **破壊的操作やユーザーに見える操作は、まずバックアップを取る**（`~/.chronicle/backups/` 配下）とともに、明示的なクリックを必要とします。秘匿化は不可逆で、リプレイはサンドボックス内で実行されます。

## ブランチと PR のワークフロー

些細でない変更には、ブランチとプルリクエストを使ってください——`fix/…` または `feat/…` ブランチを作り、プッシュして、単独作業のときでも `gh pr create` を行います。`main` への直接コミットは、些細で合意済みの一度きりの変更に限ってください。PR がマージされたら、ローカルのチェックアウトを `main` に戻します。

```bash
git checkout main && git pull && git fetch --prune && git branch -D <branch>
```

UI 上のプロジェクトカードの **Git ピル**は、`/api/projects` の呼び出しごとにチェックアウトの現在のブランチを読み取ります（キャッシュなし）。そのため、マージ後にフィーチャーブランチが表示されている場合は、チェックアウトがまだそのブランチ上にあるということです——`main` に戻ってください。

## 変更の検証

ユニットテストのランナーは組み込まれていません。パーサーは `test/fixtures/` のフィクスチャに対して検証され、機能は実データに対してエンドツーエンドで検証されます。最速のエンドツーエンド確認は、**Chronicle 自身の Claude Code セッションを取り込んで操作してみること**です——タイムトラベル、因果関係、リプレイのすべてが、Chronicle 自身の構築履歴の上で動作します。

各機能は、このリポジトリ自身のセッション、`~/health-analyst` リポジトリ（234 コミット）、稼働中の `anthropics/skills` リポジトリ（GitHub スキル取り込み用）、そして Cursor・Codex・Gemini・Copilot・OpenCode-live のフィクスチャデータベース／JSON に対して検証されています。モックよりもこちらを優先してください。実データの取り込みは、パイプライン全体（スキャン → 解析 → スナップショット → 描画）を一度にまとめて動かします。

新しいソースツールを追加するときは、[パーサーと取り込み](architecture/parsers-and-ingestion.md#howto-add-a-new-source)のウォークスルーに従い、PR を出す前にフィクスチャと実セッションの両方に対して検証してください。

## 各要素の所在

[アーキテクチャ](architecture/overview.md)のセクションで、コードベースを詳細にマッピングしています。要約すると次のとおりです。

```
server/     Express API + parsers + Git engine + live/replay/security/mcp/skills/shares
src/        React UI (Vite) — plain React + one styles.css
electron/   Desktop shell (tray, single instance, auto-update)
hooks/      chronicle-guard.mjs — the Claude Code PreToolUse hook
docs/       This documentation set
```

## 関連

- [アーキテクチャ概要](architecture/overview.md) — システム設計と実行モード
- [パーサーと取り込み](architecture/parsers-and-ingestion.md) — 新しいソースツールの追加
- [API リファレンス](architecture/api-reference.md) — 実装対象となるすべてのルート
