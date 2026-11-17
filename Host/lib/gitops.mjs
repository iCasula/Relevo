// Git for a thread's project, as the Mac's Git menu does it: what changed (files, +/− and diffs), commit,
// commit and push, and the work state an agent receives in a handoff. Plain `git` from PATH.

import fs from 'node:fs';
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

export function initRepo(cwd) {
  return git(cwd, ['init']).ok;
}
