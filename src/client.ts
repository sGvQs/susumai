import type { Config } from './config.ts';
import { StreamInterpreter, type Fragment } from './parser.ts';

export function buildHeaders(cfg: Config): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
  };
}

/** /api/tags のレスポンスから照合対象のモデル名を集める（各エントリの name と model 両方）。 */
export function collectModelNames(tags: unknown): string[] {
  const out: string[] = [];
  const models =
    tags && typeof tags === 'object' && Array.isArray((tags as { models?: unknown }).models)
      ? (tags as { models: unknown[] }).models
      : [];
  for (const m of models) {
    if (m && typeof m === 'object') {
      const rec = m as Record<string, unknown>;
      if (typeof rec.name === 'string') out.push(rec.name);
      if (typeof rec.model === 'string') out.push(rec.model);
    }
  }
  return out;
}

/**
 * 寛容なモデル照合。
 * - want に :tag が無い → <name> または <name>:latest 一致で可
 * - want に :tag が有る → 完全一致のみ
 */
export function modelMatches(want: string, available: readonly string[]): boolean {
  if (want.includes(':')) return available.includes(want);
  return available.includes(want) || available.includes(`${want}:latest`);
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { cause?: { code?: string }; code?: string; message?: string; name?: string };
    return String(e.cause?.code ?? e.code ?? e.message ?? e.name ?? err);
  }
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

/** すべての fetch に明示 AbortController タイムアウトを付ける（undici 既定の ~300s に依存しない）。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/tags で到達性を確認し、cfg.model がサーバにあるか寛容に照合する。 */
export async function checkHealth(cfg: Config, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${cfg.url}/api/tags`,
      { method: 'GET', headers: buildHeaders(cfg) },
      timeoutMs,
    );
  } catch (err) {
    throw new Error(
      `サーバに到達できません (${cfg.url})。トンネル URL とネットワークを確認してください [${describeError(err)}]`,
    );
  }
  if (resp.status === 401) {
    void resp.body?.cancel().catch(() => {}); // 未消費レスポンスボディを解放
    throw new Error('認証に失敗しました (401)。`susumai config set --token <token>` を確認してください');
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {}); // 未消費レスポンスボディを解放
    throw new Error(`サーバが HTTP ${resp.status} を返しました。トンネル URL を確認してください`);
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new Error('サーバの応答を解釈できませんでした（/api/tags が JSON を返していません）');
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { models?: unknown }).models)
  ) {
    // models が配列でない＝Ollama の /api/tags ではない（別サービス／エラーページ等）。
    // 「モデルがありません」と誤誘導せず、解釈不能として報告する。
    throw new Error(
      'サーバの応答を解釈できませんでした（/api/tags の形式が想定と異なります）。トンネル URL を確認してください',
    );
  }
  const names = collectModelNames(data);
  if (!modelMatches(cfg.model, names)) {
    throw new Error(
      `モデル ${cfg.model} がサーバにありません。サーバで \`ollama pull ${cfg.model}\` を実行してください`,
    );
  }
}

/** POST /api/chat に messages:[] を送ってモデルをロードさせる。 */
export async function warmup(cfg: Config, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${cfg.url}/api/chat`,
      {
        method: 'POST',
        headers: buildHeaders(cfg),
        body: JSON.stringify({ model: cfg.model, messages: [], stream: false }),
      },
      timeoutMs,
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error('トンネルの応答開始制限。サーバ側で先にモデルを温めてください');
    }
    throw new Error(`ウォームアップに失敗しました [${describeError(err)}]`);
  }
  if (resp.status === 524) {
    void resp.body?.cancel().catch(() => {}); // 未消費レスポンスボディを解放
    throw new Error('トンネルの応答開始制限 (524)。サーバ側で先にモデルを温めてください');
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {}); // 未消費レスポンスボディを解放
    throw new Error(`ウォームアップでサーバが HTTP ${resp.status} を返しました`);
  }
  await resp.text().catch(() => ''); // ボディを読み切って接続を綺麗に閉じる
}

/**
 * POST /api/chat のストリームを Fragment 列として返す async generator（内部用）。
 *
 * ワイヤ上は常に stream:true を送る（QA 2巡目 提案2）。タイムアウトは
 * 「初トークンが来るまで firstTokenTimeoutMs（既定 60s）のウォッチドッグ。最初の
 * 1 バイトが届いた時点で解除し、以降は上限なし（外部 signal でのみ中断）」の単一ロジック。
 *
 * `--no-stream`（cfg.stream === false）でも stream:false は送らない。非ストリーム
 * 表示は公開ラッパ {@link chatStream} が「フラグメントを蓄積して生成完了後に一括 yield」で
 * 実現する。こうすることで undici の headersTimeout（既定 ~300s・ゼロ依存では変更不可）が
 * 「生成完了までヘッダが来ない stream:false」応答で先に発火する問題を回避する。
 */
async function* rawChatStream(
  cfg: Config,
  messages: ReadonlyArray<{ role: string; content: string }>,
  opts: { signal?: AbortSignal; firstTokenTimeoutMs?: number } = {},
): AsyncGenerator<Fragment> {
  const firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 60000;
  const ac = new AbortController();
  const external = opts.signal;
  const onExternalAbort = () => ac.abort();
  if (external) {
    if (external.aborted) ac.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  let firstToken = false;
  let timedOut = false;
  // 初トークン未達のまま制限時間に達したら abort。初バイト到達で解除、以降は上限なし。
  const watchdog = setTimeout(() => {
    if (!firstToken) {
      timedOut = true;
      ac.abort();
    }
  }, firstTokenTimeoutMs);
  const timeoutMessage =
    'サーバの応答がありません（初回トークンのタイムアウト、またはトンネル断）';

  const cleanup = () => {
    clearTimeout(watchdog);
    if (external) external.removeEventListener('abort', onExternalAbort);
  };

  const body = JSON.stringify({
    model: cfg.model,
    messages,
    stream: true, // ワイヤ上は常にストリーミング（undici headersTimeout 回避）
    think: true,
    options: { num_ctx: cfg.numCtx, temperature: 0.6 },
  });

  let resp: Response;
  try {
    resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body,
      signal: ac.signal,
    });
  } catch (err) {
    cleanup();
    if (external?.aborted) return;
    if (timedOut) throw new Error(timeoutMessage);
    if (!firstToken) {
      throw new Error('サーバの応答がありません（初回トークンのタイムアウト、またはトンネル断）');
    }
    throw new Error(`リクエストに失敗しました [${describeError(err)}]`);
  }

  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {}); // 未消費レスポンスボディを解放
    cleanup();
    if (resp.status === 401) throw new Error('認証に失敗しました (401)。token を確認してください');
    if (resp.status === 404 || resp.status === 503) {
      throw new Error(`モデルが未ロードです (HTTP ${resp.status})。サーバ側でモデルを温めてください`);
    }
    throw new Error(`サーバが HTTP ${resp.status} を返しました`);
  }
  if (!resp.body) {
    // resp.body は null なので解放不要（cancel 対象なし）。
    cleanup();
    throw new Error(
      `サーバが応答本文を返しませんでした (HTTP ${resp.status})。トンネルまたはサーバの状態を確認してください`,
    );
  }

  const interp = new StreamInterpreter();
  try {
    for await (const chunk of resp.body as AsyncIterable<Uint8Array>) {
      if (!firstToken) {
        firstToken = true;
        clearTimeout(watchdog);
      }
      for (const frag of interp.push(chunk)) yield frag;
    }
    for (const frag of interp.flush()) yield frag;
  } catch (err) {
    if (external?.aborted) return; // ユーザーによる中断は静かに終える
    if (timedOut) throw new Error(timeoutMessage);
    if (!firstToken) {
      throw new Error('サーバの応答がありません（初回トークンのタイムアウト、またはトンネル断）');
    }
    throw new Error(`ストリームが中断されました [${describeError(err)}]`);
  } finally {
    cleanup();
  }
}

/**
 * 公開 API。
 * - `cfg.stream !== false` … {@link rawChatStream} をそのまま逐次流す。
 * - `cfg.stream === false`（`--no-stream`）… ワイヤは stream:true のまま、フラグメントを
 *   内部に蓄積し、生成完了後に thinking → content → done の順で一括 yield する。
 *   ユーザー体感は非ストリーミング、ネットワークは常にストリーミング。
 */
export async function* chatStream(
  cfg: Config,
  messages: ReadonlyArray<{ role: string; content: string }>,
  opts: { signal?: AbortSignal; firstTokenTimeoutMs?: number } = {},
): AsyncGenerator<Fragment> {
  const raw = rawChatStream(cfg, messages, opts);
  if (cfg.stream !== false) {
    yield* raw;
    return;
  }
  let thinking = '';
  let content = '';
  for await (const frag of raw) {
    if (frag.error) {
      yield frag; // サーバ由来のランタイムエラーは蓄積せず即座に表面化させる
      return;
    }
    if (frag.thinking) thinking += frag.thinking;
    if (frag.content) content += frag.content;
  }
  if (thinking) yield { thinking };
  if (content) yield { content };
  yield { done: true };
}
