// e2e/playwright.config.mjs — susumai 運用ダッシュボード (ops/dashboard.mjs) の
// Playwright E2E テスト設定。
//
// 安全上の注意（README.md も参照）:
//   このテストスイートは本物の ops/hosting.sh・npm run rehearse・本番launchd
//   サービス（com.susumai.proxy / com.susumai.cloudflared）には一切触れない。
//   各テストは e2e/dashboard-harness.mjs 経由で、隔離されたポート・モック
//   スクリプト・一時ディレクトリ上の状態ファイルを使う専用の dashboard.mjs
//   インスタンスを起動する。
//
// セットアップ:
//   npm install -D @playwright/test   （実施済み。devDependencies 参照）
//   npx playwright install chromium   （初回のみ。ブラウザバイナリをダウンロードする）
//
// 実行:
//   npx playwright test --config e2e/playwright.config.mjs
//   （または: npm run test:e2e）
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false, // 各テストが自前でポートを払い出すため並列自体は安全だが、
  // lsof ベースの層2チェックを多重実行する負荷を避けるため直列に倒す。
  workers: 1,
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
