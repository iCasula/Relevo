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
  for (const k of ['_account', '_exhausted', '_used', '_usableTarget', '_limitedUntil', '_noteLimit', '_smartTarget', '_planTarget', '_onLimit', '_preTurnSwitch', '_relayNow']) h[k] = P[k];
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
  // Mid-turn: a task bounces (and the orchestrator is told it won't arrive by itself)…
  rts.E.isRunning = true;
  assert.equal(teams._deliver(team, ex, 'otra tarea', { ...from, label: 'tarea' }), 'bounced');
  assert.match(notices.pop(), /no le llega solo/);
  // …but the answer to its own question is queued for when the turn ends.
  ex.awaitingAnswer = true;
  assert.equal(teams._deliver(team, ex, 'respuesta', { ...from, label: 'respuesta' }), 'queued');
  void lead;
});

test("the safety net: a finished turn whose words never reached the team is sent, once", () => {
  const sent = [], notices = [];
  const t = { id: 'E', title: 'Ejecutor 2', queued: [], items: [{ kind: 'user', text: 'tarea', done: true, date: 1 }] };
  const teams = Object.create(Teams.prototype);
  teams.host = { threads: new Map([['E', t]]), _rt: () => ({ isRunning: false, approvals: new Map() }), _append: (th, it) => { th.items.push({ ...it, date: 2 }); notices.push(it.text); }, _changed() {}, _uuid: () => 'u', log() {} };
  teams.onTurnFinished = (th, a) => sent.push(a.text);
  Object.defineProperty(teams, 'list', { value: [{ status: 'active', members: [{ threadId: 'E', role: 'executor', name: 'Ejecutor 2' }] }] });
  teams.sweepUnreported(1e12);
  assert.equal(t.teamReportedUpTo, 1, 'older threads: what is there counts as told');
  t.items.push({ kind: 'assistant', text: 'ESTADO: hecho <relevo:pregunta>¿restauro el volcado?</relevo:pregunta>', date: 3 });
  teams.sweepUnreported(3 * 1000 + 5_000);
  assert.equal(sent.length, 0, 'too soon: it may still be on its way');
  teams.sweepUnreported(3 * 1000 + 30_000);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /restauro el volcado/);
  assert.match(notices[0], /no había llegado/);
  teams.sweepUnreported(1e12);
  assert.equal(sent.length, 1, 'not twice');
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
