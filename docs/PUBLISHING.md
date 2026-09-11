# PUBLISHING — docs.susumai.net の公開手順（後藤さん専用）

`docs/index.html` を GitHub Pages で `docs.susumai.net` として公開する手順。初回だけ。

## 前提

- `docs/`（`index.html` / `CNAME` / `.nojekyll`）が `main` にマージ済み
- `susumai.net` のゾーンが Cloudflare にある

## 1. GitHub Pages を有効化（リポジトリ設定・初回だけ）

1. https://github.com/sGvQs/susumai/settings/pages
2. Build and deployment → Source: **Deploy from a branch**
3. Branch: **`main`** ／ フォルダ: **`/docs`** → Save
4. Custom domain 欄に **`docs.susumai.net`** を入力 → Save（`docs/CNAME` があるので既に埋まっていることがある）

## 2. Cloudflare に DNS レコードを1本追加

`susumai.net` ゾーン →

| 項目 | 値 |
| :--- | :--- |
| Type | CNAME |
| Name | `docs` |
| Target | `sgvqs.github.io` |
| Proxy status | **DNS only（グレー雲）** ← 最初は必ずこれ |

**プロキシ（オレンジ雲）にすると GitHub 側の証明書発行（Let's Encrypt）が失敗することがある。** Pages の設定画面で「証明書が発行されました／設定は正しい」と緑になってから、オレンジ雲に変えるのは任意（変えなくてもよい）。

## 3. 反映を待って HTTPS を強制

- 数分〜数十分待つ
- Pages の設定画面が緑になったら **Enforce HTTPS** にチェック
- `https://docs.susumai.net` にアクセスして表示を確認

## 詰まったら

- Pages 設定画面に出るエラーメッセージが一番正確（DNS 未反映・CNAME 誤りなど、原因を教えてくれる）
- `dig docs.susumai.net` で `sgvqs.github.io` の CNAME が引けているか確認

## 更新のしかた（公開した後）

`docs/index.html` を直接編集する運用ではない（`main` は branch protection で直接 push 不可・CI 必須）。

```sh
git checkout -b docs/update-xxxx
# docs/index.html を編集
git add docs/
git commit -m "docs: ..."
git push -u origin docs/update-xxxx
gh pr create --fill
gh pr merge --squash   # CI（test）が緑になってから
```

マージすると GitHub Pages が数分以内に自動で再デプロイする。手動デプロイ操作は不要。
