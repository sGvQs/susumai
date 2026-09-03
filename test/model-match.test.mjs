import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMatches, collectModelNames } from '../src/client.ts';

test(':tag 付きは完全一致', () => {
  assert.equal(modelMatches('deepseek-r1:8b', ['deepseek-r1:8b']), true);
  assert.equal(modelMatches('deepseek-r1:8b', ['deepseek-r1:latest']), false);
  assert.equal(modelMatches('deepseek-r1:8b', ['deepseek-r1']), false);
});

test('tag 無しは <name> か <name>:latest に一致、:8b には一致しない', () => {
  assert.equal(modelMatches('deepseek-r1', ['deepseek-r1:latest']), true);
  assert.equal(modelMatches('deepseek-r1', ['deepseek-r1']), true);
  assert.equal(modelMatches('deepseek-r1', ['deepseek-r1:8b']), false);
});

test('collectModelNames は各エントリの name と model の両方を集める', () => {
  const names = collectModelNames({
    models: [
      { name: 'foo:1', model: 'deepseek-r1' },
      { name: 'bar', model: 'bar:2' },
    ],
  });
  assert.deepEqual(names, ['foo:1', 'deepseek-r1', 'bar', 'bar:2']);
  assert.equal(modelMatches('deepseek-r1', names), true);
});

test('壊れた /api/tags 応答でも落ちない', () => {
  assert.deepEqual(collectModelNames(null), []);
  assert.deepEqual(collectModelNames({}), []);
  assert.deepEqual(collectModelNames({ models: 'nope' }), []);
});
