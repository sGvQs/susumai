import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatStream } from '../src/client.ts';

/** NDJSON 行を順に書き出す使い捨て /api/chat サーバを立てる。受信した body を記録する。 */
function startServer(lines, opts = {}) {
  const state = { body: null };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', async () => {
        state.body = JSON.parse(data);
        res.writeHead(opts.status ?? 200, { 'content-type': 'application/x-ndjson' });
        for (const line of lines) res.write(line + '\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      state.url = `http://127.0.0.1:${port}`;
      state.close = () => server.close();
      resolve(state);
    });
  });
}

async function collect(gen) {
  const out = [];
  for await (const f of gen) out.push(f);
  return out;
}

test('stream:true — フラグメントは逐次 yield され、ワイヤも stream:true', async () => {
  const srv = await startServer([
    '{"message":{"thinking":"かんが"}}',
    '{"message":{"content":"こた"}}',
    '{"message":{"content":"え"}}',
    '{"done":true}',
  ]);
  try {
    const cfg = { model: 'm', numCtx: 4096, stream: true, url: srv.url };
    const frags = await collect(chatStream(cfg, [{ role: 'user', content: 'hi' }]));
    assert.equal(srv.body.stream, true);
    assert.equal(srv.body.think, true);
    assert.equal(srv.body.options.num_ctx, 4096);
    assert.equal(srv.body.options.temperature, 0.6);
    // 逐次: content フラグメントが 2 つ（結合されない）
    const contents = frags.filter((f) => f.content !== undefined).map((f) => f.content);
    assert.deepEqual(contents, ['こた', 'え']);
    assert.ok(frags.some((f) => f.done));
  } finally {
    srv.close();
  }
});

test('--no-stream（cfg.stream=false）— ワイヤは stream:true、表示は一括', async () => {
  const srv = await startServer([
    '{"message":{"thinking":"す"}}',
    '{"message":{"thinking":"いり"}}',
    '{"message":{"content":"こ"}}',
    '{"message":{"content":"たえ"}}',
    '{"done":true}',
  ]);
  try {
    const cfg = { model: 'm', numCtx: 8192, stream: false, url: srv.url };
    const frags = await collect(chatStream(cfg, [{ role: 'user', content: 'hi' }]));
    // 内部的には stream:true を送る
    assert.equal(srv.body.stream, true);
    // 蓄積されて一括: thinking 1件・content 1件・done 1件のみ
    const thinking = frags.filter((f) => f.thinking !== undefined);
    const content = frags.filter((f) => f.content !== undefined);
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].thinking, 'すいり');
    assert.equal(content.length, 1);
    assert.equal(content[0].content, 'こたえ');
    assert.equal(frags.filter((f) => f.done).length, 1);
    // 一括分は末尾: 最初の frag が done ではない
    assert.equal(frags[frags.length - 1].done, true);
  } finally {
    srv.close();
  }
});

test('--no-stream — サーバ由来 error は蓄積せず即 yield', async () => {
  const srv = await startServer(['{"error":"out of memory"}']);
  try {
    const cfg = { model: 'm', numCtx: 4096, stream: false, url: srv.url };
    const frags = await collect(chatStream(cfg, [{ role: 'user', content: 'hi' }]));
    assert.equal(frags.length, 1);
    assert.match(frags[0].error, /out of memory/);
  } finally {
    srv.close();
  }
});

test('!resp.ok — 未消費ボディを解放して分かりやすいエラーを投げる', async () => {
  const srv = await startServer(['nope'], { status: 503 });
  try {
    const cfg = { model: 'm', numCtx: 4096, stream: true, url: srv.url };
    await assert.rejects(collect(chatStream(cfg, [{ role: 'user', content: 'hi' }])), /HTTP 503/);
  } finally {
    srv.close();
  }
});
