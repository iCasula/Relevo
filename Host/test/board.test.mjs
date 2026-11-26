// The team's board and log: each order is a task with a number, its milestone and its state; reports move it,
// the orchestrator closes it; results go to a searchable log instead of the decisions; the decisions that set
// the course are pinned; an auditor reviews the course; you can send a pending order now from the agent's chat.
// Teams methods on a small stand-in host, with the ledger in memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Teams, parseOrders, looksLikeRecord, milestonesBlock, decisionsBlock, currentMilestone } from '../lib/team.mjs';
import { openLedger } from '../lib/ledger.mjs';

function stand({ projectPath = null } = {}) {
  const L = { id: 'L', title: 'Orquestador', queued: [], items: [] };
  const E = { id: 'E', title: 'Ejecutor 1', queued: [], items: [], team: { id: 'T1', role: 'executor', name: 'Ejecutor 1' } };
  const R = { id: 'R', title: 'Investigador', queued: [], items: [] };
  const delivered = [], notices = [];
  const teams = Object.create(Teams.prototype);
  teams.host = {
    threads: new Map([['L', L], ['E', E], ['R', R]]), projects: () => (projectPath ? [{ id: 'P', path: projectPath }] : []),
    _rt: () => ({ isRunning: false, approvals: new Map(), backgroundTasks: [] }),
    _append: (th, it) => notices.push(it.text), _changed() {}, _uuid: () => 'u', log() {}, _saveState() {}, _broadcastSnapshot() {},
  };
  const team = {
    id: 'T1', projectId: 'P', goal: 'Objetivo (decisiones #2)', status: 'active', auto: 0, held: [], findings: [],
    milestones: [{ id: 1, text: 'Menú', done: true }, { id: 2, text: 'Primera escena', done: false }],
    members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, { threadId: 'E', role: 'executor', name: 'Ejecutor 1' }, { threadId: 'R', role: 'researcher', name: 'Investigador' }],
  };
  Object.defineProperty(teams, 'list', { value: [team] });
  teams._deliver = (tm, m, text, from) => { delivered.push({ to: m.name, text, from }); return 'sent'; };
  return { teams, team, delivered, notices, lead: team.members[0], exec: team.members[1], researcher: team.members[2] };
}

test('orders carry their attributes; results look like records, not decisions', () => {
  assert.deepEqual(parseOrders('<relevo:tarea para="Ejecutor 1" hito="7">haz x</relevo:tarea>')[0].attrs, { para: 'Ejecutor 1', hito: '7' });
  assert.deepEqual(parseOrders('<relevo:cerrar tarea="12" estado="descartada">ya no</relevo:cerrar>')[0], { type: 'cerrar', to: null, body: 'ya no', attrs: { tarea: '12', estado: 'descartada' } });
  assert.equal(parseOrders('<relevo:tarea para="E">x</relevo:tarea>')[0].attrs, undefined, 'para= alone: as before');
  assert.equal(looksLikeRecord('24-nov: E4 despliega /switch/09.nro y verifica SHA256 941d5ddf'), true);
  assert.equal(looksLikeRecord('aceptado 3cce968b tras doble revisión'), true);
  assert.equal(looksLikeRecord('24-nov (usuario): se descarta sacar un NRO 09b intermedio'), false);
  assert.equal(looksLikeRecord('usamos shadPS4 como referencia para GNM'), false);
});

test('a task: numbered on the board, to the milestone in progress, done when reported, closed by the orchestrator', () => {
  const { teams, team, delivered, lead, exec } = stand();
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'implementa el GC' });
  const [t1] = teams.ledger.tasks('T1');
  assert.equal(t1.id, 1);
  assert.equal(t1.state, 'en curso');
  assert.equal(t1.milestone, 2, 'without hito=: the milestone in progress');
  assert.equal(delivered[0].text, 'implementa el GC', 'what you see in its chat is the order itself');
  assert.match(delivered[0].from.lead, /Tarea T1 · hito #2.*ESTADO: hecho \(T1\)/);
  assert.equal(exec.taskId, 1);
  // Its report: done, waiting for the orchestrator to check it.
  teams._taskReport(team, exec, 'ESTADO: hecho (T1)\nGC listo, tests pasan', 'hecha');
  assert.equal(teams.ledger.task('T1', 1).state, 'hecha');
  assert.match(teams._boardLine(team), /T1 Ejecutor 1 HECHA, sin cerrar #2/);
  assert.match(teams._boardLine(team), /Tablero sin cambios: 1 abierta \(T1\)/, 'unchanged: one short line');
  // Closed.
  teams._order(team, lead, { type: 'cerrar', to: null, body: 'comprobado en QEMU', attrs: { tarea: '1' } });
  assert.equal(teams.ledger.task('T1', 1).state, 'verificada');
  assert.equal(teams.ledger.task('T1', 1).result, 'comprobado en QEMU');
  assert.equal(exec.taskId, null);
  assert.match(teams._boardLine(team), /ninguna tarea abierta/);
  assert.match(teams.boardText(team), /Cerradas hace poco:\n- T1 Ejecutor 1 · verificada/);
  // A report is in the log: searchable.
  assert.match(teams.searchText(team, 'GC listo'), /informe T1 · Ejecutor 1/);
});

test('a task for a busy agent waits as pending; replaced, it is dropped; dropped by you, the orchestrator hears it', () => {
  const { teams, team, lead, exec } = stand();
  teams._deliver = (tm, m, text, from) => { m.parked = { text, from, label: from.label, at: 1 }; return 'parked'; };
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'primera', attrs: { hito: '2' } });
  assert.equal(teams.ledger.task('T1', 1).state, 'pendiente');
  // You drop it from the agent's chat.
  teams.parkedAction(teams.host.threads.get('E'), 'drop');
  assert.equal(exec.parked, null);
  assert.equal(teams.ledger.task('T1', 1).state, 'descartada');
  assert.match(team.notes.at(-1), /El usuario ha descartado tu orden pendiente para Ejecutor 1 \(«primera»\)/);
  // Another one: you send it now (it interrupts).
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'segunda' });
  let urgent = null;
  teams._deliver = (tm, m, text, from, resumed, isUrgent) => { urgent = isUrgent; return 'sent'; };
  teams.parkedAction(teams.host.threads.get('E'), 'send');
  assert.equal(urgent, true);
  assert.equal(teams.ledger.task('T1', 2).state, 'en curso');
  assert.equal(exec.taskId, 2);
  assert.match(team.notes.at(-1), /entregado ya a Ejecutor 1 tu orden pendiente \(«segunda»\).*no se la repitas/);
  assert.throws(() => teams.parkedAction(teams.host.threads.get('E'), 'send'), /Ya no hay ninguna orden pendiente/);
});

test('a research order is a task too, closed by its own report; a blocked task goes on when answered', () => {
  const { teams, team, lead, exec, researcher } = stand();
  teams._order(team, lead, { type: 'investigar', to: null, body: 'busca un GC para Vulkan' });
  assert.equal(teams.ledger.task('T1', 1).kind, 'investigar');
  teams._taskReport(team, researcher, 'Conclusión: VMA ya lo resuelve', 'verificada');
  assert.equal(teams.ledger.task('T1', 1).state, 'verificada');
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'integra VMA' });
  exec.awaitingAnswer = true;
  exec.task = { text: 'integra VMA', state: 'bloqueado' };
  teams._taskReport(team, exec, '¿Qué versión?', 'bloqueada');
  assert.equal(teams.ledger.task('T1', 2).state, 'bloqueada');
  teams._order(team, lead, { type: 'respuesta', to: 'Ejecutor 1', body: 'la 3.1' });
  assert.equal(teams.ledger.task('T1', 2).state, 'en curso');
});

test('results go to the log, not the decisions; «buscar» finds them; the decisions the goal names are pinned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-board-'));
  const { teams, team, lead, delivered, notices } = stand({ projectPath: dir });
  teams._order(team, lead, { type: 'decision', to: null, body: '24-nov: E4 despliega 09.nro, SHA256 941d5ddf verificado por FTP' });
  assert.equal(team.decisions ?? undefined, undefined, 'not a decision');
  assert.match(notices.at(-1), /Al registro \(no a decisiones\)/);
  assert.match(fs.readFileSync(path.join(dir, '.relevo', 'registro.md'), 'utf8'), /E4 despliega 09\.nro/);
  teams._order(team, lead, { type: 'registro', to: null, body: '24-nov: NRO 09 probado en la Switch 2: crashea tras la cinemática' });
  teams._order(team, lead, { type: 'buscar', to: null, body: 'cinematica switch' });
  assert.match(delivered.at(-1).text, /registro · Orquestador · .*NRO 09 probado en la Switch 2/);
  assert.equal(delivered.at(-1).from.label, 'búsqueda');
  // Decisions past the limit leave the list but stay in the ledger; the one the goal names comes back pinned.
  for (let i = 1; i <= 30; i++) teams.addDecision(team, `Decisión de rumbo ${i}`, 'Orquestador');
  assert.equal(team.decisions.some((d) => d.id === 2), false, '#2 left the list');
  teams._pinGoalDecisions(team);
  const d2 = team.decisions.find((d) => d.id === 2);
  assert.equal(d2?.pinned, true);
  assert.equal(d2.text, 'Decisión de rumbo 2');
  assert.match(decisionsBlock(team), /Fijadas \(el rumbo del equipo\):\n#2 Decisión de rumbo 2\nRecientes:/);
  for (let i = 31; i <= 40; i++) teams.addDecision(team, `Decisión de rumbo ${i}`, 'Orquestador');
  assert.ok(team.decisions.some((d) => d.id === 2), 'pinned: never leaves');
  teams._pinGoalDecisions(team); // once: you can unpin it
  teams._order(team, lead, { type: 'soltar', to: null, body: '2' });
  assert.equal(team.decisions.find((d) => d.id === 2)?.pinned, undefined);
  teams._pinGoalDecisions(team);
  assert.equal(team.decisions.find((d) => d.id === 2)?.pinned, undefined, 'not pinned again by itself');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('archived decisions of an older version are imported from their file, and can be pinned back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-board-'));
  fs.mkdirSync(path.join(dir, '.relevo'));
  fs.writeFileSync(path.join(dir, '.relevo', 'decisiones-anteriores.md'), '# Decisiones anteriores del equipo\n\nYa no…\n\n## #231 (antigua) · Orquestador\n\nArquitectura genérica, no parches por pantalla.\n\nSegunda línea.\n\n## #232 (retirada) · usuario\n\nOtra.\n\n');
  const { teams, team } = stand({ projectPath: dir });
  team.goal = 'Camino (decisiones #231)';
  teams._importArchived(team);
  teams._pinGoalDecisions(team);
  const d = team.decisions.find((x) => x.id === 231);
  assert.equal(d.pinned, true);
  assert.equal(d.text, 'Arquitectura genérica, no parches por pantalla. Segunda línea.');
  assert.match(teams.searchText(team, 'otra'), /decisión antigua #232/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sub-milestones: the one in progress, its siblings shown, and a reminder to split a big one', () => {
  const { teams, team } = stand();
  assert.match(milestonesBlock(team, true), /El hito en curso \(#2\) no tiene subhitos: divídelo/);
  const a = teams.addMilestone(team, 'Carga la partida', 2);
  const b = teams.addMilestone(team, 'Mueve a Shepard', 2);
  teams.addMilestone(team, '60 fps');
  assert.equal(a.parent, 2);
  assert.deepEqual(team.milestones.map((m) => m.id), [1, 2, a.id, b.id, team.milestones.at(-1).id], 'sub-milestones right after their parent');
  assert.equal(currentMilestone(team).id, a.id);
  teams.setMilestones(team, String(a.id), true);
  assert.equal(currentMilestone(team).id, b.id);
  const block = milestonesBlock(team, true);
  assert.match(block, /→ #2 Primera escena\n   ✓ #\d+ Carga la partida\n   → #\d+ Mueve a Shepard\n○ #\d+ 60 fps/);
  assert.doesNotMatch(block, /no tiene subhitos/);
  // A task without hito= goes to the sub-milestone in progress.
  const { lead } = { lead: team.members[0] };
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'mueve' });
  assert.equal(teams.ledger.tasks('T1')[0].milestone, b.id);
});

test('the auditor: set up, due only after the team worked, its review goes to the orchestrator and to the log', () => {
  const { teams, team, delivered } = stand();
  const started = [];
  const A = { id: 'A', title: 'x', queued: [], items: [] };
  Object.assign(teams.host, {
    accountsById: new Map([['ACC', { id: 'ACC', name: 'Claude' }]]), _modelName: (a, m) => m,
    createThread: () => { teams.host.threads.set('A', A); return A; }, agents: new Map(),
    _startTurn: (t, text, x, meta) => started.push({ t, text, prompt: meta.prompt }), _push() {},
  });
  team.leadTurns = 10;
  assert.match(teams.setAudit(team, { accountId: 'acc', model: 'opus', every: 4 }), /cada 4 h/);
  teams.watchAudits(team.audit.lastAt + 5 * 3600);
  assert.equal(started.length, 0, 'the team has not worked since');
  team.leadTurns = 14;
  teams.watchAudits(team.audit.lastAt + 3 * 3600);
  assert.equal(started.length, 0, 'not yet due');
  teams.watchAudits(team.audit.lastAt + 5 * 3600);
  assert.equal(started.length, 1);
  assert.equal(A.mode, 'plan', 'read-only');
  assert.equal(A.auditFor, 'T1');
  assert.match(started[0].prompt, /Eres el AUDITOR/);
  assert.match(started[0].prompt, /Objetivo del usuario:\nObjetivo/);
  teams.onAuditFinished(A, { messages: ['Voy a revisar.', 'Conclusión: avanza, pero E2 se ha desviado.\n1. …'] });
  assert.match(delivered.at(-1).text, /^Conclusión: avanza, pero E2 se ha desviado/);
  assert.equal(delivered.at(-1).from.label, 'auditoría');
  assert.match(teams.lastAuditText(team), /Última auditoría .*\nConclusión: avanza/);
  assert.equal(teams.boardFor(team).audits.length, 1);
});

test('the auditor never waits for you: reads go, writes are refused with why, its questions skipped, its plan is its review', () => {
  const { teams, team, delivered } = stand();
  const A = { id: 'A', title: 'x', queued: [], items: [], auditFor: 'T1' };
  const ask = (extra, held = null) => {
    let got = null;
    teams.auditApproval(A, { options: [{ id: 'allow', label: 'Permitir', isAllow: true }, { id: 'session', label: 'Permitir en esta sesión', isAllow: true }, { id: 'deny', label: 'Denegar', isAllow: false }], respond: (c, a, note) => { got = { c, note }; }, ...extra }, held);
    return got;
  };
  assert.equal(ask({ toolName: 'Bash', input: { command: 'git log --oneline -20 && rg -n "OOM" docs' } }).c, 'allow');
  assert.equal(ask({ toolName: 'Bash', input: { command: 'git worktree list --porcelain' } }).c, 'allow');
  assert.equal(ask({ toolName: 'Bash', input: { command: "wsl -- bash -lc 'cd ~/me1 && git -C . log -5'" } }).c, 'allow');
  assert.equal(ask({ toolName: 'Read', input: { file_path: 'V:/x/PROGRESS.md' } }).c, 'allow');
  const rm = ask({ toolName: 'Bash', input: { command: 'rm -rf build' } });
  assert.equal(rm.c, 'deny');
  assert.match(rm.note, /Eres el auditor y solo lees: ese comando escribe/);
  assert.equal(ask({ toolName: 'Bash', input: { command: 'make -j8' } }).c, 'deny');
  assert.equal(ask({ toolName: 'Write', input: { file_path: 'a.md' } }).c, 'deny');
  assert.match(ask({ toolName: 'Bash', input: { command: 'cat x' } }, { reason: 'fuera del proyecto' }).note, /Relevo lo detiene \(fuera del proyecto\)/);
  assert.equal(ask({ questions: [{ question: '¿Sigo?' }] }).c, 'deny');
  // Antigravity offers to run again what it denied: a read goes, a write doesn't.
  const agy = (text) => { let got = null; teams.auditApproval(A, { toolName: 'agy', text, options: [{ id: 'retry', label: 'Permitir y reintentar', isAllow: true }, { id: 'deny', label: 'Ignorar', isAllow: false }], respond: (c) => { got = c; } }); return got; };
  assert.equal(agy('Bash run_command git log --oneline -30'), 'retry');
  assert.equal(agy('Bash run_command rm -rf out/wt-old'), 'deny');
  const plan = ask({ toolName: 'ExitPlanMode', input: { plan: 'Conclusión: el equipo se ha desviado del subhito 7.1.\n1. …' } });
  assert.equal(plan.c, 'deny');
  teams.onAuditFinished(A, { messages: [] });
  assert.match(delivered.at(-1).text, /^Conclusión: el equipo se ha desviado del subhito 7\.1/);
});

test('the next audit is due N hours after the last one ended, not after it started', () => {
  const { teams, team } = stand();
  const started = [];
  const A = { id: 'A', title: 'x', queued: [], items: [] };
  Object.assign(teams.host, {
    accountsById: new Map([['ACC', { id: 'ACC', name: 'Claude' }]]), _modelName: (a, m) => m,
    createThread: () => { teams.host.threads.set('A', A); return A; }, agents: new Map(),
    _startTurn: (t) => started.push(t), _push() {},
  });
  teams.setAudit(team, { accountId: 'acc', model: 'opus', every: 4 });
  team.leadTurns = 10;
  const t0 = team.audit.lastAt;
  teams.watchAudits(t0 + 5 * 3600);
  assert.equal(started.length, 1);
  // It ran late (it finished 3 h after starting) while the team went on working.
  const realNow = Date.now;
  Date.now = () => (t0 + 8 * 3600) * 1000;
  try { teams.onAuditFinished(A, { messages: ['Conclusión: bien.'] }); } finally { Date.now = realNow; }
  team.leadTurns = 20;
  teams.watchAudits(t0 + 9.5 * 3600);
  assert.equal(started.length, 1, 'not two in a row');
  teams.watchAudits(t0 + 12.5 * 3600);
  assert.equal(started.length, 2);
});

test('a new task in a fresh session (sesion="nueva"): the agent writes its handoff note, the task waits for its new session', () => {
  const { teams, team, lead, exec } = stand();
  teams._deliver = Teams.prototype._deliver;
  const rts = new Map();
  const rt = (t) => { if (!rts.has(t.id)) rts.set(t.id, { isRunning: false, approvals: new Map(), backgroundTasks: [], context: { used: 0, window: 475000 } }); return rts.get(t.id); };
  const started = [];
  Object.assign(teams.host, {
    _rt: rt, _renewLimit: () => 400_000, agents: new Map(), accountsById: new Map(), _switchSoon: () => false,
    _startTurn: (t, text, x, meta) => { started.push({ t: t.id, label: meta?.from?.label, prompt: meta?.prompt }); rt(t).isRunning = true; },
  });
  const E = teams.host.threads.get('E');
  rt(E).context.used = 320_000;
  // The orchestrator sees how full its session is.
  assert.match(teams._status(team, lead), /Ejecutor 1 [^|]*sesión con 320 k tokens/);
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'compón el NRO multicore', attrs: { hito: '2', sesion: 'nueva' } });
  assert.equal(started.length, 1);
  assert.equal(started[0].label, 'traspaso', 'first its handoff note');
  assert.match(started[0].prompt, /tarea nueva que empiezas en limpio/);
  assert.equal(E.queued.length, 1, 'the task waits for its new session');
  assert.match(E.queued[0].prompt, /compón el NRO multicore/);
  // Its note is in: a fresh session, and the task goes with it.
  rt(E).isRunning = false;
  E.items.push({ kind: 'user', from: { label: 'traspaso' } });
  teams.onTurnFinished(E, { text: 'Nota: T98 publicada en d3d9a8e2; QEMU libre.', messages: ['Nota: T98 publicada en d3d9a8e2; QEMU libre.'] });
  assert.equal(E.freshSession, true);
  assert.equal(E.teamPrimed, false, 'its next message brings the whole team preamble');
  assert.match(exec.handoffNote.text, /d3d9a8e2/);
  // Without sesion="nueva", or with little context, it stays in the same session.
  rt(E).context = { used: 30_000, window: 475000 };
  E.queued = [];
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'sigue', attrs: { hito: '2', sesion: 'nueva' } });
  assert.equal(started.at(-1).label, 'tarea T2', 'no handoff turn: straight to the task');
});

test("an agent that writes in the user's mailbox speaks as itself, not as the user, and is told not to", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-inbox-'));
  const { teams, team, delivered } = stand({ projectPath: dir });
  team.members.push({ threadId: 'E3', role: 'executor', name: 'Ejecutor 3' });
  const inbox = path.join(dir, '.relevo', 'al-orquestador');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'e3-t96-qemu-window.txt'), 'T96 E3: solicito coordinar la ventana QEMU');
  fs.writeFileSync(path.join(inbox, 'revision-1300.md'), 'Prioridad: el NRO multicore antes que la nave');
  teams.watchInbox(Date.now() + 10_000);
  const toLead = delivered.filter((d) => d.to === 'Orquestador');
  assert.equal(toLead.length, 2);
  const own = toLead.find((d) => d.from.name === 'Ejecutor 3');
  assert.match(own.text, /Lo dejó Ejecutor 3 en el buzón del usuario: es un mensaje suyo/);
  assert.equal(toLead.find((d) => d.from.name === 'Auditor externo').from.label, 'auditoría');
  assert.match(delivered.find((d) => d.to === 'Ejecutor 3').text, /No escribas en .relevo\/al-orquestador/);
  assert.equal(teams._inboxAuthor(team, 'nota.md', 'Revisión: el Ejecutor 3 se ha desviado'), null, 'naming an agent in the text is not signing it');
});

test('the ledger without SQLite keeps the same board and log in a JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-ledger-'));
  for (const json of [true, false]) {
  const l = openLedger(dir, { json });
  const t = l.addTask('X', { owner: 'E1', text: 'haz algo con FIOS' });
  l.updateTask('X', t.id, { state: 'hecha', result: 'ok' });
  l.log('X', { kind: 'registro', by: 'O', text: 'Comprobado: el menú carga' });
  assert.equal(l.tasks('X')[0].state, 'hecha');
  assert.equal(l.search('X', 'menu carga')[0].text, 'Comprobado: el menú carga', 'accents and case don\'t matter');
  assert.equal(l.search('X', 'fios')[0].task.id, t.id);
  l.close();
  assert.ok(fs.existsSync(path.join(dir, json ? 'ledger.json' : 'ledger.db')));
  if (json) assert.equal(openLedger(dir, { json: true }).tasks('X')[0].result, 'ok', 'kept on disk');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an outside auditor: the board as a file to read, a folder to write to the orchestrator, a notice when a milestone is reached', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-board-'));
  const { teams, team, lead, delivered } = stand({ projectPath: dir });
  const pushes = [];
  teams.host._push = (t, title, body) => pushes.push([title, body]);
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'compón el NRO 10', attrs: { hito: '2' } });
  teams._taskReport(team, team.members[1], 'ESTADO: hecho (T1)\nNRO 10 compuesto, SHA abc', 'hecha');
  const board = fs.readFileSync(path.join(dir, '.relevo', 'tablero.md'), 'utf8');
  assert.match(board, /\*\*T1\*\* · Ejecutor 1 · hecha · hito #2/);
  assert.match(board, /Última entrega: ESTADO: hecho \(T1\) NRO 10 compuesto/);
  // Its review, left in the folder, reaches the orchestrator and moves to entregados/.
  const inbox = path.join(dir, '.relevo', 'al-orquestador');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'revision.md'), 'Prioridad: cerrar R1 antes que G4.');
  teams.watchInbox(Date.now() + 10_000);
  assert.match(delivered.at(-1).text, /^Prioridad: cerrar R1 antes que G4\./);
  assert.equal(delivered.at(-1).from.name, 'Auditor externo');
  assert.deepEqual(fs.readdirSync(inbox).filter((f) => f !== 'entregados'), []);
  assert.equal(fs.readdirSync(path.join(inbox, 'entregados')).length, 1);
  teams.watchInbox(Date.now() + 20_000);
  assert.equal(delivered.filter((d) => d.from.name === 'Auditor externo').length, 1, 'once');
  // A milestone reached: in the log and on your phone.
  teams.setMilestones(team, '2', true);
  assert.deepEqual(pushes.at(-1), ['Hito conseguido', 'Hito #2 conseguido: Primera escena']);
  assert.match(teams.searchText(team, 'conseguido'), /Hito #2 conseguido/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a task paused (by the orchestrator or by you) stays on the board, its agent leaves it; resumed, it goes back to it', () => {
  const { teams, team, delivered, lead, exec } = stand();
  teams._order(team, lead, { type: 'tarea', to: 'Ejecutor 1', body: 'GC de entradas activas' });
  assert.equal(exec.taskId, 1);
  teams._order(team, lead, { type: 'pausar', to: null, body: 'primero la memoria', attrs: { tarea: '1' } });
  const t = teams.ledger.task('T1', 1);
  assert.equal(t.state, 'pausada');
  assert.match(t.result, /^Pausada: primero la memoria/);
  assert.equal(exec.taskId, null, 'its agent is free');
  assert.match(delivered.at(-1).text, /Orquestador ha pausado T1: primero la memoria\. Déjala donde esté sin perder nada/);
  assert.equal(teams.ledger.tasks('T1').length, 1, 'still open, on the board');
  assert.match(teams._boardLine(team), /T1 Ejecutor 1 PAUSADA/);
  // A closed one can't be paused; the orchestrator hears why.
  teams._order(team, lead, { type: 'pausar', to: null, body: '7', attrs: { tarea: '7' } });
  assert.match(delivered.at(-1).text, /No hay ninguna tarea T7/);
  // Resumed with where to go on: back to its agent, in progress.
  teams._order(team, lead, { type: 'reanudar', to: null, body: 'sigue desde 2a63ad55', attrs: { tarea: '1' } });
  assert.equal(teams.ledger.task('T1', 1).state, 'en curso');
  assert.equal(exec.taskId, 1);
  assert.match(delivered.at(-1).text, /^Retoma T1: GC de entradas activas\n\nsigue desde 2a63ad55/);
  assert.equal(delivered.at(-1).from.taskId, 1);
  // From the apps: you pause it, you resume it (pending: the orchestrator gives it when it fits).
  teams.editTask('T1', { id: 1, state: 'pausada' });
  assert.equal(teams.ledger.task('T1', 1).state, 'pausada');
  assert.match(delivered.at(-1).text, /^El usuario ha pausado T1/);
  assert.match(team.notes.at(-1), /El usuario ha pausado la tarea T1/);
  const n = delivered.length;
  teams.editTask('T1', { id: 1, state: 'reabrir' });
  assert.equal(teams.ledger.task('T1', 1).state, 'pendiente');
  assert.equal(delivered.length, n, 'nothing sent behind the orchestrator');
  assert.match(team.notes.at(-1), /El usuario ha reanudado .* la tarea T1/);
  assert.equal(parseOrders('<relevo:pausar tarea="12">x</relevo:pausar>')[0].type, 'pausar');
});

test('the orchestrator asks the auditor: a read-only session with the question, the answer back to it; the periodic clock untouched', async () => {
  const { teams, team, delivered, lead, notices } = stand();
  const started = [];
  const A = { id: 'A', title: 'x', queued: [], items: [] };
  let busy = false;
  Object.assign(teams.host, {
    accountsById: new Map([['ACC', { id: 'ACC', name: 'Claude' }]]), _modelName: (a, m) => m,
    createThread: () => { teams.host.threads.set('A', A); return A; }, agents: new Map(),
    _startTurn: (t, text, x, meta) => started.push({ t, text, prompt: meta.prompt, from: meta.from }), _push() {},
  });
  teams._busy = () => busy;
  // Without an auditor: told so.
  teams._order(team, lead, { type: 'auditor', to: null, body: '¿Seguimos con el GC?' });
  assert.match(delivered.at(-1).text, /No se ha podido consultar al auditor: el equipo no tiene auditor/);
  team.leadTurns = 10;
  teams.setAudit(team, { accountId: 'acc', model: 'opus', every: 4 });
  const clock = team.audit.lastAt;
  teams._order(team, lead, { type: 'tarea', to: 'Auditor', body: '¿Vale la pena otro NRO de memoria o desglosamos antes?' });
  assert.equal(started.length, 1, 'para="Auditor" is a question for it');
  assert.equal(A.mode, 'plan');
  assert.match(started[0].prompt, /Orquestador \(el orquestador\) te consulta:\n«¿Vale la pena otro NRO/);
  assert.doesNotMatch(started[0].prompt, /6\. Orden:/, 'no full audit asked');
  assert.match(notices.at(-1), /^Consulta al auditor:/);
  // Another question while it answers: it waits its turn.
  busy = true;
  teams._order(team, lead, { type: 'auditor', to: null, body: 'Y otra cosa' });
  assert.equal(started.length, 1);
  busy = false;
  teams.onAuditFinished(A, { messages: ['Respuesta: desglosad antes.\nEvidencia: …'] });
  assert.equal(delivered.at(-1).from.label, 'respuesta');
  assert.match(delivered.at(-1).text, /^Respuesta: desglosad antes/);
  assert.equal(team.audit.lastAt, clock, 'the periodic audits keep their clock');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started.length, 2, 'the waiting question goes next');
  assert.match(started[1].prompt, /«Y otra cosa»/);
});
