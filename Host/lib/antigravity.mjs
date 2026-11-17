// Gemini through Google's Antigravity CLI (`agy`), like AntigravityAgent.swift on the Mac: one process per
// turn (`agy -p … --output-format stream-json --conversation <id>`), limits from `agy -p=/usage`, models from
// `agy models`. agy is told it runs over SSH, so it keeps its Google login in a file
// (.gemini/antigravity-cli/antigravity-oauth-token) instead of the keychain and never opens the browser.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { spawnCLI, killTree, isWindows } from './platform.mjs';
import { classify } from './claude.mjs';

export const NO_KEYCHAIN = { SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', RELEVO_AGY_NO_KEYCHAIN: '1' };
const AUTH_MARKER = /Authentication required|sign in|not logged in/i;
const cap = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 1));

export const tokenFile = (home) => path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

/**
 * The environment for an account: its own HOME when isolated (a second Google login), with the user's git
 * identity copied in so commands the agent runs still commit as them.
 */
export function antigravityEnv(baseEnv, home, isolated) {
  const env = { ...baseEnv, ...NO_KEYCHAIN };
  if (!isolated) return env;
  fs.mkdirSync(home, { recursive: true });
  for (const name of ['.gitconfig']) {
    const src = path.join(os.homedir(), name);
    try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(home, name)); } catch {}
  }
  env.HOME = home;
  if (isWindows) env.USERPROFILE = home;
  return env;
}

/** One agy run at a time per HOME for probes: two refreshing an expired token at once corrupt the login. */
const locks = new Map();
function withLock(home, fn) {
  const prev = locks.get(home) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(home, run.catch(() => {}));
  return run;
}

function runOnce(bin, args, { env, cwd, timeout = 40_000 }) {
  return new Promise((resolve) => {
    const p = spawnCLI(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', signedOut = false;
    p.stdout.on('data', (d) => { out += d; if (AUTH_MARKER.test(d)) { signedOut = true; killTree(p); } });
    p.stderr.on('data', (d) => { err += d; if (AUTH_MARKER.test(d)) { signedOut = true; killTree(p); } });
    const timer = setTimeout(() => killTree(p), timeout);
    p.on('error', (e) => { clearTimeout(timer); resolve({ out, err: e.message, code: -1, signedOut }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code, signedOut }); });
  });
}

/** `agy -p=/usage`: "<group>\t<label>\t<remaining>%\t<reset ISO>" per line. */
export function parseUsage(out) {
  const windows = [];
  for (const line of out.split('\n')) {
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length < 3) continue;
    const remaining = Number(cols[2].replace('%', ''));
    if (Number.isNaN(remaining)) continue;
    const group = cols[0].replace(/ models/i, '').replace(' and ', '/');
    const kind = cols[1].toLowerCase();
    const period = kind.includes('week') ? 'sem.' : kind.includes('5') || kind.includes('hour') ? '5 h' : kind.includes('day') ? 'día' : '';
    const label = period === 'sem.' || !period ? group : `${group} ${period}`;
    const reset = cols[3] ? Date.parse(cols[3]) : NaN;
    windows.push({ id: cols[0] + cols[1], label, percent: Math.max(0, Math.min(100, 100 - remaining)),
      resetsAt: Number.isNaN(reset) ? null : reset / 1000, detail: period === 'sem.' ? 'límite semanal' : cols[1] });
  }
  return windows;
}

export function parseModels(out) {
  const models = [];
  for (const line of out.split('\n')) {
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length >= 2 && cols[0] && !cols[0].includes(' ')) models.push({ id: cols[0], name: cols[1], efforts: ['low', 'medium', 'high'] });
  }
  return models;
}

function emailFrom(home) {
  try {
    const o = JSON.parse(fs.readFileSync(tokenFile(home), 'utf8'));
    const direct = o.id_token_email ?? o.token?.id_token_email;
    if (direct) return direct;
    const jwt = o.id_token ?? o.token?.id_token;
    if (jwt) return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).email ?? null;
  } catch {}
  return null;
}

/** Limits and models without a model call. */
export async function antigravityProbe({ bin, env, cwd, home }) {
  return withLock(home, async () => {
    const usage = await runOnce(bin, ['-p=/usage'], { env, cwd });
    if (usage.signedOut) return { loggedIn: false, windows: [], error: 'Inicia sesión en Antigravity' };
    const status = { loggedIn: true, plan: 'Antigravity', email: emailFrom(home), windows: parseUsage(usage.out), error: null };
    if (!status.windows.length) {
      const e = `${usage.err}${usage.out}`.trim();
      if (AUTH_MARKER.test(e) || classify(e) === 'auth') return { loggedIn: false, windows: [], error: 'Inicia sesión en Antigravity' };
      status.error = e ? e.slice(-200) : 'No se pudo leer el uso';
    }
    const models = await runOnce(bin, ['models'], { env, cwd });
    const list = parseModels(models.out);
    if (list.length) status.models = [{ id: 'default', name: 'Predeterminado' }, ...list];
    return status;
  });
}

export class AntigravitySession extends EventEmitter {
  constructor({ bin, cwd, env, model, effort, mode, resumeId }) {
    super();
    Object.assign(this, { bin, cwd, env, model: model === 'default' ? '' : model, effort, mode, conversationId: resumeId });
    this.resumed = !!resumeId;
    this.proc = null;
    this.turn = 0;
    this.turnActive = false;
    this.closed = false;
    this.lastActive = Date.now();
    this.nonce = Math.random().toString(36).slice(2, 6);
  }

  get alive() { return !this.closed; }

  send(prompt, skipPermissions = this.mode === 'full') {
    this.turn++;
    this.turnActive = true;
    this.failed = false;
    this.streamed = new Set();
    this.anyText = false;
    this.lastActive = Date.now();
    this.emit('status', 'Gemini está trabajando…');
    const args = ['--output-format', 'stream-json'];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.mode === 'autoEdit') args.push('--mode', 'accept-edits');
    if (this.mode === 'plan') args.push('--mode', 'plan');
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (this.conversationId) args.push('--conversation', this.conversationId);
    args.push(`-p=${prompt}`);
    const p = spawnCLI(this.bin, args, { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    let tail = '';
    p.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
    readline.createInterface({ input: p.stdout }).on('line', (line) => this._line(line));
    p.on('error', (e) => { tail = e.message; });
    p.on('close', (code) => { if (this.proc === p) this._exited(code, tail.trim()); });
  }

  _key(step) { return `${this.nonce}-${this.turn}-${step}`; }

  _fail(kind, message) {
    if (this.failed) return;
    this.failed = true;
    this.emit('failure', { kind, message, resetsAt: null });
  }

  _line(line) {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.event === 'init' && o.conversation_id && o.conversation_id !== this.conversationId) {
      this.conversationId = o.conversation_id;
      this.emit('session', o.conversation_id);
    } else if (o.event === 'step_update' && o.step_update) {
      this._step(o.step_update);
    } else if (o.event === 'result' && o.result) {
      const r = o.result;
      if (r.conversation_id && r.conversation_id !== this.conversationId) { this.conversationId = r.conversation_id; this.emit('session', r.conversation_id); }
      if (!this.anyText && r.response?.trim()) this.emit('textFinal', this._key(999), r.response.trim());
      if (r.status === 'ERROR' || r.error) {
        const message = r.error ?? 'Antigravity devolvió un error.';
        if (this.turn === 1 && this.resumed && /not found|conversation.*invalid/i.test(message)) this._fail('sessionLost', message);
        else this._fail(AUTH_MARKER.test(message) ? 'auth' : classify(message), message);
      }
      const u = r.usage;
      if (u) {
        const tokens = u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0));
        if (tokens) this.emit('tokens', { tokens, cacheShare: u.input_tokens ? (u.cache_read_tokens ?? 0) / u.input_tokens : null, cost: null });
      }
      this.turnActive = false;
      this.emit('turnFinished');
      const denied = r.denied_actions ?? [];
      if (denied.length) this._offerRetry(denied);
    }
  }

  _step(s) {
    const index = s.step_index ?? 0;
    const state = s.state ?? '';
    if (s.step_type === 'agent_response') {
      if (s.text_delta) { this.streamed.add(index); this.anyText = true; this.emit('textDelta', this._key(index), s.text_delta); }
      else if (state === 'DONE' && !this.streamed.has(index) && s.text) { this.anyText = true; this.emit('textFinal', this._key(index), s.text); }
    } else if (s.step_type === 'tool') {
      const info = s.tool_info ?? {};
      const name = s.tool_name ?? info.name ?? 'herramienta';
      const params = info.parameters ?? null;
      const title = params?.command ?? params?.path ?? params?.file_path ?? name;
      const k = this._key(index);
      this.emit('toolStarted', k, name, String(title), params);
      if (state === 'DONE') this.emit('toolFinished', k, true, cap(text(info.output ?? info.result ?? s.output ?? '')));
      else if (state === 'ERROR' || state === 'CANCELED') this.emit('toolFinished', k, false, info.error?.message ?? 'Error');
    } else if (s.text_delta) {
      this.emit('reasoningDelta', this._key(index), s.text_delta);
    }
  }

  /** Headless agy denies what needs a permission: offer to run the step again with it. */
  _offerRetry(denied) {
    const names = [...new Set(denied.map((d) => d.display_name ?? d.action ?? 'acción'))].join(', ');
    this.emit('approval', {
      key: `retry-${this.nonce}-${this.turn}`, title: `Gemini necesita permiso para: ${names}`,
      detail: 'Antigravity no puede preguntar en modo headless y denegó la acción. Puedes permitirla y reintentar este paso.',
      questions: null,
      options: [{ id: 'retry', label: 'Permitir y reintentar', isAllow: true }, { id: 'deny', label: 'Ignorar', isAllow: false }],
      respond: (choice) => {
        if (choice === 'retry') { this.emit('turnStarted'); this.send(`Te concedo el permiso para la acción que se denegó (${names}). Hazla ahora y continúa con la tarea.`, true); }
      },
    });
  }

  _exited(code, tail) {
    this.proc = null;
    if (this.closed) return;
    if (code !== 0 && code !== 2 && code !== 15 && code !== null && !this.failed) {
      const message = tail || `Antigravity terminó con código ${code}.`;
      this._fail(AUTH_MARKER.test(message) ? 'auth' : classify(message), message.slice(-1200));
    }
    if (this.turnActive) { this.turnActive = false; this.emit('turnFinished'); }
  }

  interrupt() { if (this.proc) killTree(this.proc); }
  setModel(model) { this.model = model === 'default' ? '' : model; }
  setMode(mode) { this.mode = mode; }
  setEffort(effort) { this.effort = effort; }
  refreshUsage() {}
  close(keepSession = false) {
    if (!keepSession) this.closed = true;
    if (this.proc) killTree(this.proc);
    this.proc = null;
  }
}
