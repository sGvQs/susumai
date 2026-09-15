# e2e/ — ops/dashboard.mjs の Playwright E2E テスト

`ops/dashboard.mjs`（運用ダッシュボード）のフロントエンドとAPI連携を、実ブラウザ
（Playwright）から検証する。

## 最重要: 本番には一切触れない

過去に2回、テスト目的のコマンドがそのまま本番の運用スクリプト・launchdサービスに
実行されてしまう事故が起きている。このテストスイートは、それを構造的に再発させない
設計になっている。

- `ops/dashboard.mjs` は `SUSUMAI_DASHBOARD_HOSTING_SH` / `SUSUMAI_DASHBOARD_REHEARSE_CMD`
  で実行対象を差し替えられる（未設定時は本番相当の既定動作のまま、1バイトも変えていない）。
  このテストスイートは**必ず** `e2e/fixtures/mock-hosting*.sh` と
  `e2e/fixtures/mock-rehearse.mjs`（いずれもこのリポジトリ内で完結する偽物）だけを指す。
  本物の `ops/hosting.sh` や `npm run rehearse`（`rehearsal/rehearse.mjs`）を指す
  デフォルト設定のまま `dashboard.mjs` を起動してテストすることは絶対に行わない。
- 監査ログ・CRITICALバナー状態ファイルも `SUSUMAI_DASHBOARD_AUDIT_LOG` /
  `SUSUMAI_DASHBOARD_LAST_CRITICAL` で都度 `os.tmpdir()` 配下の一時ディレクトリに
  向ける（`ops/dashboard-audit.log` 等、後藤さんが対話端末で稼働させているかもしれない
  本物の dashboard.mjs インスタンスと状態ファイルを共有しない）。
- ポートは `SUSUMAI_DASHBOARD_PORT` で本番既定の `4787` とは無関係な高位ポートを
  テストごとにランダムに払い出す（`e2e/dashboard-harness.mjs`）。
- 層2（ブラウザプロセス確認）は `SUSUMAI_DASHBOARD_EXTRA_BROWSER_PROCESSES` で
  Playwright 同梱ブラウザの実プロセス名だけを一時的に許可リストへ追加する。
  **この環境変数はこのテストハーネス以外では絶対に設定しないこと。** 本番運用時に
  設定されていると、層2の確認なしに意図しない自動化ツールからのアクセスを
  許してしまう（`ops/dashboard.mjs` 内のコメントも参照）。
- `ops/hosting.sh` 本体・`~/Library/LaunchAgents/com.susumai.*`・本番launchd
  サービス（`com.susumai.proxy` / `com.susumai.cloudflared`）には、このテスト
  スイートの実行によって一切の書き込み・実行アクセスが発生しない。

## セットアップ

```sh
npm install                      # @playwright/test は devDependencies に含まれる
npx playwright install chromium  # 初回のみ。ブラウザバイナリ（Chromium）をダウンロードする
```

## 実行

```sh
npm run test:e2e
# もしくは
npx playwright test --config e2e/playwright.config.mjs
```

## 構成

| ファイル | 役割 |
| :--- | :--- |
| `playwright.config.mjs` | Playwright 設定（テスト対象ディレクトリ、Chromiumプロジェクトのみ）。 |
| `dashboard-harness.mjs` | `ops/dashboard.mjs` をモック環境・隔離ポート・一時状態ファイルで起動/停止するヘルパー。 |
| `fixtures.mjs` | Playwright のカスタムフィクスチャ（`dashboardPage` など）。 |
| `fixtures/mock-hosting.sh` | `hosting.sh` の成功シナリオ用モック（status/down/up すべて成功）。 |
| `fixtures/mock-hosting-fail.sh` | down/up が両方失敗するシナリオ用モック（CRITICALバナー確認用）。 |
| `fixtures/mock-hosting-degraded.sh` | `loaded=true` だが `healthy=false` を返す status 専用モック（色分け確認用）。 |
| `fixtures/mock-rehearse.mjs` | `npm run rehearse` の代わりに使う、数百msで完了する偽コマンド。 |
| `tests/dashboard.spec.mjs` | 基本表示・ステータス反映・確認モーダル・実行シーケンス（タイプ入力なし）・SSEログ・同時実行時のサーバ側ロック（already-running）の検証。 |
| `tests/critical-banner.spec.mjs` | CRITICALバナーの表示・ack・再読み込み後の永続確認。 |

## 実機観測メモ（層2許可リストの根拠）

`SUSUMAI_DASHBOARD_EXTRA_BROWSER_PROCESSES` に設定している値は、実際に
macOS arm64 上で Playwright バンドル版ブラウザから `ops/dashboard.mjs` 相当の
HTTPサーバへ接続し、その瞬間の `lsof -nP -iTCP:<port>` → `ps -o comm= -p <pid>`
で観測した結果に基づく（2026-09-14 時点）:

- Chromium（headless、`@playwright/test` の既定モード）: `chrome-headless-shell`
- Chromium（headed、`--headed` / `headless:false`）: `Google Chrome for Testing Helper`
- WebKit（headless/headed とも）: `com.apple.WebKit.Networking.Development`
  （本番Safariの `com.apple.WebKit.Networking` とはプロセス名が異なる別プロセス）

Playwright や OS のバージョンが変わった場合、これらのプロセス名も変わりうる。
テストが層2で `non-browser-caller` として弾かれる場合は、上記と同じ手順で
実機観測をやり直し、`dashboard-harness.mjs` の `PLAYWRIGHT_BROWSER_PROCESS_NAMES`
を更新すること。
