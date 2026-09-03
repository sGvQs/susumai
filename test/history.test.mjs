import test from 'node:test';
import assert from 'node:assert/strict';
import { History, stripThink, MAX_TURNS } from '../src/history.ts';

test('stripThink: <think>...</think> を除去', () => {
  assert.equal(stripThink('<think>ないしょ</think>これは答え'), 'これは答え');
  assert.equal(stripThink('前<think>x</think>後'), '前後');
});

test('stripThink: 未終了 <think> と迷子タグも除去', () => {
  assert.equal(stripThink('答え<think>まだ考え中'), '答え');
  assert.equal(stripThink('ゴミ</think>答え'), 'ゴミ答え');
});

test('pushAssistant は <think> を落として積む', () => {
  const h = new History();
  h.pushUser('質問');
  h.pushAssistant('<think>推論の中身</think>最終回答');
  const msgs = h.messages();
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, '最終回答');
});

test('16ターン上限で古い方から落とす', () => {
  const h = new History();
  for (let i = 0; i < 20; i += 1) h.pushUser('m' + i);
  const msgs = h.messages();
  assert.equal(msgs.length, MAX_TURNS);
  assert.equal(msgs[0].content, 'm4');
  assert.equal(msgs[msgs.length - 1].content, 'm19');
});

test('トリム時にコールバック通知', () => {
  let count = 0;
  const h = new History(() => {
    count += 1;
  });
  for (let i = 0; i < 18; i += 1) h.pushUser('x' + i);
  assert.equal(count, 2);
});

test('pushRound は user + assistant を積み <think> を落とす', () => {
  const h = new History();
  h.pushRound('質問', '<think>推論</think>回答');
  const msgs = h.messages();
  assert.deepEqual(msgs[0], { role: 'user', content: '質問' });
  assert.deepEqual(msgs[1], { role: 'assistant', content: '回答' });
});

test('pushRound: 1 ラウンドあたり onTrim 通知は最大 1 回', () => {
  let count = 0;
  const h = new History(() => {
    count += 1;
  });
  // 容量ちょうど（8 ラウンド = 16 ターン）まで埋める → まだ通知なし
  for (let i = 0; i < MAX_TURNS / 2; i += 1) h.pushRound('u' + i, 'a' + i);
  assert.equal(count, 0);
  assert.equal(h.length, MAX_TURNS);
  // さらに 1 ラウンドで 2 ターン溢れるが、通知は 1 回だけ
  h.pushRound('u8', 'a8');
  assert.equal(count, 1);
  assert.equal(h.length, MAX_TURNS);
});
