# デスクトップシェル、パッケージング、自動アップデート

Chronicle のデスクトップアプリは、dev や standalone モードで動くのと同じヘッドレスサーバーを包む Electron シェルです。このページでは、シェル（`electron/main.mjs`）、`electron-builder` のパッケージング設定、そして署名・公証（notarization）・自動アップデートがどのように組み合わさるかを — コマンドを 1 つずつ辿るランブックとしてではなく、*どう機能し何が必要か*のレベルで — 説明します。

指針となる制約は、Electron が**薄いシェル**であるということです。すなわち、サーバーを起動し、ウィンドウとトレイを所有し、自動アップデートを行う — そして `server/` 配下のどれも Electron を import しません。この分離こそが、将来 Tauri へ乗り換える場合でも書き直しではなくシェルレベルの変更にとどめるものです。インストール手順とリリースのランブックは [インストール](../guide/installation.md) と `CLAUDE.md` のリリースチェックリストを参照してください。

## Electron シェル（`electron/main.mjs`）

起動時、シェルは 4 つのことを順に行います。単一インスタンスのロックを取得し、組み込みサーバーを起動し、トレイを構築し、ウィンドウを表示します。

**組み込みサーバー。** `startBackend()` は `server/standalone.js` を import し、`startServer(41730)` を呼びます — 他のすべてのモードで配信されるのとまったく同じ Express アプリ（`/api`、`/share`、`/mcp`）です。ウィンドウはその後、単に `http://localhost:41730` をロードします。別個の API プロセスはありません。デスクトップアプリ*そのもの*が、Chromium ウィンドウを取り付けた standalone サーバーです。

**トレイが MCP Hub を生かし続ける。** ウィンドウを閉じてもアプリは終了**しません** — close ハンドラーは `e.preventDefault()` を呼び、代わりにウィンドウを隠します。

```js
win.on('close', (e) => {
  if (!quitting) { e.preventDefault(); win.hide(); }
});
```

アプリはシステムトレイに常駐し続けるため、ウィンドウが開いていなくても集約型 MCP Hub が下流のクライアントに配信し続けます。本当に終了する唯一の方法は、トレイメニューの **Quit (stops MCP Hub)** 項目で、これは `app.quit()` の前に `quitting = true` を設定します。`window-all-closed` は意図的に何もしません — アプリはトレイに住むことを意図しています。

**単一インスタンスのロック。** `app.requestSingleInstanceLock()` は 1 マシンにつき 1 つの Chronicle を保証します（ポート `41730` も所有します）。2 度目の起動は既存のウィンドウをフォーカスして終了します。ロックやポートを保持したままの古いプロセスが、「新しいビルドが起動しない」症状のよくある原因です — `CLAUDE.md` のパッケージングの落とし穴を参照してください。

**トレイアイコンはデータ URL として同梱されます**（`nativeImage.createFromDataURL` でインラインに構築された base64 PNG）。そのためアプリはバイナリの画像アセットを一切持ちません。

### アップデーターのブリッジ

自動アップデートは完全にメインプロセスで動きますが、「Relaunch to update（更新のため再起動）」トーストは React UI がレンダリングするため、両者は preload を通した IPC で橋渡しされます。

- `electron/preload.cjs` が `window.chronicleUpdater` をレンダラーに公開します。
- `main.mjs` が `update-available` / `update-downloaded` イベントをウィンドウに転送し（`webContents.send`）、`update:relaunch`（→ `autoUpdater.quitAndInstall()`）と `update:check` を処理します。

dev や standalone（素のブラウザで preload なし）では、そのブリッジが存在しないため、トーストは決してレンダリングされません — そしてすべてのアップデーター処理は `app.isPackaged` でガードされているため、`checkForUpdates()` は非パッケージの実行では何もしません。トーストはアップデートがダウンロードされた*後*にのみ表示されます。dev でそれが見えないのは期待どおりであり、バグではありません。

## ビルドとパッケージング（`package.json` → `build`）

パッケージングは `electron-builder` で、完全に `package.json` 内で設定されます。重要な選択は次のとおりです。

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `asar` | `false` | サーバーは `dist/` とパーサーを `import.meta.url` 経由で素のファイルとして解決する。asar パッキングはそれらのパスを壊す |
| `electronLanguages` | `en`、`zh_CN` | 他のロケールバンドルを削ってアプリを縮小する |
| `files` | `dist/`、`server/`、`electron/`、`hooks/`、`package.json` | ランタイムが必要とするものだけ |
| `mac.target` | `dmg`、`zip` | ダウンロード用の DMG。**zip は electron-updater が更新に使うもの** |
| `mac.hardenedRuntime` | `true` | 公証に必須 |
| `dmg.format` | `ULFO` | electron-builder 26 が受け付ける最も強い DMG 圧縮（`ULMO` ではない） |
| `publish` | github `chizhangucb/homebrew-chronicle` | アップデートフィード + 公開ダウンロードホスト |

### 依存関係の規律

真の**サーバーランタイム**依存だけが `dependencies` に置かれます — `express` と `electron-updater` です。クライアント側のすべて（`react`、`react-dom`、`diff`）は `devDependency` です。Vite がそれらを `dist/` にバンドルし、electron-builder は `dependencies` に含まれる*すべて*をアプリに同梱するからです。`dependencies` に置き間違えられたクライアントライブラリは、こっそりすべてのビルドを太らせます。**新しいクライアント依存は `devDependencies` に入れてください。**

### ビルドスクリプト

| スクリプト | 生成物 |
| --- | --- |
| `npm run build` | `vite build` → `dist/` |
| `npm run dist:mac` | 署名済み（クレデンシャルがあれば）arm64 **と** x64 の DMG + zip を `release/` に |
| `npm run reinstall:mac` | arm64 のみの再ビルド + `/Applications/Chronicle.app` のローカル置き換え |
| `npm run dist:win` | NSIS インストーラー（クロスビルド。実際の Windows では未検証） |
| `npm run dist:linux` | AppImage + `.deb`（実際の Linux では未検証） |

アーキテクチャの選択はビルド設定ではなく CLI フラグに存在します — これが、`dist:mac` が両方のアーキテクチャをビルドする一方で `reinstall:mac` が arm64 のみをビルドする理由です。Windows と Linux のターゲットは設定には存在しますが、**出荷されません** — それらのプラットフォームはソースから実行します（[インストール](../guide/installation.md) を参照）。

## 署名と公証（概念）

macOS ビルドは Apple の **Developer ID** で署名され、公証されるため、Gatekeeper の警告なしに開けます。その仕組みは次のとおりです。

- **`build/notarize.cjs`** が `afterSign` フックです。**環境に `APPLE_*` クレデンシャルが存在するときにのみ**公証します — クレデンシャルがなければ公証もありません。これは意図的です。`npm run dist:mac` は、Apple アカウントを持たないコントリビューターでもグリーンのままでなければならず、未署名ビルドを生成します。
- **`build.mac` にハードコードされた `identity` はありません。** electron-builder は Developer ID 証明書が発見可能なときに署名し、それ以外の場合は未署名ビルドを生成します。`identity: null` を**再追加しないでください** — それは署名をハードに無効化します。
- **署名には `CSC_LINK` ではなく専用のキーチェーンが必要です。** デフォルトの `CSC_LINK=<p12>` の経路は、証明書を使い捨ての一時キーチェーンにインポートしますが、それはシステムの Apple Root に到達できないため、`codesign` が信頼チェーンの構築に失敗します。有効なアプローチは、ユーザーの検索リストに追加された専用のキーチェーン（leaf → intermediate → root の完全なチェーン付き）を使います。チーム ID は `9W7B6USGG9` です。

正確なキーチェーンのセットアップと公証の環境変数は運用のランブックです — ここで重複させるのではなく、`CLAUDE.md` の署名セクションを参照してください。

> **注意:** v0.1.6 が最初の署名済みリリースでした。未署名ビルド（≤0.1.5）のユーザーは 1 度だけ手動でアップグレードします。その後は自動アップデートが引き継ぎます。

## 自動アップデート

自動アップデートは `electron-updater` です。フィードは `build.publish`（github `chizhangucb/homebrew-chronicle`）で、ビルド時に `app-update.yml` に焼き込まれます — `electron/main.mjs` にハードコードされているのでは**ありません**。フローは次のとおりです。

1. `autoUpdater.checkForUpdates()` が起動時と 6 時間ごとに実行されます（パッケージ版のみ）。
2. `autoDownload` が新しいビルドをバックグラウンドで取得し、UI は `update-downloaded` で **「Relaunch to update」** トーストを表示します。
3. `quitAndInstall()`（トーストから IPC 経由で）が、クリーンな終了 + 入れ替え + 再起動を行います。

アップデートを実際にインストールさせるには、2 つの厳格な要件があります。

- **`package.json` のバージョンがリリースタグと（`v` を除いて）一致していなければなりません。** electron-updater がフィードに対して semver 比較を行うためです。
- **electron-updater は DMG ではなく zip から更新します** — そのため、リリースには DMG と並んで `.zip` に加えて `latest-mac.yml` と `.blockmap` をアップロードする必要があります。

そして安全ゲート: **稼働中のアプリとアップデートが Developer ID 署名を共有しているときにのみインストールされます。** これが、自動アップデートが最初の署名済みリリースまで休眠している理由であり、また署名済みユーザーに改ざんされたビルドをプッシュできない理由です。

## Homebrew 配布

Homebrew の cask は `packaging/homebrew/` にあり、公開の `chizhangucb/homebrew-chronicle` タップに公開されます。このタップはリリースの DMG もホストし、自動アップデートフィードとしても機能します。インストールは次のとおりです。

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

タップリポジトリ*そのもの*が公開ターゲットであるため、各リリースには `chronicle` リポジトリ（記録用）とタップ（公開ダウンロード + アップデートフィード）の両方に対応するリリースが必要で、cask のバージョンと両方の SHA が DMG に追随していなければなりません。`CLAUDE.md` のリリースチェックリストを参照してください。

## 関連ページ
- [インストール](../guide/installation.md) — インストール方法、実行モード、要件、自動アップデートの UX。
- [アーキテクチャ概要](overview.md) — シングルプロセス・シングルポートと、Electron を一切 import しないルール。
- [設定](../reference/configuration.md) — `~/.chronicle/` のレイアウト、環境変数、`config.json`。
