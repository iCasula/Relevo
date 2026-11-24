// Git for a thread's project, as the Mac's Git menu does it: what changed (files, +/− and diffs), commit,
// commit and push, and the work state an agent receives in a handoff. Plain `git` from PATH.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const MAX_DIFF = 400_000;

function git(cwd, args, timeout = 20_000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 << 20, windowsHide: true });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') || (r.error?.message ?? '') };
}

/** Async, for commands that may take a while (push) without blocking the host. */
function gitAsync(cwd, args, timeout = 120_000) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill(), timeout);
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
  });
}

export function isRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
}

function countLines(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 << 20) return { added: 0, binary: st.size > 4 << 20 };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { added: 0, binary: true };
    const text = buf.toString('utf8');
    return { added: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, binary: false };
  } catch { return { added: 0, binary: false }; }
}

/** Branch, upstream and every changed file (staged, unstaged and new) with lines added and removed. */
export function status(cwd) {
  if (!isRepo(cwd)) return { repo: false, files: [] };
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || null;
  const hasHead = git(cwd, ['rev-parse', '--verify', 'HEAD']).ok;
  const upstream = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let ahead = 0, behind = 0;
  if (upstream.ok) {
    const [b, a] = git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).out.trim().split(/\s+/).map(Number);
    behind = b || 0; ahead = a || 0;
  }
  const stats = new Map();
  const numstat = hasHead ? git(cwd, ['diff', '--numstat', '-z', 'HEAD']) : git(cwd, ['diff', '--numstat', '-z', '--cached']);
  // -z: "added\tremoved\tpath\0", renames "added\tremoved\t\0old\0new\0".
  const parts = numstat.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    if (!file) { file = parts[i + 2]; i += 2; }
    stats.set(file, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  const files = [];
  const entries = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2), file = e.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the old path
    const kind = code === '??' ? 'new' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code[0] === 'R' ? 'renamed' : 'modified';
    const s = stats.get(file) ?? (code === '??' ? { ...countLines(path.join(cwd, file)), removed: 0 } : { added: 0, removed: 0, binary: false });
    files.push({ path: file, kind, added: s.added, removed: s.removed, binary: !!s.binary });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { repo: true, branch, upstream: upstream.ok ? upstream.out.trim() : null, ahead, behind, files };
}

/** Unified diff of one file or of everything, new files included (capped). */
export function diff(cwd, file) {
  if (!isRepo(cwd)) return '';
  const hasHead = git(cwd, ['rev-parse', '--verify', 'HEAD']).ok;
  const base = hasHead ? ['diff', 'HEAD', '--no-color', '--no-ext-diff'] : ['diff', '--cached', '--no-color'];
  let out = git(cwd, file ? [...base, '--', file] : base).out;
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...(file ? ['--', file] : [])]).out.split('\0').filter(Boolean);
  for (const f of untracked) {
    if (out.length > MAX_DIFF) break;
    let text;
    try {
      const buf = fs.readFileSync(path.join(cwd, f));
      text = buf.includes(0) ? null : buf.toString('utf8');
    } catch { continue; }
    const lines = text === null ? [] : text.replace(/\n$/, '').split('\n');
    out += `diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n`;
    out += text === null ? 'Fichero binario\n' : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
  }
  return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n… (diff recortado)` : out;
}

/** Stages everything, commits, and with `push` pushes the branch (setting its upstream the first time). */
export async function commit(cwd, { message, push }) {
  if (!isRepo(cwd)) return { ok: false, output: 'Esta carpeta no es un repositorio git.' };
  if (!message?.trim()) return { ok: false, output: 'Falta el mensaje del commit.' };
  const add = git(cwd, ['add', '-A']);
  if (!add.ok) return { ok: false, output: add.err };
  const c = await gitAsync(cwd, ['commit', '-m', message.trim()]);
  if (!c.ok) return { ok: false, output: c.out };
  let output = c.out;
  if (push) {
    const hasUpstream = git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']).ok;
    const p = await gitAsync(cwd, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
    output += `\n${p.out}`;
    if (!p.ok) return { ok: false, committed: true, output: `${output}\n\nEl commit está hecho, pero el push ha fallado.` };
  }
  return { ok: true, output: output.trim() };
}

/** What a new agent needs to know about the project's state, besides the conversation (as Handoff.swift). */
export function workState(cwd) {
  if (!cwd || !isRepo(cwd)) return null;
  const s = status(cwd);
  const lines = [`- Rama: ${s.branch ?? '?'}${s.upstream ? ` (${s.upstream}${s.ahead ? `, ${s.ahead} commits sin subir` : ''})` : ''}`];
  if (s.files.length) {
    lines.push(`- Cambios sin commit (${s.files.length}):`);
    for (const f of s.files.slice(0, 40)) lines.push(`  - ${f.kind === 'new' ? 'nuevo' : f.kind === 'deleted' ? 'borrado' : 'modificado'}: ${f.path} (+${f.added} −${f.removed})`);
    if (s.files.length > 40) lines.push(`  - … y ${s.files.length - 40} más`);
  } else lines.push('- Sin cambios sin commit.');
  const log = git(cwd, ['log', '--oneline', '-n', '5']).out.trim();
  if (log) lines.push(`- Últimos commits:\n${log.split('\n').map((l) => `  - ${l}`).join('\n')}`);
  return lines.join('\n');
}

/** Adds `pattern` to the repository's own ignore list (.git/info/exclude), which is never committed. */
export function exclude(cwd, pattern) {
  if (!isRepo(cwd)) return false;
  const rel = git(cwd, ['rev-parse', '--git-path', 'info/exclude']).out.trim();
  if (!rel) return false;
  const file = path.resolve(cwd, rel);
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text.split(/\r?\n/).includes(pattern)) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`);
    return true;
  } catch { return false; }
}

export function initRepo(cwd) {
  return git(cwd, ['init']).ok;
}

// MARK: - Turn snapshots (the Mac's «Restaurar a antes de este turno»)

function gitEnv(cwd, args, env, timeout = 60_000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20, windowsHide: true, env: { ...process.env, ...env } });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') || (r.error?.message ?? '') };
}

/** A throwaway index, seeded from the real one so unchanged files aren't hashed again. */
function withTempIndex(cwd, fn) {
  const real = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']).out.trim() || '.git/index');
  const tmp = path.join(os.tmpdir(), `relevo-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    try { fs.copyFileSync(real, tmp); } catch {}
    return fn({ GIT_INDEX_FILE: tmp });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * The working tree as a git tree object (tracked and new files; ignored ones left out), without touching
 * the real index, HEAD or any branch. Returns the tree id, or null outside a repository.
 */
export function snapshot(cwd) {
  if (!cwd || !isRepo(cwd)) return null;
  return withTempIndex(cwd, (env) => {
    if (!gitEnv(cwd, ['add', '-A', '--', '.'], env).ok) return null;
    const tree = gitEnv(cwd, ['write-tree'], env);
    return tree.ok ? tree.out.trim() : null;
  });
}

/** Puts the working tree back as it was in `tree`: files changed since are rewritten, new ones removed. */
export function restore(cwd, tree) {
  if (!isRepo(cwd)) throw new Error('Esta carpeta no es un repositorio git');
  if (!git(cwd, ['cat-file', '-t', tree]).ok) throw new Error('La instantánea ya no existe en el repositorio');
  const now = new Set(git(cwd, ['ls-files', '-co', '--exclude-standard', '-z']).out.split('\0').filter(Boolean));
  const then = new Set(git(cwd, ['ls-tree', '-r', '-z', '--name-only', tree]).out.split('\0').filter(Boolean));
  for (const f of now) if (!then.has(f)) fs.rmSync(path.join(cwd, f), { force: true });
  withTempIndex(cwd, (env) => {
    const read = gitEnv(cwd, ['read-tree', tree], env);
    if (!read.ok) throw new Error(read.err);
    const out = gitEnv(cwd, ['checkout-index', '-a', '-f'], env);
    if (!out.ok) throw new Error(out.err);
  });
  return { removed: [...now].filter((f) => !then.has(f)).length };
}

/** What changed between two snapshots (or a snapshot and the working tree now). */
export function changesBetween(cwd, before, after) {
  const target = after ?? snapshot(cwd);
  if (!target) return { files: [], diff: '' };
  const files = [];
  for (const line of git(cwd, ['diff', '--numstat', before, target]).out.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (m) files.push({ path: m[3], added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  let out = git(cwd, ['diff', '--no-color', before, target]).out;
  if (out.length > MAX_DIFF) out = `${out.slice(0, MAX_DIFF)}\n… (diff recortado)`;
  return { files, diff: out };
}

// MARK: - Worktrees

export const currentBranch = (cwd) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || null;

/** A new worktree on its own branch from the repository's current commit (the Mac's «hilo en un worktree»). */
/** A repository with at least one commit (what a worktree needs). */
export function hasCommits(cwd) {
  return isRepo(cwd) && git(cwd, ['rev-parse', '--verify', 'HEAD']).ok;
}

export function addWorktree(repo, dir, branch) {
  if (!isRepo(repo)) throw new Error('El proyecto no es un repositorio git');
  if (!git(repo, ['rev-parse', '--verify', 'HEAD']).ok) throw new Error('El repositorio aún no tiene ningún commit');
  const base = currentBranch(repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = git(repo, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  if (!r.ok) throw new Error(r.err.trim());
  return { path: dir, branch, base, repo };
}

/**
 * The same, without blocking the host: in a big repository (a game's) the checkout takes minutes. What a failed
 * or cut checkout left (its folder, its new branch) is taken away again: only what this call made.
 */
export async function addWorktreeAsync(repo, dir, branch, timeout = 20 * 60_000) {
  if (!isRepo(repo)) throw new Error('El proyecto no es un repositorio git');
  if (!git(repo, ['rev-parse', '--verify', 'HEAD']).ok) throw new Error('El repositorio aún no tiene ningún commit');
  const base = currentBranch(repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await gitAsync(repo, ['worktree', 'add', '-b', branch, dir, 'HEAD'], timeout);
  if (!r.ok) {
    await gitAsync(repo, ['worktree', 'remove', '--force', dir], 5 * 60_000);
    await gitAsync(repo, ['worktree', 'prune']);
    await gitAsync(repo, ['branch', '-D', branch]);
    throw new Error(`No se ha podido crear el worktree: ${r.out.split('\n').filter(Boolean).at(-1) ?? `git no respondió en ${Math.round(timeout / 60_000)} min`}`);
  }
  return { path: dir, branch, base, repo };
}

/** Commits what the worktree has and merges its branch into the base branch of the main folder. */
export async function mergeWorktree(wt, message) {
  if (status(wt.path).files.length) {
    const c = await commit(wt.path, { message: message || `Cambios de ${wt.branch}`, push: false });
    if (!c.ok) throw new Error(c.output);
  }
  const head = currentBranch(wt.repo);
  if (head !== wt.base) throw new Error(`La carpeta principal está en «${head}», no en «${wt.base}»: cámbiala de rama antes de fusionar`);
  const m = await gitAsync(wt.repo, ['merge', '--no-ff', '--no-edit', wt.branch]);
  if (!m.ok) {
    git(wt.repo, ['merge', '--abort']);
    throw new Error(`No se ha podido fusionar (conflictos o cambios sin commit en la carpeta principal):\n${m.out}`);
  }
  return m.out;
}

export function removeWorktree(wt, deleteBranch) {
  const r = git(wt.repo, ['worktree', 'remove', '--force', wt.path]);
  if (!r.ok && fs.existsSync(wt.path)) throw new Error(r.err.trim());
  git(wt.repo, ['worktree', 'prune']);
  if (deleteBranch) git(wt.repo, ['branch', '-D', wt.branch]);
}

// MARK: - Pull requests (GitHub CLI)

function gh(cwd, args, timeout = 60_000) {
  return new Promise((resolve) => {
    const p = spawn('gh', args, { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeout);
    p.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '', err: 'No encuentro GitHub CLI (gh) en el host' }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim(), err: err.trim() }); });
  });
}

/** The pull request of the current branch: state, review and checks; null when there's none. */
export async function pullRequest(cwd) {
  const r = await gh(cwd, ['pr', 'view', '--json', 'number,title,state,url,isDraft,reviewDecision,statusCheckRollup']);
  if (!r.ok) {
    if (/no pull requests found|no open pull requests/i.test(r.err)) return null;
    throw new Error(r.err || 'gh no ha respondido');
  }
  const pr = JSON.parse(r.out);
  const checks = { passed: 0, failed: 0, pending: 0 };
  for (const c of pr.statusCheckRollup ?? []) {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) checks.passed++;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(v)) checks.failed++;
    else checks.pending++;
  }
  return { number: pr.number, title: pr.title, state: pr.state, url: pr.url, draft: pr.isDraft, review: pr.reviewDecision || null, checks };
}

export async function createPullRequest(cwd) {
  const r = await gh(cwd, ['pr', 'create', '--fill'], 120_000);
  if (!r.ok) throw new Error(r.err || r.out);
  return r.out.split('\n').find((l) => l.startsWith('http')) ?? r.out;
}

/** The repository's worktrees (the main checkout included): [{ path, branch }]. */
export function worktrees(cwd) {
  if (!cwd || !isRepo(cwd)) return [];
  const out = git(cwd, ['worktree', 'list', '--porcelain']).out;
  const list = [];
  for (const block of out.split(/\n\n+/)) {
    const p = /^worktree (.+)$/m.exec(block)?.[1];
    if (!p) continue;
    list.push({ path: p, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? (/^detached$/m.test(block) ? '(detached)' : null) });
  }
  return list;
}

// MARK: - A team's task branches and worktrees

/**
 * The repository's branches and worktrees, for the team's tidy-up: the main checkout and its branch (`base`, where
 * work is integrated) and, for each local branch or worktree that `pick(branch, worktreePath|null)` accepts, how many commits it has
 * that the base hasn't (`ahead`), its worktree's folder if it has one (`missing` if that folder is gone) and when
 * it last changed. Only reads.
 */
export function taskRefs(cwd, pick) {
  if (!cwd || !isRepo(cwd)) return null;
  const out = git(cwd, ['worktree', 'list', '--porcelain']).out;
  const wts = [];
  for (const block of out.split(/\n\n+/)) {
    const p = /^worktree (.+)$/m.exec(block)?.[1];
    if (!p) continue;
    wts.push({ path: p, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null, missing: /^prunable/m.test(block) });
  }
  const main = wts[0];
  if (!main) return null;
  const base = main.branch;
  const items = new Map();
  for (const line of git(cwd, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)']).out.split('\n')) {
    const [branch, when] = line.split('\t');
    if (!branch || branch === base || !pick(branch, null)) continue;
    items.set(branch, { branch, path: null, when: Number(when) || null });
  }
  for (const w of wts.slice(1)) {
    if (!pick(w.branch ?? '', w.path)) continue;
    const key = w.branch ?? `@${w.path}`;
    items.set(key, { ...(items.get(key) ?? { branch: w.branch, when: null }), path: w.path, missing: w.missing || undefined });
  }
  // Integrated means in the main checkout's branch or in an integration branch (integration/me1): a team that
  // gathers its work there before it reaches main has its task branches integrated all the same.
  const heads = git(cwd, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']).out.split('\n').filter(Boolean);
  const targets = [...new Set([base, ...heads.filter((b) => /^integra(tion|cion|ción)\//i.test(b))].filter(Boolean))];
  for (const it of items.values()) {
    if (!it.branch || !targets.length) continue;
    let best = null;
    for (const t of targets) {
      const n = git(cwd, ['rev-list', '--count', `${t}..${it.branch}`]);
      if (n.ok && (best === null || Number(n.out.trim()) < best.n)) best = { n: Number(n.out.trim()) || 0, t };
    }
    it.ahead = best ? best.n : null;
    if (best && best.n === 0 && best.t !== base) it.into = best.t;
  }
  return { repo: main.path, base, integration: targets.filter((t) => t !== base), items: [...items.values()] };
}

/** How many files a worktree has changed and not committed (null if git can't tell). */
export async function dirtyCount(dir) {
  return (await leftovers(dir)).dirty;
}

/**
 * What a worktree has besides its commits: files changed or new (`dirty`, null if git can't tell) and what git
 * ignores (build outputs…), which `git worktree remove` would take away with the folder without asking.
 */
export async function leftovers(dir) {
  if (!dir || !fs.existsSync(dir)) return { dirty: 0, ignored: [] };
  const r = await gitAsync(dir, ['status', '--porcelain', '--ignored'], 5 * 60_000);
  if (!r.ok) return { dirty: null, ignored: [] };
  const lines = r.out.split('\n').filter(Boolean);
  return { dirty: lines.filter((l) => !l.startsWith('!! ')).length, ignored: lines.filter((l) => l.startsWith('!! ')).map((l) => l.slice(3)) };
}

/** A folder before taking it away: how many files, how big, the first and last ones (up to `cap` files). */
export async function folderStats(dir, cap = 300_000) {
  let files = 0, bytes = 0, capped = false;
  const all = [];
  const walk = async (d) => {
    let list = [];
    try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      if (files >= cap) { capped = true; return; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      files++;
      try { bytes += (await fs.promises.lstat(p)).size; } catch {}
      if (all.length < 5) all.push(p); else { all.push(p); if (all.length > 10) all.splice(5, 1); }
    }
  };
  await walk(dir);
  return { files, bytes, capped, first: all.slice(0, 5), last: files > 5 ? all.slice(5) : [] };
}

/**
 * Takes away a task's worktree and branch. Without `force`, only what git can take away without losing anything:
 * a clean worktree (git refuses otherwise) and a branch already merged (`branch -d`).
 */
export async function removeTaskRef(repo, { path: dir, branch, into }, { force = false } = {}) {
  // Merged into an integration branch, not the checked-out one: git's -d would refuse; -D after checking it here.
  const merged = !!into && git(repo, ['merge-base', '--is-ancestor', branch, into]).ok;
  const done = [];
  if (dir) {
    // Never the main checkout, a disk's root or a relative path: only a worktree git listed elsewhere.
    const abs = path.resolve(dir);
    if (!path.isAbsolute(dir) || abs === path.parse(abs).root || abs === path.resolve(repo) || /^\/(mnt\/[a-z]|home|Users)\/?$/i.test(abs)) return { ok: false, done, out: `No retiro ${dir}: no es un worktree` };
    const r = await gitAsync(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir], 10 * 60_000);
    if (!r.ok && fs.existsSync(dir)) return { ok: false, done, out: r.out };
    await gitAsync(repo, ['worktree', 'prune']);
    done.push(`worktree ${dir}`);
  }
  if (branch) {
    const r = await gitAsync(repo, ['branch', force || merged ? '-D' : '-d', branch]);
    if (!r.ok) return { ok: false, done, out: r.out };
    done.push(`rama ${branch}`);
  }
  return { ok: true, done };
}

/** Merges a branch into the base branch of the main checkout (which must be on it), without fast-forward. */
export async function mergeBranch(repo, base, branch, message) {
  const head = currentBranch(repo);
  if (head !== base) throw new Error(`La carpeta principal está en «${head}», no en «${base}»: cámbiala de rama antes de integrar`);
  const m = await gitAsync(repo, ['merge', '--no-ff', '-m', message || `Integra ${branch}`, branch]);
  if (!m.ok) {
    git(repo, ['merge', '--abort']);
    throw new Error(`No se ha podido fusionar (conflictos o cambios sin commit en la carpeta principal):\n${m.out}`);
  }
  return m.out;
}
