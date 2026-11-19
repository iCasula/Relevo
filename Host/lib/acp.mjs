// Agent Client Protocol (JSON-RPC 2.0 over stdio), like ACPAgent.swift on the Mac: any ACP agent — Gemini CLI
// (`gemini --experimental-acp`) or another — with the same events as ClaudeSession.

import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { spawnCLI, killTree } from './platform.mjs';
import { classify } from './claude.mjs';

const MODE_KEYWORDS = {
  ask: ['default', 'ask every', 'manual', 'ask'],
  autoEdit: ['when needed', 'yolo', 'accept', 'edit'],
  full: ['never ask', 'auto', 'bypass', 'full'],
  plan: ['plan'],
};
const cap = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 1));

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flatten).join('\n');
  if (content?.type === 'text') return content.text ?? '';
  if (content?.content) return flatten(content.content);
  return content == null ? '' : text(content);
}

class RPC extends EventEmitter {
  constructor(bin, args, { cwd, env }) {
    super();
    this.next = 1;
    this.pending = new Map();
    this.tail = '';
    this.proc = spawnCLI(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.proc.stderr.on('data', (d) => { this.tail = (this.tail + d).slice(-4000); });
    this.proc.on('error', (e) => { this.tail = e.message; });
    this.proc.on('exit', (code) => {
      for (const cb of this.pending.values()) cb({ message: this.tail.trim() || `terminó (código ${code})` }, null);
      this.pending.clear();
      this.emit('exit', code, this.tail.trim());
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.method && o.id != null) this.emit('request', o.id, o.method, o.params ?? {});
      else if (o.method) this.emit('notification', o.method, o.params ?? {});
      else if (o.id != null) {
        const cb = this.pending.get(o.id);
        this.pending.delete(o.id);
        cb?.(o.error ?? null, o.result ?? null);
      }
    });
  }
  _send(o) { if (this.proc.stdin.writable) this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`); }
  request(method, params) {
    const id = this.next++;
    return new Promise((resolve) => { this.pending.set(id, (error, result) => resolve({ error, result })); this._send({ id, method, params }); });
  }
  notify(method, params) { this._send({ method, params }); }
  respond(id, result) { this._send({ id, result }); }
  respondError(id, message) { this._send({ id, error: { code: -32601, message } }); }
  kill() { try { this.proc.stdin.end(); } catch {} killTree(this.proc); }
}

export class ACPSession extends EventEmitter {
  constructor({ bin, args = [], cwd, env, model, mode, resumeId, agentName = 'El agente', loginHint, guarded = false }) {
    super();
    Object.assign(this, { bin, args, cwd, env, model: model === 'default' ? '' : model, mode, resumeId, agentName, loginHint, guarded });
    this.rpc = null;
    this.sessionId = null;
    this.ready = false;
    this.queued = [];
    this.turnActive = false;
    this.closed = false;
    this.counter = 0;
    this.lastKind = null;
    this.modes = [];
    this.modelConfigId = null;
    this.loadSupported = false;
    this.loading = false;
    this.lastActive = Date.now();
    this.nonce = Math.random().toString(36).slice(2, 6);
  }

  get alive() { return !!this.rpc && !this.closed; }

  _start() {
    const rpc = new RPC(this.bin, this.args, { cwd: this.cwd, env: this.env });
    this.rpc = rpc;
    this.ready = false;
    rpc.on('notification', (method, params) => this._notification(method, params));
    rpc.on('request', (id, method, params) => this._request(id, method, params));
    rpc.on('exit', (code, tail) => { if (this.rpc === rpc) this._exited(code, tail); });
    this.emit('status', `Conectando con ${this.agentName}…`);
    rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'relevo', title: 'Relevo', version: '1.0' },
    }).then(({ error, result }) => {
      if (error) { this._fail('other', `${this.agentName} no arrancó: ${error.message}`); return; }
      this.loadSupported = !!result?.agentCapabilities?.loadSession;
      this._openSession();
    });
  }

  _isAuth(e) { return /auth/i.test(e?.message ?? '') || classify(e?.message) === 'auth'; }

  async _openSession() {
    const base = { cwd: this.cwd, mcpServers: [] };
    if (this.resumeId && this.loadSupported) {
      this.loading = true;
      const { error, result } = await this.rpc.request('session/load', { ...base, sessionId: this.resumeId });
      this.loading = false;
      if (!error) { this._ready(this.resumeId, result); return; }
      if (this._isAuth(error)) { this._fail('auth', this.loginHint ?? error.message); return; }
      this.emit('failure', { kind: 'sessionLost', message: `No se pudo reanudar la sesión: ${error.message}` });
      this.resumeId = null;
    } else if (this.resumeId) {
      this.emit('failure', { kind: 'sessionLost', message: `${this.agentName} no permite reanudar sesiones.` });
      this.resumeId = null;
    }
    const { error, result } = await this.rpc.request('session/new', base);
    if (error || !result?.sessionId) {
      const auth = this._isAuth(error);
      this._fail(auth ? 'auth' : classify(error?.message ?? ''), auth ? this.loginHint ?? error.message : error?.message ?? `Respuesta inesperada de ${this.agentName}`);
      return;
    }
    this._ready(result.sessionId, result);
  }

  _ready(id, info) {
    this.sessionId = id;
    this.ready = true;
    this.emit('session', id);
    let models = (info?.models?.availableModels ?? []).filter((m) => m.modelId).map((m) => ({ id: m.modelId, name: m.name ?? m.modelId, detail: m.description ?? null }));
    if (!models.length) {
      const option = (info?.configOptions ?? []).find((o) => /model/i.test(o.id ?? ''));
      if (option) {
        this.modelConfigId = option.id;
        models = (option.options ?? []).map((o) => ({ id: o.value ?? o.id, name: o.name ?? o.label ?? o.value ?? o.id, detail: o.description ?? null })).filter((m) => m.id);
      }
    }
    if (models.length) this.emit('models', [{ id: 'default', name: 'Predeterminado' }, ...models]);
    this.modes = (info?.modes?.availableModes ?? []).filter((m) => m.id).map((m) => ({ id: m.id, name: `${m.name ?? m.id} ${m.description ?? ''}`.toLowerCase() }));
    this._applyMode();
    this._applyModel();
    const pending = this.queued;
    this.queued = [];
    for (const p of pending) this._prompt(p);
  }

  _applyMode() {
    if (!this.sessionId || !this.modes.length) return;
    // Under the guard, full access asks (and Relevo answers at once, except what it holds for you).
    for (const k of MODE_KEYWORDS[this.mode === 'full' && this.guarded ? 'autoEdit' : this.mode] ?? []) {
      const m = this.modes.find((x) => x.id.toLowerCase().includes(k) || x.name.includes(k));
      if (m) { this.rpc?.request('session/set_mode', { sessionId: this.sessionId, modeId: m.id }); return; }
    }
  }

  _applyModel() {
    if (!this.sessionId || !this.model) return;
    if (this.modelConfigId) this.rpc?.request('session/set_config_option', { sessionId: this.sessionId, configId: this.modelConfigId, value: this.model });
    else this.rpc?.request('session/set_model', { sessionId: this.sessionId, modelId: this.model });
  }

  send(prompt) {
    if (!this.alive) this._start();
    this.turnActive = true;
    this.lastActive = Date.now();
    this.emit('status', `${this.agentName} está trabajando…`);
    if (this.ready) this._prompt(prompt); else this.queued.push(prompt);
  }

  async _prompt(prompt) {
    this.turnActive = true;
    this.counter++;
    this.lastKind = null;
    const { error, result } = await this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] });
    if (error) {
      const message = `${error.message} ${text(error.data)}`.trim();
      this.emit('failure', { kind: this._isAuth(error) ? 'auth' : classify(message), message: error.message, resetsAt: null });
    } else {
      const u = result?.usage;
      if (u) {
        const tokens = u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.thoughtTokens ?? 0));
        if (tokens) this.emit('tokens', { tokens, cacheShare: u.inputTokens ? (u.cachedReadTokens ?? 0) / u.inputTokens : null, cost: null });
      }
      if (result?.stopReason === 'refusal') this.emit('notice', `${this.agentName} rechazó la petición`);
      if (result?.stopReason === 'max_tokens') this.emit('notice', 'Se alcanzó el máximo de tokens');
    }
    this.turnActive = false;
    this.lastActive = Date.now();
    this.emit('turnFinished');
  }

  interrupt() { if (this.sessionId) this.rpc?.notify('session/cancel', { sessionId: this.sessionId }); }
  setMode(mode) { this.mode = mode; this._applyMode(); }
  setModel(model) { this.model = model === 'default' ? '' : model; this._applyModel(); }
  setEffort() {}
  refreshUsage() {}

  close(keepSession = false) {
    if (!keepSession) this.closed = true;
    const rpc = this.rpc;
    this.rpc = null;
    this.ready = false;
    rpc?.kill();
  }

  _fail(kind, message) {
    this.emit('failure', { kind, message, resetsAt: null });
    if (this.turnActive) { this.turnActive = false; this.emit('turnFinished'); }
  }

  _key(s) { return `${this.nonce}-${s}`; }

  _notification(method, params) {
    const u = params?.update;
    if (method !== 'session/update' || this.loading || !u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (this.lastKind !== 'message') this.counter++;
        this.lastKind = 'message';
        if (u.content?.text) this.emit('textDelta', this._key(`msg${this.counter}`), u.content.text);
        break;
      case 'agent_thought_chunk':
        if (this.lastKind !== 'thought') this.counter++;
        this.lastKind = 'thought';
        if (u.content?.text) this.emit('reasoningDelta', this._key(`th${this.counter}`), u.content.text);
        break;
      case 'tool_call': {
        this.lastKind = 'tool';
        if (!u.toolCallId) break;
        const title = u.title ?? 'Herramienta';
        this.emit('toolStarted', this._key(u.toolCallId), u.kind ?? title, title, u.rawInput ?? null);
        if (u.status === 'completed' || u.status === 'failed') this.emit('toolFinished', this._key(u.toolCallId), u.status !== 'failed', this._toolContent(u));
        break;
      }
      case 'tool_call_update': {
        this.lastKind = 'tool';
        if (!u.toolCallId) break;
        const output = this._toolContent(u);
        if (u.status === 'completed' || u.status === 'failed') this.emit('toolFinished', this._key(u.toolCallId), u.status !== 'failed', output);
        else if (output) this.emit('toolOutput', this._key(u.toolCallId), output);
        break;
      }
      default: break;
    }
  }

  _toolContent(u) {
    const parts = (u.content ?? []).map((c) => (c.type === 'content' ? flatten(c.content) : c.type === 'diff' ? `── ${c.path ?? ''}\n${c.newText ?? ''}` : null)).filter(Boolean);
    if (!parts.length && u.rawOutput != null) return cap(text(u.rawOutput));
    return parts.length ? cap(parts.join('\n')) : null;
  }

  _request(id, method, params) {
    if (method !== 'session/request_permission') { this.rpc?.respondError(id, `Relevo no implementa ${method}`); return; }
    const tool = params.toolCall ?? {};
    const options = (params.options ?? []).filter((o) => o.optionId).map((o) => ({ id: o.optionId, label: o.name ?? o.optionId, isAllow: String(o.kind ?? '').startsWith('allow') }));
    this.emit('approval', {
      key: tool.toolCallId ? this._key(tool.toolCallId) : `${Date.now()}`,
      title: tool.title ?? `${this.agentName} quiere usar una herramienta`,
      detail: tool.rawInput != null ? text(tool.rawInput).slice(0, 1500) : '',
      questions: null, toolName: tool.kind ?? 'acp', input: tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput : null, text: [tool.title, typeof tool.rawInput === 'string' ? tool.rawInput : ''].filter(Boolean).join(' '),
      options: options.length ? options : [{ id: 'cancel', label: 'Cancelar', isAllow: false }],
      respond: (choice) => {
        const outcome = choice === 'cancel' || choice === 'deny' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: choice };
        this.rpc?.respond(id, { outcome });
      },
    });
  }

  _exited(code, tail) {
    if (this.closed) return;
    this.rpc = null;
    this.ready = false;
    if (this.turnActive || (code !== 0 && code !== null)) {
      const message = tail || `${this.agentName} terminó inesperadamente (código ${code}).`;
      this._fail(classify(message), message.slice(-1200));
    }
  }
}

/** ACP agents don't report quotas: signed in until a turn says otherwise. */
export async function acpProbe() {
  return { loggedIn: null, windows: [], note: 'Este agente no informa de su cuota', error: null };
}
