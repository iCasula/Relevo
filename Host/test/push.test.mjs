// Push notifications: the provider token APNs accepts, the key you give the host, and the iPhones it reaches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { providerToken, validKey, APNs } from '../lib/apns.mjs';
import { Host } from '../lib/host.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('the provider token is an ES256 JWT signed with the APNs key', () => {
  const jwt = providerToken({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: pem }, 1_800_000_000_000);
  const [h, c, sig] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(dec(c), { iss: 'TEAM123456', iat: 1_800_000_000 });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.ok(validKey(pem));
  assert.equal(validKey('no es una clave'), false);
});

test('without a key nothing is sent', async () => {
  const r = await new APNs(() => null).send({ token: 'x', bundleId: 'b' }, { title: 't' });
  assert.equal(r.ok, false);
});

test('the host keeps your key and the iPhones that register, and only pushes to the ones not looking', () => {
  const P = Host.prototype;
  const saved = [];
  const h = { state: {}, peers: new Set(), pushSent: new Map(), config: { name: 'TORRE' }, apns: { jwt: null, send: (d, n) => { saved.push([d.name, n.title]); return Promise.resolve({ ok: true }); } },
    _saveState() {}, _broadcastSnapshot() {}, log() {} };
  for (const k of ['_apnsConfig', '_registerDevice', 'setPushKey', '_push']) h[k] = P[k];
  assert.throws(() => h.setPushKey({ teamId: 'corto', keyId: 'KEY1234567', key: pem }), /Team ID/);
  assert.throws(() => h.setPushKey({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: 'basura' }), /\.p8/);
  h.setPushKey({ teamId: 'team123456', keyId: 'key1234567', key: pem });
  assert.equal(h.state.push.apns.teamId, 'TEAM123456');
  const phone = {}, mac = {};
  h._registerDevice(phone, { deviceId: 'D1', deviceName: 'iPhone 15 Pro', alertToken: 'abc', environment: 'development', bundleId: 'app.relevo.RelevoCompanion' });
  assert.equal(h.state.push.devices.D1.token, 'abc');
  const t = { id: 'T', title: 'Orquestador' };
  h.peers.add(phone); phone.deviceId = 'D1'; h.peers.add(mac);
  h._push(t, 'El orquestador te escribe', '¿Seguimos?', 'orquestador');
  assert.equal(saved.length, 0, 'the app is open on that iPhone: no push');
  h.peers.delete(phone);
  h._push(t, 'El orquestador te escribe', '¿Seguimos?', 'orquestador2');
  assert.deepEqual(saved, [['iPhone 15 Pro', 'El orquestador te escribe']]);
  h._push(t, 'otra vez', '', 'orquestador2');
  assert.equal(saved.length, 1, 'once a minute per thread and kind');
});
