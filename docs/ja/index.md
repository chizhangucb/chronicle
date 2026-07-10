# Chronicle ドキュメント

**Chronicle は、AI コーディングセッションのためのローカルファースト（local-first）なタイムマシンです。** AI コーディングアシスタントがすでに書き出している会話ログを取り込み、各メッセージを、その瞬間のコードの正確な状態に対応付けます。この状態は、プロジェクトの Git 履歴から再構築されます。任意のメッセージをクリックすれば、当時のコードへとさかのぼれます。

すべては手元のマシン上で動作します。**LLM の呼び出しはどこにも存在せず、クラウドのバックエンドもなく、元のログやプロジェクトのリポジトリに書き込むことも一切ありません**。Chronicle は AI ツールを観測して整理するだけで、それらを置き換えることはありません。

Chronicle は現在、6 つのツール——**Claude Code、Codex、Cursor、OpenCode、Gemini CLI、GitHub Copilot Chat**——から取り込み、それらのセッションを、パスを基準とした単一のプロジェクトビューに統合します。

> **はじめての方へ** [クイックスタート](guide/quickstart.md)へ進めば、5 分以内に最初のタイムトラベル体験にたどり着けます。

## 3 つの柱

Chronicle の設計思想は **Replay（再生）· Control（制御）· Secure（保護）** です。

- **Replay（再生）** — 任意のセッションを対象とした[タイムトラベル](guide/time-travel.md)、決定論的な[Replay サンドボックス](guide/replay-mode.md)、セッションをドキュメントや再利用可能なプロンプトへ蒸留する[Refine](guide/refine-mode.md)、そして AI が読んだ内容と変更した内容を結びつける[コンテキスト因果関係](guide/context-causality.md)。
- **Control（制御）** — すべてのツールにまたがる [MCP サービス](guide/mcp-hub.md)と [Skills](guide/skills-hub.md) のための統合コントロールプレーン。既存の設定を*引き継ぎ*、*一元化*し、あらゆる場所へ*配布*します。
- **Secure（保護）** — ワンクリックの[セキュリティチェックと秘匿化（redaction）](guide/security-and-sharing.md)、リアルタイムのツール実行前インターセプト、そしてローカルで提供される秘匿化済みの共有リンク。解析と保存はすべてデバイス上に留まります（[プライバシーとデータ](reference/privacy-and-data.md)を参照）。

## ガイド

セットアップして動かし、各機能を順に見ていきましょう。

| ページ | 内容 |
| --- | --- |
| [インストール](guide/installation.md) | Homebrew、署名済み DMG、ソースからの実行、自動アップデート |
| [クイックスタート](guide/quickstart.md) | 5 分以内で体験する最初のタイムトラベル |
| [セッションの取り込み](guide/importing-sessions.md) | 取り込みウィザード、6 つのソースすべて、読み取り専用の保証 |
| [タイムトラベル](guide/time-travel.md) | 再生モード、コードスナップショット、差分ビュー、TimberLine タイムライン |
| [検索とフィルタリング](guide/search-and-filtering.md) | 種類フィルターのチップ、`⌘F` 検索、`⌘K` コマンドパレット |
| [セッションインサイト](guide/session-insights.md) | 概要統計、アクティブ時間、コストと使用量、コンテキストウィンドウのバー |
| [Refine モード](guide/refine-mode.md) | Keep / Delete / Edit / Insert でセッションを蒸留してエクスポート |
| [Replay モード](guide/replay-mode.md) | 隔離されたサンドボックス内での決定論的な再実行 |
| [プロジェクト管理](guide/project-management.md) | 論理プロジェクト、関連付け、Git ピル、同期 |
| [コンテキスト因果関係](guide/context-causality.md) | 信頼度ティア付きのヒューリスティックな読み取り → 変更のリンク付け |
| [ライブストリーミング](guide/live-streaming.md) | 進行中のセッションをリアルタイムで観察 |
| [MCP Hub](guide/mcp-hub.md) | 集約型 MCP サーバー、設定の引き継ぎ、ツールポリシー、Inspector |
| [Skills Hub](guide/skills-hub.md) | スキルの中央保管、シンボリックリンクによる配布、GitHub 取り込み、バージョン管理 |
| [セキュリティと共有](guide/security-and-sharing.md) | セキュリティチェック、カスタムルール、ツール実行前フック、共有リンク |

## リファレンス

| ページ | 内容 |
| --- | --- |
| [キーボードショートカット](reference/keyboard-shortcuts.md) | モード別にまとめたすべてのショートカット |
| [互換性](reference/compatibility.md) | 6 ツールのサポート状況の一覧と、ツールごとのログの場所 |
| [設定](reference/configuration.md) | `~/.chronicle/` の構成、環境変数、`config.json` |
| [プライバシーとデータ](reference/privacy-and-data.md) | ローカルファーストの保証と、正確な送信リクエストの一覧 |

## アーキテクチャ

コードベースを理解し、拡張したいコントリビューター向けです。

| ページ | 内容 |
| --- | --- |
| [概要](architecture/overview.md) | 単一プロセス／単一ポートの設計、実行モード、コンポーネントマップ、原則 |
| [データモデル](architecture/data-model.md) | SQLite スキーマ、正規化されたイベントモデル、`replaceSession` |
| [パーサーと取り込み](architecture/parsers-and-ingestion.md) | イベントモデルの詳細と、新しいソースの追加方法 |
| [Git スナップショットエンジン](architecture/git-snapshot-engine.md) | Git 履歴からのコード状態の再構築 |
| [MCP と Skills の内部構造](architecture/mcp-and-skills-internals.md) | レジストリ、ハブ、Streamable HTTP、スキルの配布 |
| [セキュリティ・ライブ・リプレイ](architecture/security-live-replay.md) | 秘匿化エンジン、SSE ウォッチャー、リプレイエンジン、因果関係 |
| [API リファレンス](architecture/api-reference.md) | すべての REST ルート、SSE ストリーム、`/mcp`、`/share` |
| [デスクトップとパッケージング](architecture/desktop-packaging.md) | Electron シェル、署名、自動アップデート、リリースフロー |

その後、開発環境のセットアップ、ブランチと PR のワークフロー、変更の検証方法については[コントリビューション](contributing.md)を参照してください。

## プロジェクトの背景

Chronicle は、詳細な[プロダクト要求仕様書](AI-session-manager-PRD.md)に基づいて構築されました。その[意思決定ログ](AI-session-manager-PRD.md#9-decision-log-post-implementation)には、実際に出荷されたものと見送られたものが記録されています。[`README`](../README.md) には全機能の一覧があり、[`CHANGELOG`](../CHANGELOG.md) はリリースを追跡しています。

> **ライセンス:** Chronicle は [MIT ライセンス](../LICENSE)で提供されています。
