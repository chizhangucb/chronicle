# アーキテクチャ概要

Chronicle は、AI コーディングセッションのためのローカルファースト（local-first）な「タイムマシン」です。6 つのツールから会話ログをインポートし、すべてのメッセージをその時点の Git スナップショットにマッピングし、さらに MCP Hub、Skills Hub、セキュリティのリダクション（秘匿情報の伏せ字化）、ライブストリーミング、決定論的なリプレイを提供します。これらはすべて、クラウドバックエンドも LLM 呼び出しもない単一の Node プロセス内で完結します。

このページは全体の地図です。ほかのすべてが依存する唯一の設計判断 — **シングルプロセス・シングルポート** — を説明したうえで、コンポーネントの各レイヤー、3 つの実行モード、そしてコードベースを健全に保つプロダクト原則を順に見ていきます。最初にこのページを読んでください。ほかのアーキテクチャ各ページは、それぞれのボックスを掘り下げます。

## シングルプロセス・シングルポート

Chronicle は 3 つの Express アプリと 1 つの React UI で構成されています。各アプリは次のとおりです。

| アプリ | マウント先 | 責務 |
| --- | --- | --- |
| `server/api.js` | `/api` | すべての REST ルート（スキャン/インポート、プロジェクト、セッション、git、検索、セキュリティ、skills、MCP 管理、リプレイ、フィードバック） |
| `server/shares.js` | `/share` | ローカルアプリが配信する、公開用にリダクション済みでトークン化された共有ページ |
| `server/mcp/hub.js` | `/mcp` | 集約型 MCP サーバー（Streamable HTTP） |

鍵となるのは、**まったく同じアプリオブジェクトがすべての実行モードで配信される**という点です。開発時にはそれらが Vite 開発サーバーの*中に*マウントされ、本番では素の Express サーバー（`server/standalone.js`）がそれらを直接マウントします。これらのアプリのいずれかにエンドポイントを追加すれば、それが dev・desktop・standalone のすべてで自動的に動作します。モードごとの配線は不要です。

dev では、`vite.config.js` が小さなプラグイン（`chronicleApi`）をインストールし、Vite の connect サーバーにミドルウェアをぶら下げ、各アプリをリクエストごとに遅延ロードします。

```js
// vite.config.js — one process, one port
server.middlewares.use('/api', async (req, res, next) => {
  const { api } = await server.ssrLoadModule('/server/api.js');
  api(req, res, next);
});
```

`ssrLoadModule` の呼び出しは意図的なものです。これにより API が Vite の SSR モジュールグラフを経由するため、**`server/*.js` を編集すると API がホットリロードされ**、プロセスを再起動する必要がありません。UI の HMR と API のホットリロードを同じポート（`4173`）上で得られます。

本番には Vite はありません。`server/standalone.js` が Express アプリを構築し、同じ 3 つのアプリをマウントし、それ以外のすべてについてはビルド済みの `dist/` を配信します。

```js
// server/standalone.js
app.use('/api', api);
app.use('/share', sharePage);
app.use('/mcp', mcpEndpoint);
app.use(express.static(dist));
app.get(/^\/(?!api|share|mcp).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
```

> **注意点 — Router ではなく Express *アプリ*をマウントすること。** Vite ミドルウェアはアプリに素の Node の `req`/`res` を渡します。Express の *Router* はこれらのオブジェクトを装飾しないため、`res.json` が `undefined` となり、すべてのルートが例外を投げます。これらのレスポンスヘルパーをインストールする完全な Express *アプリケーション*をマウントすることこそが、同じコードを Vite の背後でも `standalone.js` の背後でも動作させる仕組みです。新しいエンドポイントは素の Router ではなく、これらのアプリ上に置いてください。

## コンポーネントマップ

```
┌──────────────────────────────────────────────────────────────┐
│  Desktop shell — Electron (electron/main.mjs)                 │
│  tray, single-instance lock, auto-update; zero server imports │
└───────────────────────────┬──────────────────────────────────┘
                            │ starts
┌───────────────────────────▼──────────────────────────────────┐
│  Server layer (Node, node:sqlite, shells out to git)          │
│                                                               │
│  parsers/      claudeCode · codex · cursor · opencode ·       │
│                gemini · copilot   → normalized events         │
│  db.js         projects / sessions / messages  (SQLite)       │
│  git.js        read-only snapshot engine (rev-list/ls-tree)   │
│  live.js       JSONL tail + SQLite poll → SSE                 │
│  replay.js     deterministic sandbox re-execution             │
│  causality.js  read→change linking (heuristic)                │
│  security.js   redaction rules, pre-tool-use check            │
│  mcp/          registry + Streamable-HTTP hub                  │
│  skills.js     central store + symlink fanout                 │
│  shares.js     tokenized redacted /share pages                │
│                                                               │
│  Exposed as three Express apps → /api · /share · /mcp         │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼──────────────────────────────────┐
│  React UI (src/) — plain React + one styles.css, no framework │
│  App.jsx global sidebar · SessionView playback/refine/replay  │
│  hand-rolled SVG charts · i18n (en/zh/ja)                     │
└──────────────────────────────────────────────────────────────┘
```

このレイヤー構造は、重要な一方向において厳格です。すなわち、**サーバーレイヤーは Electron を一切 import しません**。Electron はサーバーを起動し、ウィンドウ/トレイを所有しますが、`server/` 配下のどのコードも Electron の存在を知りません。これにより、将来 Tauri へ乗り換える場合でも、書き直しではなくシェルレベルの変更にとどめられます（[デスクトップとパッケージング](desktop-packaging.md) を参照）。

## 実行モード

3 つのモードはすべて同じ 3 つのアプリを配信し、それらを何でラップするかだけが異なります。

| コマンド | 実行内容 | ポート | 備考 |
| --- | --- | --- | --- |
| `npm run dev` | Vite 開発サーバー + プラグイン経由でマウントされたアプリ | `http://localhost:4173` | UI の HMR **と** API のホットリロード（`ssrLoadModule`） |
| `npm run desktop` | `vite build` → Electron シェル + トレイ | `41730` | 本番バンドル、ウィンドウはトレイに隠れる |
| `npm run standalone` | `server/standalone.js`、ヘッドレス | `41730` | `127.0.0.1` にバインド、`PORT` で上書き可、UI + `/api` + `/share` + `/mcp` |

Electron は standalone サーバーを内部で実行するため、「desktop」と「standalone」はウィンドウの有無を除けば同じサーバーコードです。

### `globalThis` 上の状態

Vite の SSR はモジュールを再評価することでリロードします。もしウォッチャーや子プロセスがモジュールスコープの変数に置かれていた場合、リロードによってそれらが孤立してしまいます。古いタイマーは動き続け、新しいモジュールからは見えなくなります。Chronicle はこれを回避するために、長命なシングルトンを `globalThis` に置いています。

- `__chronicleLive` — ライブ tail/ポーリングのウォッチャー（`server/live.js`）
- `__chronicleHub` — MCP hub のアップストリーム子プロセスとセッション
- `__chronicleSkillWatch` — skills のファイルシステムウォッチャー

`globalThis` はモジュールの再評価を生き延びるため、ホットリロードは管理しているリソースを漏らすことなくコードだけを再バインドします。これが、ウォッチャーを積み上げることなくセッションの途中で `server/live.js` を編集できる理由です。

## プロダクト原則（スタックがこの形である理由）

6 つの原則がすべてのサブシステムを貫いています。これらを明示するのは、そうしなければ単に保守的に見えかねない選択を説明できるからです。

1. **ローカルファースト、デフォルトでオフライン。** セッションのパース、閲覧、管理にネットワーク呼び出しは不要です。意図的なアウトバウンド機能はアップデートチェック、GitHub スキルのインポート、フィードバックのリレーのみで、いずれもオプトインかつ限定的です。
2. **コードの状態については Git が信頼できる唯一の情報源。** スナップショットは、会話のタイムスタンプに対応づけられたコミット履歴から再構築されます。別のスナップショットストアからでも、現在のディスクからでもありません。[Git スナップショットエンジン](git-snapshot-engine.md) を参照してください。
3. **テイクオーバー → 集約 → 分配（Takeover → Centralize → Distribute）。** MCP Hub と Skills Hub の背後にある、共有コントロールプレーンのパターンです。散在した設定を取り込み、一箇所に保持し、再分配します（名前空間付きのツール、シンボリックリンクされた skills）。
4. **外部システムに対しては読み取り専用。** ソースログやプロジェクトリポジトリに書き込むことはありません。SQLite のソースは開く前に一時ディレクトリへコピーされ（[パーサーとインジェスト](parsers-and-ingestion.md) を参照）、git エンジンは読み取りのみを行います。
5. **デフォルトで安全。** リプレイはサンドボックス内で実行され、リダクションは一方向で、破壊的な操作はまずバックアップを取り、明示的なクリックを要求します。
6. **重い処理はすべてヒューリスティック + ローカル。** 因果関係の確信度ティア、リダクションの正規表現、アクティブ時間の計算 — いずれもローカルなヒューリスティックです。**どこにも LLM 呼び出しはなく**、これがオフライン保証を守っています。

### スタックに関する主要な判断

- **`node:sqlite`（`DatabaseSync`）であり、better-sqlite3 ではない。** ネイティブコンパイルがゼロなので、ターゲット上にコンパイラがなくてもアプリのビルドと配布ができます。スキーマ全体はモジュールスコープで冪等に作成され、マイグレーションは `try { ALTER TABLE … } catch {}` の行です。[データモデル](data-model.md) を参照してください。
- **git エンジンは libgit2 をリンクするのではなく `git` を（`execFileSync` で）呼び出す。** ネイティブ依存がなく、開発者がすでに信頼している `git` にそのまま合わせられます。
- **Tauri ではなく Electron。** 開発マシンに Rust ツールチェーンがなく、また Electron を一切 import しないというルールにより、〜100 MB のフレームワークのフロアを削る価値が出た場合でも Tauri への道は開かれています。
- **素の React + 1 つの `styles.css`**（CSS 変数、ダークテーマ） — UI フレームワークなし。**チャートは手作りの SVG/CSS**（polyline のトレンド、conic-gradient のドーナツ） — チャートライブラリなし。依存が減り、バンドルが小さくなり、完全に制御できます。
- **依存関係の規律。** 真のサーバーランタイム依存（`express`、`electron-updater`）のみが `dependencies` に置かれ、クライアントライブラリ（`react`、`react-dom`、`diff`）は `devDependencies` です。Vite がそれらを `dist/` にバンドルし、electron-builder は `dependencies` に含まれるすべてを同梱するためです。

## 関連ページ
- [データモデル](data-model.md) — SQLite スキーマと、すべてのサブシステムが読む正規化イベントモデル。
- [パーサーとインジェスト](parsers-and-ingestion.md) — 6 つのツールが正規化イベントになる仕組みと、7 つ目を追加する方法。
- [Git スナップショットエンジン](git-snapshot-engine.md) — 履歴からコードの状態を再構築する。
- [設定](../reference/configuration.md) — `~/.chronicle/` のレイアウト、環境変数、`config.json`。
- [デスクトップとパッケージング](desktop-packaging.md) — Electron シェル、署名、自動アップデート。
