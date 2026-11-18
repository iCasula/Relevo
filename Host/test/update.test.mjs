// Updating without cutting the agents: the restart waits while an agent works, new messages wait in their
// queue, and they go out on their own after the restart. On the whole host with the echo agent.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCompanion } from '../lib/transport.mjs';
import { parsePairingLink, Client } from '../ui/state.mjs';

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'relevo-host.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-update-'));
const port = 41000 + Math.floor(Math.random() * 8000);
const env = {
  ...process.env, RELEVO_HOST_DATA: path.join(dir, 'data'), RELEVO_PROJECTS: path.join(dir, 'projects'), RELEVO_PORT: String(port),
  RELEVO_FAKE_AGENT: '1', RELEVO_SUPERVISE: '0', RELEVO_ENV_FILE: path.join(dir, 'none.env'),
};
fs.mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
let service, peer, log = '';
const inbox = [], waiters = [];

function next(predicate, timeout = 15_000) {
  const i = inbox.findIndex(predicate);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve };
    waiters.push(w);
    setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out; host log:\n${log.slice(-1500)}`)); }, timeout);
  });
}

async function start() {
  service = spawn(process.execPath, [SCRIPT, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host didn't start:\n${log}`)), 20_000);
    const on = () => { if (log.includes(`listening on :${port}`)) { clearTimeout(timer); service.stdout.off('data', on); resolve(); } };
    service.stdout.on('data', on);
  });
  const info = parsePairingLink(execFileSync(process.execPath, [SCRIPT, 'pair'], { env }).toString().trim());
  peer = await connectCompanion({ host: '127.0.0.1', port, serverId: info.serverId, secret: Buffer.from(info.key, 'base64url') });
  peer.on('message', (data) => {
    const msg = JSON.parse(data.toString('utf8'));
    const w = waiters.find((x) => x.predicate(msg));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else inbox.push(msg);
  });
  peer.send(Client.hello('Test'));
  return (await next((m) => m.snapshot)).snapshot._0;
}

after(() => {
  peer?.close();
  service?.kill();
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
});

test('an update waits for the working agent, holds new messages and sends them after the restart', async () => {
  const snapshot = await start();
  const project = snapshot.projects[0].id;
  peer.send(Client.newThread(project, 'A'));
  const busy = (await next((m) => m.created?.requestId === 'A')).created.threadId;
  peer.send(Client.newThread(project, 'B'));
  const other = (await next((m) => m.created?.requestId === 'B')).created.threadId;

  // An agent busy: it asks a question and waits for the answer.
  peer.send(Client.subscribe(busy));
  peer.send(Client.send(busy, 'pregunta algo'));
  await next((m) => m.threadPatch?._0.id === busy && m.threadPatch._0.upserts.some((i) => i.kind === 'approval'));

  // The update asks for a restart: the service stays up while the agent is busy.
  fs.writeFileSync(path.join(dir, 'data', 'control', 'restart'), '');
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(service.exitCode, null, 'the service kept running');
  assert.match(log, /restarting when the agents are idle \(1 busy\)/);

  // A new message elsewhere waits in its queue instead of starting a turn.
  peer.send(Client.subscribe(other));
  peer.send(Client.send(other, 'mensaje durante la actualización'));
  const held = await next((m) => m.threadPatch?._0.id === other && m.threadPatch._0.runtime.queued?.length === 1);
  assert.ok(held.threadPatch._0.upserts.some((i) => i.kind === 'notice' && /se está actualizando/.test(i.text)));

  // The agent finishes: now the service restarts.
  const exited = new Promise((resolve) => service.once('exit', resolve));
  peer.send(Client.subscribe(busy));
  const q = (await next((m) => m.thread?._0.id === busy && m.thread._0.items.some((i) => i.kind === 'approval'))).thread._0.items.find((i) => i.kind === 'approval');
  peer.send(Client.answer(busy, q.id, { [q.questions[0].question]: 'Azul' }));
  assert.equal(await exited, 75, 'restarted for the update once idle');

  // Back up: the held message goes out by itself.
  peer.close();
  inbox.length = 0;
  log = '';
  await start();
  peer.send(Client.subscribe(other));
  const done = await next((m) => m.threadPatch?._0.id === other && m.threadPatch._0.upserts.some((i) => i.kind === 'assistant' && /mensaje durante la actualización/.test(i.text) && i.usage));
  assert.ok(done);
});

test('after a restart that cut a turn, the agent carries on and its queue goes out', async () => {
  // (The host from the previous test is running.)
  const snapshot = await (async () => { peer.send(Client.hello('Test')); return (await next((m) => m.snapshot)).snapshot._0; })();
  peer.send(Client.newThread(snapshot.projects[0].id, 'K'));
  const id = (await next((m) => m.created?.requestId === 'K')).created.threadId;
  peer.send(Client.subscribe(id));
  peer.send(Client.send(id, 'pregunta y espera'));
  await next((m) => m.threadPatch?._0.id === id && m.threadPatch._0.upserts.some((i) => i.kind === 'approval'));
  peer.send(Client.send(id, 'mensaje en cola'));
  await next((m) => m.threadPatch?._0.id === id && m.threadPatch._0.runtime.queued?.length === 1);

  // The host stops mid-turn (as a forced restart does) and comes back.
  const exited = new Promise((resolve) => service.once('exit', resolve));
  fs.writeFileSync(path.join(dir, 'data', 'control', 'restartNow'), '');
  await exited;
  peer.close();
  inbox.length = 0;
  log = '';
  await start();
  peer.send(Client.subscribe(id));
  const resumed = await next((m) => m.threadPatch?._0.id === id && m.threadPatch._0.upserts.some((i) => i.kind === 'user' && i.from?.label === 'reinicio'), 20_000);
  assert.ok(resumed.threadPatch._0.upserts.some((i) => i.kind === 'notice' && /se ha reiniciado a mitad/.test(i.text)));
  // The resumed turn ends, then the queued message runs.
  await next((m) => m.threadPatch?._0.id === id && m.threadPatch._0.upserts.some((i) => i.kind === 'assistant' && /mensaje en cola/.test(i.text) && i.usage), 20_000);
});
