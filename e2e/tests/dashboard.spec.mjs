// e2e/tests/dashboard.spec.mjs — susumai 運用ダッシュボードの基本シナリオ。
//
// **本物の ops/hosting.sh・npm run rehearse・本番launchdサービスには一切触れない。**
// すべて e2e/fixtures/ のモックスクリプトと、隔離されたポート・一時状態ファイルに
// 向けて起動した ops/dashboard.mjs インスタンスに対してのみ操作する
// （e2e/dashboard-harness.mjs 参照）。
//
// 2026-09-14 のUI再設計（Disk Utility 風の左サイドバー＋右ペイン詳細情報バー、
// 確認文字列のタイプ入力廃止）に合わせて更新済み。
import {
  test,
  expect,
  startDashboard,
  MOCK_HOSTING_OK,
  MOCK_HOSTING_FAIL,
  MOCK_HOSTING_DEGRADED,
  MOCK_REHEARSE_CMD,
} from '../fixtures.mjs';

// 矢印のclassは常に "diagram-arrow" と "connected"/"disconnected" のどちらか一方を
// 持つ。"disconnected" は部分文字列として "connected" を含むため、単純な /connected/
// では両方にマッチしてしまう。トークン境界を明示したこの正規表現で区別する。
const CONNECTED_CLASS = /(^|\s)connected(\s|$)/;
const DISCONNECTED_CLASS = /(^|\s)disconnected(\s|$)/;
const ARROW_IDS = [
  'arrow-cli-proxy',
  'arrow-proxy-cloudflared',
  'arrow-cloudflared-edge',
  'arrow-edge-public',
  'arrow-proxy-ollama',
];

test.describe('トップページの基本要素', () => {
  test('タイトルバー・サイドバー・アーキテクチャ図・実行ボタンが表示される', async ({ dashboardPage }) => {
    const { page } = dashboardPage;

    // タイトルバーは廃止済み。アプリ名はツールバー左端の .os-toolbar-title に移設されている。
    await expect(page.locator('.os-titlebar')).toHaveCount(0);
    await expect(page.locator('.os-toolbar-title')).toHaveText('susumai 運用ダッシュボード');

    // 左サイドバー: 監視対象一覧（proxy / cloudflared / Ollama）
    await expect(page.locator('#sidebar-item-proxy')).toBeVisible();
    await expect(page.locator('#sidebar-item-cloudflared')).toBeVisible();
    await expect(page.locator('#sidebar-item-ollama')).toBeVisible();
    await expect(page.locator('#sidebar-item-proxy')).toContainText('proxy :8787');
    await expect(page.locator('#sidebar-item-ollama')).toContainText('Ollama');

    // アーキテクチャ図
    await expect(page.locator('#diagram')).toBeVisible();
    await expect(page.locator('#rect-proxy')).toBeVisible();
    await expect(page.locator('#rect-cloudflared')).toBeVisible();
    await expect(page.locator('#rect-public')).toBeVisible();

    // 詳細情報バー（Disk Utility 下部のキー・バリュー情報バー相当）
    await expect(page.locator('#detail-kv')).toBeVisible();
    await expect(page.locator('.kv-item')).toHaveCount(4);

    // 実行ボタン（右ペイン下部）
    await expect(page.locator('#open-modal-btn')).toBeVisible();
    await expect(page.locator('#open-modal-btn')).toContainText('本番再起動');
  });
});

test.describe('ステータスAPIの反映', () => {
  test('healthy な状態がアーキテクチャ図・サイドバー・詳細情報バーに反映される（既定のモック）', async ({
    dashboardPage,
  }) => {
    const { page } = dashboardPage;
    await expect(page.locator('#rect-proxy')).toHaveAttribute('fill', '#2e7d32');
    await expect(page.locator('#rect-cloudflared')).toHaveAttribute('fill', '#2e7d32');
    await expect(page.locator('#rect-public')).toHaveAttribute('fill', '#2e7d32');

    // 既定選択は proxy。詳細情報バーに loaded/state/pid/healthy が反映される。
    await expect(page.locator('#detail-target-name')).toHaveText('proxy :8787');
    await expect(page.locator('.kv-value[data-field="loaded"]')).toHaveText('true');
    await expect(page.locator('.kv-value[data-field="state"]')).toHaveText('running');
    await expect(page.locator('.kv-value[data-field="pid"]')).toHaveText('11111');
    await expect(page.locator('.kv-value[data-field="healthy"]')).toHaveText('true');
  });

  test('loaded だが unhealthy な状態は赤で反映される', async ({ browser }) => {
    const instance = await startDashboard({ hostingSh: MOCK_HOSTING_DEGRADED, rehearseCmd: MOCK_REHEARSE_CMD });
    const page = await browser.newPage();
    try {
      await page.goto(instance.url);
      await expect(page.locator('#rect-proxy')).toHaveAttribute('fill', '#c62828');
      await expect(page.locator('#rect-cloudflared')).toHaveAttribute('fill', '#2e7d32');
      await expect(page.locator('#rect-public')).toHaveAttribute('fill', '#c62828');
      await expect(page.locator('.kv-value[data-field="healthy"]')).toHaveText('false');
    } finally {
      await page.close();
      await instance.stop();
    }
  });
});

test.describe('アーキテクチャ図の矢印: 常時接続表示', () => {
  test('初期状態では矢印5本ともdisconnected（灰色・非アニメーション）で表示される', async ({ browser }) => {
    const instance = await startDashboard({ hostingSh: MOCK_HOSTING_OK, rehearseCmd: MOCK_REHEARSE_CMD });
    const page = await browser.newPage();
    try {
      // /api/status の応答をわざと遅延させ、pollStatus() が解決する前の初期描画
      // （HTMLの初期disconnectedクラス + 起動時の renderArrows() 安全側デフォルト呼び出し）
      // を確実に観測する。
      await page.route('**/api/status*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.continue();
      });
      await page.goto(instance.url);
      for (const id of ARROW_IDS) {
        await expect(page.locator('#' + id)).toHaveClass(DISCONNECTED_CLASS);
        await expect(page.locator('#' + id)).not.toHaveClass(CONNECTED_CLASS);
      }
    } finally {
      await page.close();
      await instance.stop();
    }
  });

  test('healthyなモック応答で矢印①②③④がconnectedになり、⑤(proxy-ollama)は常にdisconnectedのまま', async ({
    dashboardPage,
  }) => {
    const { page } = dashboardPage;
    await expect(page.locator('#arrow-cli-proxy')).toHaveClass(CONNECTED_CLASS);
    await expect(page.locator('#arrow-proxy-cloudflared')).toHaveClass(CONNECTED_CLASS);
    await expect(page.locator('#arrow-cloudflared-edge')).toHaveClass(CONNECTED_CLASS);
    await expect(page.locator('#arrow-edge-public')).toHaveClass(CONNECTED_CLASS);
    await expect(page.locator('#arrow-proxy-ollama')).toHaveClass(DISCONNECTED_CLASS);
    await expect(page.locator('#arrow-proxy-ollama')).not.toHaveClass(CONNECTED_CLASS);
  });

  test('cloudflaredはloadedだがoverallHealthyがfalseの場合、①②③はconnected・④はdisconnectedに個別分岐する', async ({
    browser,
  }) => {
    // MOCK_HOSTING_DEGRADED: proxy/cloudflared とも loaded=true だが overallHealthy=false。
    // ③(cloudflared-edge)はcf.loadedのみで判定するため connected のまま、
    // ④(edge-public)はoverallHealthyで判定するため disconnected になる、という
    // 個別トグルを検証する。
    const instance = await startDashboard({ hostingSh: MOCK_HOSTING_DEGRADED, rehearseCmd: MOCK_REHEARSE_CMD });
    const page = await browser.newPage();
    try {
      await page.goto(instance.url);
      await expect(page.locator('#arrow-cli-proxy')).toHaveClass(CONNECTED_CLASS);
      await expect(page.locator('#arrow-proxy-cloudflared')).toHaveClass(CONNECTED_CLASS);
      await expect(page.locator('#arrow-cloudflared-edge')).toHaveClass(CONNECTED_CLASS);
      await expect(page.locator('#arrow-edge-public')).toHaveClass(DISCONNECTED_CLASS);
      await expect(page.locator('#arrow-proxy-ollama')).toHaveClass(DISCONNECTED_CLASS);
    } finally {
      await page.close();
      await instance.stop();
    }
  });

  test('unhealthy（down/up失敗）なモック環境では矢印がすべてdisconnected（灰色）に戻る', async ({ browser }) => {
    const instance = await startDashboard({ hostingSh: MOCK_HOSTING_FAIL, rehearseCmd: MOCK_REHEARSE_CMD });
    const page = await browser.newPage();
    try {
      await page.goto(instance.url);
      for (const id of ARROW_IDS) {
        await expect(page.locator('#' + id)).toHaveClass(DISCONNECTED_CLASS);
        await expect(page.locator('#' + id)).not.toHaveClass(CONNECTED_CLASS);
      }
    } finally {
      await page.close();
      await instance.stop();
    }
  });
});

test.describe('サイドバーの選択と詳細情報バー', () => {
  test('サイドバーで対象を切り替えると詳細情報バーの内容が切り替わる', async ({ dashboardPage }) => {
    const { page } = dashboardPage;

    await page.locator('#sidebar-item-cloudflared').click();
    await expect(page.locator('#sidebar-item-cloudflared')).toHaveClass(/selected/);
    await expect(page.locator('#sidebar-item-proxy')).not.toHaveClass(/selected/);
    await expect(page.locator('#detail-target-name')).toHaveText('cloudflared');
    await expect(page.locator('.kv-value[data-field="pid"]')).toHaveText('22222');

    // Ollama はこのリポジトリの管轄外（/api/status が返さない）ため「不明」表示になる。
    await page.locator('#sidebar-item-ollama').click();
    await expect(page.locator('#sidebar-item-ollama')).toHaveClass(/selected/);
    await expect(page.locator('#detail-target-name')).toHaveText('Ollama');
    await expect(page.locator('.kv-value[data-field="loaded"]')).toHaveText('不明');
    await expect(page.locator('.kv-value[data-field="state"]')).toHaveText('不明');
    await expect(page.locator('.kv-value[data-field="pid"]')).toHaveText('不明');
    await expect(page.locator('.kv-value[data-field="healthy"]')).toHaveText('不明');
  });
});

test.describe('確認モーダルと本番再起動シーケンス（モック対象・タイプ入力なし）', () => {
  test('本番再起動ボタン→確認モーダル→実行ボタンのクリックのみでシーケンスが進み、ログとステップが表示される', async ({
    dashboardPage,
  }) => {
    const { page } = dashboardPage;
    await page.locator('#open-modal-btn').click();
    await expect(page.locator('#modal-overlay')).toBeVisible();

    // タイプ入力欄は存在しない。実行ボタンは最初から有効。
    await expect(page.locator('#confirm-input')).toHaveCount(0);
    await expect(page.locator('#prepare-btn')).toHaveCount(0);
    await expect(page.locator('#run-btn')).toBeEnabled();

    await page.locator('#run-btn').click();
    // 実行開始（202）でモーダルが閉じる。
    await expect(page.locator('#modal-overlay')).toBeHidden();

    // ステップchipが順に active になる（down → rehearse → up）。モックは高速なので
    // 見逃す可能性を考え、chip の active/非active の遷移ではなく最終的なログ内容で検証する。
    await expect(page.locator('#log-panel')).toContainText('down --target proxy: ok', { timeout: 10_000 });
    await expect(page.locator('#log-panel')).toContainText('mock-rehearse', { timeout: 10_000 });
    await expect(page.locator('#log-panel')).toContainText('up --target proxy: ok', { timeout: 10_000 });

    // SSEで配信されたログ行がステップごとの色分けクラスを持つ（実装のCSSクラス契約）。
    await expect(page.locator('#log-panel .log-down').first()).toBeVisible();
    await expect(page.locator('#log-panel .log-rehearse').first()).toBeVisible();
    await expect(page.locator('#log-panel .log-up').first()).toBeVisible();

    // シーケンス終了後、ステップchipはすべて非activeに戻る。
    await expect(page.locator('#chip-down')).not.toHaveClass(/active/);
    await expect(page.locator('#chip-rehearse')).not.toHaveClass(/active/);
    await expect(page.locator('#chip-up')).not.toHaveClass(/active/);
  });

  test('同時に2回 POST すると片方だけ受理され、もう片方は already-running (409) になる（サーバ側ロック）', async ({
    dashboardPage,
  }) => {
    const { page, instance } = dashboardPage;
    const viewToken = new URL(instance.url).searchParams.get('t');

    // クライアントJSのボタン無効化に頼らず、サーバ側の currentStep ロックだけで
    // 二重実行が防がれることを検証する。2つの fetch をほぼ同時に発行する
    // （どちらも await せずに構築するため、ネットワーク的にほぼ同時にサーバへ届く）。
    const statuses = await page.evaluate(async (viewToken) => {
      const p1 = fetch(`/api/execute/run?t=${viewToken}`, { method: 'POST' }).then((r) => r.status);
      const p2 = fetch(`/api/execute/run?t=${viewToken}`, { method: 'POST' }).then((r) => r.status);
      return Promise.all([p1, p2]);
    }, viewToken);
    expect(statuses.sort()).toEqual([202, 409]);

    // シーケンス自体は最後まで完走することを確認しておく。
    await expect(page.locator('#log-panel')).toContainText('up --target proxy: ok', { timeout: 10_000 });
  });
});
