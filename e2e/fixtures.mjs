// e2e/fixtures.mjs — Playwright のカスタムフィクスチャ。
// 各テストごとに独立した（モック環境に向けた）ops/dashboard.mjs インスタンスを
// 起動し、ページをその view token 付きURLへ遷移させてから使わせる。
// テスト終了後は必ず該当インスタンスだけを停止する（他インスタンス・本物の
// dashboard.mjs プロセスには一切触れない）。
import { test as base, expect } from '@playwright/test';
import {
  startDashboard,
  MOCK_HOSTING_OK,
  MOCK_HOSTING_FAIL,
  MOCK_HOSTING_DEGRADED,
  MOCK_REHEARSE_CMD,
} from './dashboard-harness.mjs';

export const test = base.extend({
  // 既定（成功シナリオ）の dashboard インスタンス + そのページ。
  dashboardPage: async ({ page }, use) => {
    const instance = await startDashboard({ hostingSh: MOCK_HOSTING_OK, rehearseCmd: MOCK_REHEARSE_CMD });
    try {
      await page.goto(instance.url);
      await use({ page, instance });
    } finally {
      await instance.stop();
    }
  },
});

export { expect, startDashboard, MOCK_HOSTING_OK, MOCK_HOSTING_FAIL, MOCK_HOSTING_DEGRADED, MOCK_REHEARSE_CMD };
