// Codex through its own CLI and ChatGPT login: `codex app-server` (JSON-RPC over stdio), like CodexAgent.swift
// on the Mac. Same events as ClaudeSession, so the host treats both alike.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { classify } from './claude.mjs';

const APPROVAL = { ask: 'untrusted', autoEdit: 'on-request', plan: 'on-request', full: 'never' };
const SANDBOX = { ask: 'workspace-write', autoEdit: 'workspace-write', plan: 'read-only', full: 'danger-full-access' };
const SANDBOX_POLICY = { ask: { type: 'workspaceWrite' }, autoEdit: { type: 'workspaceWrite' }, plan: { type: 'readOnly' }, full: { type: 'dangerFullAccess' } };
const CLIENT_INFO = { clientInfo: { name: 'relevo', title: 'Relevo', version: '1.0' } };

const cap = (s, n = 4000) => (s.length > n ? s.slice(0, n) + '\n…' : s);

function toDate(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t / 1000;
}

function windowLabel(minutes) {
  if (minutes >= 10_000 && minutes <= 10_100) return 'Semana';
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export function codexWindows(rl = {}) {
  const out = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (!w || typeof w.usedPercent !== 'number') continue;
    out.push({ id: key, label: windowLabel(w.windowDurationMins ?? (key === 'primary' ? 300 : 10080)), percent: w.usedPercent, resetsAt: toDate(w.resetsAt) });
  }
  return out;
}

const planName = (p) => (p ? p[0].toUpperCase() + p.slice(1) : null);

/** Line-delimited JSON-RPC without the "jsonrpc" field, as `codex app-server` speaks it. */
class RPC extends EventEmitter {
  constructor(bin, cwd, env) {
    super();
    this.next = 1;
    this.pending = new Map();
    this.tail = '';
    this.proc = spawn(bin, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.proc.stderr.on('data', (d) => { this.tail = (this.tail + d).slice(-4000); });
    this.proc.on('error', (e) => { this.tail = e.message; });
    this.proc.on('exit', (code) => {
      for (const cb of this.pending.values()) cb({ message: this.tail.trim() || `codex terminó (código ${code})` }, null);
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
        if (cb) cb(o.error ?? null, o.result ?? null);
      }
    });
  }
  _send(obj) { if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  request(method, params) {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, (error, result) => resolve({ error, result }));
      this._send(params === undefined ? { id, method } : { id, method, params });
    });
  }
  notify(method, params) { this._send(params === undefined ? { method } : { method, params }); }
  respond(id, result) { this._send({ id, result }); }
  respondError(id, message) { this._send({ id, error: { code: -32601, message } }); }
  kill() { try { this.proc.stdin.end(); } catch {} this.proc.kill('SIGTERM'); }
}

export class CodexSession extends EventEmitter {
  constructor({ bin, cwd, env, model, effort, mode, resumeId }) {
    super();
    Object.assign(this, { bin, cwd, env, model: model === 'default' ? '' : model, effort, mode, resumeId });
    this.rpc = null;
    this.threadId = null;
    this.turnId = null;
    this.ready = false;
    this.queued = [];
    this.turnActive = false;
    this.closed = false;
    this.reported = false;
    this.lastActive = Date.now();
    this.latestTotal = null;
    this.baseline = null;
  }

  get alive() { return !!this.rpc && !this.closed; }

  async start() {
    const rpc = new RPC(this.bin, this.cwd, this.env);
    this.rpc = rpc;
    this.ready = false;
    rpc.on('notification', (m, p) => { if (this.rpc === rpc) this._notification(m, p); });
    rpc.on('request', (id, m, p) => { if (this.rpc === rpc) this._request(id, m, p); });
    rpc.on('exit', (code, tail) => { if (this.rpc === rpc) this._exit(code, tail); });
    this.emit('status', 'Conectando con Codex…');
    const init = await rpc.request('initialize', CLIENT_INFO);
    if (init.error) { this._fail(`Codex no arrancó: ${init.error.message}`); return; }
    rpc.notify('initialized');
    const params = { cwd: this.cwd, approvalPolicy: APPROVAL[this.mode], sandbox: SANDBOX[this.mode] };
    if (this.model) params.model = this.model;
    const resuming = !!this.resumeId;
    const r = await rpc.request(resuming ? 'thread/resume' : 'thread/start', resuming ? { ...params, threadId: this.resumeId } : params);
    if (r.error || !r.result?.thread?.id) {
      if (resuming) {
        this.resumeId = null;
        this.emit('failure', { kind: 'sessionLost', message: `No se pudo reanudar el hilo de Codex: ${r.error?.message ?? 'respuesta inesperada'}`, resetsAt: null });
        if (this.turnActive) { this.turnActive = false; this.emit('turnFinished'); }
        this.queued = [];
        return;
      }
      this._fail(r.error?.message ?? 'Respuesta inesperada de Codex al crear el hilo.');
      return;
    }
    this.threadId = this.resumeId = r.result.thread.id;
    this.ready = true;
    this.emit('session', this.threadId);
    const pending = this.queued;
    this.queued = [];
    for (const text of pending) this._turn(text);
  }

  send(text) {
    this.turnActive = true;
    this.reported = false;
    this.lastActive = Date.now();
    this.emit('status', 'Codex está trabajando…');
    if (this.ready && this.alive) this._turn(text);
    else {
      this.queued.push(text);
      if (!this.alive) { this.closed = false; this.start(); }
    }
  }

  async _turn(text) {
    this.baseline = this.latestTotal;
    const params = {
      threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }],
      approvalPolicy: APPROVAL[this.mode], sandboxPolicy: SANDBOX_POLICY[this.mode],
    };
    if (this.model) params.model = this.model;
    if (this.effort) params.effort = this.effort;
    const r = await this.rpc?.request('turn/start', params);
    if (r?.error) this._fail(r.error.message);
    else if (r?.result?.turn?.id) this.turnId = r.result.turn.id;
  }

  interrupt() {
    if (this.threadId && this.turnId) this.rpc?.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }
  setMode(mode) { this.mode = mode; }
  setModel(model) { this.model = model === 'default' ? '' : model; }
  setEffort(effort) { this.effort = effort; }

  async refreshUsage() {
    const r = await this.rpc?.request('account/rateLimits/read');
    const rl = r?.result?.rateLimits;
    if (rl) this.emit('usage', { windows: codexWindows(rl), plan: planName(rl.planType) });
  }

  close(keepSession = false) {
    if (!keepSession) this.closed = true;
    const rpc = this.rpc;
    this.rpc = null;
    this.ready = false;
    rpc?.kill();
  }

  _fail(message, kind) {
    if (!this.reported) {
      this.reported = true;
      this.emit('failure', { kind: kind ?? classify(message), message, resetsAt: null });
    }
    if (this.turnActive) { this.turnActive = false; this.emit('turnFinished'); }
  }

  _notification(method, p) {
    this.lastActive = Date.now();
    switch (method) {
      case 'turn/started': this.turnId = p.turn?.id ?? this.turnId; break;
      case 'item/started': this._itemStarted(p.item ?? {}); break;
      case 'item/agentMessage/delta': if (p.itemId && p.delta) this.emit('textDelta', p.itemId, p.delta); break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': if (p.itemId && p.delta) this.emit('reasoningDelta', p.itemId, p.delta); break;
      case 'item/commandExecution/outputDelta': if (p.itemId && p.delta) this.emit('toolOutput', p.itemId, p.delta); break;
      case 'item/completed': this._itemCompleted(p.item ?? {}); break;
      case 'turn/completed': {
        if (p.turn?.status === 'failed') this._turnError(p.turn.error);
        this.turnActive = false;
        this._tokens();
        this.emit('turnFinished');
        this.refreshUsage();
        break;
      }
      case 'thread/tokenUsage/updated': {
        const total = p.tokenUsage?.total, last = p.tokenUsage?.last;
        if (!total) break;
        if (!this.baseline) this.baseline = last ? sub(total, last) : total;
        this.latestTotal = total;
        if (last) this.emit('context', (last.inputTokens ?? 0) + (last.outputTokens ?? 0), p.tokenUsage.modelContextWindow ?? null);
        break;
      }
      case 'error':
        if (p.willRetry) this.emit('status', `Codex reintenta: ${p.error?.message ?? ''}`);
        else this._turnError(p.error);
        break;
      case 'account/rateLimits/updated': {
        const windows = codexWindows(p.rateLimits);
        if (windows.length) this.emit('usage', { windows, plan: planName(p.rateLimits?.planType) });
        break;
      }
      case 'thread/compacted': this.emit('notice', 'Codex ha compactado el contexto'); break;
      case 'model/rerouted': if (p.toModel ?? p.model) this.emit('notice', `Codex cambió al modelo ${p.toModel ?? p.model}`); break;
    }
  }

  _turnError(err) {
    if (this.reported) return;
    this.reported = true;
    const message = err?.message ?? 'Codex devolvió un error.';
    let kind = classify(message);
    const info = err?.codexErrorInfo;
    if (['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(info)) kind = 'limit';
    if (info === 'unauthorized') kind = 'auth';
    if (['serverOverloaded', 'policyCapacityUnavailable', 'flexUnavailable'].includes(info)) kind = 'unavailable';
    this.emit('failure', { kind, message, resetsAt: null });
  }

  _itemStarted(item) {
    if (!item.id) return;
    switch (item.type) {
      case 'commandExecution': this.emit('toolStarted', item.id, 'Shell', item.command ?? 'comando', { command: item.command }); break;
      case 'fileChange': {
        const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean).map((p) => p.split('/').pop());
        this.emit('toolStarted', item.id, 'Edición', paths.length ? `Editar ${paths.join(', ')}` : 'Editar ficheros');
        break;
      }
      case 'mcpToolCall': this.emit('toolStarted', item.id, 'MCP', `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`); break;
      case 'dynamicToolCall': this.emit('toolStarted', item.id, item.tool ?? 'Herramienta', item.tool ?? 'Herramienta'); break;
      case 'webSearch': this.emit('toolStarted', item.id, 'Web', `Buscar «${item.query ?? ''}»`); break;
    }
  }

  _itemCompleted(item) {
    if (!item.id) return;
    switch (item.type) {
      case 'agentMessage': case 'plan': if (item.text) this.emit('textFinal', item.id, item.text); break;
      case 'reasoning': {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n\n');
        if (text) this.emit('reasoningFinal', item.id, text);
        break;
      }
      case 'commandExecution': {
        const exit = item.exitCode;
        const failed = item.status === 'failed' || item.status === 'declined' || (exit ?? 0) !== 0;
        let out = item.aggregatedOutput ?? '';
        if (exit != null && exit !== 0) out += `\n(código de salida ${exit})`;
        this.emit('toolFinished', item.id, !failed, cap(out));
        break;
      }
      case 'fileChange': {
        const diff = (item.changes ?? []).map((c) => `── ${c.path ?? ''}\n${c.diff ?? ''}`).join('\n');
        this.emit('toolFinished', item.id, item.status !== 'failed' && item.status !== 'declined', cap(diff));
        break;
      }
      case 'mcpToolCall': this.emit('toolFinished', item.id, !item.error, cap(JSON.stringify(item.error ?? item.result?.content ?? ''))); break;
      case 'dynamicToolCall': this.emit('toolFinished', item.id, item.success !== false, ''); break;
      case 'webSearch': this.emit('toolFinished', item.id, true, ''); break;
      case 'contextCompaction': this.emit('notice', 'Codex ha compactado el contexto'); break;
    }
  }

  _request(id, method, p) {
    const options = [
      { id: 'accept', label: 'Permitir', isAllow: true },
      { id: 'acceptForSession', label: 'Permitir en esta sesión', isAllow: true },
      { id: 'decline', label: 'Denegar', isAllow: false },
    ];
    const respond = (choice) => this.rpc?.respond(id, { decision: choice });
    if (method === 'item/commandExecution/requestApproval') {
      const detail = [p.reason, p.cwd && `En ${p.cwd}`].filter(Boolean).join('\n');
      this.emit('approval', { key: p.approvalId ?? p.itemId ?? String(id), title: `Ejecutar: ${p.command ?? 'comando'}`, detail, options, questions: null, respond });
    } else if (method === 'item/fileChange/requestApproval') {
      const detail = [p.reason, p.grantRoot && `Permitir escritura en ${p.grantRoot}`].filter(Boolean).join('\n');
      this.emit('approval', { key: p.itemId ?? String(id), title: 'Aplicar cambios en ficheros', detail, options, questions: null, respond });
    } else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      this.rpc?.respond(id, { decision: 'denied' });
    } else {
      this.rpc?.respondError(id, `Relevo no soporta ${method}`);
    }
  }

  _tokens() {
    const total = this.latestTotal;
    if (!total) return;
    const d = sub(total, this.baseline ?? {});
    this.baseline = total;
    const tokens = (d.inputTokens ?? 0) + (d.outputTokens ?? 0);
    if (tokens > 0) this.emit('tokens', { tokens, cacheShare: d.inputTokens ? (d.cachedInputTokens ?? 0) / tokens : null, cost: null });
  }

  _exit(code, tail) {
    this.rpc = null;
    this.ready = false;
    if (this.closed) return;
    if (this.turnActive || code !== 0) {
      if (this.turnActive || (code !== null && code !== 143 && code !== -15)) this._fail(tail || `Codex terminó inesperadamente (código ${code}).`);
    }
    this.emit('exit', code);
  }
}

function sub(a, b) {
  const out = {};
  for (const k of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) out[k] = (a[k] ?? 0) - (b[k] ?? 0);
  return out;
}

/** Login, plan, limits and models through app-server, without a model call. */
export async function codexProbe({ bin, env, cwd }) {
  const status = { loggedIn: null, email: null, plan: null, windows: [], error: null, note: null, models: null };
  let rpc;
  try { rpc = new RPC(bin, cwd, env); } catch (e) { status.error = e.message; return status; }
  const timeout = setTimeout(() => rpc.kill(), 30_000);
  try {
    const init = await rpc.request('initialize', CLIENT_INFO);
    if (init.error) { status.error = init.error.message; return status; }
    rpc.notify('initialized');
    const acc = await rpc.request('account/read', {});
    if (acc.result?.account) {
      status.loggedIn = true;
      status.email = acc.result.account.email ?? null;
      status.plan = planName(acc.result.account.planType);
    } else {
      status.loggedIn = false;
      status.error = 'Sin sesión: ejecuta «relevo-host login codex» en el host';
    }
    if (status.loggedIn) {
      const rl = await rpc.request('account/rateLimits/read');
      if (rl.result?.rateLimits) {
        status.windows = codexWindows(rl.result.rateLimits);
        status.plan ??= planName(rl.result.rateLimits.planType);
      }
      const credits = rl.result?.rateLimitResetCredits?.availableCount;
      if (credits > 0) status.note = credits === 1 ? '1 reinicio de límites disponible' : `${credits} reinicios de límites disponibles`;
    }
    const models = await rpc.request('model/list', {});
    const list = (models.result?.data ?? []).filter((m) => !m.hidden).map((m) => ({
      id: m.model ?? m.id, name: m.displayName ?? m.model ?? m.id, detail: m.description ?? null,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter(Boolean),
      defaultEffort: m.defaultReasoningEffort ?? null,
    })).filter((m) => m.id).map((m) => ({ ...m, efforts: m.efforts.length ? m.efforts : null }));
    if (list.length) status.models = list;
  } finally {
    clearTimeout(timeout);
    rpc.kill();
  }
  return status;
}
