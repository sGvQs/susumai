/*
 * susumai リハーサル用 undici (global fetch) ストリームスパイク
 * ----------------------------------------------------------------------------
 * 目的:
 *   Cloudflare Tunnel → allowlist プロキシ → Ollama /api/chat のストリーミングが
 *   別PC側の Node (undici) から見て「逐次届くか・NDJSON が壊れないか・中断が
 *   上流に伝播するか・死んだトンネルで無限待ちにならないか」を計測する。
 *
 * 使い方:
 *   node rehearsal/fetch-spike.mjs --url <baseUrl> --token <token> \
 *     [--model deepseek-r1:8b] [--abort-after <ms>] [--think <true|false>]
 *
 *   --url         プロキシ/トンネルの base URL（末尾スラッシュ不要）
 *   --token       Bearer トークン
 *   --model       既定 deepseek-r1:8b
 *   --abort-after 指定 ms 後に AbortController.abort()。abort 後 3 秒待って終了
 *   --think       既定 true（Ollama の think パラメータ）
 *
 * 出力:
 *   最後に JSON サマリを整形（2 スペースインデント・複数行）で stdout に出力する
 *   （呼び出し側でファイルに保存する前提）。
 * ----------------------------------------------------------------------------
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args.url || '').replace(/\/+$/, '');
const token = args.token || '';
const model = args.model || 'deepseek-r1:8b';
const USAGE = 'usage: --url <baseUrl> --token <token> [--model] [--abort-after ms] [--think true|false]\n';

if (!baseUrl || !token) {
  process.stderr.write(USAGE);
  process.exit(2);
}

// --think は true / false のみ受ける（既定 true）
if (args.think !== undefined && args.think !== 'true' && args.think !== 'false') {
  process.stderr.write(`error: --think は true か false（受け取った値: ${JSON.stringify(args.think)}）\n` + USAGE);
  process.exit(2);
}
const think = args.think !== undefined ? args.think === 'true' : true;

// --abort-after は有限数のみ（未指定なら null）
let abortAfter = null;
if (args['abort-after'] !== undefined) {
  abortAfter = Number(args['abort-after']);
  if (!Number.isFinite(abortAfter)) {
    process.stderr.write(`error: --abort-after は数値（受け取った値: ${JSON.stringify(args['abort-after'])}）\n` + USAGE);
    process.exit(2);
  }
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const controller = new AbortController();
  let abortTimer = null;
  let aborted = false;
  if (abortAfter != null) {
    abortTimer = setTimeout(() => {
      aborted = true;
      controller.abort();
    }, abortAfter);
  }

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: '1から20まで数えて、それぞれ短く一言そえて' }],
    stream: true,
    think,
    options: { num_ctx: 16384, temperature: 0.6 },
  });

  const summary = {
    url: baseUrl,
    model,
    think,
    abortAfter,
    headersMs: null,
    firstChunkMs: null,
    chunkCount: 0,
    chunkIntervalMaxMs: null,
    chunkIntervalMedianMs: null,
    totalBytes: 0,
    doneTrue: false,
    ndjsonLines: 0,
    ndjsonParseErrors: 0,
    thinkingFieldSeen: false,
    thinkTagSeen: false,
    responseHead500: '',
    aborted: false,
    error: null,
    failureMode: null,
    wallMs: null,
  };

  const t0 = performance.now();
  let contentAccum = '';
  let thinkingAccum = '';

  try {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
      signal: controller.signal,
    });
    summary.headersMs = Math.round(performance.now() - t0);
    summary.httpStatus = resp.status;

    if (!resp.ok || !resp.body) {
      summary.error = `HTTP ${resp.status}`;
      const text = await resp.text().catch(() => '');
      summary.responseHead500 = text.slice(0, 500);
      finish(summary, t0, abortTimer);
      return;
    }

    let buf = '';
    let lastChunkAt = null;
    const intervals = [];
    // multibyte 文字がチャンク境界で分断されても化けないよう、
    // ストリーミングデコーダで継ぐ（終了後に dec.decode() でフラッシュ）。
    const dec = new TextDecoder('utf-8');

    for await (const chunk of resp.body) {
      const now = performance.now();
      if (summary.firstChunkMs == null) summary.firstChunkMs = Math.round(now - t0);
      if (lastChunkAt != null) intervals.push(now - lastChunkAt);
      lastChunkAt = now;
      summary.chunkCount += 1;
      summary.totalBytes += chunk.length;

      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? ''; // 末尾は不完全な可能性 → バッファに戻す

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        summary.ndjsonLines += 1;
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          summary.ndjsonParseErrors += 1;
          continue;
        }
        if (obj.done === true) summary.doneTrue = true;
        const msg = obj.message || {};
        if (typeof msg.thinking === 'string') {
          summary.thinkingFieldSeen = true;
          thinkingAccum += msg.thinking;
        }
        if (typeof msg.content === 'string') contentAccum += msg.content;
      }
    }

    // ストリーム終了後、デコーダに残った未確定バイトをフラッシュしてから残りを処理
    buf += dec.decode();
    const rest = buf.trim();
    if (rest) {
      summary.ndjsonLines += 1;
      try {
        const obj = JSON.parse(rest);
        if (obj.done === true) summary.doneTrue = true;
        if (typeof obj.message?.content === 'string') contentAccum += obj.message.content;
        if (typeof obj.message?.thinking === 'string') {
          summary.thinkingFieldSeen = true;
          thinkingAccum += obj.message.thinking;
        }
      } catch {
        summary.ndjsonParseErrors += 1;
      }
    }

    summary.chunkIntervalMaxMs = intervals.length ? Math.round(Math.max(...intervals)) : null;
    summary.chunkIntervalMedianMs = intervals.length ? Math.round(median(intervals)) : null;
    summary.thinkTagSeen = /<think>|<\/think>/.test(contentAccum);
    summary.responseHead500 = (thinkingAccum ? `[thinking] ${thinkingAccum}\n[content] ` : '') + contentAccum;
    summary.responseHead500 = summary.responseHead500.slice(0, 500);
  } catch (err) {
    if (err && (err.name === 'AbortError' || aborted)) {
      summary.aborted = true;
      summary.failureMode = 'AbortError';
    } else {
      summary.error = String(err && (err.message || err));
      summary.failureMode = err && (err.cause?.code || err.code || err.name || 'unknown');
    }
  }

  if (summary.aborted) {
    // abort 後 3 秒待ってから終了（呼び出し側が ollama ps を確認する時間ではなく、
    // undici 側のクリーンアップ観測用）
    await new Promise((r) => setTimeout(r, 3000));
  }

  finish(summary, t0, abortTimer);
}

function finish(summary, t0, abortTimer) {
  if (abortTimer) clearTimeout(abortTimer);
  summary.wallMs = Math.round(performance.now() - t0);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main();
