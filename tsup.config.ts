import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

// OAuth App の client_id を publish 時にビルドへ焼き込む（実行時 env なしで `susumai login` が動く）。
// ビルド時に SUSUMAI_OAUTH_CLIENT_ID が立っていればそれを、無ければこの repo の OAuth App の既定を使う。
// 秘密ではない（公開情報）。実行時の env override は src/auth.ts の clientId() が引き続き優先する。
const clientId = process.env.SUSUMAI_OAUTH_CLIENT_ID || 'Ov23liuaEuBGcxLCPA3T';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __CLIENT_ID__: JSON.stringify(clientId),
  },
});
