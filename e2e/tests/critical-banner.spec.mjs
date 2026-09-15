// e2e/tests/critical-banner.spec.mjs — CRITICALバナー表示の確認。
//
// down / up の両方が失敗するシナリオ（e2e/fixtures/mock-hosting-fail.sh）を意図的に
// 発生させ、CRITICAL_DOUBLE_FAILURE が dashboard.mjs の computeOutcome() で
// 判定されてバナーに表示されることを確認する。本物の ops/hosting.sh 等には触れない。
//
// 2026-09-14 のUI再設計に合わせ、確認文字列のタイプ入力（#confirm-input / #prepare-btn）
// は廃止済みのため、実行フローは「本番再起動」→ モーダルの「実行」クリックのみになった。
import { test, expect } from '@playwright/test';
import { startDashboard, MOCK_HOSTING_FAIL, MOCK_REHEARSE_CMD } from '../fixtures.mjs';

test('down/up 双方が失敗するとCRITICALバナーが表示され、確認済みにすると消える', async ({ page }) => {
  const instance = await startDashboard({ hostingSh: MOCK_HOSTING_FAIL, rehearseCmd: MOCK_REHEARSE_CMD });
  try {
    await page.goto(instance.url);

    await page.locator('#open-modal-btn').click();
    await expect(page.locator('#run-btn')).toBeEnabled();
    await page.locator('#run-btn').click();
    await expect(page.locator('#modal-overlay')).toBeHidden();

    // down/up 双方の失敗ログが流れてくる。
    await expect(page.locator('#log-panel')).toContainText('FAILING', { timeout: 10_000 });

    // CRITICALバナーが表示される。
    await expect(page.locator('#critical-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#critical-banner-text')).toContainText('CRITICAL');
    await expect(page.locator('#critical-banner-text')).toContainText('CRITICAL_DOUBLE_FAILURE');

    // 確認済みにする操作でバナーが消える。
    await page.locator('#ack-critical-btn').click();
    await expect(page.locator('#critical-banner')).toBeHidden();
  } finally {
    await instance.stop();
  }
});

test('CRITICALバナーはページ再読み込み後も（ackするまで）表示され続ける', async ({ page }) => {
  const instance = await startDashboard({ hostingSh: MOCK_HOSTING_FAIL, rehearseCmd: MOCK_REHEARSE_CMD });
  try {
    await page.goto(instance.url);
    await page.locator('#open-modal-btn').click();
    await page.locator('#run-btn').click();
    await expect(page.locator('#critical-banner')).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('#critical-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#critical-banner-text')).toContainText('CRITICAL');
  } finally {
    await instance.stop();
  }
});
