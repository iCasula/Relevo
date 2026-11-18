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
const demo = () => snapshot.projects.find((p) => p.name === 'demo').id;
const inbox = [], waiters = [];

function next(predicate, timeout = 15_000) {
  const i = inbox.findIndex(predicate);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve: (msg) => { clearTimeout(w.timer); resolve(msg); } };
    waiters.push(w);
    w.timer = setTimeout(() => {
      if (waiters.includes(w)) waiters.splice(waiters.indexOf(w), 1);
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
/** The orchestrator's first turn is over: as a patch, or in the full thread if it ended before subscribing. */
const firstDone = (id) => (m) => (m.thread?._0.id === id && !m.thread._0.runtime.isRunning && m.thread._0.items.some((i) => i.kind === 'assistant'))
  || (m.threadPatch?._0.id === id && !m.threadPatch._0.runtime.isRunning && m.threadPatch._0.upserts.some((i) => i.kind === 'assistant' && i.usage));
const idle = (m) => m.threadPatch?._0.id === lead && !m.threadPatch._0.runtime.isRunning && !m.threadPatch._0.runtime.queued?.length;

before(async () => {
  fs.mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
  const repo = path.join(dir, 'projects', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'repo\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) execFileSync('git', args, { cwd: repo });
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
    projectId: demo(), goal: 'Añadir login con OAuth',
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
  peer.send(Client.newThread(demo(), 'J1'));
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

test('worktrees in a folder without git: the executors share it instead of the team failing', async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: {
    projectId: demo(), goal: 'Dos ejecutores sin git', worktrees: true,
    orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }, { accountId: claude.id }], researcher: null,
  } });
  assert.ok(r.ok, r.error);
  peer.send(Client.subscribe(r.threadId));
  const t = (await next((m) => m.thread?._0.id === r.threadId)).thread._0;
  assert.ok(t.items.some((i) => i.kind === 'notice' && /Sin worktrees/.test(i.text)));
  assert.ok(t.items.some((i) => i.kind === 'user' && i.text === 'Dos ejecutores sin git'), 'the orchestrator started');
});

test('editing a team keeps its threads and tells the orchestrator what changed', async () => {
  const s0 = (await next((m) => m.snapshot?._0.hostTeams?.some((x) => x.goal === 'Dos ejecutores sin git' && x.members.length === 3))).snapshot._0;
  const t = s0.hostTeams.find((x) => x.goal === 'Dos ejecutores sin git');
  const [lead2, ex1, ex2] = t.members;
  const codex = s0.accounts.find((a) => a.kind === 'codex');
  const r = await request('updateTeam', { teamId: t.id, changes: {
    goal: 'Dos ejecutores sin git, ahora con investigador',
    members: [{ threadId: ex1.threadId, accountId: codex.id, model: 'default', notes: 'Solo traducciones' }],
    remove: [ex2.threadId],
    add: { researcher: { accountId: codex.id, model: 'default' } },
  } });
  assert.ok(r.ok, r.error);
  const snap = (await next((m) => m.snapshot?._0.hostTeams?.find((x) => x.id === t.id)?.members.some((m) => m.role === 'researcher'))).snapshot._0;
  const after = snap.hostTeams.find((x) => x.id === t.id);
  assert.equal(after.goal, 'Dos ejecutores sin git, ahora con investigador');
  assert.deepEqual(after.members.map((m) => m.role), ['orchestrator', 'executor', 'researcher']);
  assert.equal(after.members[1].notes, 'Solo traducciones');
  assert.equal(after.members[1].accountId, codex.id);
  assert.ok(snap.threads.some((x) => x.id === ex2.threadId && !x.team), 'the removed executor stays as a normal thread');
  const news = await next((m) => m.threadPatch?._0.id === lead2.threadId && m.threadPatch._0.upserts.some((i) => i.kind === 'user' && i.from?.label === 'cambios en el equipo'), 20_000);
  const text = news.threadPatch._0.upserts.find((i) => i.from?.label === 'cambios en el equipo').text;
  assert.match(text, /Nuevo objetivo:[\s\S]*Solo traducciones[\s\S]*pasa a Codex[\s\S]*ha salido del equipo[\s\S]*Se une el Investigador/);
});

test("orders for a busy executor go back to the orchestrator instead of piling up", async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Cola', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }], researcher: null } });
  assert.ok(r.ok, r.error);
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  // The executor gets busy (a question waiting for its answer)…
  peer.send(Client.send(boss, '<relevo:tarea para="Ejecutor">pregunta algo</relevo:tarea>'));
  await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.from?.label === 'pregunta'));
  await next((m) => m.threadPatch?._0.id === boss && !m.threadPatch._0.runtime.isRunning && !m.threadPatch._0.runtime.queued?.length);
  // …so a normal order for it isn't queued: the orchestrator is told instead.
  peer.send(Client.send(boss, '<relevo:tarea para="Ejecutor">haz A</relevo:tarea>'));
  await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.kind === 'notice' && /No entregado a Ejecutor/.test(i.text)));
  const snap = (await next((m) => m.snapshot?._0.hostTeams?.some((x) => x.goal === 'Cola'))).snapshot._0;
  const exId = snap.hostTeams.find((x) => x.goal === 'Cola').members.find((m) => m.role === 'executor').threadId;
  peer.send(Client.subscribe(exId));
  const ex = (await next((m) => m.thread?._0.id === exId)).thread._0;
  assert.equal(ex.runtime.queued?.length ?? 0, 0, 'nothing waiting for the executor');
  // Once it answers and finishes, its report reaches the orchestrator with a note of what wasn't delivered.
  const q = ex.items.find((i) => i.kind === 'approval' && !i.resolution);
  peer.send(Client.answer(exId, q.id, { [q.questions[0].question]: 'Azul' }));
  peer.send(Client.subscribe(boss));
  const report = await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.from?.label === 'informe'));
  assert.match(report.threadPatch._0.upserts.find((i) => i.from?.label === 'informe').text, /No entregado a Ejecutor[\s\S]*haz A/);
});

test('orders: para= among other attributes, and integrar de=', () => {
  assert.deepEqual(parseOrders('<relevo:respuesta para="Ejecutor 1" force="true">x</relevo:respuesta>'), [{ type: 'respuesta', to: 'Ejecutor 1', body: 'x' }]);
  assert.deepEqual(parseOrders('<relevo:integrar de="Ejecutor 2"/>'), [{ type: 'integrar', to: 'Ejecutor 2', body: '' }]);
});

test("an answer to someone who didn't ask isn't delivered: it goes with its next task", async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Acuses', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }], researcher: null } });
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  peer.send(Client.send(boss, '<relevo:respuesta para="Ejecutor">Recibido, sigue así</relevo:respuesta>'));
  const saved = await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.kind === 'notice' && /Respuesta guardada para la próxima tarea de Ejecutor/.test(i.text)));
  void saved;
  peer.send(Client.send(boss, '<relevo:tarea para="Ejecutor">haz C</relevo:tarea>'));
  const fromEx = (i) => i.kind === 'user' && (i.from?.name === 'Ejecutor' || i.text?.includes('[Ejecutor · informe]'));
  const report = await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some(fromEx));
  assert.match(report.threadPatch._0.upserts.find(fromEx).text, /Notas anteriores del Orquestador: Recibido, sigue así[\s\S]*haz C/);
});

test("waiting for a background job doesn't wake the orchestrator; the result does", async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Fondo', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }], researcher: null } });
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  peer.send(Client.send(boss, '<relevo:tarea para="Ejecutor">segundo plano</relevo:tarea>'));
  const fromEx = (i) => i.kind === 'user' && (i.from?.name === 'Ejecutor' || i.text?.includes('[Ejecutor ·'));
  const report = await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some(fromEx), 20_000);
  const item = report.threadPatch._0.upserts.find(fromEx);
  assert.match(item.text, /Compilación terminada/, 'the first message it gets is the final report');
  assert.doesNotMatch(item.text, /sigue en segundo plano/, 'not the wait');
});

test('integrar merges an executor worktree without the orchestrator touching git', async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const repo = snapshot.projects.find((p) => p.name === 'repo').id;
  const r = await request('createTeam', { team: { projectId: repo, goal: 'Integrar', worktrees: true, orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }, { accountId: claude.id }], researcher: null } });
  assert.ok(r.ok, r.error);
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  peer.send(Client.send(boss, '<relevo:integrar de="Ejecutor 2"/>'));
  const done = await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.from?.label === 'integración'), 20_000);
  assert.match(done.threadPatch._0.upserts.find((i) => i.from?.label === 'integración').text, /Integrado: la rama relevo\/\w+ de Ejecutor 2/);
});

test("each role's fallback is its thread's out-of-quota plan, and the orchestrator talking to you is flagged", async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude'), codex = snapshot.accounts.find((a) => a.kind === 'codex');
  const r = await request('createTeam', { team: {
    projectId: demo(), goal: 'Fallbacks', researcher: null,
    orchestrator: { accountId: claude.id, fallback: `${codex.id}|default` }, executors: [{ accountId: claude.id, fallback: 'wait' }],
  } });
  assert.ok(r.ok, r.error);
  const snap = (await next((m) => m.snapshot?._0.hostTeams?.some((x) => x.goal === 'Fallbacks'))).snapshot._0;
  const members = snap.hostTeams.find((x) => x.goal === 'Fallbacks').members;
  assert.equal(members[0].fallback, `${codex.id}|default`);
  assert.equal(members[1].fallback, 'wait');
  // The echo orchestrator's first turn gives no orders: that's it talking to you.
  const flagged = (await next((m) => m.snapshot?._0.threads.find((t) => t.id === r.threadId)?.attention, 20_000)).snapshot._0;
  const first = flagged.threads.find((t) => t.id === r.threadId).attention;
  assert.equal(first.kind, 'orquestador');
  // You answer: the flag goes (or, with the quick echo agent, is replaced by its next message).
  peer.send(Client.send(r.threadId, 'vale'));
  await next((m) => { const t = m.snapshot?._0.threads.find((x) => x.id === r.threadId); return t && (!t.attention || t.attention.at !== first.at); });
  // Edited afterwards.
  const r2 = await request('updateTeam', { teamId: snap.hostTeams.find((x) => x.goal === 'Fallbacks').id, changes: { members: [{ threadId: members[1].threadId, fallback: '' }] } });
  assert.ok(r2.ok, r2.error);
  await next((m) => m.snapshot?._0.hostTeams?.find((x) => x.goal === 'Fallbacks')?.members[1].fallback === '');
});

test("an orchestrator waiting on a timer sends its orders at once and stops waiting when a report arrives", async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Temporizador', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }], researcher: null } });
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  const sent = Date.now();
  peer.send(Client.send(boss, 'temporizador <relevo:tarea para="Ejecutor">haz T</relevo:tarea>'));
  const report = await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.kind === 'user' && (i.from?.name === 'Ejecutor' || i.text?.includes('[Ejecutor ·'))), 20_000);
  assert.ok(Date.now() - sent < 9_000, `the report arrived ${Date.now() - sent} ms later: the order or the report waited for the 12 s timer`);
  assert.match(report.threadPatch._0.upserts.find((i) => i.kind === 'user' && (i.from?.name === 'Ejecutor' || i.text?.includes('[Ejecutor ·'))).text, /haz T/);
});

test("a timer that names an agent isn't cut short by another agent's report", async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Temporizador con nombre', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }, { accountId: claude.id }], researcher: null } });
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  const sent = Date.now();
  peer.send(Client.send(boss, 'temporizador para revisar al Ejecutor 2 <relevo:tarea para="Ejecutor 1">haz U</relevo:tarea>'));
  await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.kind === 'user' && (i.from?.name === 'Ejecutor 1' || i.text?.includes('[Ejecutor 1 ·'))), 25_000);
  assert.ok(Date.now() - sent > 10_000, `Ejecutor 1's report cut the timer for Ejecutor 2 (${Date.now() - sent} ms)`);
});

test('renaming a member: its thread, the orders that name it (new and old name) and duplicates refused', async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Nombres', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }, { accountId: claude.id }], researcher: null } });
  assert.ok(r.ok, r.error);
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  const t0 = (await next((m) => m.snapshot?._0.hostTeams?.some((x) => x.goal === 'Nombres'))).snapshot._0.hostTeams.find((x) => x.goal === 'Nombres');
  const [, ex1, ex2] = t0.members;
  const dup = await request('updateTeam', { teamId: t0.id, changes: { members: [{ threadId: ex1.threadId, name: 'Ejecutor 2' }] } });
  assert.equal(dup.ok, false, 'two members with one name');
  const ok = await request('updateTeam', { teamId: t0.id, changes: { members: [{ threadId: ex1.threadId, name: 'Gráficos "GPU"' }, { threadId: ex2.threadId, fallback: 'wait' }] } });
  assert.ok(ok.ok, ok.error);
  const snap = (await next((m) => m.snapshot?._0.hostTeams?.find((x) => x.id === t0.id)?.members[1].name === 'Gráficos GPU')).snapshot._0;
  assert.equal(snap.threads.find((x) => x.id === ex1.threadId).team.name, 'Gráficos GPU');
  assert.match(snap.threads.find((x) => x.id === ex1.threadId).title, /^Gráficos GPU · /);
  // The orchestrator still using the old name reaches the same agent.
  peer.send(Client.send(boss, '<relevo:tarea para="Ejecutor 1">haz V</relevo:tarea>'));
  const report = await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.kind === 'user' && (i.from?.name === 'Gráficos GPU' || i.text?.includes('[Gráficos GPU ·'))), 25_000);
  assert.ok(report);
});

test('decisions: the orchestrator keeps them, every agent hears them, and they survive a fresh session', async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Decisiones', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }], researcher: null } });
  assert.ok(r.ok, r.error);
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  // The echo orchestrator repeats this: a decision and a task in one reply.
  peer.send(Client.send(boss, '<relevo:decision>Usamos shadPS4 como referencia para GNM</relevo:decision> <relevo:tarea para="Ejecutor">haz W</relevo:tarea>'));
  const team = (await next((m) => m.snapshot?._0.hostTeams?.find((x) => x.goal === 'Decisiones')?.decisions?.length === 1)).snapshot._0.hostTeams.find((x) => x.goal === 'Decisiones');
  assert.equal(team.decisions[0].text, 'Usamos shadPS4 como referencia para GNM');
  // The executor's report comes back; the decision went in its first message (its preamble).
  await next((m) => m.threadPatch?._0.id === boss && m.threadPatch._0.upserts.some((i) => i.kind === 'user' && (i.from?.name === 'Ejecutor' || i.text?.includes('[Ejecutor ·'))), 25_000);
  // You add one and withdraw it.
  const add = await request('teamDecisions', { teamId: team.id, add: 'Sin audio por ahora' });
  assert.ok(add.ok, add.error);
  const dup = await request('teamDecisions', { teamId: team.id, add: 'sin  audio por ahora' });
  assert.equal(dup.ok, false);
  const rm = await request('teamDecisions', { teamId: team.id, remove: '2' });
  assert.ok(rm.ok, rm.error);
  await next((m) => { const x = m.snapshot?._0.hostTeams?.find((y) => y.id === team.id); return x && x.decisions.length === 1 && x.decisions[0].id === 1; });
});

test('a fresh orchestrator session gets the decisions, the board and the last reports', async () => {
  const { preamble } = await import('../lib/team.mjs');
  const host = {
    threads: new Map([['L', { projectPath: '/p' }], ['E', { projectPath: '/p' }]]),
    accountsById: new Map(), projects: () => [], _modelName: () => 'm', _rt: () => ({ approvals: new Map() }),
    teams: { _status: () => 'Estado del equipo: Ejecutor libre' },
  };
  const team = { goal: 'G', decisions: [{ id: 1, text: 'Usamos shadPS4' }], members: [
    { threadId: 'L', role: 'orchestrator', name: 'Orquestador' },
    { threadId: 'E', role: 'executor', name: 'Ejecutor', lastReport: { text: 'ESTADO: hecho, menú carga', at: 0 } },
  ] };
  const fresh = preamble(host, team, team.members[0], true);
  assert.match(fresh, /#1 Usamos shadPS4/);
  assert.match(fresh, /Estado del equipo: Ejecutor libre/);
  assert.match(fresh, /Ejecutor \(.*\): ESTADO: hecho, menú carga/);
  assert.doesNotMatch(preamble(host, team, team.members[0], false), /Último informe/);
  assert.match(preamble(host, team, team.members[1]), /#1 Usamos shadPS4/);
});

test('milestones and the research library: kept from the orders, editable, and the spend of each agent today', async () => {
  const claude = snapshot.accounts.find((a) => a.kind === 'claude');
  const r = await request('createTeam', { team: { projectId: demo(), goal: 'Hitos', orchestrator: { accountId: claude.id }, executors: [{ accountId: claude.id }], researcher: { accountId: claude.id } } });
  assert.ok(r.ok, r.error);
  const boss = r.threadId;
  peer.send(Client.subscribe(boss));
  await next(firstDone(boss));
  peer.send(Client.send(boss, '<relevo:hito>Arranca el binario</relevo:hito> <relevo:hito>Menú visible</relevo:hito> <relevo:hecho>1</relevo:hecho> <relevo:investigar>shadPS4 y GNM</relevo:investigar>'));
  const teamOf = (m) => m.snapshot?._0.hostTeams?.find((x) => x.goal === 'Hitos');
  const t1 = teamOf(await next((m) => teamOf(m)?.milestones?.length === 2 && teamOf(m).milestones[0].done && teamOf(m).findings?.length === 1, 25_000));
  assert.equal(t1.milestones[1].done, false);
  assert.equal(t1.findings[0].topic, 'shadPS4 y GNM');
  assert.ok(t1.members[0].today?.tokens > 0, 'the orchestrator spent tokens today');
  const tg = await request('teamMemory', { teamId: t1.id, kind: 'milestone', toggle: '2' });
  assert.ok(tg.ok, tg.error);
  await next((m) => teamOf(m)?.milestones?.[1]?.done === true);
  const rm = await request('teamMemory', { teamId: t1.id, kind: 'finding', remove: '1' });
  assert.ok(rm.ok, rm.error);
  await next((m) => teamOf(m)?.findings?.length === 0);
});

test('a long background job gets its agent asked to check it, once per period', async () => {
  const { Teams, BG_CHECK } = await import('../lib/team.mjs');
  const sent = [];
  const rt = { isRunning: false, approvals: new Map(), backgroundTasks: [{ id: 'b1', description: 'QEMU run', startedAt: 0 }] };
  const ctx = {
    host: { threads: new Map([['E', {}]]), _rt: () => rt },
    list: [{ status: 'active', members: [{ threadId: 'E', role: 'executor', name: 'Ejecutor' }] }],
    _deliver: (team, member, text, from) => sent.push({ member: member.name, text, from }),
  };
  Teams.prototype.watchBackground.call(ctx, BG_CHECK - 10);
  assert.equal(sent.length, 0, 'too early');
  Teams.prototype.watchBackground.call(ctx, BG_CHECK + 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /QEMU run/);
  assert.equal(sent[0].from.label, 'comprobación');
  Teams.prototype.watchBackground.call(ctx, BG_CHECK + 60);
  assert.equal(sent.length, 1, 'not again right away');
  Teams.prototype.watchBackground.call(ctx, 2 * BG_CHECK + 2);
  assert.equal(sent.length, 2, 'again after another period');
});
