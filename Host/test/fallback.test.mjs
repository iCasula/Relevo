// Where a thread goes when its model runs out, and when it comes back: the plan's choice, the role's best
// model, waiting when nothing has quota, the way home, and a relay before a turn that would be cut short.
// Host methods on a small stand-in, without starting a host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host, modelScore } from '../lib/host.mjs';
import { catchUpText } from '../lib/handoff.mjs';
import { Teams } from '../lib/team.mjs';

const P = Host.prototype;
const nowS = () => Date.now() / 1000;

function stand(accounts, extra = {}) {
  const notices = [], selects = [];
  const h = {
    accounts, accountsById: new Map(accounts.map((a) => [a.id, a])), settings: { limitPlan: { mode: 'ask', targets: [] }, relayDelay: 10 },
    rts: new Map(), modelLimits: new Map(),
    _rt(t) { if (!this.rts.has(t.id)) this.rts.set(t.id, { approvals: new Map(), backgroundTasks: [] }); return this.rts.get(t.id); },
    _append: (t, it) => notices.push(it.text), _changed() {}, _modelName: (a, m) => m,
    select(t, accountId, model, carryOn, auto) { selects.push({ accountId, model, auto }); t.accountId = accountId; t.model = model; },
    _clearLimitTimers() {}, ...extra,
  };
  for (const k of ['_account', '_exhausted', '_used', '_usableTarget', '_limitedUntil', '_noteLimit', '_smartTarget', '_planTarget', '_onLimit', '_preTurnSwitch', '_relayNow', '_waitForQuota', '_checkQuotaBack', '_limitAction']) h[k] = P[k];
  return { h, notices, selects };
}
const acct = (id, kind, models, percent = 10) => ({ id, kind, name: id, models: models.map((m) => ({ id: m, name: m })), defaultModel: models[0], status: { loggedIn: true, windows: [{ percent }] } });

test('models are ranked for their role from their names', () => {
  const s = (id, tier) => modelScore({ id, name: id }, tier);
  assert.ok(s('claude-opus-5-5', 'heavy') > s('claude-sonnet-5-5', 'heavy'));
  assert.ok(s('gpt-6.1-terra', 'heavy') > s('gemini-3-flash', 'heavy'));
  assert.ok(s('gemini-3-flash', 'light') > s('claude-opus-5-5', 'light'));
  assert.ok(s('deepseek-v4-flash', 'light') > s('deepseek-v4-pro', 'light'));
});

test('automatic fallback: an executor gets the strongest model with quota, the orchestrator a light one', () => {
  const { h } = stand([acct('CL', 'claude', ['opus', 'haiku']), acct('CX', 'codex', ['gpt-6.1-terra', 'gpt-5.6-luna']), acct('DS', 'api:deepseek', ['deepseek-v4-flash'])]);
  const t = { id: 'T', accountId: 'CL', model: 'opus' };
  assert.deepEqual(h._planTarget(t, { mode: 'smart', tier: 'heavy' }), { accountId: 'CX', model: 'gpt-6.1-terra' });
  assert.deepEqual(h._planTarget(t, { mode: 'smart', tier: 'light' }), { accountId: 'DS', model: 'deepseek-v4-flash' });
});

test('a chain skips subscriptions that are nearly used up, and limits are remembered per Antigravity model', () => {
  const agy = acct('AG', 'gemini', ['gemini-3-flash', 'claude-sonnet']);
  const { h } = stand([acct('CL', 'claude', ['opus']), acct('CX', 'codex', ['terra'], 95), agy, acct('DS', 'api:deepseek', ['flash'])]);
  const t = { id: 'T', accountId: 'CL', model: 'opus' };
  const plan = { mode: 'chain', targets: [{ accountId: 'CX', model: 'terra' }, { accountId: 'AG', model: 'claude-sonnet' }, { accountId: 'DS', model: 'flash' }] };
  assert.deepEqual(h._planTarget(t, plan), { accountId: 'AG', model: 'claude-sonnet' }, 'Codex at 95 % is passed over');
  h._noteLimit(agy, 'claude-sonnet', nowS() + 600);
  assert.deepEqual(h._planTarget(t, plan), { accountId: 'DS', model: 'flash' }, "Antigravity's Claude is out");
  assert.ok(h._usableTarget('AG', 'gemini-3-flash'), "Antigravity's Gemini still has its own quota");
});

test('nothing in the plan has quota: the same agent waits for the reset instead of stopping', () => {
  const { h, notices } = stand([acct('CL', 'claude', ['opus']), acct('CX', 'codex', ['terra'], 100)]);
  h.accounts[1].status.windows = [{ percent: 100, resetsAt: nowS() + 3600 }];
  const t = { id: 'T', accountId: 'CL', model: 'opus', limitPlan: { mode: 'chain', targets: [{ accountId: 'CX', model: 'terra' }] } };
  h._rt(t).limit = { resetsAt: nowS() + 1800 };
  h._onLimit(t);
  const r = h._rt(t);
  assert.ok(r.resumeAt > nowS() + 1700, 'it carries on when the quota comes back');
  assert.ok(!r.pendingRelay);
  clearTimeout(r.relayTimer);
  assert.match(notices.join('\n'), /Ningún otro modelo del plan tiene cuota/);
});

test('back to its own model once that quota is back, and off a nearly used up one before a turn', () => {
  const { h, selects, notices } = stand([acct('CL', 'claude', ['opus']), acct('CX', 'codex', ['terra'])]);
  const t = { id: 'T', accountId: 'CX', model: 'terra', home: { accountId: 'CL', model: 'opus' }, limitPlan: { mode: 'smart', tier: 'heavy' } };
  h.accounts[0].status.windows = [{ percent: 100, resetsAt: nowS() + 600 }];
  h._preTurnSwitch(t);
  assert.equal(selects.length, 0, 'Claude is still out');
  h.accounts[0].status.windows = [{ percent: 3 }];
  h._preTurnSwitch(t);
  assert.deepEqual(selects.pop(), { accountId: 'CL', model: 'opus', auto: true });
  assert.equal(t.home, null);
  assert.match(notices.pop(), /Vuelve a CL/);
  // Claude at 98 %: the turn would be cut halfway, so it moves first (and will come back).
  h.accounts[0].status.windows = [{ percent: 98 }];
  h._preTurnSwitch(t);
  assert.deepEqual(selects.pop(), { accountId: 'CX', model: 'terra', auto: true });
  assert.deepEqual(t.home, { accountId: 'CL', model: 'opus' });
  assert.match(notices.pop(), /Relevo preventivo/);
});

test("not while something runs in the background: a switch would kill it", () => {
  const { h, selects } = stand([acct('CL', 'claude', ['opus']), acct('CX', 'codex', ['terra'])]);
  const t = { id: 'T', accountId: 'CX', model: 'terra', home: { accountId: 'CL', model: 'opus' }, limitPlan: { mode: 'smart', tier: 'heavy' } };
  h._rt(t).backgroundTasks = [{ id: 'b', description: 'QEMU' }];
  h._preTurnSwitch(t);
  assert.equal(selects.length, 0);
});

test('back in its own session, an agent hears only what happened while it was away', () => {
  const text = catchUpText({
    items: [{ kind: 'user', text: 'arregla el shader' }, { kind: 'assistant', text: 'Hecho en gnm.cpp', accountId: 'X' }],
    accounts: new Map([['X', { name: 'Codex', agentName: 'Codex' }]]), workState: '- Rama: main', pendingRequest: true,
  });
  assert.match(text, /^<relevo_mientras_tanto>/);
  assert.match(text, /Codex siguió/);
  assert.match(text, /arregla el shader/);
  assert.match(text, /Rama: main/);
  assert.match(text, /quedó sin terminar/);
});

test('a long time away: the newest turns in the catch-up, the rest in the trace it is pointed to', () => {
  const items = Array.from({ length: 60 }, (_, i) => [{ kind: 'user', text: `informe ${i} ${'dato '.repeat(60)}` }, { kind: 'assistant', text: `decido ${i} ${'paso '.repeat(80)}`, accountId: 'X' }]).flat();
  const text = catchUpText({ items, accounts: new Map([['X', { name: 'DeepSeek', agentName: 'DeepSeek' }]]), traceFile: 'C:\\trazas\\orq.md' });
  assert.match(text, /decido 59/, 'the latest turn is there');
  assert.ok(text.length > 10_000, 'room for many turns, not a handful');
  assert.match(text, /turnos anteriores sin resumir aquí: léelos en la traza/);
  assert.match(text, /entero, está en C:\\trazas\\orq\.md/);
});

test("the day's summary: milestones, decisions, research and spend, without an AI", () => {
  const today = Date.now() / 1000;
  const host = { threads: new Map([['L', {}], ['E', {}]]), _spendToday: () => ({ tokens: 120_000, cost: 1.5, estimated: true }) };
  const team = {
    members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, { threadId: 'E', role: 'executor', name: 'Ejecutor', task: { text: 'shaders', state: 'en curso' } }],
    milestones: [{ id: 1, text: 'Arranca', done: true, doneAt: today }, { id: 2, text: 'Menú visible', done: false }],
    decisions: [{ id: 1, text: 'shadPS4 como referencia', at: today }], findings: [{ id: 1, topic: 'GNM en shadPS4', at: today }],
  };
  const text = Teams.prototype.dailySummary.call({ host }, team);
  assert.match(text, /Hitos: 1\/2 · hoy: #1 Arranca · ahora: Menú visible/);
  assert.match(text, /Decisiones nuevas: #1 shadPS4/);
  assert.match(text, /Investigado: GNM en shadPS4/);
  assert.match(text, /Orquestador 120k tokens \(≈ 1\.50 USD\)/);
  assert.match(text, /Ejecutor: shaders \(en curso\)/);
});

test("a pause the loop guard caused ends when you write, without sending what it held", async () => {
  const appended = [];
  const lead = { items: [] };
  const team = { status: 'paused', pausedBy: 'limit', auto: 61, held: [{ id: 'x', text: 'vieja', from: { role: 'orchestrator' } }], members: [] };
  const ctx = {
    host: { _append: (t, it) => appended.push(it.text), _changed() {}, _uuid: () => 'u' },
    of: () => team, _lead: () => lead, _reactivate: Teams.prototype._reactivate,
  };
  Teams.prototype.userSpoke.call(ctx, {});
  assert.equal(team.status, 'active');
  assert.equal(team.auto, 0);
  assert.equal(team.held.length, 1, 'held stays for review');
  assert.match(appended[0], /reactivado por tu mensaje: 1 mensaje retenido/);
  assert.match(team.notes[0], /no des por hecho que llegaron/);
  // Paused by you: it stays paused.
  team.status = 'paused'; team.pausedBy = 'user';
  Teams.prototype.userSpoke.call(ctx, {});
  assert.equal(team.status, 'paused');
});

test('an agent only waiting on background work gets messages; one mid-turn still gets the answer to its question', () => {
  const started = [], notices = [];
  const rts = { E: { isRunning: false, approvals: new Map(), backgroundTasks: [{ id: 'q', description: 'QEMU' }] } };
  const threads = new Map([['E', { id: 'E', queued: [], teamPrimed: true }], ['L', { id: 'L', queued: [] }]]);
  const teams = Object.create(Teams.prototype);
  teams.host = {
    threads, _rt: (t) => rts[t.id] ?? { isRunning: false, approvals: new Map() }, _uuid: () => 'u', _append: (t, it) => notices.push(it.text),
    _changed() {}, _saveState() {}, _broadcastSnapshot() {}, _startTurn: (t, text) => started.push(text), sendNow() {},
  };
  const team = { status: 'active', auto: 0, held: [], members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, { threadId: 'E', role: 'executor', name: 'Ejecutor 2', awaitingAnswer: true }] };
  const [lead, ex] = team.members;
  const from = { threadId: 'L', name: 'Orquestador', role: 'orchestrator' };
  assert.equal(teams._deliver(team, ex, 'parche en rama aparte', { ...from, label: 'respuesta' }), 'sent', 'idle with QEMU in the background: delivered');
  // Mid-turn: a task is kept pending (and the orchestrator is told it goes when the turn ends)…
  rts.E.isRunning = true;
  assert.equal(teams._deliver(team, ex, 'otra tarea', { ...from, label: 'tarea' }), 'parked');
  assert.match(notices.pop(), /Pendiente para Ejecutor 2/);
  assert.equal(ex.parked.text, 'otra tarea');
  // …while it writes its handoff note for Relevo, a message simply waits in its queue.
  ex.noteRequested = true;
  assert.equal(teams._deliver(team, ex, 'tarea durante el traspaso', { ...from, label: 'tarea' }), 'queued');
  ex.noteRequested = false;
  // …but the answer to its own question is queued for when the turn ends.
  ex.awaitingAnswer = true;
  assert.equal(teams._deliver(team, ex, 'respuesta', { ...from, label: 'respuesta' }), 'queued');
  // Idle, but seconds away from the model change you asked for: it waits for the new model.
  rts.E.isRunning = false; rts.E.backgroundTasks = [];
  teams.host._switchSoon = () => true;
  assert.equal(teams._deliver(team, ex, 'tarea tras el cambio', { ...from, label: 'tarea' }), 'queued');
  assert.equal(started.length, 1, 'no turn on the old model');
  void lead;
});

test('every agent sees where the others stand: working, background, free, waiting for you, out of quota', () => {
  const at = Math.floor(new Date('2026-11-20T10:00:00').getTime() / 1000);
  const rts = {
    L: { isRunning: true, turnStartedAt: at, statusLine: 'Leyendo informes', approvals: new Map(), backgroundTasks: [] },
    E1: { isRunning: false, approvals: new Map(), backgroundTasks: [{ id: 'b', description: 'QEMU 900 s', startedAt: at + 60 }] },
    E2: { isRunning: false, approvals: new Map(), backgroundTasks: [], resumeAt: at + 3 * 3600, limit: { accountId: 'claude' } },
    E3: { isRunning: false, approvals: new Map([['a', {}]]), backgroundTasks: [] },
    I: { isRunning: false, approvals: new Map(), backgroundTasks: [], pendingSwitch: { accountId: 'codex', auto: false } },
  };
  const threads = new Map(Object.keys(rts).map((id) => [id, { id, queued: [], items: [{ date: at + 120 }], home: id === 'E1' ? { accountId: 'claude' } : null }]));
  const teams = Object.create(Teams.prototype);
  teams.host = { threads, _rt: (t) => rts[t.id], accountsById: new Map([['claude', { name: 'Claude' }], ['codex', { name: 'Codex' }]]) };
  const team = { status: 'active', held: [], outbox: [], members: [
    { threadId: 'L', role: 'orchestrator', name: 'Orquestador' },
    { threadId: 'E1', role: 'executor', name: 'Ejecutor 1', task: { text: 'Shaders', state: 'en curso', since: at } },
    { threadId: 'E2', role: 'executor', name: 'Ejecutor 2' },
    { threadId: 'E3', role: 'executor', name: 'Ejecutor 3' },
    { threadId: 'I', role: 'researcher', name: 'Investigador' },
  ] };
  // An executor reads the others, the orchestrator included, without the orchestrator's own bookkeeping.
  const seen = teams._status(team, team.members[2]);
  assert.match(seen, /Orquestador \(orquestador\) trabajando desde las 10:00: Leyendo informes/);
  assert.match(seen, /Ejecutor 1 esperando un trabajo en segundo plano desde las 10:01 \(QEMU 900 s\); en un modelo de reserva hasta que vuelva la cuota de Claude · tarea «Shaders»/);
  assert.match(seen, /Ejecutor 3 BLOQUEADO esperando al usuario/);
  assert.match(seen, /Investigador libre desde las 10:02; cambiará a Codex al quedar libre/);
  assert.doesNotMatch(seen, /Ejecutor 2 /, 'not itself');
  // The orchestrator sees who is out of quota and until when.
  assert.match(teams._status(team, team.members[0]), /Ejecutor 2 SIN CUOTA: retoma solo hacia las 13:00/);
  // A quota stop with nothing planned, and a relay on its way.
  rts.E2.resumeAt = null;
  assert.match(teams._status(team, team.members[0]), /Ejecutor 2 SIN CUOTA: parado hasta que el usuario decida/);
  rts.E2.pendingRelay = { accountId: 'codex' };
  assert.match(teams._status(team, team.members[0]), /Ejecutor 2 SIN CUOTA: pasa a Codex en unos segundos/);
});

test("the safety net: an agent's last words the orchestrator never got are sent, once; a deliberate skip isn't", () => {
  const sent = [], notices = [];
  const t = { id: 'E', title: 'Ejecutor 2', queued: [], items: [{ kind: 'user', text: 'tarea', done: true, date: 1 }] };
  const L = { id: 'L', title: 'Orquestador', queued: [], items: [] };
  const teams = Object.create(Teams.prototype);
  teams.host = { threads: new Map([['E', t], ['L', L]]), _rt: () => ({ isRunning: false, approvals: new Map(), backgroundTasks: [] }), _append: (th, it) => { th.items.push({ ...it, date: th.items.at(-1)?.date ?? 0 }); notices.push(it.text); }, _changed() {}, _uuid: () => 'u', log() {} };
  teams.onTurnFinished = (th, a) => sent.push(a.text);
  const ex = { threadId: 'E', role: 'executor', name: 'Ejecutor 2' };
  Object.defineProperty(teams, 'list', { value: [{ status: 'active', members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, ex] }] });
  teams.sweepUnreported(2 * 1000);
  assert.equal(t.teamSince, 2, 'first look: what is there counts as handled');
  // It got its last report through at 2; at 3 it said more that never arrived (the night of 20-nov).
  ex.lastToLeadAt = 2;
  t.items.push({ id: 'a1', kind: 'assistant', text: 'ESTADO: hecho\nLos NRO están listos.', date: 3 });
  teams.sweepUnreported(3 * 1000 + 5_000);
  assert.equal(sent.length, 0, 'too soon: it may still be on its way');
  teams.sweepUnreported(3 * 1000 + 30_000);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /NRO están listos/);
  assert.match(notices[0], /no había llegado/);
  teams.sweepUnreported(1e12);
  assert.equal(sent.length, 1, 'not twice');
  // Stopped by you (or its handoff note): never sent.
  t.items.push({ id: 'a2', kind: 'assistant', text: 'a medias', date: 50, teamSkip: true });
  teams.sweepUnreported(1e12);
  assert.equal(sent.length, 1);
});

test("the orchestrator's orders that never went out are sent by the sweep, and only those", () => {
  const delivered = [], notices = [];
  const L = { id: 'L', title: 'Orquestador', queued: [], items: [] };
  const R = { id: 'R', title: 'Investigador', queued: [], items: [] };
  const teams = Object.create(Teams.prototype);
  teams.host = { threads: new Map([['L', L], ['R', R]]), _rt: () => ({ isRunning: false, approvals: new Map(), backgroundTasks: [] }), _append: (th, it) => notices.push(it.text), _changed() {}, _uuid: () => 'u', log() {}, _saveState() {} };
  const team = { status: 'active', auto: 0, held: [], findings: [], members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, { threadId: 'R', role: 'researcher', name: 'Investigador' }] };
  teams._deliver = (tm, m, text, from) => { delivered.push([m.name, text, from.label]); return 'sent'; };
  Object.defineProperty(teams, 'list', { value: [team] });
  teams.sweepUnreported(1000);
  // One order went out with its turn (marked); one never did (the 07:44 research order).
  L.items.push({ id: 'o1', kind: 'assistant', text: '<relevo:investigar>ya enviada</relevo:investigar>', date: 2, orderSigs: ['investigar||ya enviada'] });
  L.items.push({ id: 'o2', kind: 'assistant', text: 'Pido investigación.\n<relevo:investigar para="Ejecutor 1">compara las trazas FIOS</relevo:investigar>', date: 3 });
  teams.sweepUnreported(100_000);
  assert.deepEqual(delivered.map((d) => d[1]), ['compara las trazas FIOS']);
  assert.match(notices[0], /no habían salido/);
  assert.match(notices[1], /Entregas: investigar → Investigador: entregada/);
  assert.match(team.outbox.at(-1).result, /sent/);
  teams.sweepUnreported(200_000);
  assert.equal(delivered.length, 1, 'once');
});

test('the watchdog: a team idle for a while wakes the orchestrator once, then tells you; a question for you is waiting, not stuck', () => {
  const delivered = [], notices = [];
  const L = { id: 'L', title: 'Orquestador', queued: [], items: [{ kind: 'assistant', text: '<relevo:tarea para="Ejecutor 1">x</relevo:tarea>', date: 100 }] };
  const E = { id: 'E', title: 'Ejecutor 1', queued: [], items: [{ kind: 'user', text: 'x', date: 101 }, { kind: 'assistant', text: 'ESTADO: hecho\nListo.', date: 200 }] };
  const teams = Object.create(Teams.prototype);
  teams.host = { threads: new Map([['L', L], ['E', E]]), _rt: () => ({ isRunning: false, approvals: new Map(), backgroundTasks: [] }), _append: (th, it) => notices.push(it.text), _changed() {}, _uuid: () => 'u', log() {}, _broadcastSnapshot() {} };
  teams._attention = () => {};
  const team = { status: 'active', auto: 0, held: [], members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, { threadId: 'E', role: 'executor', name: 'Ejecutor 1' }] };
  teams._deliver = (tm, m, text) => { delivered.push(text); L.items.push({ kind: 'assistant', text: 'vale', date: L.items.at(-1).date + 1000 }); return 'sent'; };
  Object.defineProperty(teams, 'list', { value: [team] });
  teams.watchIdle(200 + 60);
  assert.equal(delivered.length, 0, 'not idle long enough');
  teams.watchIdle(200 + 1000);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /lleva 17 min parado[\s\S]*Ejecutor 1: libre desde las .*ESTADO: hecho/);
  teams.watchIdle(200 + 1100);
  assert.equal(delivered.length, 1, 'once per idle stretch');
  // It answered without giving work; idle again: a second nudge, then you are told instead.
  teams.watchIdle(L.items.at(-1).date + 1000);
  assert.equal(delivered.length, 2);
  teams.watchIdle(L.items.at(-1).date + 1000);
  assert.equal(delivered.length, 2);
  assert.match(notices.at(-1), /sigue parado tras dos avisos/);
  // Its last word is a question for you: that's waiting for you.
  team.nudges = 0; team.nudgedFor = null;
  L.items.push({ kind: 'assistant', text: '¿Abro el FTP o esperamos?', date: 9_000 });
  teams.watchIdle(20_000);
  assert.equal(delivered.length, 2);
});

test('the orchestrator gets the final report, plain and short, not the progress chatter', async () => {
  const { finalMessage, compactReport } = await import('../lib/team.mjs');
  const msgs = ['Voy a revisar el árbol.', 'Ahora compilo.', '**ESTADO: hecho**\n## Qué he hecho\n| Fichero | Cambio |\n|---|---|\n| a.c | +3 |\nTodo **verificado**.'];
  const fin = finalMessage(msgs);
  assert.doesNotMatch(fin, /Voy a revisar/);
  const c = compactReport(fin);
  assert.match(c, /^ESTADO: hecho\nQué he hecho\nFichero · Cambio\na\.c · \+3\nTodo verificado\.$/);
  assert.equal(finalMessage(['primero', 'último sin estado']), 'último sin estado');
  const long = `ESTADO: hecho\n${'hallazgo importante '.repeat(400)}`;
  assert.equal(compactReport(long), long.trim(), 'nothing is cut');
});

test('a session is renewed only when its context is really full, after the agent writes its own handoff note', async () => {
  const { REFRESH, preamble } = await import('../lib/team.mjs');
  const started = [], notices = [];
  const rt = { isRunning: false, approvals: new Map(), backgroundTasks: [], context: { used: 100_000, window: 200_000 }, sessionTokens: 9_000_000 };
  const t = { id: 'L', title: 'Orquestador', projectPath: '/p', queued: [], items: [{ kind: 'user', text: 'El probe ya enumera Vulkan, comprobado en la consola', date: Date.now() / 1000 - 60 }] };
  const closed = [];
  const teams = Object.create(Teams.prototype);
  teams.host = {
    threads: new Map([['L', t]]), _rt: () => rt, _uuid: () => 'u', _append: (th, it) => { th.items.push({ ...it, date: Date.now() / 1000 }); notices.push(it.text); }, _changed() {}, _saveState() {},
    _startTurn: (th, text, p, meta) => { started.push(meta.prompt); th.items.push({ kind: 'user', text, from: meta.from, date: Date.now() / 1000 }); },
    agents: { get: () => ({ close: () => closed.push(1) }), delete() {} }, accountsById: new Map(), projects: () => [], _modelName: () => 'm',
    teams: { _status: () => 'Estado del equipo: Ejecutor libre' },
  };
  const lead = { threadId: 'L', role: 'orchestrator', name: 'Orquestador' };
  const team = { id: 'T', goal: 'G', status: 'active', decisions: [], members: [lead] };
  Object.defineProperty(teams, 'list', { value: [team] });
  teams.of = () => team; teams.memberOf = () => lead; teams._checkBudget = () => {}; teams._dispatch = () => { throw new Error('a note gives no orders'); };

  teams._maybeRefresh(team, lead, t);
  assert.equal(started.length, 0, '50 % of the window, however many tokens the session added up: not yet');
  rt.context = { used: 372_000, window: null };
  teams._maybeRefresh(team, lead, t);
  assert.equal(started.length, 0, `unknown window: only past ${REFRESH.cap}`);
  rt.context = { used: 160_000, window: 200_000 };
  teams._maybeRefresh(team, lead, t);
  assert.equal(started.length, 1, 'past 75 % of its window: asks for the note first');
  assert.match(started[0], /nota de traspaso[\s\S]*ya comprobado/);
  assert.equal(closed.length, 0, 'not renewed until the note is written');

  teams.onTurnFinished(t, { text: 'x', messages: ['Comprobado: Vulkan enumera 1 dispositivo en la consola (19-nov). Espero el NRO runtime-lift de E1. <relevo:tarea para="Ejecutor">no debe salir</relevo:tarea>'] });
  assert.equal(closed.length, 1, 'now the session starts over');
  assert.match(lead.handoffNote.text, /Vulkan enumera 1 dispositivo/);
  assert.doesNotMatch(lead.handoffNote.text, /no debe salir/);
  assert.equal(t.freshSession, true);

  const fresh = preamble(teams.host, team, lead, true);
  assert.match(fresh, /Tu nota de traspaso[\s\S]*Vulkan enumera 1 dispositivo/);
  assert.match(fresh, /Lo último que te ha dicho el usuario[\s\S]*El probe ya enumera Vulkan/);
  assert.doesNotMatch(preamble(teams.host, team, lead, false), /nota de traspaso \(/);
});

test("waiting here: the thread stays on its model and carries on when the balance is back", async () => {
  const ds = acct('DS', 'api:deepseek', ['deepseek-v4-pro']);
  ds.status = { loggedIn: true, windows: [], balance: 0 };
  const resumed = [];
  const { h } = stand([ds, acct('CL', 'claude', ['opus'])], { _refreshAccount: async () => {}, _resumeAfterLimit: (t) => resumed.push(t.id) });
  h._clearLimitTimers = P._clearLimitTimers;
  const t = { id: 'T', accountId: 'DS', model: 'deepseek-v4-pro' };
  const r = h._rt(t);
  r.limit = { message: 'Insufficient Balance', resetsAt: null };
  h._limitAction(t, 'wait');
  assert.equal(r.waitChosen, true);
  assert.equal(r.resumeUnknown, true, 'no reset time: it will keep checking');
  assert.ok(r.resumeAt > nowS() + 200);
  clearTimeout(r.relayTimer);
  await h._checkQuotaBack(t);
  assert.equal(resumed.length, 0, 'still no balance: checks again later');
  clearTimeout(r.relayTimer);
  ds.status.balance = 12.5;
  await h._checkQuotaBack(t);
  assert.deepEqual(resumed, ['T'], 'balance back: carries on with the same model');
  // The next time it runs out it waits again without asking, until you say otherwise.
  h._onLimit(t);
  assert.ok(r.resumeAt, 'waits again');
  clearTimeout(r.relayTimer);
  h._limitAction(t, 'cancelResume');
  assert.equal(r.waitChosen, false);
});

test("an agent sent to the model you chose goes back to its own as soon as that has quota again", () => {
  const ds = acct('DS', 'api:deepseek', ['deepseek-v4-pro']);
  const { h } = stand([acct('CX', 'codex', ['gpt-6.1-terra']), acct('CL', 'claude', ['haiku']), ds]);
  const notices = [];
  h._append = (x, it) => notices.push(it.text);
  // On Codex, with «→ DeepSeek» as its out-of-quota choice: that is where it goes, whatever else has quota.
  const t = { id: 'T', accountId: 'CX', model: 'gpt-6.1-terra', limitPlan: { mode: 'chain', targets: [{ accountId: 'DS', model: 'deepseek-v4-pro' }] } };
  assert.deepEqual(h._planTarget(t, t.limitPlan), { accountId: 'DS', model: 'deepseek-v4-pro' });
  h._rt(t).pendingRelay = { accountId: 'DS', model: 'deepseek-v4-pro' };
  h._relayNow(t);
  assert.equal(t.accountId, 'DS');
  assert.deepEqual(t.home, { accountId: 'CX', model: 'gpt-6.1-terra' }, 'it remembers where it was');
  assert.match(notices.pop(), /volverá a CX · gpt-6\.1-terra en cuanto recupere la cuota/);
  // Codex still out: it stays on DeepSeek.
  h.accounts[0].status.windows = [{ percent: 100, resetsAt: nowS() + 900 }];
  h._preTurnSwitch(t);
  assert.equal(t.accountId, 'DS');
  // Codex has quota again: back before the next turn.
  h.accounts[0].status.windows = [{ percent: 4 }];
  h._preTurnSwitch(t);
  assert.equal(t.accountId, 'CX');
  assert.equal(t.model, 'gpt-6.1-terra');
  assert.equal(t.home, null);
  // And DeepSeek is no last resort by rule: the automatic choice goes by fit for the role, pay-per-use or not.
  assert.deepEqual(h._planTarget({ id: 'U', accountId: 'CX', model: 'gpt-6.1-terra' }, { mode: 'smart', tier: 'heavy' }), { accountId: 'DS', model: 'deepseek-v4-pro' });
});

test('the research list goes once with the instructions, not with every order', async () => {
  const { preamble, researchReport } = await import('../lib/team.mjs');
  const started = [];
  const threads = new Map([['L', { id: 'L', queued: [], teamPrimed: true }], ['I', { id: 'I', queued: [], teamPrimed: true, projectPath: '/p' }]]);
  const teams = Object.create(Teams.prototype);
  teams.host = {
    threads, _rt: () => ({ isRunning: false, approvals: new Map() }), _uuid: () => 'u', _append() {}, _changed() {}, _saveState() {}, _broadcastSnapshot() {},
    _startTurn: (t, text) => started.push({ to: t.id, text }), accountsById: new Map(), projects: () => [], _modelName: () => 'm',
  };
  const lead = { threadId: 'L', role: 'orchestrator', name: 'Orquestador' };
  const inv = { threadId: 'I', role: 'researcher', name: 'Investigador', findingsSeen: 2 };
  const team = { status: 'active', auto: 0, held: [], goal: 'G', members: [lead, inv], nextFinding: 2,
    findings: [{ id: 1, topic: 'Vulkan en Switch 2', summary: 'consoleInit retiene la GPU' }, { id: 2, topic: 'Mando con kaiHEN', summary: 'la API pad habitual' }] };

  // It already has everything researched so far: the order arrives as the orchestrator wrote it.
  teams._order(team, lead, { type: 'investigar', to: null, body: '¿Qué función llama a vsnwprintf_s?' });
  assert.equal(started.pop().text, '¿Qué función llama a vsnwprintf_s?');

  // Something it hasn't been given: only that, once.
  team.findings.push({ id: 3, topic: 'Bink en el arranque', summary: 'es la película del logo' });
  team.nextFinding = 3;
  teams._order(team, lead, { type: 'investigar', to: null, body: 'Otra pregunta' });
  const second = started.pop().text;
  assert.match(second, /^Otra pregunta\n\n\(Investigado desde tu última consulta:\n#3 Bink en el arranque — es la película del logo\)$/);
  assert.doesNotMatch(second, /Vulkan en Switch 2/);
  teams._order(team, lead, { type: 'investigar', to: null, body: 'Y otra' });
  assert.equal(started.pop().text, 'Y otra', 'not again');

  // A session about to start gets the whole list with its instructions, so the order adds nothing.
  threads.get('I').teamPrimed = false;
  inv.findingsSeen = 0;
  teams._order(team, lead, { type: 'investigar', to: null, body: 'Tras renovar' });
  assert.equal(started.pop().text, 'Tras renovar');
  const rules = preamble(teams.host, team, inv);
  assert.match(rules, /Ya investigado en este equipo[\s\S]*#1 Vulkan en Switch 2[\s\S]*#3 Bink en el arranque/);
  assert.match(rules, /primera línea es la conclusión[\s\S]*unos 2\.500 caracteres/);
  assert.doesNotMatch(rules, /40 líneas/);

  // Its report starts at the conclusion; what it said before is narration.
  assert.equal(researchReport(['Voy a revisar el desensamblado.', '**Conclusión:** es `_fn_0x1624`.\nEvidencia: code_137.s:88']), '**Conclusión:** es `_fn_0x1624`.\nEvidencia: code_137.s:88');
  assert.equal(researchReport(['Parte 1 del informe', 'Parte 2 del informe']), 'Parte 1 del informe\n\nParte 2 del informe', 'no conclusion line: all of it, as written');
});

test("the researcher's report reaches the orchestrator from its conclusion, and it isn't told what it just found", () => {
  const sent = [];
  const t = { id: 'I', queued: [], items: [] };
  const teams = Object.create(Teams.prototype);
  teams.host = { threads: new Map([['I', t]]), _rt: () => ({ isRunning: false, approvals: new Map() }), _saveState() {}, _broadcastSnapshot() {} };
  const inv = { threadId: 'I', role: 'researcher', name: 'Investigador', inquiry: '¿Por qué Vulkan da 0 dispositivos?' };
  const team = { status: 'active', members: [inv], findings: [], nextFinding: 0 };
  teams.of = () => team; teams.memberOf = () => inv; teams._checkBudget = () => {}; teams._maybeRefreshMember = () => {};
  teams._toLead = (tm, m, kind, text) => sent.push({ kind, text });
  teams.onTurnFinished(t, { text: 'x', messages: ['He revisado probe.txt y vulkan.c.', 'Conclusión: `consoleInit` retiene la GPU.\nQuítalo antes de Vulkan (main.c:324).'] });
  assert.equal(sent[0].kind, 'informe de investigación');
  assert.match(sent[0].text, /^Conclusión: `consoleInit` retiene la GPU\./);
  assert.doesNotMatch(sent[0].text, /He revisado/);
  assert.equal(team.findings[0].topic, '¿Por qué Vulkan da 0 dispositivos?');
  assert.equal(inv.findingsSeen, 1);
});

test('decisions are written whole in the project, out of git, and the old or withdrawn ones kept apart', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-dec-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const teams = Object.create(Teams.prototype);
  teams.host = { projects: () => [{ id: 'P', path: root }], _saveState() {}, _broadcastSnapshot() {}, threads: new Map() };
  const team = { id: 'T', projectId: 'P', goal: 'Mass Effect', members: [] };
  const long = `Comprobado 20-nov: ${'el gestor 0x2777c00 no se llena '.repeat(30)}FIN`;
  const d = teams.addDecision(team, long, 'Orquestador');
  assert.ok(d.text.length <= 402 && d.text.endsWith('…'), 'short in the state');
  const file = path.join(root, '.relevo', 'decisiones.md');
  assert.match(fs.readFileSync(file, 'utf8'), /## #1 · Orquestador[\s\S]*FIN/, 'whole on disk');
  assert.equal(team.decisionsFile, file);
  assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\/\.relevo\/$/m);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString(), '', 'git does not see it');
  teams.addDecision(team, 'Usar shadPS4 como referencia', 'usuario');
  teams.dropDecisions(team, '2');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /shadPS4/);
  assert.match(fs.readFileSync(path.join(root, '.relevo', 'decisiones-anteriores.md'), 'utf8'), /#2 \(retirada\)[\s\S]*shadPS4/);
  // An agent is told where they are.
  const { decisionsBlock } = await import('../lib/team.mjs');
  assert.match(decisionsBlock(team), new RegExp(`enteras .* están en ${file.replace(/[\\.]/g, '\\$&')}`));
  // Saved cut by an older version: the whole text comes back from the orchestrator's message.
  const old = { id: 'O', projectId: 'P', goal: 'x', decisions: [{ id: 5, text: 'La lista está muerta: nadie inserta y …', by: 'Orquestador', at: 1 }], members: [{ role: 'orchestrator', threadId: 'L' }] };
  teams.host.threads.set('L', { items: [{ kind: 'assistant', text: 'Vale. <relevo:decision>La lista está muerta: nadie inserta y FIOS sí lee Core.xxx.</relevo:decision>' }] });
  teams._recoverDecisions(old);
  assert.equal(old.decisions[0].full, 'La lista está muerta: nadie inserta y FIOS sí lee Core.xxx.');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the Live Activity: a team is one, seen from its orchestrator, with a line per agent; you first', () => {
  const lead = { id: 'L', title: 'Orquestador', items: [{ kind: 'assistant', text: 'Hecho el reparto.' }], updatedAt: 10, model: 'sonnet' };
  const ex = { id: 'E', title: 'Ejecutor 1', items: [], updatedAt: 9 };
  const solo = { id: 'S', title: 'Arreglar login', items: [], updatedAt: 8 };
  const rts = new Map([['L', { approvals: new Map() }], ['E', { approvals: new Map(), isRunning: true, statusLine: 'make -j8' }], ['S', { approvals: new Map() }]]);
  const team = { id: 'T', projectId: 'P', goal: 'Mass Effect en Switch 2\nfase 1', milestones: [{ done: true }, { done: false }],
    members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, { threadId: 'E', role: 'executor', name: 'Ejecutor 1' }] };
  const h = {
    threads: new Map([['L', lead], ['E', ex], ['S', solo]]), teams: { list: [team] }, _rt: (t) => rts.get(t.id),
    _item: (t, id) => t.items.find((i) => i.id === id), _account: () => ({ name: 'Claude', symbol: 'asterisk' }), projects: () => [{ id: 'P', name: 'masseffect' }],
  };
  let a = P._activity.call(h);
  assert.equal(a.phase, 'working');
  assert.equal(a.threadTitle, 'Equipo · masseffect');
  assert.equal(a.threadId, 'L', 'tapping it opens the orchestrator');
  assert.equal(a.statusLine, 'Ejecutor 1: make -j8');
  assert.equal(a.detail, 'Hitos 1/2 · Mass Effect en Switch 2');
  assert.deepEqual(a.agents, [{ name: 'Orquestador', role: 'orchestrator', state: 'free' }, { name: 'Ejecutor 1', role: 'executor', state: 'working' }]);
  // A permission the orchestrator is deciding is not for you yet.
  ex.items.push({ id: 'p1', kind: 'approval', title: 'cp a /opt', options: [{ id: 'allow', label: 'Permitir', isAllow: true }], reviewBy: 'L' });
  rts.get('E').approvals.set('p1', {});
  rts.get('E').isRunning = false;
  a = P._activity.call(h);
  assert.equal(a.phase, 'working');
  assert.equal(a.agents[1].state, 'reviewing');
  assert.equal(a.statusLine, 'Ejecutor 1: esperando que Orquestador decida un permiso');
  // Passed on to you: you first, with its buttons, from the executor's thread.
  ex.items[0].escalated = true;
  a = P._activity.call(h);
  assert.equal(a.phase, 'needsYou');
  assert.equal(a.threadId, 'E');
  assert.equal(a.statusLine, 'Ejecutor 1 necesita tu permiso');
  assert.equal(a.approval.title, 'cp a /opt');
  // Done and talking to you, while a thread of its own works: the orchestrator waiting is shown, the other counted.
  ex.items[0].resolution = 'Permitido'; rts.get('E').approvals.clear();
  lead.attention = { kind: 'orquestador', text: 'Fase 1 cerrada. ¿Empezamos la fase 2?' };
  rts.get('S').isRunning = true;
  a = P._activity.call(h);
  assert.equal(a.phase, 'finished');
  assert.equal(a.ready, true);
  assert.equal(a.statusLine, 'Fase 1 cerrada. ¿Empezamos la fase 2?');
  assert.equal(a.others, 1);
});
