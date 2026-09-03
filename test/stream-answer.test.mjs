import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamAnswer } from '../src/index.ts';
import { History } from '../src/history.ts';

// 注意: streamAnswer は process.stdout に直接書く。`node --test` は子プロセスの
// stdout でテスト結果を親に返すため、stdout を差し替えて飲み込むと結果報告が壊れる。
// ここでは飲み込まず、生成テキストが TAP 出力に少量混ざるのを許容する。

function startServer(lines) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const line of lines) res.write(line + '\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const sig = () => new AbortController().signal;

test('成功したラウンドは user + assistant を履歴に確定する', async () => {
  const srv = await startServer(['{"message":{"content":"答え"}}', '{"done":true}']);
  try {
    const cfg = { model: 'm', numCtx: 4096, stream: true, url: srv.url };
    const history = new History();
    await streamAnswer(cfg, history, 'しつもん', sig());
    const msgs = history.messages();
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], { role: 'user', content: 'しつもん' });
    assert.deepEqual(msgs[1], { role: 'assistant', content: '答え' });
  } finally {
    srv.close();
  }
});

test('サーバ由来エラーで throw したラウンドは履歴に残らない', async () => {
  const srv = await startServer(['{"error":"out of memory"}']);
  try {
    const cfg = { model: 'm', numCtx: 4096, stream: true, url: srv.url };
    const history = new History();
    await assert.rejects(streamAnswer(cfg, history, 'しつもん', sig()));
    assert.equal(history.length, 0);
  } finally {
    srv.close();
  }
});

test('空ストリーム（応答が空文字）のラウンドは履歴に残らない', async () => {
  const srv = await startServer(['{"done":true}']);
  try {
    const cfg = { model: 'm', numCtx: 4096, stream: true, url: srv.url };
    const history = new History();
    await streamAnswer(cfg, history, 'しつもん', sig());
    assert.equal(history.length, 0);
  } finally {
    srv.close();
  }
});

test('失敗ラウンドの後、成功ラウンドの履歴に失敗 user ターンが混入しない', async () => {
  const bad = await startServer(['{"error":"boom"}']);
  const good = await startServer(['{"message":{"content":"OK"}}', '{"done":true}']);
  try {
    const history = new History();
    await assert.rejects(
      streamAnswer({ model: 'm', numCtx: 4096, stream: true, url: bad.url }, history, '失敗する質問', sig()),
    );
    await streamAnswer({ model: 'm', numCtx: 4096, stream: true, url: good.url }, history, '成功する質問', sig());
    assert.deepEqual(
      history.messages().map((m) => m.content),
      ['成功する質問', 'OK'],
    );
  } finally {
    bad.close();
    good.close();
  }
});
