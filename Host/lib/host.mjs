// The headless Relevo host: projects, threads and agents on this machine, served to Relevo Companion with
// the same messages as the Mac app. JSON shapes follow Swift's synthesized Codable (RelevoProtocol):
// enum cases are `{ "case": { "label": value } }`, unlabeled values use `_0`, dates are Unix seconds and
// UUIDs uppercase strings.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createCompanionServer } from './transport.mjs';
import { ClaudeSession, FakeSession, probe, fakeProbe } from './claude.mjs';

const PROTOCOL_VERSION = 1;
const MAX_STORED_ITEMS = 1500;
const SENT_ITEMS = 400;
const IDLE_CLOSE_MS = 15 * 60_000;
const PROBE_EVERY_MS = 10 * 60_000;
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'lost+found']);

const uuid = () => crypto.randomUUID().toUpperCase();
const now = () => Date.now() / 1000;
const uuidFrom = (s) => {
  const h = crypto.createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
};
/** Drops null/undefined fields so optionals are simply absent, as Swift encodes them. */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/** Private to this user: state.json holds the pairing secret and threads hold transcripts. */
function writeJSONAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

export function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|cni|flannel)/.test(name)) continue;
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) out.push(a.address);
  }
  return [...new Set(out)].sort();
}

export class Host {
  constructor(config) {
    this.config = config;
    this.peers = new Set();
    this.threads = new Map();
    this.agents = new Map(); // threadId -> session
    this.runtime = new Map(); // threadId -> live state
    this.projectsCache = { at: 0, list: [] };
    for (const dir of [config.dataDir, config.threadsDir, config.claudeConfigDir, config.tmpDir, config.cacheDir, config.projectsRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this._loadState();
    this.account = {
      id: this.state.accountId, kind: 'claude', name: 'Claude', agentName: 'Claude Code', symbol: 'asterisk', tint: '#D97857',
      status: null, models: [{ id: 'default', name: 'Predeterminado' }, { id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }],
      refreshing: false,
    };
    if (this.state.models?.length) this.account.models = this.state.models;
    this._limitClaudeHousekeeping();
  }

  // MARK: - Persistence

  _loadState() {
    const file = path.join(this.config.dataDir, 'state.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    s.serverId ??= `relevo-${crypto.randomBytes(4).toString('hex')}`;
    s.secret ??= crypto.randomBytes(32).toString('base64');
    s.accountId ??= uuid();
    s.threads ??= [];
    this.state = s;
    for (const meta of s.threads) {
      let stored = { items: [], totalItems: 0 };
      try { stored = JSON.parse(fs.readFileSync(path.join(this.config.threadsDir, `${meta.id}.json`), 'utf8')); } catch {}
      // A turn can't still be running after a restart: settle what was left open.
      for (const item of stored.items) {
        if (item.kind === 'tool' && item.toolState === 'running') item.toolState = 'failed';
        if (item.kind === 'approval' && !item.resolution) item.resolution = 'Sin respuesta (el host se reinició)';
      }
      this.threads.set(meta.id, { ...meta, items: stored.items, totalItems: stored.totalItems ?? stored.items.length, queued: meta.queued ?? [] });
    }
    this._saveState();
  }

  _saveState() {
    this.state.threads = [...this.threads.values()].map((t) => {
      const { items, totalItems, ...meta } = t;
      return meta;
    });
    this.state.models = this.account?.models;
    writeJSONAtomic(path.join(this.config.dataDir, 'state.json'), this.state);
  }

  _saveThread(t) {
    clearTimeout(t._saveTimer);
    t._saveTimer = setTimeout(() => {
      if (t.items.length > MAX_STORED_ITEMS) t.items = t.items.slice(-MAX_STORED_ITEMS);
      writeJSONAtomic(path.join(this.config.threadsDir, `${t.id}.json`), { items: t.items, totalItems: t.totalItems });
      this._saveState();
    }, 1000);
  }

  /** Claude Code keeps transcripts in its config folder: let it prune them sooner than its 30-day default. */
  _limitClaudeHousekeeping() {
    const file = path.join(this.config.claudeConfigDir, 'settings.json');
    if (!fs.existsSync(file)) writeJSONAtomic(file, { cleanupPeriodDays: 14 });
  }

  get pairing() {
    const key = Buffer.from(this.state.secret, 'base64');
    const b64url = key.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const items = { v: '1', id: this.state.serverId, name: this.config.name, key: b64url, port: String(this.config.port) };
    const addrs = localAddresses();
    if (addrs.length) items.addrs = addrs.join(',');
    // Percent-encoding (not form encoding): URLComponents on the iPhone reads `+` literally, not as a space.
    const query = Object.entries(items).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return `relevocompanion://pair?${query}`;
  }

  // MARK: - Serving

  listen() {
    this.server = createCompanionServer({
      serverId: this.state.serverId, secret: Buffer.from(this.state.secret, 'base64'), port: this.config.port,
    }, (peer) => this._accept(peer));
    this.server.on('listening', () => this.log(`listening on :${this.config.port} as ${this.state.serverId} (${this.config.name})`));
    this.server.on('error', (e) => { this.log(`server error: ${e.message}`); process.exitCode = 1; });
    this.refreshUsage();
    setInterval(() => this.refreshUsage(), PROBE_EVERY_MS).unref();
    setInterval(() => this._housekeeping(), 60_000).unref();
  }

  log(s) { console.log(`[relevo-host] ${s}`); }

  _accept(peer) {
    peer.greeted = false;
    peer.subscribed = null;
    peer.lastSnapshot = null;
    peer.lastActivity = null;
    this.peers.add(peer);
    peer.on('close', () => this.peers.delete(peer));
    peer.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      const [name] = Object.keys(msg ?? {});
      if (!name) return;
      try { this._handle(peer, name, msg[name] ?? {}); } catch (e) { this.log(`error handling ${name}: ${e.stack ?? e}`); }
    });
  }

  _handle(peer, name, a) {
    if (name === 'hello') {
      peer.greeted = true;
      peer.device = a.device;
      this.log(`iPhone connected: ${a.device} from ${peer.remote}`);
      peer.send({ welcome: { name: this.config.name, version: PROTOCOL_VERSION } });
      peer.send({ addresses: { hosts: localAddresses(), port: this.config.port } });
      this._sendSnapshot(peer, true);
      this._sendActivity(peer, true);
      return;
    }
    if (!peer.greeted) return;
    const t = a.threadId ? this.threads.get(String(a.threadId).toUpperCase()) : null;
    switch (name) {
      case 'subscribe':
        peer.subscribed = a.threadId ? String(a.threadId).toUpperCase() : null;
        if (t) peer.send({ thread: { _0: this._remoteThread(t) } });
        break;
      case 'send': if (t) this.send(t, a.text); break;
      case 'sendNow': if (t) this.sendNow(t, a.text); break;
      case 'dequeue': if (t) { t.queued = t.queued.filter((q) => q.id !== String(a.messageId).toUpperCase()); this._changed(t); } break;
      case 'sendQueuedNow': if (t) {
        const q = t.queued.find((x) => x.id === String(a.messageId).toUpperCase());
        if (q) { t.queued = t.queued.filter((x) => x !== q); this.sendNow(t, q.text); }
        break;
      }
      case 'resumeQueue': if (t) { t.queuePaused = false; this._changed(t); this._next(t); } break;
      case 'stop': if (t) this.stop(t); break;
      case 'approve': if (t) this._resolve(t, a.itemId, a.optionId, null); break;
      case 'answer': if (t) this._resolve(t, a.itemId, 'answer', a.answers ?? {}); break;
      case 'select': if (t) { t.model = a.model; this.agents.get(t.id)?.setModel(a.model); this._changed(t); } break;
      case 'setEffort': if (t) { t.effort = a.effort ?? null; this.agents.get(t.id)?.setEffort(t.effort); this._changed(t); } break;
      case 'setMode': if (t) { t.mode = a.mode; this.agents.get(t.id)?.setMode(a.mode); this._changed(t); } break;
      case 'newThread': {
        const thread = this.createThread(String(a.projectId).toUpperCase());
        peer.send({ created: { requestId: a.requestId, threadId: thread?.id ?? uuid() } });
        break;
      }
      case 'refreshUsage': this.refreshUsage(); break;
      case 'fetchImage': peer.send({ image: { requestId: a.requestId, error: 'Este host todavía no sirve imágenes' } }); break;
      case 'openOnMac': peer.send({ toast: { _0: `«Abrir» no está disponible en ${this.config.name}` } }); break;
      case 'relay': peer.send({ toast: { _0: `${this.config.name} solo tiene Claude por ahora` } }); break;
      default: break; // setDraft, suggestion, setLimitPlan, limitAction, registerLiveActivity: not in this host yet
    }
  }

  // MARK: - Projects and threads

  projects() {
    if (Date.now() - this.projectsCache.at < 5000) return this.projectsCache.list;
    let entries = [];
    try { entries = fs.readdirSync(this.config.projectsRoot, { withFileTypes: true }); } catch {}
    const list = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => {
        const p = path.join(this.config.projectsRoot, e.name);
        return { id: uuidFrom(p), name: e.name, path: p };
      })
      .sort((x, y) => x.name.localeCompare(y.name));
    this.projectsCache = { at: Date.now(), list };
    return list;
  }

  createThread(projectId) {
    const project = this.projects().find((p) => p.id === projectId);
    if (!project) return null;
    const t = {
      id: uuid(), projectId, projectPath: project.path, title: 'Nuevo hilo', createdAt: now(), updatedAt: now(),
      model: 'default', effort: null, mode: 'autoEdit', sessionId: null, items: [], totalItems: 0, queued: [], queuePaused: false,
    };
    this.threads.set(t.id, t);
    this._saveThread(t);
    this._broadcastSnapshot();
    return t;
  }

  _rt(t) {
    let r = this.runtime.get(t.id);
    if (!r) {
      r = { isRunning: false, statusLine: null, limit: null, approvals: new Map(), keys: new Map(), dirty: new Set(), sendNow: null, finishedAt: null };
      this.runtime.set(t.id, r);
    }
    return r;
  }

  _append(t, item) {
    t.items.push(clean({ date: now(), ...item }));
    t.totalItems += 1;
    this._rt(t).dirty.add(item.id);
    return t.items[t.items.length - 1];
  }

  _item(t, id) {
    for (let i = t.items.length - 1; i >= 0; i--) if (t.items[i].id === id) return t.items[i];
    return null;
  }

  _touch(t, item) {
    this._rt(t).dirty.add(item.id);
  }

  send(t, text) {
    if (!text?.trim()) return;
    const r = this._rt(t);
    if (r.isRunning) {
      t.queued.push({ id: uuid(), text });
      this._changed(t);
      return;
    }
    this._startTurn(t, text);
  }

  sendNow(t, text) {
    const r = this._rt(t);
    if (!r.isRunning) { this._startTurn(t, text); return; }
    r.sendNow = text;
    r.statusLine = 'Interrumpiendo para enviar tu mensaje…';
    this.agents.get(t.id)?.interrupt();
    this._changed(t);
  }

  stop(t) {
    const r = this._rt(t);
    if (!r.isRunning) return;
    t.queuePaused = t.queued.length > 0;
    r.statusLine = 'Deteniendo…';
    this.agents.get(t.id)?.interrupt();
    this._changed(t);
  }

  _diskProblem(t) {
    const gb = (n) => (n / 1e9).toFixed(1);
    const data = freeBytes(this.config.dataDir), proj = freeBytes(t.projectPath ?? this.config.projectsRoot);
    if (data < this.config.minFreeDataBytes) return `Queda poco espacio para los datos del host (${gb(data)} GB libres en ${this.config.dataDir}).`;
    if (proj < this.config.minFreeProjectsBytes) return `Queda poco espacio en el disco de proyectos (${gb(proj)} GB libres).`;
    return null;
  }

  _startTurn(t, text) {
    const r = this._rt(t);
    const problem = this._diskProblem(t);
    if (problem) {
      this._append(t, { id: uuid(), kind: 'error', text: `${problem} No arranco el agente para no llenar el disco.` });
      this._changed(t);
      return;
    }
    if (!fs.existsSync(t.projectPath)) {
      this._append(t, { id: uuid(), kind: 'error', text: `La carpeta del proyecto ya no existe: ${t.projectPath}` });
      this._changed(t);
      return;
    }
    if (!this._agentSlot(t)) {
      t.queued.unshift({ id: uuid(), text });
      r.statusLine = `Esperando: ya hay ${this.config.maxAgents} agentes trabajando en ${this.config.name}`;
      this._changed(t);
      return;
    }
    if (t.title === 'Nuevo hilo') {
      const first = text.trim().split('\n')[0];
      t.title = first.length > 60 ? `${first.slice(0, 57)}…` : first;
    }
    this._append(t, { id: uuid(), kind: 'user', text });
    r.isRunning = true;
    r.limit = null;
    r.turnItems = [];
    r.statusLine = 'Claude está trabajando…';
    t.updatedAt = now();
    this._agent(t).send(text);
    this._changed(t);
  }

  /** Room for one more agent process: closes the longest-idle one when needed. */
  _agentSlot(t) {
    if (this.agents.get(t.id)?.alive) return true;
    const alive = [...this.agents.entries()].filter(([, s]) => s.alive);
    if (alive.length < this.config.maxAgents) return true;
    const idle = alive.filter(([id, s]) => !s.turnActive && !this._rt(this.threads.get(id)).approvals.size)
      .sort(([, a], [, b]) => a.lastActive - b.lastActive);
    if (!idle.length) return false;
    idle[0][1].close(true);
    return true;
  }

  _agent(t) {
    let s = this.agents.get(t.id);
    if (s) return s;
    const Session = this.config.fakeAgent ? FakeSession : ClaudeSession;
    s = new Session({ bin: this.config.claudeBin, cwd: t.projectPath, env: this.config.agentEnv, model: t.model, effort: t.effort, mode: t.mode, resumeId: t.sessionId });
    this.agents.set(t.id, s);
    const r = this._rt(t);
    const item = (key, make) => {
      let id = r.keys.get(key);
      let it = id && this._item(t, id);
      if (!it) { it = this._append(t, make()); r.keys.set(key, it.id); r.turnItems?.push(it.id); }
      return it;
    };
    s.on('session', (id) => { t.sessionId = id; this._saveThread(t); });
    s.on('status', (text) => { r.statusLine = text; this._changed(t, false); });
    s.on('textDelta', (key, text) => {
      const it = item(`a:${key}`, () => ({ id: uuid(), kind: 'assistant', text: '', accountId: this.account.id, model: t.model }));
      it.text += text; this._touch(t, it); this._changed(t, false);
    });
    s.on('textFinal', (key, text) => {
      const it = item(`a:${key}`, () => ({ id: uuid(), kind: 'assistant', text: '', accountId: this.account.id, model: t.model }));
      it.text = text; this._touch(t, it); this._changed(t, false);
    });
    s.on('reasoningDelta', (key, text) => {
      const it = item(`r:${key}`, () => ({ id: uuid(), kind: 'reasoning', text: '' }));
      it.text += text; this._touch(t, it); this._changed(t, false);
    });
    s.on('toolStarted', (key, name, title, input) => {
      const it = item(`t:${key}`, () => ({ id: uuid(), kind: 'tool', text: title, title, toolName: name, toolState: 'running' }));
      if (input?.command && !it.output) it.output = `$ ${input.command}`;
      r.statusLine = title; this._touch(t, it); this._changed(t, false);
    });
    s.on('toolFinished', (key, ok, output) => {
      const it = item(`t:${key}`, () => ({ id: uuid(), kind: 'tool', text: 'Herramienta', toolState: 'running' }));
      it.toolState = ok ? 'done' : 'failed';
      if (output) it.output = output;
      this._touch(t, it); this._changed(t, false);
    });
    s.on('approval', (req) => {
      const it = this._append(t, {
        id: uuid(), kind: 'approval', text: req.title, title: req.title, output: req.detail || null,
        options: req.options, questions: req.questions || null,
      });
      r.approvals.set(it.id, req.respond);
      r.statusLine = 'Esperando tu respuesta';
      this._changed(t);
    });
    s.on('notice', (text) => { this._append(t, { id: uuid(), kind: 'notice', text }); this._changed(t); });
    s.on('failure', (f) => {
      this._append(t, { id: uuid(), kind: 'error', text: f.message, accountId: this.account.id });
      if (f.kind === 'auth') {
        this.account.status = { ...(this.account.status ?? {}), loggedIn: false, error: 'Sin sesión: ejecuta «relevo-host login» en el host' };
        this._append(t, { id: uuid(), kind: 'notice', text: `Inicia sesión en Claude en ${this.config.name}: ssh y «relevo-host login».` });
      }
      if (f.kind === 'limit' || f.kind === 'unavailable') {
        r.limit = { accountId: this.account.id, message: f.message, resetsAt: f.resetsAt ?? null, isCapacity: f.kind === 'unavailable', isNoPlan: false };
      }
      if (f.kind === 'sessionLost') t.sessionId = null;
      if (t.queued.length) t.queuePaused = true;
      this._changed(t);
    });
    s.on('usage', ({ windows, plan }) => {
      this.account.status = { ...(this.account.status ?? {}), loggedIn: true, windows, plan: plan ?? this.account.status?.plan ?? null, updatedAt: now() };
      this._broadcastSnapshot();
    });
    s.on('tokens', (u) => {
      const lastAssistant = [...(r.turnItems ?? [])].reverse().map((id) => this._item(t, id)).find((x) => x?.kind === 'assistant');
      const target = lastAssistant ?? t.items[t.items.length - 1];
      if (!target) return;
      target.usage = clean({ tokens: u.tokens, cacheShare: u.cacheShare, cost: u.cost, costEstimated: true, paid: false });
      this._touch(t, target);
    });
    s.on('turnStarted', () => { r.isRunning = true; r.turnItems = []; r.statusLine = 'Claude retoma por su cuenta…'; this._changed(t); });
    s.on('turnFinished', () => {
      r.isRunning = false;
      r.statusLine = null;
      r.finishedAt = Date.now();
      for (const [id] of r.approvals) {
        const it = this._item(t, id);
        if (it && !it.resolution) { it.resolution = 'Sin respuesta'; this._touch(t, it); }
      }
      r.approvals.clear();
      r.keys.clear();
      t.updatedAt = now();
      this._changed(t);
      if (r.sendNow) { const text = r.sendNow; r.sendNow = null; this._startTurn(t, text); return; }
      this._next(t);
      for (const other of this.threads.values()) if (other !== t && other.queued.length && !this._rt(other).isRunning && !other.queuePaused) this._next(other);
    });
    return s;
  }

  _next(t) {
    const r = this._rt(t);
    if (r.isRunning || t.queuePaused || !t.queued.length) return;
    const q = t.queued.shift();
    this._startTurn(t, q.text);
  }

  _resolve(t, itemId, optionId, answers) {
    const r = this._rt(t);
    const respond = r.approvals.get(itemId);
    const it = this._item(t, itemId);
    if (!respond || !it || it.resolution) return;
    r.approvals.delete(itemId);
    if (answers) {
      it.answers = answers;
      it.resolution = 'Respondido';
      respond('answer', answers);
    } else {
      const option = (it.options ?? []).find((o) => o.id === optionId);
      it.resolution = option?.label ?? optionId;
      respond(optionId, null);
    }
    r.statusLine = 'Claude está trabajando…';
    this._touch(t, it);
    this._changed(t);
  }

  // MARK: - Limits and housekeeping

  async refreshUsage() {
    if (this.account.refreshing) return;
    this.account.refreshing = true;
    this._broadcastSnapshot();
    const env = this.config.agentEnv;
    const result = this.config.fakeAgent ? fakeProbe() : await probe({ bin: this.config.claudeBin, env, cwd: this.config.dataDir });
    this.account.refreshing = false;
    if (result.models) this.account.models = result.models;
    this.account.status = {
      loggedIn: result.loggedIn, plan: result.plan, email: result.email, windows: result.windows ?? [],
      error: result.error, note: null, updatedAt: now(),
    };
    this._saveState();
    this._broadcastSnapshot();
  }

  _housekeeping() {
    // Idle agent processes hold memory: close them; the next message resumes the same session.
    for (const [id, s] of this.agents) {
      const r = this._rt(this.threads.get(id) ?? { id });
      if (s.alive && !s.turnActive && !r.approvals.size && Date.now() - s.lastActive > IDLE_CLOSE_MS) s.close(true);
    }
    // Agents' temporary files live on the data disk; remove what's older than a day.
    const cutoff = Date.now() - 24 * 3600_000;
    try {
      for (const name of fs.readdirSync(this.config.tmpDir)) {
        const p = path.join(this.config.tmpDir, name);
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }

  // MARK: - Remote objects

  _remoteAccount() {
    const a = this.account, s = a.status;
    return clean({
      id: a.id, kind: a.kind, name: a.name, agentName: a.agentName, symbol: a.symbol, tint: a.tint, usesAPIKey: false,
      status: s ? clean({
        loggedIn: s.loggedIn, plan: s.plan, email: s.email, error: s.error, note: s.note,
        windows: (s.windows ?? []).map((w) => clean({ id: w.id, label: w.label, percent: w.percent, resetsAt: w.resetsAt, detail: w.detail })),
        noPlan: false, exhausted: (s.windows ?? []).some((w) => w.percent >= 99.5 && (w.resetsAt ?? Infinity) > now()), updatedAt: s.updatedAt,
      }) : null,
      models: a.models.map((m) => clean({ id: m.id, name: m.name, detail: m.detail, efforts: m.efforts, defaultEffort: m.defaultEffort })),
      defaultModel: 'default', refreshing: a.refreshing,
    });
  }

  _snapshot() {
    const projects = this.projects();
    const known = new Set(projects.map((p) => p.id));
    const threads = [...this.threads.values()]
      .filter((t) => known.has(t.projectId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => {
        const r = this._rt(t);
        const last = [...t.items].reverse().find((i) => i.kind === 'assistant' || i.kind === 'user');
        return clean({
          id: t.id, projectId: t.projectId, title: t.title, updatedAt: t.updatedAt, isRunning: r.isRunning,
          needsApproval: r.approvals.size > 0, accountId: this.account.id, preview: last?.text?.slice(0, 160) ?? null, isWaiting: false,
        });
      });
    return { macName: this.config.name, accounts: [this._remoteAccount()], projects, threads, autoRelay: false, pushReady: false };
  }

  _runtime(t) {
    const r = this._rt(t);
    return clean({
      isRunning: r.isRunning, statusLine: r.statusLine, limit: r.limit ? clean(r.limit) : null, mode: t.mode,
      selectedAccountId: this.account.id, selectedModel: t.model, selectedEffort: t.effort, relayCandidates: [],
      queued: t.queued.map((q) => ({ id: q.id, text: q.text })), queuePaused: t.queuePaused,
      usage: (this.account.status?.windows ?? []).map((w) => clean({ id: w.id, label: w.label, percent: w.percent, resetsAt: w.resetsAt, detail: w.detail })),
      backgroundTasks: [],
    });
  }

  _remoteThread(t) {
    return { id: t.id, title: t.title, items: t.items.slice(-SENT_ITEMS), totalItems: t.totalItems, runtime: this._runtime(t) };
  }

  _activity() {
    const list = [...this.threads.values()];
    const waiting = list.filter((t) => this._rt(t).approvals.size);
    const running = list.filter((t) => this._rt(t).isRunning);
    const recent = list.filter((t) => this._rt(t).finishedAt && Date.now() - this._rt(t).finishedAt < 10 * 60_000)
      .sort((a, b) => this._rt(b).finishedAt - this._rt(a).finishedAt);
    const focus = waiting[0] ?? running[0] ?? recent[0];
    const phase = waiting.length ? 'needsYou' : running.length ? 'working' : recent.length ? 'finished' : 'idle';
    let approval = null;
    if (waiting[0]) {
      const r = this._rt(waiting[0]);
      const [itemId] = r.approvals.keys();
      const it = this._item(waiting[0], itemId);
      if (it) approval = clean({ itemId, title: it.title ?? it.text, detail: it.output, options: it.options ?? [] });
    }
    return clean({
      phase, threadId: focus?.id, threadTitle: focus?.title ?? '', accountName: focus ? 'Claude' : null,
      symbol: focus ? this.account.symbol : null, tint: focus ? this.account.tint : null, model: focus?.model,
      statusLine: focus ? this._rt(focus).statusLine : null, approval, running: running.length, waiting: waiting.length, updatedAt: now(),
    });
  }

  // MARK: - Pushing changes

  _changed(t, structural = true) {
    t.updatedAt = Math.max(t.updatedAt, now() - 0.001);
    this._saveThread(t);
    this._schedulePatch(t);
    if (structural) this._broadcastSnapshot();
    this._broadcastActivity();
  }

  _schedulePatch(t) {
    const r = this._rt(t);
    if (r.patchTimer) return;
    r.patchTimer = setTimeout(() => {
      r.patchTimer = null;
      const ids = r.dirty;
      r.dirty = new Set();
      const upserts = t.items.filter((i) => ids.has(i.id));
      const patch = { id: t.id, title: t.title, upserts, totalItems: t.totalItems, runtime: this._runtime(t) };
      for (const peer of this.peers) if (peer.greeted && peer.subscribed === t.id) peer.send({ threadPatch: { _0: patch } });
      this._broadcastSnapshot();
    }, 120);
  }

  _broadcastSnapshot() {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      for (const peer of this.peers) if (peer.greeted) this._sendSnapshot(peer);
    }, 300);
  }

  _sendSnapshot(peer, force = false) {
    const snap = this._snapshot();
    const json = JSON.stringify(snap);
    if (!force && json === peer.lastSnapshot) return;
    peer.lastSnapshot = json;
    peer.send({ snapshot: { _0: snap } });
  }

  _broadcastActivity() {
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      for (const peer of this.peers) if (peer.greeted) this._sendActivity(peer);
    }, 500);
  }

  _sendActivity(peer, force = false) {
    const state = this._activity();
    const key = JSON.stringify({ ...state, updatedAt: 0 });
    if (!force && key === peer.lastActivity) return;
    peer.lastActivity = key;
    peer.send({ activity: { _0: state } });
  }
}
