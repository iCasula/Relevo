// The whole host with the echo agent (RELEVO_FAKE_AGENT=1), driven over TLS-PSK as the iPhone and the desktop
// app do: pairing, a turn, a permission, a relay when the quota runs out, the app's requests and its page.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCompanion } from '../lib/transport.mjs';
import { parsePairingLink, Client } from '../ui/state.mjs';

const HOST = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(HOST, 'relevo-host.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-e2e-'));
const port = 41000 + Math.floor(Math.random() * 8000);
const env = {
  ...process.env, RELEVO_HOST_DATA: path.join(dir, 'data'), RELEVO_PROJECTS: path.join(dir, 'projects'), RELEVO_PORT: String(port),
  RELEVO_UI_PORT: String(port + 1), RELEVO_FAKE_AGENT: '1', RELEVO_SUPERVISE: '0', RELEVO_HOST_NAME: 'E2E', RELEVO_ENV_FILE: path.join(dir, 'none.env'),
};
let service, peer;
const inbox = [];
const waiters = [];

function next(predicate, timeout = 15_000) {
  const i = inbox.findIndex(predicate);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve };
    waiters.push(w);
    setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      const recent = inbox.slice(-4).map((m) => JSON.stringify(m).slice(0, 400)).join('\n');
      reject(new Error(`timed out waiting for a message; latest unclaimed:\n${recent}`));
    }, timeout);
  });
}

before(async () => {
  fs.mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
  service = spawn(process.execPath, [SCRIPT, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host didn't start:\n${out}`)), 20_000);
    const onData = (d) => { out += d; if (out.includes('listening on') && out.includes('desktop app on')) { clearTimeout(timer); resolve(); } };
    service.stdout.on('data', onData);
    service.stderr.on('data', onData);
  });
  const link = execFileSync(process.execPath, [SCRIPT, 'pair'], { env }).toString().trim();
  const info = parsePairingLink(link);
  peer = await connectCompanion({ host: '127.0.0.1', port, serverId: info.serverId, secret: Buffer.from(info.key, 'base64url') });
  peer.on('message', (data) => {
    const msg = JSON.parse(data.toString('utf8'));
    const w = waiters.find((x) => x.predicate(msg));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else inbox.push(msg);
  });
});

after(() => {
  peer?.close();
  service?.kill();
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
});

const reply = (requestId) => (m) => m.reply?.requestId === requestId;
let threadId, snapshot;

test('pairing and welcome', async () => {
  const wrong = connectCompanion({ host: '127.0.0.1', port, serverId: 'relevo-x', secret: Buffer.alloc(32) });
  await assert.rejects(wrong, (e) => e.reason === 'key' || e.reason === 'unreachable');
  peer.send(Client.hello('E2E', ));
  assert.equal((await next((m) => m.welcome)).welcome.name, 'E2E');
  snapshot = (await next((m) => m.snapshot)).snapshot._0;
  assert.equal(snapshot.projects[0].name, 'demo');
  assert.ok(snapshot.hostFeatures.includes('settings'));
});

test('a turn, end to end', async () => {
  peer.send(Client.newThread(snapshot.projects[0].id, 'R1'));
  threadId = (await next((m) => m.created?.requestId === 'R1')).created.threadId;
  peer.send(Client.subscribe(threadId));
  await next((m) => m.thread?._0.id === threadId);
  peer.send(Client.send(threadId, 'hola'));
  const done = await next((m) => m.threadPatch && !m.threadPatch._0.runtime.isRunning && m.threadPatch._0.upserts.some((i) => i.kind === 'assistant' && i.usage));
  assert.match(done.threadPatch._0.upserts.find((i) => i.kind === 'assistant').text, /Eco .*hola/);
});

test('a permission request', async () => {
  peer.send(Client.send(threadId, 'necesito permiso'));
  const ask = await next((m) => m.threadPatch?._0.upserts.some((i) => i.kind === 'approval' && !i.resolution));
  const item = ask.threadPatch._0.upserts.find((i) => i.kind === 'approval');
  peer.send(Client.approve(threadId, item.id, 'allow'));
  await next((m) => m.threadPatch?._0.upserts.some((i) => i.id === item.id && i.resolution === 'Permitir'));
});

test('out of quota: relay to the other subscription', async () => {
  const codex = snapshot.accounts.find((a) => a.kind === 'codex');
  peer.send(Client.setLimitPlan(threadId, { mode: 'mostQuota', targets: [] }));
  peer.send(Client.send(threadId, 'agota la cuota ya'));
  const pending = await next((m) => m.threadPatch?._0.runtime.pendingRelay);
  assert.equal(pending.threadPatch._0.runtime.pendingRelay.accountId, codex.id);
  peer.send(Client.limitAction(threadId, 'relayNow'));
  await next((m) => m.threadPatch?._0.upserts.some((i) => i.kind === 'notice' && /Relevo de Claude a Codex/.test(i.text)));
  const after = await next((m) => m.threadPatch && !m.threadPatch._0.runtime.isRunning && m.threadPatch._0.runtime.selectedAccountId === codex.id);
  assert.ok(after);
});

test('the desktop app requests', async () => {
  peer.send({ listDirectory: { requestId: 'D1', path: dir } });
  const list = (await next(reply('D1'))).reply;
  assert.ok(list.ok, list.error);
  assert.ok(list.directory.folders.some((f) => f.name === 'projects'));
  peer.send({ createProject: { requestId: 'D2', name: 'nuevo', git: false } });
  assert.ok((await next(reply('D2'))).reply.ok);
  peer.send({ renameThread: { requestId: 'D3', threadId, title: 'Renombrado' } });
  assert.ok((await next(reply('D3'))).reply.ok);
  peer.send({ usageReport: { requestId: 'D4', days: 30 } });
  const usage = (await next(reply('D4'))).reply.usage;
  assert.ok(usage.total.turns >= 2);
  peer.send({ setSettings: { requestId: 'D5', settings: { defaultMode: 'plan', maxAgents: 3 } } });
  assert.ok((await next(reply('D5'))).reply.ok);
  const snap = await next((m) => m.snapshot?._0.hostSettings.defaultMode === 'plan' && m.snapshot._0.projects.some((p) => p.name === 'nuevo'));
  assert.equal(snap.snapshot._0.hostSettings.maxAgents, 3);
  assert.equal(snap.snapshot._0.threads.find((t) => t.id === threadId).title, 'Renombrado');
});

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port + 1, path: urlPath, headers }, (res) => { res.resume(); resolve(res); }).on('error', reject);
  });
}

test('the desktop page: only with the token, only from itself', async () => {
  const token = fs.readFileSync(path.join(env.RELEVO_HOST_DATA, 'desktop', 'ui-token'), 'utf8').trim();
  assert.equal((await get('/')).statusCode, 403);
  const login = await get(`/?t=${token}`);
  assert.equal(login.statusCode, 302);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get('/app.mjs', { Cookie: cookie })).statusCode, 200);
  assert.equal((await get('/', { Cookie: cookie, Host: `evil.example:${port + 1}` })).statusCode, 421);
  const ws = await get('/ws', { Cookie: cookie, Origin: 'http://evil.example', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }).catch(() => ({ statusCode: 403 }));
  assert.notEqual(ws.statusCode, 101);
});
