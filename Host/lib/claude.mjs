// Claude Code through its own CLI and OAuth login: `claude -p --input-format stream-json --output-format
// stream-json` with permission prompts over stdio, like ClaudeAgent.swift on the Mac.

import { spawnCLI, killTree } from './platform.mjs';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const CLI_MODE = { ask: 'manual', autoEdit: 'acceptEdits', full: 'bypassPermissions', plan: 'plan' };

export const WINDOW_LABELS = {
  five_hour: '5 h', session: '5 h', seven_day: 'Semana', weekly_all: 'Semana',
  seven_day_opus: 'Semana · Opus', seven_day_sonnet: 'Semana · Sonnet',
};

export function parseUsage(r) {
  const windows = [];
  for (const l of r.limits ?? []) {
    if (typeof l.percent !== 'number' || !l.kind) continue;
    let id = l.kind, label = WINDOW_LABELS[l.kind] ?? l.kind.replaceAll('_', ' ');
    if (l.kind === 'weekly_scoped') {
      const model = l.scope?.model?.display_name ?? 'modelo';
      id = `weekly_${model}`; label = `Semana · ${model}`;
    }
    windows.push({ id, label, percent: l.percent, resetsAt: toDate(l.resets_at) });
  }
  if (!windows.length && r.rate_limits) {
    for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      const w = r.rate_limits[key];
      if (w && typeof w.utilization === 'number') windows.push({ id: key, label: WINDOW_LABELS[key], percent: w.utilization, resetsAt: toDate(w.resets_at) });
    }
  }
  const plan = r.subscription_type ? r.subscription_type[0].toUpperCase() + r.subscription_type.slice(1) : null;
  return { windows, plan };
}

export function parseModels(r) {
  return (r.models ?? []).filter((m) => m.value).map((m) => {
    let name = m.displayName ?? m.value;
    if (m.value === 'default' && m.description) name = `Predeterminado (${m.description.split('·')[0].trim()})`;
    const efforts = m.supportedEffortLevels?.length ? m.supportedEffortLevels : null;
    return { id: m.value, name, detail: m.description ?? null, efforts };
  });
}

function toDate(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t / 1000;
}

// Specific phrases only: a bare "401", "quota" or "capacity" anywhere in a long stderr tail (a test log, a
// file the agent printed) mustn't mark the account signed out or out of quota.
const AUTH_RE = /not logged in|please run \/login|invalid api key|oauth token has expired|authentication_error|\b401\b[^\n]{0,40}unauthori[sz]ed|token (?:has been )?revoked/i;
const LIMIT_RE = /usage limit|rate[ _-]limit(?:ed| reached| exceeded|_error)|limit reached|out of extra usage|exceeded your (?:current )?quota|insufficient_quota|quota (?:exceeded|exhausted|reached)|individual quota|hit your [\w -]{0,20}limit|upgrade your subscription to increase your limits|resource[_ ]exhausted|\b429\b[^\n]{0,40}too many requests/i;

/** «Resets in 166h28m11s» / «resets in 2d 3h» → epoch seconds, or null. */
export function resetFromText(message, from = Date.now()) {
  const m = /resets? in\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?/i.exec(String(message ?? ''));
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const secs = (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return from / 1000 + secs;
}
const UNAVAILABLE_RE = /overloaded_error|\boverloaded\b|\b529\b|over capacity|capacity constraints/i;

export function classify(message) {
  const text = String(message ?? '').slice(-2000);
  if (AUTH_RE.test(text)) return 'auth';
  if (LIMIT_RE.test(text)) return 'limit';
  if (UNAVAILABLE_RE.test(text)) return 'unavailable';
  return 'other';
}

/** One-line summary of a tool call, as in the Mac's transcript. */
export function toolTitle(name, input = {}) {
  const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : '');
  switch (name) {
    case 'Bash': return input.description || input.command || 'Comando';
    case 'Read': return `Leer ${base(input.file_path)}`;
    case 'Write': return `Crear ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editar ${base(input.file_path)}`;
    case 'Glob': return `Buscar ${input.pattern ?? ''}`;
    case 'Grep': return `Buscar «${input.pattern ?? ''}»`;
    case 'WebFetch': return `Abrir ${input.url ?? ''}`;
    case 'WebSearch': return `Buscar en la web «${input.query ?? ''}»`;
    case 'Task': case 'Agent': return input.description || 'Subagente';
    case 'TodoWrite': return 'Plan';
    default: return name;
  }
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('\n');
  return content == null ? '' : JSON.stringify(content);
}

const cap = (s, n = 4000) => (s.length > n ? s.slice(0, n) + '\n…' : s);

/**
 * A Claude Code session for one thread. Events:
 * session(id) status(text) textDelta(key, text) textFinal(key, text) reasoningDelta(key, text)
 * toolStarted(key, name, title, input) toolFinished(key, ok, output) approval(request) notice(text)
 * failure({kind, message, resetsAt}) usage({windows, plan}) tokens(usage) context(used) turnStarted turnFinished exit
 */
export class ClaudeSession extends EventEmitter {
  constructor({ bin, cwd, env, model, effort, mode, resumeId, guarded = false }) {
    super();
    Object.assign(this, { bin, cwd, env, model, effort, mode, resumeId, guarded });
    this.proc = null;
    this.turnActive = false;
    this.streamed = new Set();
    this.pending = new Map();
    this.counter = 0;
    this.pendingLimit = null;
    this.cumulative = {};
    this.contextWindow = null;
    this.gotOutput = false;
    this.closed = false;
    this.lastActive = Date.now();
  }

  get alive() { return !!this.proc && !this.closed; }

  start() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', CLI_MODE[this._cliMode()] ?? 'manual',
      '--allow-dangerously-skip-permissions'];
    if (this.model && this.model !== 'default') args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.resumeId) args.push('--resume', this.resumeId);
    const proc = spawnCLI(this.bin, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.stderrTail = '';
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._line(line));
    proc.stderr.on('data', (d) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    proc.on('error', (e) => this._exit(-1, e.message));
    proc.on('exit', (code) => { if (this.proc === proc) this._exit(code ?? -1); });
    proc.stdin.on('error', () => {});
    this._control({ subtype: 'initialize' });
  }

  send(text) {
    if (!this.alive) this.start();
    this.turnActive = true;
    this.pendingLimit = null;
    this.lastActive = Date.now();
    this.emit('status', 'Claude está trabajando…');
    this._write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  interrupt() { if (this.alive) this._control({ subtype: 'interrupt' }); }

  setMode(mode) {
    this.mode = mode;
    if (this.alive) this._control({ subtype: 'set_permission_mode', mode: CLI_MODE[this._cliMode()] ?? 'manual' });
  }

  /** Full access under the guard: Claude asks for everything and Relevo answers at once, except what it holds for you. */
  _cliMode() { return this.mode === 'full' && this.guarded ? 'ask' : this.mode; }

  setModel(model) {
    this.model = model;
    if (this.alive) this._control({ subtype: 'set_model', model: model === 'default' ? null : model });
  }

  /** Effort is a launch flag: the next turn starts a new process resuming the same session. */
  setEffort(effort) {
    if (effort === this.effort) return;
    this.effort = effort;
    if (this.alive && !this.turnActive) this.close(true);
  }

  refreshUsage() {
    if (!this.alive) return;
    this._control({ subtype: 'get_usage' }, (r) => { if (r) this.emit('usage', parseUsage(r)); });
  }

  /** Stops the process; with `keepSession` the next send resumes the same conversation. */
  close(keepSession = false) {
    if (!keepSession) this.closed = true;
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.stdin.end(); } catch {} killTree(p); }
    for (const cb of this.pending.values()) cb(null, 'closed');
    this.pending.clear();
  }

  _write(obj) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _control(request, cb) {
    const id = `relevo-${++this.counter}`;
    if (cb) this.pending.set(id, cb);
    this._write({ type: 'control_request', request_id: id, request });
  }

  _respond(requestId, response) {
    this._write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  _line(line) {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    this.gotOutput = true;
    this.lastActive = Date.now();
    const sub = 'parent_tool_use_id' in o && o.parent_tool_use_id;
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init' && o.session_id) {
          this.resumeId = o.session_id;
          this.emit('session', o.session_id);
          // An init we didn't ask for: the CLI woke up by itself (a background task finished).
          if (!this.turnActive) { this.turnActive = true; this.emit('turnStarted', this.finishedTask ? `Terminó en segundo plano: ${this.finishedTask}. El agente retoma.` : null); }
          this.finishedTask = null;
        } else if (o.subtype === 'background_tasks_changed') {
          // Builds, emulators and monitors the agent left running: while any is alive it isn't really idle.
          const before = new Map((this.background ?? []).map((b) => [b.id, b]));
          this.background = (o.tasks ?? []).filter((x) => x.task_id).map((x) => ({
            id: x.task_id, description: x.description ?? x.task_type ?? 'tarea', startedAt: before.get(x.task_id)?.startedAt ?? Date.now() / 1000,
          }));
          this.emit('backgroundTasks', this.background);
        } else if (o.subtype === 'task_notification') {
          this.finishedTask = (this.background ?? []).find((b) => b.id === o.task_id)?.description ?? o.description ?? 'una tarea';
        } else if (o.subtype === 'api_retry') this.emit('status', 'Reintentando la llamada a la API…');
        else if (o.subtype === 'compact_boundary') this.emit('notice', 'Claude ha compactado el contexto');
        break;
      case 'stream_event': {
        const ev = o.event;
        if (sub || !ev) break;
        if (ev.type === 'message_start') this.messageId = ev.message?.id;
        else if (ev.type === 'content_block_delta') {
          const key = `${this.messageId ?? 'm'}:${ev.index ?? 0}`;
          if (ev.delta?.type === 'text_delta' && ev.delta.text) { this.streamed.add(this.messageId); this.emit('textDelta', key, ev.delta.text); }
          else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) this.emit('reasoningDelta', key, ev.delta.thinking);
        }
        break;
      }
      case 'assistant': {
        const m = o.message;
        if (!m) break;
        const u = m.usage;
        if (!sub && u) {
          const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          if (used) this.emit('context', used, this.contextWindow);
        }
        (m.content ?? []).forEach((block, i) => {
          if (block.type === 'text' && !sub && !this.streamed.has(m.id) && block.text) this.emit('textFinal', `${m.id}:final${i}`, block.text);
          if (block.type === 'tool_use') {
            const title = (sub ? '↳ ' : '') + toolTitle(block.name, block.input);
            this.emit('toolStarted', block.id, block.name, title, block.input);
          }
        });
        break;
      }
      case 'user':
        for (const block of o.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          this.emit('toolFinished', block.tool_use_id, !block.is_error, cap(flatten(block.content)));
        }
        break;
      case 'result': {
        this.turnActive = false;
        const failed = o.is_error || (o.subtype && o.subtype !== 'success');
        if (failed) {
          const text = o.result || (o.errors ?? []).join('\n') || `La ejecución terminó con error (${o.subtype}).`;
          const failure = { kind: classify(text), message: text, resetsAt: null };
          if (this.pendingLimit && failure.kind !== 'auth') { failure.kind = 'limit'; failure.resetsAt = this.pendingLimit.resetsAt; }
          this.emit('failure', failure);
        } else if (this.pendingLimit) this.emit('failure', this.pendingLimit);
        this.pendingLimit = null;
        this._tokens(o);
        this.emit('turnFinished');
        this.refreshUsage();
        break;
      }
      case 'rate_limit_event': {
        const info = o.rate_limit_info;
        if (!info) break;
        const windows = Object.entries(info.unifiedWindows ?? {})
          .filter(([, w]) => typeof w?.utilization === 'number')
          .map(([key, w]) => ({ id: key, label: WINDOW_LABELS[key] ?? key, percent: w.utilization * 100, resetsAt: toDate(w.resetsAt) }));
        if (windows.length) this.emit('usage', { windows, plan: null });
        if (info.status === 'rejected') {
          const type = WINDOW_LABELS[info.rateLimitType] ?? 'uso';
          this.pendingLimit = { kind: 'limit', message: `Has alcanzado el límite de ${type} de Claude.`, resetsAt: toDate(info.resetsAt) };
        }
        break;
      }
      case 'control_request':
        this._controlRequest(o);
        break;
      case 'control_response': {
        const r = o.response;
        const cb = r && this.pending.get(r.request_id);
        if (!cb) break;
        this.pending.delete(r.request_id);
        if (r.subtype === 'error') cb(null, r.error ?? 'error'); else cb(r.response ?? {}, null);
        break;
      }
    }
  }

  _controlRequest(o) {
    const rid = o.request_id, req = o.request ?? {};
    if (req.subtype !== 'can_use_tool') {
      this._write({ type: 'control_response', response: { subtype: 'error', request_id: rid, error: 'No soportado por Relevo' } });
      return;
    }
    const input = req.input ?? {};
    const key = req.tool_use_id ?? rid;
    if (req.tool_name === 'AskUserQuestion') {
      const questions = (input.questions ?? []).map((q) => ({
        question: q.question ?? '', header: q.header ?? null, multiSelect: !!q.multiSelect,
        options: (q.options ?? []).map((x) => ({ label: x.label ?? '', description: x.description ?? null })),
      }));
      this.emit('approval', {
        key, title: questions.length === 1 ? questions[0].question : `${questions.length} preguntas del agente`, detail: '',
        options: [{ id: 'deny', label: 'Omitir', isAllow: false }], questions,
        respond: (choice, answers) => {
          if (answers) this._respond(rid, { behavior: 'allow', updatedInput: { ...input, answers } });
          else this._respond(rid, { behavior: 'deny', message: 'El usuario ha preferido no responder a las preguntas.' });
        },
      });
      return;
    }
    const suggestions = req.permission_suggestions ?? [];
    const detail = [req.description, req.decision_reason, req.blocked_path && `Ruta: ${req.blocked_path}`].filter(Boolean).join('\n');
    const options = [{ id: 'allow', label: 'Permitir', isAllow: true }];
    if (suggestions.length) options.push({ id: 'session', label: 'Permitir en esta sesión', isAllow: true });
    options.push({ id: 'deny', label: 'Denegar', isAllow: false });
    this.emit('approval', {
      key, title: `${req.display_name ?? req.tool_name}: ${toolTitle(req.tool_name, input)}`, detail, options, questions: null, toolName: req.tool_name, input,
      respond: (choice) => {
        if (choice === 'allow') this._respond(rid, { behavior: 'allow', updatedInput: input });
        else if (choice === 'session') this._respond(rid, { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions.map((s) => ({ ...s, destination: 'session' })) });
        else this._respond(rid, { behavior: 'deny', message: 'El usuario ha denegado esta acción desde Relevo.' });
      },
    });
  }

  _tokens(o) {
    const all = o.modelUsage ?? {};
    let total = 0, cacheRead = 0, cost = 0, any = false;
    const source = o.model_usage_since_last_result ?? null;
    for (const [key, m] of Object.entries(source ?? all)) {
      const prev = source ? {} : (this.cumulative[key] ?? {});
      const d = (f) => (m[f] ?? 0) - (prev[f] ?? 0);
      const t = d('inputTokens') + d('cacheReadInputTokens') + d('cacheCreationInputTokens') + d('outputTokens');
      if (t > 0) any = true;
      total += t; cacheRead += d('cacheReadInputTokens'); cost += d('costUSD');
    }
    for (const [key, m] of Object.entries(all)) {
      this.cumulative[key] = { ...m };
      if (m.contextWindow) this.contextWindow = Math.max(this.contextWindow ?? 0, m.contextWindow);
    }
    if (any) this.emit('tokens', { tokens: total, cacheShare: total ? cacheRead / total : null, cost: cost || null });
  }

  _exit(code, error) {
    if (this.closed) return;
    const tail = (error ?? this.stderrTail ?? '').trim();
    this.proc = null;
    if (this.resumeId && (!this.gotOutput || /no conversation found/i.test(tail)) && code !== 0 && code !== null && code !== 143 && code !== -15) {
      this.emit('failure', { kind: 'sessionLost', message: 'No se pudo reanudar la sesión de Claude.', resetsAt: null });
      this.resumeId = null;
    } else if (this.turnActive) {
      const message = tail || `Claude Code terminó inesperadamente (código ${code}).`;
      this.emit('failure', { kind: classify(message), message: message.slice(-1200), resetsAt: null });
    }
    for (const cb of this.pending.values()) cb(null, 'exited');
    this.pending.clear();
    if (this.turnActive) { this.turnActive = false; this.emit('turnFinished'); }
    this.emit('exit', code);
  }
}

/** Login, plan, limits and models without a model call: `auth status` plus `get_usage`/`list_models`. */
export async function probe({ bin, env, cwd }) {
  const status = { loggedIn: null, email: null, plan: null, windows: [], error: null, models: null };
  const auth = await new Promise((resolve) => {
    const p = spawnCLI(bin, ['auth', 'status', '--json'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('exit', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    setTimeout(() => killTree(p), 15_000);
  });
  if (auth) {
    status.email = auth.email ?? null;
    if (auth.loggedIn === false) { status.loggedIn = false; status.error = 'Sin sesión: ejecuta «relevo-host login claude» en el host'; return status; }
  }
  await new Promise((resolve) => {
    const p = spawnCLI(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const answered = new Set();
    let tail = '';
    const done = () => { try { p.stdin.end(); } catch {} killTree(p); resolve(); };
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type !== 'control_response') return;
      const r = o.response, rid = r?.request_id;
      answered.add(rid);
      if (r.subtype === 'error') {
        if (rid === 'usage') { status.error = r.error ?? 'error'; if (AUTH_RE.test(status.error)) status.loggedIn = false; }
      } else if (rid === 'usage') {
        const u = parseUsage(r.response ?? {});
        Object.assign(status, { windows: u.windows, plan: u.plan, loggedIn: true });
      } else if (rid === 'models') {
        const list = parseModels(r.response ?? {});
        if (list.length) status.models = list;
      }
      if (answered.has('usage') && answered.has('models')) done();
    });
    p.stderr.on('data', (d) => { tail = (tail + d).slice(-500); });
    p.stdin.on('error', () => {});
    p.on('error', (e) => { status.error = e.message; resolve(); });
    p.on('exit', () => { if (!status.windows.length && !status.error && tail.trim()) status.error = tail.trim(); resolve(); });
    for (const [id, subtype] of [['init', 'initialize'], ['usage', 'get_usage'], ['models', 'list_models']]) {
      p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n');
    }
    setTimeout(() => { if (!status.windows.length && !status.error) status.error = 'Tiempo de espera agotado'; done(); }, 30_000);
  });
  return status;
}

/** Stand-in for tests (RELEVO_FAKE_AGENT=1): streams an echo and asks for a permission when told to. */
export class FakeSession extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.turnActive = false; this.lastActive = Date.now(); this.n = 0; this.closed = false; }
  get alive() { return !this.closed; }
  send(text) {
    this.closed = false; // like the real ones: a closed session starts again with the next message
    // Team instructions and the «[Orquestador · tarea]» header aren't echoed: the test drives what follows.
    text = text.replace(/^<relevo_equipo>[\s\S]*?<\/relevo_equipo>\s*/, '').replace(/^\[[^\]\n]+\]\n/, '');
    this.turnActive = true;
    const turn = ++this.n;
    this.emit('status', 'Agente de prueba trabajando…');
    if (!this.resumeId) { this.resumeId = `fake-${Date.now()}`; this.emit('session', this.resumeId); }
    const finish = () => {
      const reply = `Eco (${this.model}, ${this.mode}): ${text}`;
      const step = Math.max(8, Math.ceil(reply.length / 20)); // long prompts (handoffs) stream in ~20 chunks too
      let i = 0;
      const tick = setInterval(() => {
        if (!this.turnActive) { clearInterval(tick); return; }
        this.emit('textDelta', `t${turn}`, reply.slice(i, i + step));
        i += step;
        if (i >= reply.length) {
          clearInterval(tick);
          this.turnActive = false;
          this.emit('tokens', { tokens: 1234, cacheShare: 0.5, cost: 0.01 });
          this.emit('turnFinished');
        }
      }, 40);
    };
    // «agota la cuota» at the start (not inside a handoff, which quotes it): the quota runs out, as in a real limit.
    if (/^agota la cuota/i.test(text)) {
      setTimeout(() => {
        this.turnActive = false;
        this.emit('failure', { kind: 'limit', message: 'Has alcanzado el límite de uso (prueba).', resetsAt: Date.now() / 1000 + 3600 });
        this.emit('turnFinished');
      }, 100);
      return;
    }
    // «temporizador …»: says it (orders included) and then waits on a 12 s timer, unless interrupted.
    if (/^temporizador/i.test(text)) {
      this.emit('textDelta', `t${turn}`, `Eco (${this.model}, ${this.mode}): ${text}`);
      this.emit('toolStarted', `sched${turn}`, 'schedule', 'schedule', { prompt: text.replace(/<relevo:[\s\S]*$/, '').trim() });
      setTimeout(() => {
        if (!this.turnActive || this.n !== turn) return;
        this.emit('toolFinished', `sched${turn}`, true, '');
        this.turnActive = false;
        this.emit('turnFinished');
      }, 12_000);
      return;
    }
    // «segundo plano»: leaves a job running and ends the turn; when it ends, wakes up and reports.
    if (/^segundo plano/i.test(text)) {
      setTimeout(() => {
        this.emit('backgroundTasks', [{ id: `job${turn}`, description: 'compilación de prueba', startedAt: Date.now() / 1000 }]);
        this.emit('textDelta', `t${turn}`, 'ESTADO: esperando\nLa compilación sigue en segundo plano.');
        this.turnActive = false;
        this.emit('turnFinished');
        setTimeout(() => {
          this.emit('backgroundTasks', []);
          this.turnActive = true;
          this.emit('turnStarted', 'Terminó en segundo plano: compilación de prueba. El agente retoma.');
          this.emit('textDelta', `r${turn}`, 'ESTADO: hecho\nCompilación terminada sin errores.');
          this.emit('tokens', { tokens: 100, cacheShare: 0.5, cost: 0 });
          this.turnActive = false;
          this.emit('turnFinished');
        }, 1500);
      }, 100);
      return;
    }
    if (/^pregunta/i.test(text)) {
      this.emit('approval', {
        key: `q${turn}`, title: 'El agente pregunta', detail: null,
        questions: [{ question: '¿Qué color prefieres?', header: 'Color', options: [{ label: 'Rojo', description: 'Cálido' }, { label: 'Azul' }], multiSelect: false }],
        options: [], respond: () => finish(),
      });
      return;
    }
    // «borra todo»: a destructive command the guard must hold for you.
    if (/^borra todo/i.test(text)) {
      this.emit('toolStarted', `tool${turn}`, 'Bash', 'rm -rf build', { command: 'rm -rf build' });
      this.emit('approval', {
        key: `tool${turn}`, title: 'Bash: rm -rf build', detail: null, questions: null, toolName: 'Bash', input: { command: 'rm -rf build' },
        options: [{ id: 'allow', label: 'Permitir', isAllow: true }, { id: 'deny', label: 'Denegar', isAllow: false }],
        respond: (choice) => { this.emit('toolFinished', `tool${turn}`, choice === 'allow', choice === 'allow' ? 'borrado' : 'Denegado'); finish(); },
      });
      return;
    }
    if (/permiso/i.test(text) && !text.includes('<relevo_handoff>')) {
      this.emit('toolStarted', `tool${turn}`, 'Bash', 'echo hola', { command: 'echo hola' });
      this.emit('approval', {
        key: `tool${turn}`, title: 'Bash: echo hola', detail: 'Prueba de permiso', questions: null, toolName: 'Bash', input: { command: 'echo hola' },
        options: [{ id: 'allow', label: 'Permitir', isAllow: true }, { id: 'deny', label: 'Denegar', isAllow: false }],
        respond: (choice) => { this.emit('toolFinished', `tool${turn}`, choice === 'allow', choice === 'allow' ? 'hola' : 'Denegado'); finish(); },
      });
    } else setTimeout(finish, 100);
  }
  interrupt() { if (this.turnActive) { this.turnActive = false; this.emit('turnFinished'); } }
  setMode(m) { this.mode = m; }
  setModel(m) { this.model = m; }
  setEffort(e) { this.effort = e; }
  refreshUsage() {}
  close() { this.closed = true; }
}

export function fakeProbe() {
  return { loggedIn: true, email: 'prueba@relevo', plan: 'Prueba', error: null,
    windows: [{ id: 'five_hour', label: '5 h', percent: 12, resetsAt: Date.now() / 1000 + 3600 }],
    models: [{ id: 'default', name: 'Predeterminado', detail: null, efforts: null }, { id: 'haiku', name: 'Haiku', detail: null, efforts: null }] };
}
