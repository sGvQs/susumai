#!/usr/bin/env node

// src/index.ts
import { parseArgs } from "util";
import * as readline from "readline/promises";
import process2 from "process";
import { Buffer } from "buffer";

// src/config.ts
import fs from "fs";
import os from "os";
import path from "path";
var DEFAULT_CONFIG = {
  model: "deepseek-r1:8b",
  numCtx: 16384,
  stream: true
};
function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.resolve(path.join(base, "susumai", "config.json"));
}
function warnBrokenConfig(reason) {
  process.stderr.write(
    `\u203B \u8A2D\u5B9A\u30D5\u30A1\u30A4\u30EB\u304C\u58CA\u308C\u3066\u3044\u307E\u3059\uFF08${reason}\uFF09\u3002\u65E2\u5B9A\u5024\u3067\u7D9A\u884C\u3057\u307E\u3059: ${configPath()}
`
  );
  return { ...DEFAULT_CONFIG };
}
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), "utf8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return warnBrokenConfig("\u4E0D\u6B63\u306A JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return warnBrokenConfig("JSON \u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  }
  const parsedObj = parsed;
  const cfg = { ...DEFAULT_CONFIG };
  if (typeof parsedObj.url === "string" && parsedObj.url) cfg.url = parsedObj.url;
  if (typeof parsedObj.model === "string" && parsedObj.model) cfg.model = parsedObj.model;
  if (parsedObj.numCtx !== void 0) {
    if (typeof parsedObj.numCtx === "number" && Number.isInteger(parsedObj.numCtx) && parsedObj.numCtx > 0) {
      cfg.numCtx = parsedObj.numCtx;
    } else {
      process.stderr.write(
        `\u203B \u8A2D\u5B9A\u306E numCtx \u304C\u4E0D\u6B63\u3067\u3059\uFF08\u6B63\u306E\u6574\u6570\u304C\u5FC5\u8981\uFF09\u3002\u65E2\u5B9A ${DEFAULT_CONFIG.numCtx} \u3092\u4F7F\u3044\u307E\u3059: ${configPath()}
`
      );
    }
  }
  if (typeof parsedObj.stream === "boolean") cfg.stream = parsedObj.stream;
  if (typeof parsedObj.token === "string" && parsedObj.token) cfg.token = parsedObj.token;
  return cfg;
}
function saveConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    model: cfg.model,
    numCtx: cfg.numCtx,
    stream: cfg.stream
  };
  if (cfg.url) body.url = cfg.url;
  if (cfg.token) body.token = cfg.token;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 384 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.chmodSync(file, 384);
}
function maskToken(token) {
  if (token.length <= 8) return "*".repeat(token.length);
  return `${token.slice(0, 4)}${"*".repeat(token.length - 8)}${token.slice(-4)}`;
}
function maskedConfig(cfg) {
  const out = {
    model: cfg.model,
    numCtx: cfg.numCtx,
    stream: cfg.stream
  };
  if (cfg.url) out.url = cfg.url;
  if (typeof cfg.token === "string" && cfg.token) out.token = maskToken(cfg.token);
  return out;
}
function assertUrl(cfg) {
  if (!cfg.url || !cfg.url.trim()) {
    throw new Error("URL \u672A\u8A2D\u5B9A\u3002`susumai config set --url <tunnel-url>` \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044");
  }
}

// src/parser.ts
var NdjsonParser = class {
  decoder = new TextDecoder("utf-8");
  buf = "";
  /** JSON.parse に失敗してスキップした行数。 */
  skipped = 0;
  push(chunk) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }
  /** ストリーム終了時に呼ぶ。デコーダの未確定バイトをフラッシュし、残余も処理する。 */
  flush() {
    this.buf += this.decoder.decode();
    return this.drain(true);
  }
  drain(final) {
    const parts = this.buf.split("\n");
    this.buf = final ? "" : parts.pop() ?? "";
    const out = [];
    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        this.skipped += 1;
      }
    }
    return out;
  }
};
var OPEN = "<think>";
var CLOSE = "</think>";
function partialTagSuffixLen(s) {
  const max = Math.min(s.length, CLOSE.length - 1);
  for (let n = max; n > 0; n -= 1) {
    const suf = s.slice(s.length - n);
    if (OPEN.startsWith(suf) || CLOSE.startsWith(suf)) return n;
  }
  return 0;
}
var ThinkSplitter = class {
  carry = "";
  inThink = false;
  sawOpen = false;
  settled = false;
  /**
   * message.thinking が別フィールドで届くモデルだと判明したら呼ぶ。
   * 以後、content はプレーンテキストとして即時に流す（保留しない）。
   */
  markPlaintext() {
    this.settled = true;
  }
  /** content フィールドの生断片を食わせ、thinking / content に分けて返す。 */
  feed(text) {
    if (!text) return {};
    this.carry += text;
    let thinking = "";
    let content = "";
    for (; ; ) {
      const iOpen = this.carry.indexOf(OPEN);
      const iClose = this.carry.indexOf(CLOSE);
      let idx = -1;
      let isOpen = false;
      if (iOpen !== -1 && (iClose === -1 || iOpen < iClose)) {
        idx = iOpen;
        isOpen = true;
      } else if (iClose !== -1) {
        idx = iClose;
        isOpen = false;
      }
      if (idx === -1) break;
      const before = this.carry.slice(0, idx);
      if (this.inThink) {
        thinking += before;
      } else if (!isOpen && !this.sawOpen) {
        thinking += before;
      } else {
        content += before;
      }
      if (isOpen) {
        this.carry = this.carry.slice(idx + OPEN.length);
        this.inThink = true;
        this.sawOpen = true;
      } else {
        this.carry = this.carry.slice(idx + CLOSE.length);
        this.inThink = false;
      }
      this.settled = true;
    }
    const hold = partialTagSuffixLen(this.carry);
    const emit = hold ? this.carry.slice(0, this.carry.length - hold) : this.carry;
    this.carry = hold ? this.carry.slice(this.carry.length - hold) : "";
    if (this.inThink) {
      thinking += emit;
    } else {
      this.settled = true;
      content += emit;
    }
    const out = {};
    if (thinking) out.thinking = thinking;
    if (content) out.content = content;
    return out;
  }
  /** ストリーム終了。保留中のテキストを確定させる。 (c) <think> 未終了は残り全部 thinking。 */
  end() {
    const out = {};
    if (!this.carry) return out;
    if (this.inThink) out.thinking = this.carry;
    else out.content = this.carry;
    this.carry = "";
    return out;
  }
};
var StreamInterpreter = class {
  ndjson = new NdjsonParser();
  splitter = new ThinkSplitter();
  /** JSON.parse に失敗してスキップした行数。 */
  get skipped() {
    return this.ndjson.skipped;
  }
  handle(obj) {
    if (typeof obj.error === "string" && obj.error.length > 0) {
      return [{ error: obj.error }];
    }
    const out = [];
    const msg = obj.message;
    if (msg && typeof msg.thinking === "string" && msg.thinking.length > 0) {
      this.splitter.markPlaintext();
      out.push({ thinking: msg.thinking });
    }
    if (msg && typeof msg.content === "string" && msg.content.length > 0) {
      const frag = this.splitter.feed(msg.content);
      if (frag.thinking !== void 0 || frag.content !== void 0) out.push(frag);
    }
    if (obj.done === true) {
      const tail = this.splitter.end();
      if (tail.thinking !== void 0 || tail.content !== void 0) out.push(tail);
      out.push({ done: true });
    }
    return out;
  }
  push(chunk) {
    const out = [];
    for (const obj of this.ndjson.push(chunk)) {
      for (const f of this.handle(obj)) out.push(f);
    }
    return out;
  }
  flush() {
    const out = [];
    for (const obj of this.ndjson.flush()) {
      for (const f of this.handle(obj)) out.push(f);
    }
    const tail = this.splitter.end();
    if (tail.thinking !== void 0 || tail.content !== void 0) out.push(tail);
    return out;
  }
};

// src/client.ts
function buildHeaders(cfg) {
  return {
    "content-type": "application/json",
    ...cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}
  };
}
function collectModelNames(tags) {
  const out = [];
  const models = tags && typeof tags === "object" && Array.isArray(tags.models) ? tags.models : [];
  for (const m of models) {
    if (m && typeof m === "object") {
      const rec = m;
      if (typeof rec.name === "string") out.push(rec.name);
      if (typeof rec.model === "string") out.push(rec.model);
    }
  }
  return out;
}
function modelMatches(want, available) {
  if (want.includes(":")) return available.includes(want);
  return available.includes(want) || available.includes(`${want}:latest`);
}
function describeError(err) {
  if (err && typeof err === "object") {
    const e = err;
    return String(e.cause?.code ?? e.code ?? e.message ?? e.name ?? err);
  }
  return String(err);
}
function isAbortError(err) {
  return Boolean(err) && typeof err === "object" && err.name === "AbortError";
}
async function fetchWithTimeout(url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function checkHealth(cfg, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1e4;
  let resp;
  try {
    resp = await fetchWithTimeout(
      `${cfg.url}/api/tags`,
      { method: "GET", headers: buildHeaders(cfg) },
      timeoutMs
    );
  } catch (err) {
    throw new Error(
      `\u30B5\u30FC\u30D0\u306B\u5230\u9054\u3067\u304D\u307E\u305B\u3093 (${cfg.url})\u3002\u30C8\u30F3\u30CD\u30EB URL \u3068\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044 [${describeError(err)}]`
    );
  }
  if (resp.status === 401) {
    void resp.body?.cancel().catch(() => {
    });
    throw new Error("\u8A8D\u8A3C\u306B\u5931\u6557\u3057\u307E\u3057\u305F (401)\u3002`susumai config set --token <token>` \u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {
    });
    throw new Error(`\u30B5\u30FC\u30D0\u304C HTTP ${resp.status} \u3092\u8FD4\u3057\u307E\u3057\u305F\u3002\u30C8\u30F3\u30CD\u30EB URL \u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044`);
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("\u30B5\u30FC\u30D0\u306E\u5FDC\u7B54\u3092\u89E3\u91C8\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF08/api/tags \u304C JSON \u3092\u8FD4\u3057\u3066\u3044\u307E\u305B\u3093\uFF09");
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.models)) {
    throw new Error(
      "\u30B5\u30FC\u30D0\u306E\u5FDC\u7B54\u3092\u89E3\u91C8\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF08/api/tags \u306E\u5F62\u5F0F\u304C\u60F3\u5B9A\u3068\u7570\u306A\u308A\u307E\u3059\uFF09\u3002\u30C8\u30F3\u30CD\u30EB URL \u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044"
    );
  }
  const names = collectModelNames(data);
  if (!modelMatches(cfg.model, names)) {
    throw new Error(
      `\u30E2\u30C7\u30EB ${cfg.model} \u304C\u30B5\u30FC\u30D0\u306B\u3042\u308A\u307E\u305B\u3093\u3002\u30B5\u30FC\u30D0\u3067 \`ollama pull ${cfg.model}\` \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044`
    );
  }
}
async function warmup(cfg, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12e4;
  let resp;
  try {
    resp = await fetchWithTimeout(
      `${cfg.url}/api/chat`,
      {
        method: "POST",
        headers: buildHeaders(cfg),
        body: JSON.stringify({ model: cfg.model, messages: [], stream: false })
      },
      timeoutMs
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error("\u30C8\u30F3\u30CD\u30EB\u306E\u5FDC\u7B54\u958B\u59CB\u5236\u9650\u3002\u30B5\u30FC\u30D0\u5074\u3067\u5148\u306B\u30E2\u30C7\u30EB\u3092\u6E29\u3081\u3066\u304F\u3060\u3055\u3044");
    }
    throw new Error(`\u30A6\u30A9\u30FC\u30E0\u30A2\u30C3\u30D7\u306B\u5931\u6557\u3057\u307E\u3057\u305F [${describeError(err)}]`);
  }
  if (resp.status === 524) {
    void resp.body?.cancel().catch(() => {
    });
    throw new Error("\u30C8\u30F3\u30CD\u30EB\u306E\u5FDC\u7B54\u958B\u59CB\u5236\u9650 (524)\u3002\u30B5\u30FC\u30D0\u5074\u3067\u5148\u306B\u30E2\u30C7\u30EB\u3092\u6E29\u3081\u3066\u304F\u3060\u3055\u3044");
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {
    });
    throw new Error(`\u30A6\u30A9\u30FC\u30E0\u30A2\u30C3\u30D7\u3067\u30B5\u30FC\u30D0\u304C HTTP ${resp.status} \u3092\u8FD4\u3057\u307E\u3057\u305F`);
  }
  await resp.text().catch(() => "");
}
async function* rawChatStream(cfg, messages, opts = {}) {
  const firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 6e4;
  const ac = new AbortController();
  const external = opts.signal;
  const onExternalAbort = () => ac.abort();
  if (external) {
    if (external.aborted) ac.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  let firstToken = false;
  let timedOut = false;
  const watchdog = setTimeout(() => {
    if (!firstToken) {
      timedOut = true;
      ac.abort();
    }
  }, firstTokenTimeoutMs);
  const timeoutMessage = "\u30B5\u30FC\u30D0\u306E\u5FDC\u7B54\u304C\u3042\u308A\u307E\u305B\u3093\uFF08\u521D\u56DE\u30C8\u30FC\u30AF\u30F3\u306E\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3001\u307E\u305F\u306F\u30C8\u30F3\u30CD\u30EB\u65AD\uFF09";
  const cleanup = () => {
    clearTimeout(watchdog);
    if (external) external.removeEventListener("abort", onExternalAbort);
  };
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    stream: true,
    // ワイヤ上は常にストリーミング（undici headersTimeout 回避）
    think: true,
    options: { num_ctx: cfg.numCtx, temperature: 0.6 }
  });
  let resp;
  try {
    resp = await fetch(`${cfg.url}/api/chat`, {
      method: "POST",
      headers: buildHeaders(cfg),
      body,
      signal: ac.signal
    });
  } catch (err) {
    cleanup();
    if (external?.aborted) return;
    if (timedOut) throw new Error(timeoutMessage);
    if (!firstToken) {
      throw new Error("\u30B5\u30FC\u30D0\u306E\u5FDC\u7B54\u304C\u3042\u308A\u307E\u305B\u3093\uFF08\u521D\u56DE\u30C8\u30FC\u30AF\u30F3\u306E\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3001\u307E\u305F\u306F\u30C8\u30F3\u30CD\u30EB\u65AD\uFF09");
    }
    throw new Error(`\u30EA\u30AF\u30A8\u30B9\u30C8\u306B\u5931\u6557\u3057\u307E\u3057\u305F [${describeError(err)}]`);
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {
    });
    cleanup();
    if (resp.status === 401) throw new Error("\u8A8D\u8A3C\u306B\u5931\u6557\u3057\u307E\u3057\u305F (401)\u3002token \u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
    if (resp.status === 404 || resp.status === 503) {
      throw new Error(`\u30E2\u30C7\u30EB\u304C\u672A\u30ED\u30FC\u30C9\u3067\u3059 (HTTP ${resp.status})\u3002\u30B5\u30FC\u30D0\u5074\u3067\u30E2\u30C7\u30EB\u3092\u6E29\u3081\u3066\u304F\u3060\u3055\u3044`);
    }
    throw new Error(`\u30B5\u30FC\u30D0\u304C HTTP ${resp.status} \u3092\u8FD4\u3057\u307E\u3057\u305F`);
  }
  if (!resp.body) {
    cleanup();
    throw new Error(
      `\u30B5\u30FC\u30D0\u304C\u5FDC\u7B54\u672C\u6587\u3092\u8FD4\u3057\u307E\u305B\u3093\u3067\u3057\u305F (HTTP ${resp.status})\u3002\u30C8\u30F3\u30CD\u30EB\u307E\u305F\u306F\u30B5\u30FC\u30D0\u306E\u72B6\u614B\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044`
    );
  }
  const interp = new StreamInterpreter();
  try {
    for await (const chunk of resp.body) {
      if (!firstToken) {
        firstToken = true;
        clearTimeout(watchdog);
      }
      for (const frag of interp.push(chunk)) yield frag;
    }
    for (const frag of interp.flush()) yield frag;
  } catch (err) {
    if (external?.aborted) return;
    if (timedOut) throw new Error(timeoutMessage);
    if (!firstToken) {
      throw new Error("\u30B5\u30FC\u30D0\u306E\u5FDC\u7B54\u304C\u3042\u308A\u307E\u305B\u3093\uFF08\u521D\u56DE\u30C8\u30FC\u30AF\u30F3\u306E\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3001\u307E\u305F\u306F\u30C8\u30F3\u30CD\u30EB\u65AD\uFF09");
    }
    throw new Error(`\u30B9\u30C8\u30EA\u30FC\u30E0\u304C\u4E2D\u65AD\u3055\u308C\u307E\u3057\u305F [${describeError(err)}]`);
  } finally {
    cleanup();
  }
}
async function* chatStream(cfg, messages, opts = {}) {
  const raw = rawChatStream(cfg, messages, opts);
  if (cfg.stream !== false) {
    yield* raw;
    return;
  }
  let thinking = "";
  let content = "";
  for await (const frag of raw) {
    if (frag.error) {
      yield frag;
      return;
    }
    if (frag.thinking) thinking += frag.thinking;
    if (frag.content) content += frag.content;
  }
  if (thinking) yield { thinking };
  if (content) yield { content };
  yield { done: true };
}

// src/history.ts
var MAX_TURNS = 16;
var THINK_PAIR = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
var THINK_OPEN_REST = /<think\b[^>]*>[\s\S]*$/i;
var THINK_STRAY_TAG = /<\/?think\b[^>]*>/gi;
function stripThink(text) {
  return text.replace(THINK_PAIR, "").replace(THINK_OPEN_REST, "").replace(THINK_STRAY_TAG, "").trim();
}
var History = class {
  turns = [];
  onTrim;
  constructor(onTrim) {
    this.onTrim = onTrim;
  }
  pushUser(content) {
    this.turns.push({ role: "user", content });
    this.trim();
  }
  /** アシスタント応答は積む前に <think>...</think> を除去（thinking フィールドは最初から積まない）。 */
  pushAssistant(content) {
    this.turns.push({ role: "assistant", content: stripThink(content) });
    this.trim();
  }
  /**
   * 1 ラウンド（user 発話 ＋ assistant 応答）をまとめて確定する。
   * trim は 2 ターン積んでから 1 回だけ走らせるので、onTrim 通知はラウンドにつき最大 1 回。
   * （pushUser→trim・pushAssistant→trim と個別に呼ぶと 1 ラウンドで通知が二重に出る。）
   */
  pushRound(userContent, assistantContent) {
    this.turns.push({ role: "user", content: userContent });
    this.turns.push({ role: "assistant", content: stripThink(assistantContent) });
    this.trim();
  }
  messages() {
    return this.turns.map((t) => ({ ...t }));
  }
  get length() {
    return this.turns.length;
  }
  trim() {
    let trimmed = false;
    while (this.turns.length > MAX_TURNS) {
      this.turns.shift();
      trimmed = true;
    }
    if (trimmed && this.onTrim) this.onTrim();
  }
};

// src/index.ts
var { stdin, stdout, stderr } = process2;
function assertNodeVersion() {
  const m = /^(\d+)\.(\d+)/.exec(process2.versions.node);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  if (major < 22 || major === 22 && minor < 18) {
    stderr.write(`Node.js 22.18 \u4EE5\u964D\u304C\u5FC5\u8981\u3067\u3059\uFF08\u73FE\u5728 v${process2.versions.node}\uFF09
`);
    process2.exit(1);
  }
}
assertNodeVersion();
var VERSION = true ? "0.1.0" : "0.0.0-dev";
var DIM = "\x1B[2m";
var RESET = "\x1B[0m";
var isTty = Boolean(stdout.isTTY);
var HELP = `susumai \u2014 \u30BB\u30EB\u30D5\u30DB\u30B9\u30C8 DeepSeek R1 (Ollama) \u3068\u8A71\u3059 CLI

\u4F7F\u3044\u65B9:
  susumai                        \u5BFE\u8A71 REPL \u3092\u958B\u59CB
  susumai "<\u30D7\u30ED\u30F3\u30D7\u30C8>"          \u30EF\u30F3\u30B7\u30E7\u30C3\u30C8: 1 \u56DE\u9001\u3063\u3066\u5FDC\u7B54\u3092\u8868\u793A\u3057\u3066\u7D42\u4E86\uFF08\u30D1\u30A4\u30D7\u53EF\uFF09
  susumai config set [\u30AA\u30D7\u30B7\u30E7\u30F3]  \u8A2D\u5B9A\u3092\u66F4\u65B0\uFF08\u6307\u5B9A\u3057\u305F\u30AD\u30FC\u3060\u3051\uFF09
  susumai config get             \u73FE\u5728\u306E\u8A2D\u5B9A\u3092\u8868\u793A\uFF08token \u306F\u30DE\u30B9\u30AF\uFF09
  susumai config path             \u8A2D\u5B9A\u30D5\u30A1\u30A4\u30EB\u306E\u7D76\u5BFE\u30D1\u30B9\u3092\u8868\u793A

config set \u306E\u30AA\u30D7\u30B7\u30E7\u30F3:
  --url <url>        \u30C8\u30F3\u30CD\u30EB\u306E base URL\uFF08\u4F8B https://xxxx.trycloudflare.com\uFF09
  --model <name>     \u30E2\u30C7\u30EB\u540D\uFF08\u65E2\u5B9A deepseek-r1:8b\uFF09
  --num-ctx <n>      \u30B3\u30F3\u30C6\u30AD\u30B9\u30C8\u9577\uFF08\u65E2\u5B9A 16384\uFF09
  --stream <bool>    \u30B9\u30C8\u30EA\u30FC\u30E0\u8868\u793A true|false
  --token <token>    \u30D7\u30ED\u30AD\u30B7\u7528 Bearer \u30C8\u30FC\u30AF\u30F3

\u5168\u4F53\u30AA\u30D7\u30B7\u30E7\u30F3:
  --no-stream        \u4ECA\u56DE\u3060\u3051\u30B9\u30C8\u30EA\u30FC\u30E0\u3092\u7121\u52B9\u5316
  --help             \u3053\u306E\u30D8\u30EB\u30D7
  --version          \u30D0\u30FC\u30B8\u30E7\u30F3

REPL \u4E2D: .exit \u3067\u7D42\u4E86 / \u751F\u6210\u4E2D\u306E Ctrl-C \u3067\u751F\u6210\u3092\u4E2D\u65AD / \u30D7\u30ED\u30F3\u30D7\u30C8\u5F85\u3061\u306E Ctrl-C \u3067\u7D42\u4E86
`;
function dim(s) {
  return isTty ? `${DIM}${s}${RESET}` : s;
}
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function fail(err) {
  stderr.write(errMessage(err) + "\n");
  process2.exit(1);
}
async function readStdin() {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
async function streamAnswer(cfg, history, userText, signal) {
  const messages = [...history.messages(), { role: "user", content: userText }];
  let assistant = "";
  let sawThinking = false;
  let sawContent = false;
  try {
    for await (const frag of chatStream(cfg, messages, { signal })) {
      if (frag.error) {
        throw new Error(`\u30B5\u30FC\u30D0\u304C\u30A8\u30E9\u30FC\u3092\u8FD4\u3057\u307E\u3057\u305F: ${frag.error}`);
      }
      if (frag.thinking) {
        sawThinking = true;
        stdout.write(isTty ? `${DIM}${frag.thinking}${RESET}` : frag.thinking);
      }
      if (frag.content) {
        if (!sawContent && sawThinking) stdout.write("\n");
        sawContent = true;
        stdout.write(frag.content);
        assistant += frag.content;
      }
      if (frag.done) break;
    }
  } finally {
    stdout.write("\n");
  }
  if (signal.aborted) stderr.write("[\u4E2D\u65AD\u3057\u307E\u3057\u305F]\n");
  if (assistant !== "") {
    history.pushRound(userText, assistant);
  }
}
async function runConfig(rest, values) {
  const sub = rest[0];
  if (sub === "path") {
    stdout.write(configPath() + "\n");
    return;
  }
  if (sub === "get") {
    stdout.write(JSON.stringify(maskedConfig(loadConfig()), null, 2) + "\n");
    return;
  }
  if (sub === "set") {
    const cfg = loadConfig();
    let touched = false;
    if (typeof values.url === "string") {
      cfg.url = values.url;
      touched = true;
    }
    if (typeof values.model === "string") {
      cfg.model = values.model;
      touched = true;
    }
    if (typeof values["num-ctx"] === "string") {
      const n = Number(values["num-ctx"]);
      if (!Number.isInteger(n) || n <= 0) fail(new Error("--num-ctx \u306F\u6B63\u306E\u6574\u6570\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044"));
      cfg.numCtx = n;
      touched = true;
    }
    if (typeof values.stream === "string") {
      if (values.stream !== "true" && values.stream !== "false") {
        fail(new Error("--stream \u306F true \u304B false \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044"));
      }
      cfg.stream = values.stream === "true";
      touched = true;
    }
    if (typeof values.token === "string") {
      cfg.token = values.token;
      touched = true;
    }
    if (!touched) {
      stderr.write("config set: \u8A8D\u8B58\u3067\u304D\u308B\u30AA\u30D7\u30B7\u30E7\u30F3\u304C\u3042\u308A\u307E\u305B\u3093\uFF08--url/--model/--num-ctx/--stream/--token\uFF09\n\n" + HELP);
      process2.exit(2);
    }
    saveConfig(cfg);
    stdout.write("\u8A2D\u5B9A\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F \u2192 " + configPath() + "\n");
    return;
  }
  stderr.write(
    (sub ? `config: \u672A\u77E5\u306E\u30B5\u30D6\u30B3\u30DE\u30F3\u30C9\u300C${sub}\u300D` : "config: \u30B5\u30D6\u30B3\u30DE\u30F3\u30C9\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044") + "\uFF08set / get / path\uFF09\n\n" + HELP
  );
  process2.exit(2);
}
async function runOneShot(cfg, prompt) {
  const history = new History();
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process2.on("SIGINT", onSigint);
  try {
    await streamAnswer(cfg, history, prompt, ac.signal);
  } catch (err) {
    fail(err);
  } finally {
    process2.off("SIGINT", onSigint);
  }
}
async function runRepl(cfg) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const history = new History(() => {
    stderr.write(dim("\u203B \u53E4\u3044\u5C65\u6B74\u30921\u4EF6\u5207\u308A\u6368\u3066\u307E\u3057\u305F\uFF08\u76F4\u8FD116\u30BF\u30FC\u30F3\u306E\u307F\u4FDD\u6301\uFF09") + "\n");
  });
  let generating = null;
  rl.on("SIGINT", () => {
    if (generating) generating.abort();
    else rl.close();
  });
  stdout.write("susumai REPL \u2014 .exit \u3067\u7D42\u4E86\u3002\u751F\u6210\u4E2D\u306E Ctrl-C \u3067\u4E2D\u65AD\u3002\n");
  for (; ; ) {
    let line;
    try {
      line = await rl.question("\u203A ");
    } catch {
      break;
    }
    const q = line.trim();
    if (!q) continue;
    if (q === ".exit") break;
    generating = new AbortController();
    try {
      await streamAnswer(cfg, history, q, generating.signal);
    } catch (err) {
      stderr.write("\n" + errMessage(err) + "\n");
    } finally {
      generating = null;
    }
  }
  rl.close();
  stdout.write("bye\n");
}
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        version: { type: "boolean" },
        "no-stream": { type: "boolean" },
        url: { type: "string" },
        model: { type: "string" },
        "num-ctx": { type: "string" },
        stream: { type: "string" },
        token: { type: "string" }
      }
    });
  } catch (err) {
    stderr.write(errMessage(err) + "\n\n" + HELP);
    process2.exit(2);
  }
  const values = parsed.values;
  const positionals = parsed.positionals;
  if (values.version) {
    stdout.write(VERSION + "\n");
    return;
  }
  if (values.help) {
    stdout.write(HELP);
    return;
  }
  if (positionals[0] === "config") {
    await runConfig(positionals.slice(1), values);
    return;
  }
  const cfg = loadConfig();
  if (values["no-stream"]) cfg.stream = false;
  try {
    assertUrl(cfg);
    stderr.write("\u63A5\u7D9A\u3092\u78BA\u8A8D\u4E2D\u2026\n");
    await checkHealth(cfg);
  } catch (err) {
    fail(err);
  }
  let oneShot = null;
  if (positionals.length > 0) {
    oneShot = positionals.join(" ");
  } else if (!stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) oneShot = piped;
  }
  try {
    stderr.write("\u30E2\u30C7\u30EB\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026\n");
    await warmup(cfg);
  } catch (err) {
    fail(err);
  }
  if (oneShot !== null) await runOneShot(cfg, oneShot);
  else await runRepl(cfg);
}
if (import.meta.main) {
  main().catch((err) => fail(err));
}
export {
  streamAnswer
};
