# HOSTING — susumai ホスト運用（後藤さん専用）

前提: `com.susumai.proxy` と `com.susumai.cloudflared` が launchd 常駐済み（構築は `ops/README.md` / Vault `Gamebook_susumai_auth`。背景は `rehearsal/RUNBOOK.md` / gamebook）。

## 開始 / 終了

主経路はこの2コマンド（`ops/hosting.sh`。詳細な仕様はスクリプト冒頭コメント）:

```
ops/hosting.sh up   --target all
ops/hosting.sh down --target all
```

- `up`: 対象がすでに healthy（公開URL経由で401）なら何もしない no-op。そうでなければ
  bootout → 自然終了待ち（既定15秒、超えたら強制kill）→ bootstrap → 健全性待ち（既定10秒）を行う。
- `down`: `all` なら公開の入口（cloudflared）を先に閉じてからバックエンド（proxy）を止める。
- 個別対象だけを操作したい場合は `--target proxy` / `--target cloudflared`。
- 途中で失敗したら abort して対象ラベルの現在状態と結果一覧を表示し、exit 1 で終わる（半端な状態のまま放置しない）。

## 状態を見る

```
launchctl print gui/$(id -u)/com.susumai.proxy | grep -E 'state = (running|not running)'
launchctl print gui/$(id -u)/com.susumai.cloudflared | grep -E 'state = (running|not running)'
curl -s -o /dev/null -w '%{http_code}\n' https://llm.susumai.net/api/tags   # 401 = 到達 OK
tail ~/Library/Logs/susumai/proxy-access.log
```

## 再起動 / 1インスタンスに収束

健全に稼働中のサービスをあえて作り直したい場合は `kickstart -k` を使う
（`hosting.sh up` は既にhealthyな対象には何もしない no-op 仕様のため、作り直しの用途には使えない）。

```
launchctl kickstart -k gui/$(id -u)/com.susumai.proxy
launchctl kickstart -k gui/$(id -u)/com.susumai.cloudflared
```

## 止める / 復帰

個別に止める・戻すだけなら `hosting.sh down` / `up --target <個別>` に集約されている。

```
ops/hosting.sh down --target proxy
ops/hosting.sh up   --target proxy
```

cloudflared も同様（`--target cloudflared`）。

## 許可リストに人を足す / 外す

```
curl -s https://api.github.com/users/<name> | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'
```

1. 上で数値 id を取得（`curl ... | grep '"id"'` でも可）
2. `rehearsal/allowlist.prod.json` を編集（id / login / note）
3. `launchctl kickstart -k gui/$(id -u)/com.susumai.proxy`

## rehearse を回す

```
ops/hosting.sh down --target proxy
npm run rehearse
ops/hosting.sh up   --target proxy   # 検証後に必ず戻す
```

`pkill` は使わない（`KeepAlive` で即復活）。

## Ollama が落ちてる / モデル

```
ollama serve
ollama list
ollama pull deepseek-r1:8b
```

## ログの場所

`~/Library/Logs/susumai/` — proxy-access.log / proxy-out.log / proxy-err.log / cloudflared-out.log / cloudflared-err.log
