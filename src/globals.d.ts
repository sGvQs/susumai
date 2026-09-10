// tsup の define で焼き込まれるビルド時定数。実行時に package.json を読まない。
declare const __VERSION__: string;
// publish 時にビルドへ焼き込まれる OAuth App の client_id（秘密ではない）。
// テスト（tsx で直接 import）では define が無いので、src/auth.ts 側で typeof ガードして参照する。
declare const __CLIENT_ID__: string;
