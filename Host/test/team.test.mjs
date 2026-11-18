// Teams: an orchestrator handing out work, an executor asking it a question, and a researcher reporting to
// both, on the whole host with the echo agent (RELEVO_FAKE_AGENT=1). The echo agent repeats each message,
// so a message with an order makes the orchestrator «give» that order.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCompanion } from '../lib/transport.mjs';
import { parseOrders, withoutOrders, findMember } from '../lib/team.mjs';
import { parsePairingLink, Client } from '../ui/state.mjs';

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'relevo-host.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-team-'));
const port = 41000 + Math.floor(Math.random() * 8000);
const env = {
  ...process.env, RELEVO_HOST_DATA: path.join(dir, 'data'), RELEVO_PROJECTS: path.join(dir, 'projects'), RELEVO_PORT: String(port),
  RELEVO_FAKE_AGENT: '1', RELEVO_SUPERVISE: '0', RELEVO_ENV_FILE: path.join(dir, 'none.env'),
};
let service, peer, snapshot, team, lead;
const inbox = [], waiters = [];

function next(predicate, timeout = 15_000) {
  const i = inbox.findIndex(predicate);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve };
    waiters.push(w);
    setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      const recent = inbox.filter((m) => m.threadPatch).slice(-4).map((m) => JSON.stringify(m.threadPatch._0.upserts.map((x) => [x.kind, x.from?.name, x.text?.slice(0, 80)]))).join('\n');
      reject(new Error(`timed out waiting for a message; latest:\n${recent}`));
    }, timeout);
  });
}
let n = 0;
function request(name, body) {
  const requestId = `T${++n}`;
  peer.send({ [name]: { ...body, requestId } });
  return next((m) => m.reply?.requestId === requestId).then((m) => m.reply);
}
/** A message in the orchestrator's thread from a team member. */
const fromMember = (name, label) => (m) => m.threadPatch?._0.id === lead
  && m.threadPatch._0.upserts.some((x) => x.kind === 'user' && (x.from?.name === name && x.from?.label === label || x.text?.includes(`[${name} · ${label}]`)));
const itemOf = (msg, name) => msg.threadPatch._0.upserts.find((x) => x.kind === 'user' && (x.from?.name === name || x.text?.includes(`[${name} ·`)));
const idle = (m) => m.threadPatch?._0.id === lead && !m.threadPatch._0.runtime.isRunning && !m.threadPatch._0.runtime.queued?.length;

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
});

after(() => {
  peer?.close();
  service?.kill();
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
});

test('orders are read outside code blocks and members found by name', () => {
  const text = 'Plan:\n<relevo:tarea para="Ejecutor 2">haz el login</relevo:tarea>\n```xml\n<relevo:fin>no</relevo:fin>\n```\n<relevo:investigar>librerías OAuth</relevo:investigar>';
  assert.deepEqual(parseOrders(text), [{ type: 'tarea', to: 'Ejecutor 2', body: 'haz el login' }, { type: 'investigar', to: null, body: 'librerías OAuth' }]);
  assert.equal(withoutOrders('Listo.\n<relevo:pregunta>¿A o B?</relevo:pregunta>'), 'Listo.');
  const t = { members: [{ name: 'Orquestador', role: 'orchestrator' }, { name: 'Ejecutor 1', role: 'executor' }, { name: 'Ejecutor 2', role: 'executor' }, { name: 'Investigador', role: 'researcher' }] };
  assert.equal(findMember(t, 'ejecutor2')?.name, 'Ejecutor 2');
  assert.equal(findMember(t, '1')?.name, 'Ejecutor 1');
  assert.equal(findMember(t, 'investigador')?.name, 'Investigador');
  assert.equal(findMember(t, 'Ejecutor 3'), null);
});

test('a team starts with the orchestrator working on the goal', async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude'), codex = snapshot.accounts.find((a) => a.kind === 'codex');
  const r = await request('createTeam', { team: {
    projectId: snapshot.projects[0].id, goal: 'Añadir login con OAuth',
    orchestrator: { accountId: claude.id }, executors: [{ accountId: codex.id }], researcher: { accountId: claude.id, model: 'haiku' },
  } });
  assert.ok(r.ok, r.error);
  lead = r.threadId;
  const snap = (await next((m) => m.snapshot?._0.hostTeams?.length)).snapshot._0;
  team = snap.hostTeams[0];
  assert.deepEqual(team.members.map((m) => [m.role, m.name]), [['orchestrator', 'Orquestador'], ['executor', 'Ejecutor'], ['researcher', 'Investigador']]);
  assert.equal(snap.threads.find((t) => t.id === lead).team.role, 'orchestrator');
  peer.send(Client.subscribe(lead));
  const first = await next((m) => m.thread?._0.id === lead);
  assert.equal(first.thread._0.items.find((i) => i.kind === 'user').text, 'Añadir login con OAuth');
  await next(idle);
});

test("an executor's question goes to the orchestrator, and its answer back to the executor", async () => {
  peer.send(Client.send(lead, '<relevo:tarea para="Ejecutor">pregunta qué color usar</relevo:tarea>'));
  const asked = await next(fromMember('Ejecutor', 'pregunta'));
  assert.match(itemOf(asked, 'Ejecutor').text, /¿Qué color prefieres\?[\s\S]*Rojo · Azul/);
  await next(idle);
  peer.send(Client.send(lead, '<relevo:respuesta para="Ejecutor">Azul</relevo:respuesta>'));
  const report = await next(fromMember('Ejecutor', 'informe'));
  assert.match(itemOf(report, 'Ejecutor').text, /pregunta qué color usar/, 'the executor carried on and reported');
  await next(idle);
});

test("the researcher's report reaches the orchestrator and the executor it was for", async () => {
  peer.send(Client.send(lead, '<relevo:investigar para="Ejecutor">busca una librería de OAuth</relevo:investigar>'));
  const report = await next(fromMember('Investigador', 'informe de investigación'));
  const text = itemOf(report, 'Investigador').text;
  assert.match(text, /busca una librería de OAuth/);
  assert.match(text, /También enviado a Ejecutor/);
});

test('pausing holds the messages between agents until the team is resumed', async () => {
  await next(idle, 20_000);
  assert.ok((await request('teamAction', { teamId: team.id, action: 'pause' })).ok);
  peer.send(Client.send(lead, '<relevo:tarea para="Ejecutor">haz algo</relevo:tarea>'));
  const held = await next((m) => m.snapshot?._0.hostTeams?.[0]?.held === 1);
  assert.equal(held.snapshot._0.hostTeams[0].status, 'paused');
  assert.ok((await request('teamAction', { teamId: team.id, action: 'resume' })).ok);
  await next(fromMember('Ejecutor', 'informe'));
});

test('a coordinator joins a thread that already did work: the thread becomes the executor', async () => {
  peer.send(Client.newThread(snapshot.projects[0].id, 'J1'));
  const old = (await next((m) => m.created?.requestId === 'J1')).created.threadId;
  peer.send(Client.subscribe(old));
  peer.send(Client.send(old, 'traduce los textos del menú principal'));
  await next((m) => m.threadPatch?._0.id === old && !m.threadPatch._0.runtime.isRunning && m.threadPatch._0.upserts.some((i) => i.kind === 'assistant' && i.usage));
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { threadId: old, goal: 'Traducir el juego entero', orchestrator: { accountId: claude.id, notes: 'Gasta poco' }, executors: [], researcher: null } });
  assert.ok(r.ok, r.error);
  const snap = (await next((m) => m.snapshot?._0.threads.find((t) => t.id === old)?.team)).snapshot._0;
  assert.deepEqual(snap.threads.find((t) => t.id === old).team.role, 'executor');
  const joined = snap.hostTeams.find((x) => x.members.some((m) => m.threadId === old));
  assert.deepEqual(joined.members.map((m) => m.role), ['orchestrator', 'executor']);
  // The orchestrator starts from a brief of the thread (the echo agent repeats it).
  lead = r.threadId;
  peer.send(Client.subscribe(lead));
  const first = await next((m) => m.threadPatch?._0.id === lead && m.threadPatch._0.upserts.some((i) => i.kind === 'assistant' && i.usage));
  const echo = first.threadPatch._0.upserts.find((i) => i.kind === 'assistant').text;
  assert.match(echo, /ya lleva trabajo hecho[\s\S]*<objetivo>\ntraduce los textos del menú principal/);
  // And its orders reach the old thread.
  if (!idle(first)) await next(idle);
  peer.send(Client.send(lead, '<relevo:tarea para="Ejecutor">sigue con los diálogos</relevo:tarea>'));
  await next(fromMember('Ejecutor', 'informe'));
});
