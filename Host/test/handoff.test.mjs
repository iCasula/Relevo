// Switching agents and handing the thread over: `node --test Host/test/`.
// The handoff text, a manual switch Claude → Codex, and the automatic relay when the quota runs out, on the
// whole host with the echo agent (RELEVO_FAKE_AGENT=1).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCompanion } from '../lib/transport.mjs';
import { handoffText } from '../lib/handoff.mjs';
import { parsePairingLink, Client } from '../ui/state.mjs';

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'relevo-host.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-handoff-'));
const port = 41000 + Math.floor(Math.random() * 8000);
const env = {
  ...process.env, RELEVO_HOST_DATA: path.join(dir, 'data'), RELEVO_PROJECTS: path.join(dir, 'projects'), RELEVO_PORT: String(port),
  RELEVO_FAKE_AGENT: '1', RELEVO_SUPERVISE: '0', RELEVO_ENV_FILE: path.join(dir, 'none.env'),
};
let service, peer, snapshot, threadId;
const inbox = [], waiters = [];

function next(predicate, timeout = 15_000) {
  const i = inbox.findIndex(predicate);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve };
    waiters.push(w);
    setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      const recent = inbox.filter((m) => m.threadPatch).slice(-3).map((m) => JSON.stringify(m.threadPatch._0.upserts.map((i) => [i.kind, i.text?.slice(0, 60)])) + JSON.stringify(m.threadPatch._0.runtime).slice(0, 200)).join('\n');
      reject(new Error(`timed out waiting for a message; latest:\n${recent}`));
    }, timeout);
  });
}
const finished = (account) => (m) => m.threadPatch?._0.id === threadId && !m.threadPatch._0.runtime.isRunning
  && m.threadPatch._0.upserts.some((i) => i.kind === 'assistant' && i.usage && i.accountId === account.id);

before(async () => {
  fs.mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
  service = spawn(process.execPath, [SCRIPT, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host didn't start:\n${out}`)), 20_000);
    service.stdout.on('data', (d) => { out += d; if (out.includes('listening on')) { clearTimeout(timer); resolve(); } });
  });
  const info = parsePairingLink(execFileSync(process.execPath, [SCRIPT, 'pair'], { env }).toString().trim());
  peer = await connectCompanion({ host: '127.0.0.1', port, serverId: info.serverId, secret: Buffer.from(info.key, 'base64url') });
  peer.on('message', (data) => {
    const msg = JSON.parse(data.toString('utf8'));
    const w = waiters.find((x) => x.predicate(msg));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else inbox.push(msg);
  });
  peer.send(Client.hello('Test'));
  snapshot = (await next((m) => m.snapshot)).snapshot._0;
  peer.send(Client.newThread(snapshot.projects[0].id, 'R1'));
  threadId = (await next((m) => m.created?.requestId === 'R1')).created.threadId;
  peer.send(Client.subscribe(threadId));
  await next((m) => m.thread?._0.id === threadId);
});

after(() => {
  peer?.close();
  service?.kill();
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
});

const account = (kind) => snapshot.accounts.find((a) => a.kind === kind);

test('the handoff carries the conversation, the work state and the unfinished request', () => {
  const text = handoffText({
    items: [{ kind: 'user', text: 'Arregla el login' }, { kind: 'assistant', text: 'Mirando auth.ts', accountId: 'A' }, { kind: 'tool', toolName: 'Edit', title: 'Editar auth.ts', toolState: 'done' }],
    accounts: new Map([['A', { name: 'Claude', agentName: 'Claude Code' }]]), projectPath: '/p',
    target: { agentName: 'Codex' }, pendingRequest: true, workState: '- Rama: main\n- Cambios sin commit (1):\n  - modificado: auth.ts (+3 −1)',
  });
  assert.match(text, /^<relevo_handoff>/);
  assert.match(text, /como Codex/);
  assert.match(text, /<estado_de_trabajo>\n- Rama: main[\s\S]*auth\.ts \(\+3 −1\)\n<\/estado_de_trabajo>/);
  assert.match(text, /### Usuario\nArregla el login/);
  assert.match(text, /### Asistente \(Claude\)\nMirando auth\.ts/);
  assert.match(text, /\[herramienta Edit\] Editar auth\.ts/);
  assert.match(text, /quedó sin terminar/);
});

test('switching agent by hand: the next message goes to Codex with the thread as context', async () => {
  const claude = account('claude'), codex = account('codex');
  peer.send(Client.send(threadId, 'primer mensaje'));
  await next(finished(claude));
  peer.send(Client.select(threadId, codex.id, 'default'));
  await next((m) => m.threadPatch?._0.upserts.some((i) => i.kind === 'notice' && /Relevo: Claude · .* → Codex/.test(i.text)));
  peer.send(Client.send(threadId, 'segundo mensaje'));
  const reply = (await next(finished(codex))).threadPatch._0.upserts.find((i) => i.kind === 'assistant');
  // The echo agent repeats its prompt: the handoff with the first exchange, then the new message.
  assert.match(reply.text, /<relevo_handoff>[\s\S]*primer mensaje[\s\S]*Nuevo mensaje del usuario:\s*segundo mensaje/);
});

test('out of quota: the thread relays on its own to the subscription with most quota left', async () => {
  const claude = account('claude'), codex = account('codex');
  peer.send(Client.select(threadId, claude.id, 'default'));
  await next((m) => m.threadPatch?._0.upserts.some((i) => i.kind === 'notice' && /Relevo: Codex · .* → Claude/.test(i.text)));
  peer.send(Client.send(threadId, 'vuelvo a Claude'));
  await next(finished(claude)); // takes the handoff, so the next prompt starts with the request itself
  peer.send(Client.setLimitPlan(threadId, { mode: 'mostQuota', targets: [] }));
  peer.send(Client.send(threadId, 'agota la cuota ahora'));
  const pending = await next((m) => m.threadPatch?._0.runtime.pendingRelay);
  assert.equal(pending.threadPatch._0.runtime.pendingRelay.accountId, codex.id);
  peer.send(Client.limitAction(threadId, 'relayNow'));
  await next((m) => m.threadPatch?._0.upserts.some((i) => i.kind === 'notice' && /Relevo: Claude · .* → Codex/.test(i.text)));
  const reply = (await next(finished(codex))).threadPatch._0.upserts.find((i) => i.kind === 'assistant');
  assert.match(reply.text, /quedó sin terminar/, 'Codex is asked to carry on with the request that ran out');
});
