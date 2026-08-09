# メトリクスとコントラクトビュー

Chronicle v0.2 は、データベースを外部のコンシューマーが読める**メトリクス基盤（metrics substrate）**に変えます。メッセージ単位のトークン使用量、サイドチェーン（サブエージェント）のアトリビューション、保存された時間メトリクス、バージョン付きの SQL コントラクトビュー、そして FTS5 全文インデックスです。このページは、スキーマへの追加と、外部のリーダーが依拠できるコントラクトを文書化します。

設計上の制約は Chronicle の他のあらゆる場所と同じです。すべてはインポート時にログからローカルで計算されます — LLM 呼び出しもネットワークもなく、コンシューマーはビューだけを読むため、ベーステーブルは自由にリファクタリングできます。

## サイドチェーンとアトリビューションのカラム（`messages`）

すべての追加は、既存のパターンに従い、`server/db.js` 内の冪等な `ALTER TABLE` マイグレーションです。

| カラム | 型 | 設定するもの | 意味 |
| --- | --- | --- | --- |
| `is_sidechain` | INTEGER (0/1) | すべてのパーサー | `1` = サブエージェント/サイドチェーンのイベント。Claude Code パーサーは、サイドチェーンの行を捨てるのではなく、いまや**インポート**します |
| `agent_type` | TEXT | Claude Code パーサー | サイドチェーン行のサブエージェント種別（例: `Explore`、`general-purpose`）。サイドチェーンの最初の user メッセージとメインチェーンの `Task`/`Agent` `tool_use` の入力（`subagent_type`）をペアリングして導出されます。一致しない場合やメインチェーンの行では `NULL` |
| `skill` | TEXT | Claude Code パーサー | アクティブなスキルのコンテキスト。`Skill` 呼び出しの `tool_use` 行と、`<command-name>` ターンの行に設定され、それ以外は `NULL`。「呼び出しから次の user ターンまでの間のメッセージ」というスパン型のアトリビューションは意図的に**試みていません** — ヒューリスティックに過ぎるため、コンシューマーは代わりに呼び出しごとにグルーピングします |

`sessions` には `sidechain_count`（カードや分析のための安価な非正規化）が追加されます。

知っておく価値のあるスコープのルール: `sessions.context_tokens` はその定義を維持します（最後の**メインチェーン**の API 呼び出し。Claude Code 自身のステータスラインに一致）。Cost & Usage の合計と Agent Active はいまやサイドチェーンを**含み**、デフォルトのメッセージ数、プレイバック、リファインはそれらを**除外**します（`is_sidechain = 0` での UI フィルター）。

## メッセージ単位のトークンカラム（`messages`）

assistant 行の 5 つの INTEGER カラム: `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_w5m_tokens`、`cache_w1h_tokens`。

1 回の API 呼び出し = 1 セットの数値で、**その呼び出しの最初のイベント**に保存されます（同じ呼び出しの他のイベントは `NULL`）。これが、最もコストの高いメッセージのランキングや、ドル加重のスキル/ツールのアトリビューションを可能にするものです — セッションレベルの `sessions.usage` JSON だけではそれらに答えられません。サイドチェーンの使用量も含まれます（以前は完全に捨てられていました）。Claude 以外のパーサーも、ログに使用量が含まれていればこれらを埋めます。ドルコストはコンシューマー側のままです（静的な価格テーブル、`src/models.js` のパターン） — **データベースはトークンを保存し、決してドルは保存しません**。

## 時間メトリクス（`sessions` に保存）

両方のメトリクスはインポート時に共有サーバーモジュールで計算されて保存されるため、UI とコントラクトビューは、クライアント側で再導出するのではなく、1 つの数値を読むだけで済みます。

**`agent_active_ms`** — 正準的な「Agent Active」。連続するメッセージ間のギャップにわたる合計です（すべての行、サイドチェーン込み、`ts` でソート — タイムラインごとの単一スキャンなので、重なったサイドチェーン時間が二重に数えられることはありません）。ここで:

1. **本物の人間のプロンプト**につながるギャップ（`SYNTHETIC_USER_RE` 分類器 — `user` ロールの行がすべて人間とは限りません）→ 完全に**除外**。
2. 先行する `tool_use` に対応づけられた `tool_result` で終わるギャップ → **全額**カウント（実際のツール/ビルド時間、上限なし）。
3. 権限承認のやり取り → 人間のプロンプトとして扱う（除外）。
4. それ以外のすべてのギャップ → カウントするが、各ギャップは**10 分で上限**。

**`engaged_ms`** — 「Engaged time」、拡張機能スタイルのハンズオン時間です。**すべての**メッセージ間ギャップの合計で、各ギャップは**90 分で上限**、人間/合成の区別はありません。

上限なしの最初から最後までのスパンは、引き続き Total Duration です。Overview では、Agent Active はその統計カードを維持し、Engaged time は副次的な行として表示され、それぞれ独自の ⓘ 説明を持ちます。

## コントラクトビューと `user_version`

外部のコンシューマー（例: ダッシュボード）は `contract_*` ビュー**のみ**を読みます — **コンテンツカラムのない**（メッセージテキストなし、ツール入力なし）読み取り専用の**メトリクス**サーフェスです。ビューがその形を維持する限り、ベーステーブルは自由にリファクタリングできます。

```sql
-- One row per message: metrics + pointers, NO content columns.
CREATE VIEW contract_message_metrics AS
SELECT m.session_id, m.seq, m.ts, m.kind, m.model,
       m.is_sidechain, m.agent_type, m.skill,
       m.tool_name,
       CASE WHEN m.tool_name LIKE 'mcp__%'
            THEN substr(m.tool_name, 6, instr(substr(m.tool_name, 6), '__') - 1)
       END AS mcp_server,
       m.input_tokens, m.output_tokens, m.cache_read_tokens,
       m.cache_w5m_tokens, m.cache_w1h_tokens,
       s.file_path AS source_file
FROM messages m JOIN sessions s ON s.id = m.session_id;

-- One row per session: identity, span, usage JSON, stored durations.
CREATE VIEW contract_sessions AS
SELECT s.id, s.source, p.path AS project_path, s.file_path,
       s.started_at, s.ended_at, s.message_count, s.sidechain_count,
       s.context_tokens, s.usage,
       s.agent_active_ms, s.engaged_ms
FROM sessions s JOIN projects p ON p.id = s.project_id;
```

ロールアップ（スキルごと、モデルごと、最もコストの高いメッセージ）は、コンシューマーがこの 2 つのビューから導出できます。Chronicle は事前集計を行いません。

**バージョニングのコントラクト:** マイグレーション時に `PRAGMA user_version = 1` が設定されます。これは**破壊的なビュー変更のときにのみ**上げられます — カラムの追加では上げません。コンシューマーは `user_version` を確認し、`0` や未知の値に対しては形を推測するのではなく、**大きな声で拒否**しなければなりません。

## FTS5 全文インデックス

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(text, tool_input, content=messages, content_rowid=id);
```

`messages.text` と `tool_input` にわたる external-content の FTS5 テーブルです。これは `replaceSession` の内部で投入されます — インポートはセッション全体の削除と再挿入であるため、同じトランザクション内でセッションの FTS 行を再構築すれば、**トリガーなしで**インデックスの一貫性が保たれます。

`GET /api/search` は、以前と同じレスポンス形式のまま FTS5 の `MATCH` を使い、FTS テーブルが存在しない場合は **`LIKE` にフォールバック**します。Node にバンドルされた SQLite には FTS5 が含まれています。利用可否は起動時に検証され、この機能はソフトに失敗します — 検索は常に動作し、FTS はそれを速くするだけです。

## 関連ページ

- [データモデル](data-model.md) — これらのカラムとビューが載るベーステーブルと、`replaceSession`。
- [セッションのインサイト](../guide/session-insights.md) — 時間、コスト、使用量のユーザー向けビュー。
- [検索とフィルタリング](../guide/search-and-filtering.md) — FTS5 インデックスに支えられたグローバル検索。
- [API リファレンス](api-reference.md) — `/api/search` ルート。
