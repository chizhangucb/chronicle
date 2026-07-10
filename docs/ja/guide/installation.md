# インストール

Chronicle を macOS にインストールする方法、任意のプラットフォームでソースから実行する方法、そしてタイムトラベルを完全に利用するためにマシンが満たすべき条件を説明します。

Chronicle は、署名・公証済みの macOS アプリとして出荷され、自身を最新に保ちます。クラウドアカウントもサインインも、立ち上げるサーバーもありません——すべてがローカルで動作するため、「インストール」とは文字どおり、バイナリをマシンに入れる（あるいはソースから `npm install` する）だけのことです。このページでは、その両方の方法と、すべての機能を有効にする少数の要件を説明します。

## macOS へのインストール

### Homebrew（推奨）

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

この cask は、公開されている [`chizhangucb/homebrew-chronicle`](https://github.com/chizhangucb/homebrew-chronicle) タップに公開されており、そこは DMG とアップデートフィードもホストしています。`brew upgrade --cask chronicle` で新しいバージョンを取得できます。

### 直接ダウンロード（DMG）

[Releases](https://github.com/chizhangucb/homebrew-chronicle/releases) から DMG を入手してください。

- **arm64** は Apple Silicon（M シリーズ）用
- **x64** は Intel Mac 用

ビルドは **Apple Developer ID で署名され、公証されている**ため、Gatekeeper の警告なしに開けます——`xattr -d com.apple.quarantine` や `--no-quarantine` フラグは*必要ありません*。Chronicle を `/Applications` にドラッグするだけです。

### 自動アップデート

インストール後、Chronicle は自身を最新に保ちます。`electron-updater` がリリースフィードをポーリングし、新しい**公証済み**ビルドをバックグラウンドでダウンロードして、ビルドの準備が整うとワンクリックの **「Relaunch to update」** トーストを表示します。それをクリックすると、クリーンな終了と再起動が行われます——手動での再インストールは不要で、ポートを握ったままの古いプロセスも残りません。

> **注記:** 自動アップデートは、実行中のアプリと同じ Developer ID 署名を共有するビルドのみをインストールします。最初の署名済みリリース（v0.1.6）が引き継ぎの分岐点です——古い未署名のコピーは一度だけ手動でアップグレードすれば、その後は自動アップデートが引き継ぎます。

## ソースからの実行

ソースは macOS、Windows、Linux で動作します。また、これらのプラットフォーム向けのネイティブインストーラーはまだビルドされていないため、現時点で Windows と Linux 上で Chronicle を実行する*唯一の*方法でもあります。

```bash
npm install
```

その後、実行モードを選びます。3 つのモードはすべて**同じ** Express アプリ（`/api`、`/share`、`/mcp`）を提供します——異なるのは、UI をどのように配信するか、そしてその周囲にデスクトップシェルがあるかどうかだけです。

| コマンド | 用途 | ポート |
| --- | --- | --- |
| `npm run dev` | API をプロセス内にマウントした Vite dev サーバー。API ルートは保存時にホットリロードされます（リクエストごとの `ssrLoadModule`）。開発時にはこれを使います。 | http://localhost:4173 |
| `npm run desktop` | Electron シェルにシステムトレイ付きで包まれたプロダクションビルド。日常的なデスクトップ体験です。 | 41730 |
| `npm run standalone` | `127.0.0.1` にバインドされたヘッドレスのプロダクションサーバー（UI + `/api` + `/share` + `/mcp`）。Electron なしで Chronicle を動かすのに便利です。ポートは `PORT` で上書きします。 | 41730 |
| `npm run build` | `vite build` → `dist/`。静的なクライアントバンドルだけで、サーバーはありません。 | — |

なぜ 1 つのポート・1 つのプロセスなのか。Express アプリは Vite dev サーバーに直接マウントされ（`vite.config.js` のプラグイン経由）、Electron 下では `server/standalone.js` によって Vite なしで提供されます。追加したエンドポイントは、3 つのモードすべてで自動的に動作します。この点は、アーキテクチャ概要でさらに詳しく扱っています。

macOS DMG を自分でビルドするには、次を実行します。

```bash
npm run dist:mac   # electron-builder → arm64 + x64 DMGs in release/
```

## 要件

- **macOS 12 以降**（パッケージ版アプリの場合）。ソースは Node が動く環境ならどこでも動作します。
- **Git** — タイムトラベルに必須です。Chronicle は、プロジェクトの履歴に対して `git` を（読み取り専用で）呼び出すことでコードスナップショットを再構築するため、スナップショットパネルを有効にするには、プロジェクトがコミットを持つ Git リポジトリである必要があります。コミットが頻繁であるほど、リプレイの忠実度は高まります。会話の再生はリポジトリがなくても機能しますが、その場合はコードビューが表示されません。
- **ディスク:** アプリ本体は約 200 MB の枠です（約 100 MB の下限は Electron フレームワーク）。加えて、`~/.chronicle/` 配下のローカル SQLite データベースとリプレイサンドボックス用に 500 MB 以上の余裕を見てください。
- **RAM:** 最小 4 GB、数千メッセージにおよぶ大規模セッションには 8 GB 以上を推奨します。

> **ローカルファースト:** ここでは何も外部に通信しません。Chronicle はログを解析してローカルの SQLite データベースに保存し、元のログやプロジェクトリポジトリに書き込むことは決してありません。送信リクエストの正確な一覧（数はごくわずかで、すべて任意です）については[プライバシーとデータ](../reference/privacy-and-data.md)を参照してください。

## 関連

- [クイックスタート](./quickstart.md) — 5 分以内で体験する最初のタイムトラベル。
- [セッションの取り込み](./importing-sessions.md) — 取り込みウィザードと、サポートされている 6 つのツール。
- [設定](../reference/configuration.md) — `~/.chronicle/` の構成、環境変数、`config.json`。
