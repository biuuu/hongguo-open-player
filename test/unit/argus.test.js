// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sm3 = require('../../src/server/native/sm3');
const { Simon, Ladon, Argus, PlayerSigner, queryParam } = require('../../src/server/native/argus');

test('sm3 vector validation', () => {
  assert.equal(sm3(Buffer.alloc(0)).toString('hex'), '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b');
  assert.equal(sm3(Buffer.from('abc')).toString('hex'), '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0');
  assert.equal(sm3(Buffer.alloc(16)).toString('hex'), '106e34a2b8c7bb13156cfdd0d91379dcc47543dcf9787c68ae5eb582620ae6e8');
});

test('simon 64/128 block cipher golden vectors', () => {
  const k = [1111111111111111111n, 2222222222222222222n, 3333333333333333333n, 4444444444444444444n];
  const ct = Simon.encrypt(1234567890123456789n, 9876543210987654321n, k);
  assert.equal(ct[0], 6071150433487837324n);
  assert.equal(ct[1], 2027321285990159935n);
  const pt = Simon.decrypt(ct[0], ct[1], k);
  assert.equal(pt[0], 1234567890123456789n);
  assert.equal(pt[1], 9876543210987654321n);
});

test('ladon cipher golden vectors', () => {
  const got = Ladon.encrypt(1700000000, 1611921764, 1967, Buffer.from('01020304', 'hex'));
  assert.equal(got, 'AQIDBKM7Y7bWnOIUXmTybD6/MpGbuge4sBwUJsyHVivhtMsH');
});

test('argus hash and 551 framing golden vectors', () => {
  assert.equal(Argus.bodyHash('').toString('hex'), '106e34a2b8c7');
  assert.equal(Argus.queryHash('').toString('hex'), '106e34a2b8c7');
  assert.equal(Argus.queryHash('aid=1967&device_id=123').toString('hex'), '925b8d86b20f');

  const query = 'aid=1967&device_id=dev_aaaaaaaa&iid=111';
  const g1 = Argus.sign(query, '', 1700000000, 1967, 1611921764, 'dev_aaaaaaaa', '', 659662259);
  const want = '8oHyrVYEy1xDCDlx64ko40qC6JC9VYY/ZkjJzEl50iSFDw8Yfph1hupLxfKrA9GswSEz0Yi4goA7OQ4u+H8ECdOaQDL4GduQ3LULSq9Q4iSEGbS3L6G24GXChtnmPr6n46M2PLlKpXvF7uE0lhH4yD+X69FpdM41gQwx5Y5U3NdwXFaxlqYFszyp7dlUE6BEBWqwDsiAH8Jk9TGKr/jfHt4fVmMc9zRyNRdGeV0x6aP//x7aV+8Po8a/9KK3UNG5KEpmIgzRT6NUttkBP9gRNUh3';
  assert.equal(g1, want);
});

test('playerSigner headers structure', () => {
  const query = 'aid=8662&device_id=1234567890&iid=99';
  const body = Buffer.from('{"x":1}');
  const headers = PlayerSigner.headers(query, body, 1700000000);
  assert.equal(headers['x-khronos'], '1700000000');
  assert.equal(headers['x-ss-req-ticket'], '1700000000000');
  assert.ok(headers['x-ss-stub']);
  assert.ok(headers['x-ladon']);
  assert.ok(headers['x-argus']);
});

test('queryParam extracts values and tolerates malformed URI encoding', () => {
  assert.equal(queryParam('foo=bar&baz=123', 'baz'), '123');
  assert.equal(queryParam('foo=bar&baz=123', 'missing'), null);
  assert.equal(queryParam('', 'foo'), null);
  assert.equal(queryParam(null, 'foo'), null);
  // Malformed percent encoding should not throw
  assert.equal(queryParam('foo=%E0%A4%A&bar=test', 'bar'), 'test');
  assert.equal(queryParam('bad=%99', 'bad'), '%99');
});
