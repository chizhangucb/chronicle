# MCP Hub と Skills Hub の内部

Chronicle は、AI ツールがあなたのマシン全体に散らばらせるもの — MCP サーバーの設定とエージェントの skills — に対して 2 つのコントロールプレーンを提供します。どちらも同じパターンを実装しています。すなわち、散在したソースを**テイクオーバー**し、`~/.chronicle` に**集約**し、名前空間付きで非破壊的な方法で**分配**して戻します。

このページは、`server/mcp/registry.js`、`server/mcp/hub.js`、`server/mcp/upstream.js`、`server/skills.js` に取り組むコントリビューター向けです。集約型 MCP サーバーがアップストリームのツールをどのように名前空間化してルーティングするか、skills ストアがシンボリックリンクを介してどのようにファンアウトするか、そして — 最も重要なこととして — 両方のハブが実際のユーザー設定を破壊せずに取り込めるようにする安全姿勢を説明します。ユーザー向けのウォークスルーは [MCP Hub](../guide/mcp-hub.md) と [Skills Hub](../guide/skills-hub.md) を参照してください。

## 共有パターン: テイクオーバー → 集約 → 分配

両方のハブは同じ問題を解決します。ある開発者が Claude Code、Cursor、Codex、Gemini を実行し、それぞれが「どの MCP サーバーが存在するか」と「どの skills がインストールされているか」の独自コピーを保持しています。何も共有されず、編集はずれていき、秘密情報が平文の設定ファイルに置かれています。

Chronicle の答えは、リソースごとに 1 つのコントロールプレーンです。

| ステージ | MCP Hub（`server/mcp/`） | Skills Hub（`server/skills.js`） |
| --- | --- | --- |
| **テイクオーバー** | `scanMcpConfigs()` が各ツールの設定を読み、`classifyScan()` がレジストリと差分を取る | `scanSkills()` が各ツールの `skills/` ディレクトリを読み、`SKILL.md` をパースする |
| **集約** | `upsertService()` が `mcp_services` テーブルに書き込む | `importSkill()` がディレクトリを `~/.chronicle/skills` にコピーする |
| **分配** | `/mcp` エンドポイントがすべてのサービスを名前空間付きの `service__tool` として再公開する | `linkSkill()` が中央コピーを各ツールの `skills/` ディレクトリにシンボリックリンクする |

テイクオーバーを信頼できるものにする安全ルールは、両者で同じです。すなわち、**元のソースは決して書き換えられません。** MCP のテイクオーバーはレジストリに触れる前にすべてのソース設定をバックアップし、skill のインポートは中央ストレージに*コピー*してソースディレクトリには手を触れず、skill の分配はシンボリックリンクを*追加*するだけで、実ディレクトリを上書きすることを拒否します。仮に Chronicle が明日消えたとしても、各ツール自身の設定は正確に元の場所に残ります。

## MCP Hub

### サービスレジストリ（`server/mcp/registry.js`）

レジストリは 1 つの SQLite テーブル `mcp_services` に対する薄い CRUD レイヤーと、それを埋めるスキャナー群です。サービス行は、トランスポート（`stdio | http | sse`）、起動の詳細（stdio 用の `command`/`args`/`env`、HTTP 用の `url`/`headers`）、`enabled` フラグ、その出所である `origin` 設定、サービスごとの `disabled_tools` ポリシーリスト、そして任意の `project_path` スコープを保持します。

コアの CRUD:

```js
listServices()                    // all rows, ordered by name
upsertService(entry)              // insert-or-update keyed on unique name
setServiceEnabled(id, enabled)    // policy on/off
deleteService(id)
maskService(s)                    // redact secret-looking env/header values for display
```

`maskService()` は表示のゲートです。API から出るすべてのレジストリ値（`GET /api/mcp/services`、`/api/mcp/scan`）はまずこれを通されるため、トークン、キー、`Authorization` ヘッダーは平文ではなく `abcd…******` として返されます。UI が生のクレデンシャルを目にすることは決してありません。

**スキャンと分類。** `scanMcpConfigs()` は既知の設定場所 — `~/.claude.json`（およびインポート済みプロジェクトのプロジェクト単位の `.mcp.json`）、`~/.cursor/mcp.json`、`~/.gemini/settings.json`、そして `~/.codex/config.toml`（Codex は `[mcp_servers.<name>]` セクションを使うため、最小限のインライン TOML リーダー経由） — を読みます。`classifyScan()` はその後、発見された各サーバーをレジストリと差分し、タグ付けします。

| ステータス | 意味 |
| --- | --- |
| `new` | まだレジストリにない |
| `unchanged` | 存在し、同一 |
| `updated` | 存在し、変更されており、**同じ**出所設定から |
| `conflict` | 存在し、変更されているが、**異なる**出所から |

New/Updated/Conflict の区別がテイクオーバーのレビュー UI を駆動します — ワンクリックのインポートが何を追加し、何を上書きするかを正確に確認できます。

**テイクオーバー前のバックアップ。** `backupSources()` は、いかなるテイクオーバーの前にもすべてのソース設定ファイルを `~/.chronicle/backups/mcp/<timestamp>/` にコピーし、直近 5 セットのバックアップを保持します。これはコードにおける「デフォルトで安全」の保証です。取り込みは元に戻せます。

**プロジェクトスコープと Roots。** サービスは `setProjectPath()` によって `project_path` にバインドできます。`servicesForRoot(root)` はその後、**最長プレフィックス一致**でルーティングします。クライアントの root が与えられると、グローバルにスコープされたすべてのサービスに加え、そのパスが root のプレフィックスである*最も深い*プロジェクトスコープを返します。`'*'` を渡すとすべて（管理者/インスペクター用のビュー）を返し、root を渡さないとグローバルのみを返します。これが、1 つのハブエンドポイントが異なるリポジトリで作業するクライアントに異なるツールセットを公開できる仕組みです。

**クレデンシャルとツールポリシー。** `setCredential(id, bearer)` は、サービスごとの bearer トークンを `Authorization` ヘッダーとして保存します（出力ではどこでもマスクされ、アップストリーム呼び出し時に適用されます）。`setDisabledTools(id, tools)` はサービスごとのブロックリストを記録します。無効化されたツールは `tools/list` から隠され、`tools/call` で拒否されます。

### `/mcp` エンドポイント（`server/mcp/hub.js`）

ハブは `/mcp` にマウントされた Express アプリで、**MCP Streamable HTTP、プロトコルバージョン `2025-03-26`** を話します。これは意図的に POST 優先です。クライアントは `POST /` で JSON-RPC を送り、`DELETE /` がセッションを破棄し、`GET /` は `405` を返します（サーバー起点の SSE ストリームは提供されないため、クライアントは POST のみのモードにフォールバックします）。

すべてのリクエストの前に 2 つの保護が置かれます。

- **Origin 検証（CSRF）。** ブラウザの `Origin` ヘッダーを持つリクエストは、その origin が `localhost`/`127.0.0.1` でない限り `403` で拒否されます。ブラウザ以外の MCP クライアント（`Origin` を送らない）は通過します。
- **セッション識別。** `initialize` が `MCP-Session-Id`（UUID）を発行し、レスポンスヘッダーで返します。クライアントは以降の呼び出しでそれをエコーバックします。セッションはまた、クライアントの **root** も記録します — `x-chronicle-root` ヘッダー、または `initialize` パラメータの `rootUri` / `workspaceFolders` から — これは後続の `tools/list` 呼び出しがスコープの対象にするものです。

**集約と名前空間化。** `aggregateTools(root)` はハブの心臓部です。`servicesForRoot(root)` を呼んでスコープ内のサービスを選び、それぞれに並列で接続し、それらのツールを 1 つのリストにフラット化します — すべてのツールを `<service>__<tool>` にリネームし、その説明の前に `[<service>]` を付けます。

```js
tools.push({
  ...t,
  name: `${svc.name}${SEP}${t.name}`,          // SEP = "__"
  description: `[${svc.name}] ${t.description ?? ''}`,
});
```

サービスの `disabled_tools` リストにあるツールはここでフィルターアウトされます。アップストリームの接続エラーはリスト全体を失敗させません — それらはサービスごとに `errors` マップに集められるため、1 つの壊れたサーバーがハブを空白にすることはありません。

**ディスパッチ。** `callTool(namespaced, args)` は最初の `__` で分割し、名前でサービスを解決し、転送する前にポリシーを強制します。無効化されたサービスやポリシーでブロックされたツールは例外を投げます（そのブロックは `blocked` エントリとしてインスペクターログに書き込まれます）。それ以外の場合は `tools/call` をアップストリームのクライアントに転送し、結果をそのまま返します。

**アップストリームのトランスポート（`server/mcp/upstream.js`）。** `connect(service)` は 2 種類のアップストリームを橋渡しします。

- **stdio** — 子プロセスを spawn し、その stdin/stdout 越しに改行区切りの JSON-RPC を話し、**ライブの子プロセスを `globalThis.__chronicleUpstreams` にキャッシュ**して、繰り返しの呼び出しが 1 つのプロセスを再利用するようにします（かつ Vite SSR のリロードを生き延びます）。子プロセスは 1 度だけ初期化されます（`initialize` → `notifications/initialized` → `tools/list`）。
- **http / sse** — `fetch` ベースの Streamable-HTTP クライアントで、ハブセッションごとに安価に再初期化され、JSON と `text/event-stream` の両方のレスポンスを扱い、アップストリーム自身の `MCP-Session-Id` を通します。

そのため、stdio サーバーとリモート HTTP サーバーは下流のクライアントからは同一に見えます。どちらも 1 つのフラットなリスト内で `service__tool` の名前として現れます。

**ステータスとインスペクター。** `hubStatus()` はエンドポイント、プロトコルバージョン、サービス/有効数、ライブセッション数、接続中の stdio 子プロセスを報告します。`hubLog()` は、送受信されたすべての JSON-RPC メッセージのリングバッファ（直近約 300 エントリ） — recv/send/blocked/note — を返します。そのログと手動の `tools/call` が、組み込みの**インスペクター**（`GET /api/mcp/log`、`GET /api/mcp/tools`、`POST /api/mcp/call`）であり、外部の MCP クライアントなしでハブを動かせる自己完結した手段です。

> **注意:** `/mcp` エンドポイント（集約型 MCP サーバー）は、`/api/mcp/*` ルート（サービスを一覧し、スキャンを実行し、テイクオーバーを駆動する管理用 REST API）とは別物です。[API リファレンス](api-reference.md) を参照してください。

## Skills Hub（`server/skills.js`）

Skills Hub は、MCP Hub がサーバーを集約するのと同じように、エージェントの skills — `SKILL.md` を持つ自己完結したディレクトリ — を集約します。その中央ストアは次のとおりです。

```js
export const CENTRAL_SKILLS = path.join(HOME, '.chronicle', 'skills');
```

### スキャンとインポート

`scanSkills()` は各ツールの skill ディレクトリ（`~/.claude/skills`、`~/.agents/skills`、`~/.cursor/skills`、`~/.codex/skills`、`~/.gemini/skills`）を歩き、`SKILL.md` のフロントマターから `name`/`description` をパースし、各エントリを 4 つのティアのいずれかに分類します。

| ティア | 意味 |
| --- | --- |
| `importable` | 中央ストアにまだない実在の skill ディレクトリ |
| `managed` | すでに `CENTRAL_SKILLS` を指しているシンボリックリンク |
| `duplicate` | 名前がすでに中央に存在する skill |
| `broken` | ぶら下がったシンボリックリンク、または `SKILL.md` のないディレクトリ |

`importSkill(sourcePath, origin)` はディレクトリを中央ストアにコピーし（必要なら数値のサフィックスで名前を重複排除し）、`skills` テーブルに行を記録します。ソースディレクトリはコピーされるのであって、移動されることはありません — 元のツールのインストールは手を触れられません。

`listSkills()` は、`linkStatus()` で注釈されたすべての中央 skill を返します — 各ツールについて、Chronicle がそこにライブのシンボリックリンクを持つか、外部のリンクか、実ディレクトリか、あるいは何もないかを示します。

### シンボリックリンクのファンアウト — 厳密に追加のみ

分配は、テイクオーバーの意図的な逆操作です。ファイルをあちこちにコピーするのではなく、Chronicle は 1 つの中央コピーを各ツールの skills ディレクトリに**シンボリックリンク**するため、すべてのツールが同じ skill を見て、1 つの編集が一度にすべてに伝播します。

`linkSkill(skillId, tool)` はシンボリックリンクを作成しますが、**上書きを拒否します**。実ディレクトリや外部のリンクがすでにそのパスを占有している場合、置き換えるのではなく例外を投げます（Windows では管理者権限が不要な `junction` を使います）。`unlinkSkill(skillId, tool)` はその鏡像であり、コアの安全保証です — **Chronicle 自身が作成したシンボリックリンクのみを削除します**（`CENTRAL_SKILLS` に解決し直すことで検証）。実ディレクトリに向けられた場合は拒否して例外を投げます。Chronicle が、ツールが実際に所有する skill を削除することは決してありません。

`updateSkillMeta(id, {tags, rating})` は、ローカル専用の整理用メタデータ — Chronicle の DB に存在し、どこにもアップロードされないタグとスター評価 — を保存します。

### バージョン履歴とスナップショット

すべての中央 skill には `~/.chronicle/snapshots/<skill>/` の下に自動的なバージョン履歴が付き、`takeSnapshot(skillId, trigger)` によって管理されます。

- **`imported`** スナップショットは永続的です — インポート時の pristine な状態です。
- **`fs_change`** スナップショットは `startSkillWatcher()` によって取られます。これは中央ストアに対する `fs.watch` で、skill ごとに **500 ms のデバウンス**を持ち、**ローリングで 50 個**保持されます（最も古いものが刈り取られます）。
- スナップショットは**コンテンツハッシュで重複排除**されます。`takeSnapshot` はディレクトリツリーをハッシュ化し、前回のスナップショットから何も変わっていなければ書き込みをスキップします（常に保持される `imported` を除きます）。

`listSnapshots()` / `restoreSnapshot(skillId, snapshotId)` はワンクリックの復元を提供します。復元はまず現在の状態を自動スナップショットし（`restore` トリガーとして）、その後で中央ディレクトリを置き換えます — そして分配はシンボリックリンクによるため、すべてのツールのリンクは、再リンクなしで入れ替えを通して機能し続けます。

### GitHub インポートとアップストリーム追跡

`importFromGithub(repoUrl, branch='main', subpath='')` は、一時ディレクトリへの**浅いクローン**（`git clone --depth 1`）を行い、解決されたコミット SHA を記録し、`SKILL.md` を含むすべてのディレクトリを最大 5 階層まで歩き、それぞれをインポートし、`origin_repo`/`origin_sha` でタグ付けし、`imported` スナップショットを取り、クローンをクリーンアップします。受け付けるのは公開 HTTPS URL のみです。

`checkUpstream(skillId)` は、記録された SHA を `git ls-remote` を使ってリモートの tip と比較します — クローンではなく、単なる ref のルックアップです — これにより、GitHub 由来の skill がその出所からずれているかどうかを一目で確認できます。

## なぜこの形なのか

両方のハブは、他ツールの状態に対する読み取り中心のコントロールプレーンなので、設計は非破壊性に強く傾いています。テイクオーバー前のバックアップ、インポート時のコピー（決して移動しない）、追加のみのシンボリックリンクと「作成したものだけを削除する」という厳格なルール、そして出力の際にすべてのクレデンシャルをマスクすること。これこそが、Chronicle を開発者の実際に稼働している設定に向けても安全である理由です — 最悪のケースは古くなったシンボリックリンクであって、設定の喪失や秘密の漏洩ではありません。これが 6 つのプロダクト原則にどう適合するかは [アーキテクチャ概要](overview.md) を参照してください。

## 関連ページ
- [MCP Hub](../guide/mcp-hub.md) — ユーザー向けガイド: テイクオーバー、ポリシー、インスペクター、Roots。
- [Skills Hub](../guide/skills-hub.md) — 中央ストア、シンボリックリンクのファンアウト、GitHub インポート、バージョン管理。
- [API リファレンス](api-reference.md) — `/api/mcp/*` 管理ルートと `/mcp` エンドポイント。
