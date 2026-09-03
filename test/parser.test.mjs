import test from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonParser, ThinkSplitter, StreamInterpreter } from '../src/parser.ts';

const enc = new TextEncoder();

test('NDJSON: 行の途中で分割されても復元する', () => {
  const p = new NdjsonParser();
  const out = [];
  out.push(...p.push(enc.encode('{"message":{"content":"ab"}}\n{"message":{"con')));
  out.push(...p.push(enc.encode('tent":"cd"}}\n')));
  out.push(...p.flush());
  assert.equal(out.length, 2);
  assert.equal(out[0].message.content, 'ab');
  assert.equal(out[1].message.content, 'cd');
});

test('NDJSON: 1チャンクに複数行', () => {
  const p = new NdjsonParser();
  const out = p.push(enc.encode('{"a":1}\n{"a":2}\n{"a":3}\n'));
  assert.deepEqual(out.map((o) => o.a), [1, 2, 3]);
});

test('NDJSON: マルチバイト文字がチャンク境界で割れても化けない', () => {
  const p = new NdjsonParser();
  const full = enc.encode('{"message":{"content":"日本語テスト"}}\n');
  const cut = 25; // "..." の直後、"日" のバイト列の途中で割る
  const out = [];
  out.push(...p.push(full.slice(0, cut)));
  out.push(...p.push(full.slice(cut)));
  out.push(...p.flush());
  assert.equal(out[0].message.content, '日本語テスト');
});

test('NDJSON: stream:false の単一 JSON（末尾改行なし）を flush で処理', () => {
  const p = new NdjsonParser();
  const out = [];
  out.push(...p.push(enc.encode('{"message":{"content":"hi"},"done":true}')));
  out.push(...p.flush());
  assert.equal(out.length, 1);
  assert.equal(out[0].done, true);
  assert.equal(out[0].message.content, 'hi');
});

test('NDJSON: 不正行はスキップして数える', () => {
  const p = new NdjsonParser();
  const out = [];
  out.push(...p.push(enc.encode('not json\n{"ok":1}\n{bad\n')));
  out.push(...p.flush());
  assert.equal(out.length, 1);
  assert.equal(p.skipped, 2);
});

test('NDJSON: CRLF と空行を吸収', () => {
  const p = new NdjsonParser();
  const out = p.push(enc.encode('{"a":1}\r\n\r\n{"a":2}\r\n'));
  assert.deepEqual(out.map((o) => o.a), [1, 2]);
});

test('分離（主経路）: message.thinking / message.content を別扱い', () => {
  const si = new StreamInterpreter();
  const frags = [];
  frags.push(...si.push(enc.encode('{"message":{"thinking":"考え"}}\n')));
  frags.push(...si.push(enc.encode('{"message":{"content":"答え"}}\n')));
  frags.push(...si.push(enc.encode('{"done":true}\n')));
  frags.push(...si.flush());
  assert.equal(frags.map((f) => f.thinking || '').join(''), '考え');
  assert.equal(frags.map((f) => f.content || '').join(''), '答え');
  assert.ok(frags.some((f) => f.done));
});

test('フォールバック: <think> タグがチャンク跨ぎで割れる', () => {
  const s = new ThinkSplitter();
  let thinking = '';
  let content = '';
  for (const piece of ['<thi', 'nk>すいり', 'ちゅう</thi', 'nk>こたえ']) {
    const f = s.feed(piece);
    thinking += f.thinking || '';
    content += f.content || '';
  }
  const e = s.end();
  thinking += e.thinking || '';
  content += e.content || '';
  assert.equal(thinking, 'すいりちゅう');
  assert.equal(content, 'こたえ');
});

test('フォールバック: 開始・終了が対', () => {
  const s = new ThinkSplitter();
  const f = s.feed('<think>reason</think>answer');
  assert.equal(f.thinking, 'reason');
  assert.equal(f.content, 'answer');
});

test('フォールバック: 開始タグ欠落の </think> が 1 フィード内なら先頭を thinking 扱い', () => {
  const s = new ThinkSplitter();
  const f = s.feed('かんがえちゅう</think>けつろん');
  assert.equal(f.thinking, 'かんがえちゅう');
  assert.equal(f.content, 'けつろん');
});

test('緩和: プレーンな短い content は done を待たず逐次 content として流れる', () => {
  const s = new ThinkSplitter();
  // <think> タグも message.thinking も無い短い応答（1024 字未満）。
  const f1 = s.feed('短い');
  assert.equal(f1.content, '短い');
  assert.equal(f1.thinking, undefined);
  const f2 = s.feed('答えです');
  assert.equal(f2.content, '答えです');
  // end() で一括表示されるものは残っていない。
  assert.deepEqual(s.end(), {});
});

test('緩和: 先にプレーン content が流れた後の単独 </think> はタグを落として content 継続', () => {
  const s = new ThinkSplitter();
  const parts = [];
  for (const piece of ['かんがえちゅう', '</think>けつろん']) {
    const f = s.feed(piece);
    if (f.content) parts.push(f.content);
    assert.equal(f.thinking, undefined);
  }
  assert.equal(parts.join(''), 'かんがえちゅうけつろん');
});

test('StreamInterpreter: {"error":"..."} を error フラグメントとして表面化', () => {
  const si = new StreamInterpreter();
  const frags = [
    ...si.push(enc.encode('{"error":"model requires more system memory (out of memory)"}\n')),
    ...si.flush(),
  ];
  const errFrag = frags.find((f) => f.error !== undefined);
  assert.ok(errFrag, 'error フラグメントが yield されること');
  assert.match(errFrag.error, /out of memory/);
});

test('フォールバック: </think> 単独（1 フィード内）', () => {
  const s = new ThinkSplitter();
  const f = s.feed('reasoning here</think>the answer');
  assert.equal(f.thinking, 'reasoning here');
  assert.equal(f.content, 'the answer');
});

test('フォールバック: <think> 未終了は残り全部 thinking', () => {
  const s = new ThinkSplitter();
  const f = s.feed('<think>まだ考えている');
  const e = s.end();
  assert.equal((f.thinking || '') + (e.thinking || ''), 'まだ考えている');
  assert.equal((f.content || '') + (e.content || ''), '');
});
