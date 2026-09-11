# QUICKSTART — susumai を使う

別 PC で susumai を使う人向け。コマンドだけ。詳細は README.md。

## 初回（1回だけ）

```
npm i -g susumai
susumai login
susumai config set --url https://llm.susumai.net
```

- `susumai login`: 表示された URL をブラウザで開き GitHub 承認。許可リストにあるアカウントで。
- Node.js >= 22.18 が必要。

## 毎回

```
susumai "質問"                  # ワンショット
susumai                         # 対話 REPL（.exit で終了）
echo "要約して" | susumai        # パイプ入力
```

## 詰まったら

| 症状 | 対処 |
| :--- | :--- |
| 401 認証エラー | `susumai login` し直す |
| 403 | そのアカウントは未許可。ホスト管理者に許可リスト追加を依頼 |
| 応答が返らない | ホストが停止中。ホスト管理者へ連絡 |
| ブラウザ不可の環境 | classic PAT: `susumai config set --token ghp_...`（scope は `read:user` のみ） |

詳細は README.md。
