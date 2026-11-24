// The team's branches and worktrees: executors may open one per task (t12-…), Relevo ties it to its task, takes
// it away when the task closes with everything integrated, integrates it when the orchestrator says so, and tells
// what's out of hand. The rest of the repository's branches are never touched. A real git repository in a temp
// folder; Teams methods on a small stand-in host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Teams, taskOfRef } from '../lib/team.mjs';

Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid' });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-git-')));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'inicio');
  return dir;
}

/** A task worktree as an executor would make it, with `commits` commits in it. */
function taskWorktree(dir, name, commits = 1) {
  const wt = path.join(dir, '.relevo', 'worktrees', name);
  git(dir, 'worktree', 'add', '-q', wt, '-b', name);
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(wt, `${name}-${i}.txt`), `${i}\n`);
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', `${name} ${i}`);
  }
  return wt;
}

function stand(projectPath) {
  const L = { id: 'L', title: 'Orquestador', queued: [], items: [] };
  const E = { id: 'E', title: 'Ejecutor 1', queued: [], items: [] };
  const delivered = [], notices = [];
  const teams = Object.create(Teams.prototype);
  teams.host = {
    threads: new Map([['L', L], ['E', E]]), projects: () => [{ id: 'P', path: projectPath }],
    _rt: () => ({ isRunning: false, approvals: new Map(), backgroundTasks: [] }),
    _append: (th, it) => notices.push(it.text), _changed() {}, _uuid: () => 'u', log() {}, _saveState() {}, _broadcastSnapshot() {},
  };
  const team = {
    id: 'T1', projectId: 'P', goal: 'Objetivo', status: 'active', auto: 0, held: [], findings: [], milestones: [],
    members: [{ threadId: 'L', role: 'orchestrator', name: 'Orquestador' }, { threadId: 'E', role: 'executor', name: 'Ejecutor 1' }],
  };
  Object.defineProperty(teams, 'list', { value: [team] });
  teams._deliver = (tm, m, text, from) => { delivered.push({ to: m.name, text, from }); return 'sent'; };
  const task = (text) => teams.ledger.addTask(team.id, { owner: 'Ejecutor 1', text, state: 'en curso', by: 'Orquestador' });
  return { teams, team, delivered, notices, lead: team.members[0], task };
}

const branches = (dir) => git(dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();

test('a branch or worktree names its task: t12-audio, relevo/T12, tarea-12', () => {
  for (const [name, id] of [['t12-audio', 12], ['relevo/T12', 12], ['tarea-12_x', 12], ['feature/t3', 3], ['T44', 44], ['main', null], ['test', null], ['t12x', null], ['relevo/3fa2b1c0', null]]) assert.equal(taskOfRef(name), id, name);
});

test('a closed task with everything integrated loses its branch and worktree; with work left, the orchestrator is told once', async () => {
  const dir = repo();
  const { teams, team, notices, task } = stand(dir);
  const t1 = task('implementa el GC');
  const t2 = task('prueba sin commits');
  const wt1 = taskWorktree(dir, 't1-gc', 2);
  const wt2 = taskWorktree(dir, 't2-prueba', 0);
  git(dir, 'branch', 'feature-del-usuario'); // not the team's: never listed nor touched
  const scan = teams.gitScan(team);
  assert.deepEqual(scan.items.map((x) => [x.branch, x.task, x.ahead]).sort(), [['t1-gc', 1, 2], ['t2-prueba', 2, 0]]);
  assert.match(teams.boardText(team), /T1 Ejecutor 1 · en curso: implementa el GC \[rama t1-gc, 2 commits sin integrar, con worktree\]/);
  // Both close: T2 had nothing of its own and goes; T1 has two commits not in main and stays.
  teams.closeTasks(team, [t1.id, t2.id], 'verificada', 'ok', 'Orquestador');
  await teams.gitTidy(team);
  assert.equal(fs.existsSync(wt2), false);
  assert.equal(fs.existsSync(wt1), true);
  assert.deepEqual(branches(dir), ['feature-del-usuario', 'main', 't1-gc']);
  assert.match(notices.join('\n'), /retirados.*T2: worktree .*t2-prueba y rama t2-prueba/);
  assert.match(team.notes.join('\n'), /T1 está verificada, pero su rama t1-gc tiene 2 commits sin integrar: intégrala con <relevo:integrar tarea="1"\/>/);
  team.notes = [];
  await teams.gitTidy(team);
  assert.equal(team.notes?.length ?? 0, 0, 'told once');
  assert.match(fs.readFileSync(path.join(dir, '.relevo', 'tablero.md'), 'utf8'), /Git: rama t1-gc, 2 commits sin integrar/);
  assert.equal(teams.boardFor(team).git[0].task, 1);
});

test('<relevo:integrar tarea="1"/> merges the task branch into main and takes it away; with uncommitted changes, it refuses', async () => {
  const dir = repo();
  const { teams, team, delivered, lead, task } = stand(dir);
  task('implementa el GC');
  const wt = taskWorktree(dir, 't1-gc', 1);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'cambiado\n');
  await assert.rejects(teams.integrateTask(team, 1), /1 cambio sin commit: pide a Ejecutor 1/);
  git(wt, 'commit', '-qam', 'más');
  teams._order(team, lead, { type: 'integrar', to: null, body: '', attrs: { tarea: '1' } });
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(delivered.at(-1).text, /Integrado: la rama t1-gc de T1 \(2 commits\) está fusionada en main, y he retirado worktree .* y rama t1-gc/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'cambiado\n');
  assert.deepEqual(branches(dir), ['main']);
  assert.equal(fs.existsSync(wt), false);
  assert.match(teams.searchText(team, 't1-gc'), /integrada en main/);
});

test('out of hand: one without a task, two for one task, more worktrees than executors; you take one away from the board', async () => {
  const dir = repo();
  const { teams, team, task } = stand(dir);
  task('a'); task('b'); task('c');
  taskWorktree(dir, 't1-a', 0);
  taskWorktree(dir, 't1-a-bis', 0);
  taskWorktree(dir, 't2-b', 0);
  taskWorktree(dir, 't3-c', 0);
  const loose = path.join(path.dirname(dir), `${path.basename(dir)}-experimento`);
  git(dir, 'worktree', 'add', '-q', loose, '-b', 'experimento');
  fs.writeFileSync(path.join(loose, 'nuevo.txt'), 'x\n');
  git(dir, 'branch', 't99-vieja');
  await teams.gitTidy(team);
  const said = team.notes.join('\n');
  assert.match(said, /T1 tiene 2 ramas o worktrees \(t1-a, t1-a-bis\)/);
  assert.match(said, /hay 4 worktrees de tareas abiertas .*máximo 2/);
  assert.match(said, /rama experimento.* no es de ninguna tarea/);
  assert.match(said, /rama t99-vieja.* no es de ninguna tarea/);
  // From the board: what loses nothing goes at once; otherwise it says what would be lost.
  const asked = await teams.gitRemove(team.id, { repo: dir, branch: 'experimento', path: loose });
  assert.deepEqual([asked.needsForce, asked.dirty, asked.ahead], [true, 1, 0]);
  assert.equal(fs.existsSync(loose), true);
  const done = await teams.gitRemove(team.id, { repo: dir, branch: 'experimento', path: loose, force: true });
  assert.equal(done.removed.length, 2);
  assert.equal(fs.existsSync(loose), false);
  assert.match(team.notes.at(-1), /El usuario ha retirado worktree .* y rama experimento/);
  await assert.rejects(teams.gitRemove(team.id, { repo: dir, branch: 'main', path: dir, force: true }), /ya no está \(o no es del equipo\)/);
  assert.deepEqual((await teams.gitRemove(team.id, { repo: dir, branch: 't99-vieja', path: null })).removed, ['rama t99-vieja']);
  const clean = taskWorktree(dir, 't2-limpio', 0);
  assert.equal((await teams.gitRemove(team.id, { repo: dir, branch: 't2-limpio', path: clean })).needsForce, true, 'a folder: always confirmed by you');
  assert.equal(fs.existsSync(clean), true);
});

test("a worktree Relevo made for a thread is not the team's to tidy", () => {
  const dir = repo();
  const { teams, team } = stand(dir);
  const wt = path.join(dir, '..', `${path.basename(dir)}-hilo`);
  git(dir, 'worktree', 'add', '-q', wt, '-b', 'relevo/abc123');
  teams.host.threads.get('E').worktree = { path: wt, branch: 'relevo/abc123', base: 'main', repo: dir };
  assert.deepEqual(teams.gitScan(team).items, []);
});

test('build outputs (what git ignores) are never deleted on their own: the worktree waits for you, who see its files and size', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'ignora build');
  const { teams, team, notices, task } = stand(dir);
  const t1 = task('compila');
  const wt = taskWorktree(dir, 't1-compila', 0);
  fs.mkdirSync(path.join(wt, 'build'));
  fs.writeFileSync(path.join(wt, 'build', 'juego.nro'), 'x'.repeat(5000));
  teams.closeTasks(team, [t1.id], 'verificada', 'ok', 'Orquestador');
  await teams.gitTidy(team);
  assert.equal(fs.existsSync(path.join(wt, 'build', 'juego.nro')), true);
  assert.match(notices.join('\n'), /T1: su worktree .* está integrado y listo para retirar, pero tiene 1 ficheros o carpetas que git ignora \(build\/\)/);
  assert.equal(team.notes?.length ?? 0, 0, 'the orchestrator is not bothered with it');
  assert.equal(teams.boardFor(team).git[0].ready, 1);
  const asked = await teams.gitRemove(team.id, { repo: dir, branch: 't1-compila', path: wt });
  assert.equal(asked.needsForce, true);
  assert.deepEqual(asked.ignored, ['build/']);
  assert.ok(asked.stats.files >= 3 && asked.stats.bytes >= 5000, 'its files and size, to confirm');
  assert.ok(asked.stats.first.some((f) => f.endsWith('juego.nro')) || asked.stats.last.some((f) => f.endsWith('juego.nro')));
  assert.deepEqual((await teams.gitRemove(team.id, { repo: dir, branch: 't1-compila', path: wt, force: true })).removed.length, 2);
  assert.equal(fs.existsSync(wt), false);
});
