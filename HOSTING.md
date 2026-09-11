# HOSTING — susumai ホスト運用（後藤さん専用）

前提: `com.susumai.proxy` と `com.susumai.cloudflared` が launchd 常駐済み（構築は `ops/README.md` / Vault `Gamebook_susumai_auth`。背景は `rehearsal/RUNBOOK.md` / gamebook）。

## 状態を見る

```
launchctl print gui/$(id -u)/com.susumai.proxy | grep -E 'state = (running|not running)'
launchctl print gui/$(id -u)/com.susumai.cloudflared | grep -E 'state = (running|not running)'
curl -s -o /dev/null -w '%{http_code}\n' https://llm.susumai.net/api/tags   # 401 = 到達 OK
tail ~/Library/Logs/susumai/proxy-access.log
```

## 再起動 / 1インスタンスに収束

```
launchctl kickstart -k gui/$(id -u)/com.susumai.proxy
launchctl kickstart -k gui/$(id -u)/com.susumai.cloudflared
```

## 止める / 復帰

```
launchctl bootout gui/$(id -u)/com.susumai.proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.susumai.proxy.plist
```

cloudflared も同様（plist: `~/Library/LaunchAgents/com.susumai.cloudflared.plist`）。

## 許可リストに人を足す / 外す

```
curl -s https://api.github.com/users/<name> | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'
```

1. 上で数値 id を取得（`curl ... | grep '"id"'` でも可）
2. `rehearsal/allowlist.prod.json` を編集（id / login / note）
3. `launchctl kickstart -k gui/$(id -u)/com.susumai.proxy`

## rehearse を回す

```
launchctl bootout gui/$(id -u)/com.susumai.proxy
npm run rehearse
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.susumai.proxy.plist   # 検証後に必ず戻す
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
