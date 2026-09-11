import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseDeviceCodeResponse,
  classifyPollResponse,
  classifyRefreshResponse,
  toTokenGrant,
  nextInterval,
  clientId,
  isNonInteractive,
} = await import('../src/auth.ts');

// --- parseDeviceCodeResponse --------------------------------------------

test('parseDeviceCodeResponse: 正常応答を DeviceCode にする', () => {
  const dc = parseDeviceCodeResponse({
    device_code: 'dc_xxx',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval: 5,
    expires_in: 899,
  });
  assert.deepEqual(dc, {
    deviceCode: 'dc_xxx',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    interval: 5,
    expiresIn: 899,
  });
});

test('parseDeviceCodeResponse: interval / expires_in 欠落は既定にフォールバック', () => {
  const dc = parseDeviceCodeResponse({
    device_code: 'dc',
    user_code: 'x',
    verification_uri: 'https://github.com/login/device',
  });
  assert.equal(dc.interval, 5);
  assert.equal(dc.expiresIn, 900);
});

test('parseDeviceCodeResponse: 必須欠落は throw', () => {
  assert.throws(() => parseDeviceCodeResponse({ user_code: 'x' }), /必須フィールド/);
  assert.throws(() => parseDeviceCodeResponse(null), /解釈できません/);
});

test('parseDeviceCodeResponse: error 応答は throw', () => {
  assert.throws(
    () => parseDeviceCodeResponse({ error: 'unauthorized_client', error_description: 'bad app' }),
    /bad app/,
  );
});

// --- classifyPollResponse ----------------------------------------------

test('classifyPollResponse: access_token → { token }', () => {
  assert.deepEqual(classifyPollResponse({ access_token: 'gho_tok', token_type: 'bearer' }), {
    token: 'gho_tok',
  });
});

test('classifyPollResponse: refresh_token / expires_in ありなら全フィールドを載せる', () => {
  assert.deepEqual(
    classifyPollResponse({
      access_token: 'gho_tok',
      refresh_token: 'ghr_tok',
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
      token_type: 'bearer',
    }),
    {
      token: 'gho_tok',
      refreshToken: 'ghr_tok',
      expiresIn: 28800,
      refreshTokenExpiresIn: 15897600,
    },
  );
});

test('classifyPollResponse: refresh_token 等が無ければ従来どおり { token } のみ（後方互換）', () => {
  assert.deepEqual(classifyPollResponse({ access_token: 'gho_tok' }), { token: 'gho_tok' });
});

test('toTokenGrant: 非正 / 型不一致のフィールドは省略する', () => {
  assert.deepEqual(toTokenGrant({ access_token: 't', expires_in: 0, refresh_token: '' }), {
    token: 't',
  });
  assert.deepEqual(toTokenGrant({ access_token: 't', expires_in: '28800' }), { token: 't' });
});

// --- classifyRefreshResponse ------------------------------------------

test('classifyRefreshResponse: 正常応答は TokenGrant（新 refresh_token 同梱）', () => {
  assert.deepEqual(
    classifyRefreshResponse({
      access_token: 'gho_new',
      refresh_token: 'ghr_new',
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
    }),
    {
      token: 'gho_new',
      refreshToken: 'ghr_new',
      expiresIn: 28800,
      refreshTokenExpiresIn: 15897600,
    },
  );
});

test('classifyRefreshResponse: bad_refresh_token → invalid_grant', () => {
  assert.equal(classifyRefreshResponse({ error: 'bad_refresh_token' }), 'invalid_grant');
  assert.equal(classifyRefreshResponse({ error: 'invalid_grant' }), 'invalid_grant');
  assert.equal(classifyRefreshResponse({ error: 'unauthorized' }), 'invalid_grant');
});

test('classifyRefreshResponse: 未知 error / 非オブジェクトは throw', () => {
  assert.throws(() => classifyRefreshResponse({ error: 'wat' }), /予期しない/);
  assert.throws(() => classifyRefreshResponse(null), /解釈できません/);
});

test('classifyPollResponse: authorization_pending → pending', () => {
  assert.equal(classifyPollResponse({ error: 'authorization_pending' }), 'pending');
});

test('classifyPollResponse: slow_down → slow_down', () => {
  assert.equal(classifyPollResponse({ error: 'slow_down' }), 'slow_down');
});

test('classifyPollResponse: expired_token → expired', () => {
  assert.equal(classifyPollResponse({ error: 'expired_token' }), 'expired');
});

test('classifyPollResponse: access_denied → denied', () => {
  assert.equal(classifyPollResponse({ error: 'access_denied' }), 'denied');
});

test('classifyPollResponse: 未知の error は throw', () => {
  assert.throws(() => classifyPollResponse({ error: 'wat', error_description: 'unexpected' }), /予期しない/);
  assert.throws(() => classifyPollResponse(null), /解釈できません/);
});

// --- nextInterval -----------------------------------------------------

test('nextInterval: slow_down で +5s、それ以外は据え置き', () => {
  assert.equal(nextInterval(5, true), 10);
  assert.equal(nextInterval(10, true), 15);
  assert.equal(nextInterval(5, false), 5);
});

// --- isNonInteractive -----------------------------------------------

test('isNonInteractive: (a) TTY かつ CI 無し → false / (b) CI=1 → true / (c) isTTY 偽 → true', () => {
  const prevCI = process.env.CI;
  const hadOwnTTY = Object.prototype.hasOwnProperty.call(process.stdin, 'isTTY');
  const prevTTY = process.stdin.isTTY;
  const setTTY = (v) => {
    Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true, writable: true });
  };
  try {
    // (a)
    delete process.env.CI;
    setTTY(true);
    assert.equal(isNonInteractive(), false);
    // (b)
    process.env.CI = '1';
    assert.equal(isNonInteractive(), true);
    // (c)
    delete process.env.CI;
    setTTY(false);
    assert.equal(isNonInteractive(), true);
  } finally {
    if (prevCI === undefined) delete process.env.CI;
    else process.env.CI = prevCI;
    if (hadOwnTTY) setTTY(prevTTY);
    else delete process.stdin.isTTY;
  }
});

// --- clientId --------------------------------------------------------

test('clientId: env override が効く / 既定にフォールバック', () => {
  const prev = process.env.SUSUMAI_OAUTH_CLIENT_ID;
  try {
    process.env.SUSUMAI_OAUTH_CLIENT_ID = 'Ov_custom';
    assert.equal(clientId(), 'Ov_custom');
    delete process.env.SUSUMAI_OAUTH_CLIENT_ID;
    assert.equal(typeof clientId(), 'string');
    assert.ok(clientId().length > 0);
  } finally {
    if (prev === undefined) delete process.env.SUSUMAI_OAUTH_CLIENT_ID;
    else process.env.SUSUMAI_OAUTH_CLIENT_ID = prev;
  }
});
