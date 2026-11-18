// The headless Relevo host: projects, threads and agents on this machine, served to Relevo Companion with
// the same messages as the Mac app. JSON shapes follow Swift's synthesized Codable (RelevoProtocol):
// enum cases are `{ "case": { "label": value } }`, unlabeled values use `_0`, dates are Unix seconds and
// UUIDs uppercase strings.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCompanionServer } from './transport.mjs';
import { killTree } from './platform.mjs';
import { ClaudeSession, FakeSession, probe, fakeProbe } from './claude.mjs';
import { CodexSession, codexProbe } from './codex.mjs';
import { handoffText, saveTrace } from './handoff.mjs';
import * as gitops from './gitops.mjs';
import { listDirectory, readThreadImage } from './files.mjs';
import { usageReport } from './usage.mjs';
import { LoginSession } from './login.mjs';
import { quickCompletion, cleanTitle } from './quick.mjs';
import { buildAccount, API_PRESETS, ACP_PRESETS, TYPES } from './accounts.mjs';
import { Teams, fallbackOf } from './team.mjs';

const PROTOCOL_VERSION = 1;
const MAX_STORED_ITEMS = 1500;
const SENT_ITEMS = 400;
const IDLE_CLOSE_MS = 15 * 60_000;
const PROBE_EVERY_MS = 10 * 60_000;
const STALE_AFTER_S = 120;
const CODEX_SESSIONS_DAYS = 30;
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'lost+found']);
const MODES = new Set(['ask', 'autoEdit', 'full', 'plan']);
const PLAN_MODES = new Set(['ask', 'mostQuota', 'chain', 'wait']);
/** What this host does beyond the shared protocol; clients show those controls only when listed. */
export const HOST_FEATURES = ['teams', 'projects', 'threads', 'git', 'images', 'usage', 'login', 'settings', 'limitPlans', 'history', 'titles', 'accounts',
  'turns', 'worktrees', 'pullRequests', 'suggest', 'quickActions', 'attachments', 'teamRename', 'teamDecisions'];
const IMAGE_UPLOAD = /\.(png|jpe?g|gif|webp)$/i;

/** Providers this host can run. Each account is one provider with its own CLI login on this machine. */
export const PROVIDERS = {
  claude: {
    kind: 'claude', name: 'Claude', agentName: 'Claude Code', symbol: 'asterisk', tint: '#D97857', Session: ClaudeSession, probe,
    models: [{ id: 'default', name: 'Predeterminado' }, { id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }],
  },
  codex: {
    kind: 'codex', name: 'Codex', agentName: 'Codex', symbol: 'hexagon', tint: '#12A380', Session: CodexSession, probe: codexProbe,
    models: [{ id: 'default', name: 'Predeterminado' }],
  },  antigravity: { name: 'Gemini' },
};

const uuid = () => crypto.randomUUID().toUpperCase();
const now = () => Date.now() / 1000;
const uuidFrom = (s) => {
  const h = crypto.createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
};
/** Drops null/undefined fields so optionals are simply absent, as Swift encodes them. */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const remoteWindow = (w) => clean({ id: w.id, label: w.label, percent: w.percent, resetsAt: w.resetsAt, detail: w.detail });

/** Private to this user: state.json holds the pairing secret and threads hold transcripts. */
function writeJSONAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  // Windows refuses to replace a file another process (an antivirus, a backup) has open for a moment.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

/** Deletes files under `dir` not modified since `cutoff` (ms). */
function prune(dir, cutoff) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) prune(p, cutoff);
      else if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    } catch {}
  }
}

export function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // Linux bridges and containers; on Windows, Hyper-V/WSL switches and other virtual machines' adapters.
    if (/^(lo|docker|br-|veth|virbr|cni|flannel)/.test(name) || /^vEthernet|VirtualBox|VMware|Loopback/i.test(name)) continue;
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
    for (const dir of [config.dataDir, config.threadsDir, config.claudeConfigDir, config.codexHome, config.tmpDir, config.cacheDir, config.projectsRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.interrupted = new Set(); // threads whose turn the last stop cut (see _wasCut)
    this._loadState();
    this.teams = new Teams(this);
    this._limitClaudeHousekeeping();
  }

  _uuid() { return uuid(); }

  // MARK: - Persistence

  _loadState() {
    const file = path.join(this.config.dataDir, 'state.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      // Starting over would change the pairing key and lose every thread: only when there's no state yet.
      if (e.code !== 'ENOENT') {
        try {
          s = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
          this.log(`state.json unreadable (${e.message}); using the previous copy (state.json.bak)`);
        } catch {
          throw new Error(`Can't read ${file} (${e.message}). Fix or remove it (a new one means pairing again).`);
        }
      }
    }
    const created = !s.serverId || !s.secret;
    s.serverId ??= `relevo-${crypto.randomBytes(4).toString('hex')}`;
    s.secret ??= crypto.randomBytes(32).toString('base64');
    s.settings ??= {};
    s.extraProjects ??= [];
    s.hiddenProjects ??= [];
    s.quickActions ??= {};
    // One account per provider; the first version had only Claude (`accountId`, `models`).
    s.accounts ??= {};
    if (s.accountId) { s.accounts.claude ??= s.accountId; delete s.accountId; }
    s.models = Array.isArray(s.models) ? { claude: s.models } : (s.models ?? {});
    s.threads ??= [];
    this.state = s;

    // Subscriptions: one per installed provider the first time (keeping the ids and sign-in folders of the
    // single-account versions), then as added, edited and removed from the apps.
    if (!Array.isArray(s.accountList)) {
      s.accountList = this.config.providers.map(({ provider }) => ({
        id: s.accounts[provider] ?? uuid(), type: provider, name: PROVIDERS[provider].name,
        home: provider === 'claude' ? this.config.claudeConfigDir : this.config.codexHome,
      }));
    }
    this._buildAccounts();

    for (const meta of s.threads) {
      let stored = { items: [], totalItems: 0 };
      try { stored = JSON.parse(fs.readFileSync(path.join(this.config.threadsDir, `${meta.id}.json`), 'utf8')); } catch {}
      // A turn can't still be running after a restart: settle what was left open.
      for (const item of stored.items) {
        if (item.kind === 'tool' && item.toolState === 'running') item.toolState = 'failed';
        if (item.kind === 'approval' && !item.resolution) item.resolution = 'Sin respuesta (el host se reinició)';
      }
      const t = { ...meta, items: stored.items, totalItems: stored.totalItems ?? stored.items.length, queued: meta.queued ?? [] };
      if (!this.accountsById.has(t.accountId)) t.accountId = this.accounts[0]?.id;
      this.threads.set(meta.id, t);
      if (this._wasCut(t)) this.interrupted.add(t.id);
    }
    // `pair` and other one-off commands read the state; only the service (or a brand-new state) writes it.
    if (!this.config.readOnly || created) this._saveState();
  }

  /**
   * The thread's last turn was cut by the host stopping (a restart, an update that didn't wait, a crash): it
   * started and never finished. Recent turns only, and never a turn that was itself such a resumption.
   */
  _wasCut(t) {
    let u = null;
    for (let i = t.items.length - 1; i >= 0 && !u; i--) if (t.items[i].kind === 'user') u = t.items[i];
    if (!u || u.done) return false;
    if (now() - (u.date ?? 0) > 12 * 3600) return false;
    if (u.from?.label === 'reinicio') {
      // A resumption cut again: carry on if it had been working a while; one that died right away (a turn
      // that brings the host down) or the third in a row is left alone, so it can't loop.
      const ranFor = (t.items[t.items.length - 1]?.date ?? u.date) - u.date;
      const users = t.items.filter((i) => i.kind === 'user');
      let streak = 0;
      for (let i = users.length - 1; i >= 0 && users[i].from?.label === 'reinicio'; i--) streak++;
      if (ranFor < 120 || streak >= 3) return false;
    }
    const started = u.started || u.turnBefore;
    return !!started && !u.turnAfter;
  }

  /** Settings changed from the apps (stored in state.json), over the defaults from host.env. */
  get settings() {
    return {
      projectsRoot: this.config.projectsRoot, maxAgents: this.config.maxAgents, defaultMode: 'autoEdit', defaultAccountId: null,
      limitPlan: { mode: 'ask', targets: [] }, relayDelay: 10, aiTitles: true, suggest: true, suggestMode: 'suggest', probeMinutes: 10, ...this.state.settings,
    };
  }

  /** Writes every pending thread and the state now (before exiting or restarting). */
  flush() {
    for (const t of this.threads.values()) {
      if (!t._saveTimer) continue;
      clearTimeout(t._saveTimer);
      t._saveTimer = null;
      try { writeJSONAtomic(path.join(this.config.threadsDir, `${t.id}.json`), { items: t.items, totalItems: t.totalItems }); } catch {}
    }
    try { this._saveState(); } catch {}
  }

  _saveState() {
    this.state.threads = [...this.threads.values()].map((t) => {
      const { items, totalItems, _saveTimer, _preview, ...meta } = t;
      return meta;
    });
    // Model lists the CLIs reported (an API's come from its definition).
    for (const a of this.accounts ?? []) if (a.provider !== 'api') this.state.models[a.id] = a.models;
    const file = path.join(this.config.dataDir, 'state.json');
    try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch {}
    writeJSONAtomic(file, this.state);
  }

  _saveThread(t) {
    clearTimeout(t._saveTimer);
    t._saveTimer = setTimeout(() => {
      t._saveTimer = null;
      if (!this.threads.has(t.id)) return;
      if (t.items.length > MAX_STORED_ITEMS) t.items = t.items.slice(-MAX_STORED_ITEMS);
      writeJSONAtomic(path.join(this.config.threadsDir, `${t.id}.json`), { items: t.items, totalItems: t.totalItems });
      this._saveState();
    }, 1000);
  }

  /** Claude Code keeps transcripts in its config folder: let it prune them sooner than its 30-day default. */
  _limitClaudeHousekeeping() {
    if (this.config.readOnly) return;
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
    this.server.on('listening', () => this.log(`listening on :${this.config.port} as ${this.state.serverId} (${this.config.name}) · ${this.accounts.map((a) => a.name).join(', ')}`));
    // A busy port means another copy is serving: exit so the supervisor (or systemd) tries again later.
    this.server.on('error', (e) => { this.log(`server error: ${e.message}`); this.flush(); process.exit(1); });
    this.refreshUsage();
    const probe = () => { this.refreshUsage(); this.probeTimer = setTimeout(probe, (this.settings.probeMinutes || PROBE_EVERY_MS / 60_000) * 60_000); this.probeTimer.unref?.(); };
    this.probeTimer = setTimeout(probe, (this.settings.probeMinutes || 10) * 60_000);
    this.probeTimer.unref?.();
    setInterval(() => this._housekeeping(), 60_000).unref();
    // After a restart: the turns it cut carry on where they were, and messages waiting in a queue go out (those
    // held back by an update included). Agents beyond the limit wait their turn as usual.
    setTimeout(() => this._resumeAfterRestart(), 3000).unref();
  }

  _resumeAfterRestart() {
    for (const t of this.threads.values()) {
      delete t.resumeAfterRestart;
      if (this._rt(t).isRunning) continue;
      if (this.interrupted.has(t.id)) {
        this.interrupted.delete(t.id);
        this._append(t, { id: uuid(), kind: 'notice', text: 'Relevo se ha reiniciado a mitad de este turno: el agente sigue donde lo dejó' });
        this._startTurn(t, 'Relevo se ha reiniciado y el turno anterior se cortó a medias. Sigue donde lo dejaste.', false, {
          from: { name: 'Relevo', role: 'relevo', label: 'reinicio' },
          prompt: '(Relevo se ha reiniciado y tu turno anterior se cortó a medias: los comandos que estuvieran en marcha se pararon.) Comprueba en qué estado quedó lo que estabas haciendo (ficheros, compilaciones, procesos) y sigue con la tarea donde la dejaste; no repitas lo que ya esté hecho.',
        });
        continue;
      }
      if (t.queued.length && !t.queuePaused) this._next(t);
    }
    this.interrupted.clear();
    this.teams.afterRestart();
  }

  // MARK: - Updates without cutting the agents

  /** Agents working or waiting for an answer right now. */
  busyAgents() {
    return [...this.threads.values()].filter((t) => { const r = this._rt(t); return r.isRunning || r.approvals.size > 0 || r.backgroundTasks?.length > 0; }).length;
  }

  /**
   * An update is installed and the service has to restart: it waits until no agent is working or waiting for
   * an answer (turns end on their own; between turns nothing is lost, each agent resumes its session), and
   * meanwhile new turns wait in their thread's queue so that moment comes. Then `onIdle` restarts.
   */
  restartWhenIdle(version, onIdle) {
    if (this.pendingRestart) { this.pendingRestart.version = version; return; }
    this.pendingRestart = { version, onIdle, fired: false };
    this.log(`update to ${version} installed: restarting when the agents are idle (${this.busyAgents()} busy)`);
    this._restartTimer = setInterval(() => this._checkRestart(), 2000);
    this._restartTimer.unref?.();
    this._checkRestart();
  }

  _checkRestart() {
    const p = this.pendingRestart;
    if (!p || p.fired || this.busyAgents()) return;
    p.fired = true;
    clearInterval(this._restartTimer);
    this.flush();
    setTimeout(() => p.onIdle(), 500);
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
      this._refreshStale();
      return;
    }
    if (!peer.greeted) return;
    const t = a.threadId ? this.threads.get(String(a.threadId).toUpperCase()) : null;
    const accountId = a.accountId ? String(a.accountId).toUpperCase() : null;
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
      case 'select': if (t) this.select(t, accountId, a.model, false); break;
      case 'relay': if (t) this.select(t, accountId, a.model, true); break;
      case 'setEffort': if (t) { t.effort = a.effort ?? null; this.agents.get(t.id)?.setEffort(t.effort); this._changed(t); } break;
      case 'setMode': if (t) {
        t.mode = a.mode;
        this.agents.get(t.id)?.setMode(a.mode);
        // Full access also lets through what's already waiting for your permission (not questions).
        if (a.mode === 'full') {
          for (const id of [...this._rt(t).approvals.keys()]) {
            const it = this._item(t, id);
            const allow = it && !it.questions?.length && (it.options ?? []).find((o) => o.isAllow);
            if (allow) this._resolve(t, id, allow.id, null);
          }
        }
        this._changed(t);
      } break;
      case 'newThread': {
        const thread = this.createThread(String(a.projectId).toUpperCase());
        peer.send({ created: { requestId: a.requestId, threadId: thread?.id ?? uuid() } });
        break;
      }
      case 'refreshUsage': this.refreshUsage(); break;
      case 'fetchImage': {
        if (!t) { peer.send({ image: { requestId: a.requestId, error: 'Hilo desconocido' } }); break; }
        try { peer.send({ image: { requestId: a.requestId, data: readThreadImage(t, a.path).toString('base64') } }); } catch (e) {
          peer.send({ image: { requestId: a.requestId, error: e.message } });
        }
        break;
      }
      case 'openOnMac': peer.send({ toast: { _0: `«Abrir» no está disponible en ${this.config.name}` } }); break;
      case 'setLimitPlan': if (t) { t.limitPlan = a.plan ? this._validPlan(a.plan) : null; this._changed(t); } break;
      case 'limitAction': if (t) this._limitAction(t, a.action); break;
      default: this._handleExtra(peer, name, a, t); break; // setDraft, suggestion, registerLiveActivity: Mac only
    }
  }

  /** Requests only this host answers (the desktop app uses them when the snapshot lists the feature). */
  _handleExtra(peer, name, a, t) {
    const reply = (data) => peer.send({ reply: { requestId: a.requestId, ok: true, ...data } });
    const fail = (e) => peer.send({ reply: { requestId: a.requestId, ok: false, error: e?.message ?? String(e) } });
    const run = (fn) => { try { const r = fn(); if (r?.then) r.then((d) => reply(d ?? {}), fail); else reply(r ?? {}); } catch (e) { fail(e); } };
    switch (name) {
      case 'listDirectory': run(() => ({ directory: listDirectory(a.path) })); break;
      case 'addProject': run(() => ({ projectId: this.addProject(a.path) })); break;
      case 'createProject': run(() => ({ projectId: this.createProject(a.name, a.git !== false, a.location) })); break;
      case 'removeProject': run(() => this.removeProject(String(a.projectId).toUpperCase(), !!a.deleteThreads)); break;
      case 'setSettings': run(() => this.setSettings(a.settings ?? {})); break;
      case 'renameThread': if (t) run(() => { t.title = String(a.title ?? '').trim().slice(0, 120) || t.title; t.aiTitled = true; this._changed(t); }); break;
      case 'deleteThread': if (t) run(() => this.deleteThread(t)); break;
      case 'regenerateTitle': if (t) run(() => this._aiTitle(t, true)); break;
      case 'loadOlder': if (t) run(() => {
        const have = Math.max(0, Number(a.have) || 0);
        const end = Math.max(0, t.items.length - have);
        return { items: t.items.slice(Math.max(0, end - 300), end), more: end > 300 };
      }); break;
      case 'gitStatus': if (t) run(() => ({ git: gitops.status(t.projectPath) })); break;
      case 'gitDiff': if (t) run(() => ({ diff: gitops.diff(t.projectPath, a.path || null) })); break;
      case 'gitCommit': if (t) run(async () => {
        const r = await gitops.commit(t.projectPath, { message: a.message, push: !!a.push });
        if (!r.ok) throw new Error(r.output);
        this._append(t, { id: uuid(), kind: 'notice', text: `${a.push ? 'Commit y push' : 'Commit'}: ${String(a.message).split('\n')[0]}` });
        this._changed(t);
        return { output: r.output };
      }); break;
      case 'gitMessage': if (t) run(async () => {
        const changes = gitops.diff(t.projectPath).slice(0, 30_000);
        if (!changes.trim()) throw new Error('No hay cambios sin commit');
        const text = await this._quick(`Escribe el mensaje de commit (en el idioma de los commits que veas; si no, en español) para estos cambios: una primera línea imperativa de menos de 70 caracteres y, si hace falta, un párrafo breve. Solo el mensaje.\n\n${changes}`);
        return { message: text.replace(/^```\w*\n?|```$/g, '').trim() };
      }); break;
      case 'usageReport': run(() => ({ usage: usageReport(this.threads.values(), this.accountsById, { days: Number(a.days) || 0 }) })); break;
      case 'addAccount': run(() => this.addAccount(a.account ?? {})); break;
      case 'turnChanges': if (t) run(() => {
        const it = this._item(t, a.itemId);
        if (!it?.turnBefore) throw new Error('Este turno no tiene instantánea (el proyecto no es git, o es anterior a esta versión)');
        return { changes: gitops.changesBetween(t.projectPath, it.turnBefore, it.turnAfter ?? null), finished: !!it.turnAfter };
      }); break;
      case 'restoreTurn': if (t) run(() => this.restoreTurn(t, a.itemId)); break;
      case 'restoreTree': if (t) run(() => this.restoreTree(t, a.tree)); break;
      case 'newWorktreeThread': run(() => ({ threadId: this.createWorktreeThread(String(a.projectId).toUpperCase()).id })); break;
      case 'mergeWorktree': if (t) run(() => this.mergeWorktree(t, a.message, a.remove !== false)); break;
      case 'removeWorktree': if (t) run(() => this.removeWorktree(t, !!a.deleteBranch)); break;
      case 'createTeam': run(() => this.teams.create(a.team ?? {})); break;
      case 'teamAction': run(() => this.teams.action(a.teamId, a.action)); break;
      case 'updateTeam': run(() => this.teams.update(String(a.teamId).toUpperCase(), a.changes ?? {})); break;
      case 'teamDecisions': run(() => this.teams.editDecisions(String(a.teamId).toUpperCase(), { add: a.add, remove: a.remove })); break;
      case 'pullRequest': if (t) run(async () => ({ pr: await gitops.pullRequest(t.projectPath) })); break;
      case 'createPullRequest': if (t) run(async () => {
        const url = await gitops.createPullRequest(t.projectPath);
        this._append(t, { id: uuid(), kind: 'notice', text: `PR creada: ${url}` });
        this._changed(t);
        return { url };
      }); break;
      case 'setQuickActions': run(() => this.setQuickActions(String(a.projectId).toUpperCase(), a.actions ?? [])); break;
      case 'runQuickAction': run(() => this.runQuickAction(t, String(a.projectId ?? t?.projectId ?? '').toUpperCase(), a.actionId)); break;
      case 'uploadImage': if (t) run(() => this.saveUpload(t, a.name, a.data)); break;
      case 'workState': if (t) run(() => ({ markdown: this.workStateMarkdown(t) })); break;
      case 'setupSharedMemory': run(() => this.setupSharedMemory(String(a.projectId).toUpperCase())); break;
      case 'updateAccount': run(() => this.updateAccount(String(a.accountId).toUpperCase(), a.account ?? {})); break;
      case 'removeAccount': run(() => this.removeAccount(String(a.accountId).toUpperCase())); break;
      case 'login': {
        const account = this.accountsById.get(String(a.accountId).toUpperCase());
        if (!account) { fail(new Error('Suscripción desconocida')); break; }
        if (!account.loginArgs) { fail(new Error(account.usesAPIKey ? 'Esta suscripción usa una API key: cámbiala en sus ajustes' : `${account.name} no inicia sesión desde Relevo: ábrelo una vez en una terminal del host`)); break; }
        this._startLogin(peer, a.requestId, account);
        break;
      }
      case 'loginInput': this.logins?.get(a.requestId)?.input(a.text ?? ''); break;
      case 'loginCancel': this.logins?.get(a.requestId)?.cancel(); break;
      case 'setDraft': if (t) this._suggestSoon(t, a.text ?? ''); break;
      case 'suggestion': if (t) this._suggestionAction(t, a.action); break;
      default: break; // registerLiveActivity: Mac only
    }
  }

  // MARK: - Projects, settings and threads (from the apps)

  _projectsRoot() { return path.resolve(this.settings.projectsRoot); }

  addProject(dir) {
    const p = path.resolve(String(dir ?? ''));
    if (!fs.statSync(p).isDirectory()) throw new Error('No es una carpeta');
    const s = this.state;
    s.hiddenProjects = s.hiddenProjects.filter((x) => x !== p);
    if (path.dirname(p) !== this._projectsRoot() && !s.extraProjects.includes(p)) s.extraProjects.push(p);
    this._projectsChanged();
    return uuidFrom(p);
  }

  createProject(name, git, location) {
    const clean = String(name ?? '').trim();
    if (!clean || /[\\/:*?"<>|]/.test(clean) || clean.startsWith('.')) throw new Error('Nombre de carpeta no válido');
    const p = path.join(location ? path.resolve(String(location)) : this._projectsRoot(), clean);
    if (fs.existsSync(p)) throw new Error(`Ya existe ${p}`);
    fs.mkdirSync(p, { recursive: true });
    if (git) gitops.initRepo(p);
    return this.addProject(p);
  }

  removeProject(projectId, deleteThreads) {
    const project = this.projects().find((x) => x.id === projectId);
    if (!project) throw new Error('Proyecto desconocido');
    const s = this.state;
    s.extraProjects = s.extraProjects.filter((x) => x !== project.path);
    if (path.dirname(project.path) === this._projectsRoot() && !s.hiddenProjects.includes(project.path)) s.hiddenProjects.push(project.path);
    if (deleteThreads) for (const t of [...this.threads.values()]) if (t.projectId === projectId) this.deleteThread(t, false);
    this._projectsChanged();
    return {};
  }

  _projectsChanged() {
    this.projectsCache.at = 0;
    this._saveState();
    this._broadcastSnapshot();
  }

  setSettings(changes) {
    const next = { ...this.state.settings };
    if ('projectsRoot' in changes) {
      const p = path.resolve(String(changes.projectsRoot));
      fs.mkdirSync(p, { recursive: true });
      next.projectsRoot = p;
    }
    if ('defaultMode' in changes && MODES.has(changes.defaultMode)) next.defaultMode = changes.defaultMode;
    if ('defaultAccountId' in changes) next.defaultAccountId = this.accountsById.has(changes.defaultAccountId) ? changes.defaultAccountId : null;
    if ('maxAgents' in changes) next.maxAgents = Math.min(8, Math.max(1, Math.round(Number(changes.maxAgents) || 1)));
    if ('limitPlan' in changes) next.limitPlan = this._validPlan(changes.limitPlan);
    if ('relayDelay' in changes) next.relayDelay = Math.min(300, Math.max(0, Math.round(Number(changes.relayDelay) || 0)));
    if ('aiTitles' in changes) next.aiTitles = !!changes.aiTitles;
    if ('suggest' in changes) next.suggest = !!changes.suggest;
    if ('suggestMode' in changes && ['off', 'suggest', 'auto'].includes(changes.suggestMode)) { next.suggestMode = changes.suggestMode; next.suggest = changes.suggestMode !== 'off'; }
    if ('probeMinutes' in changes && [5, 10, 15, 30, 60].includes(Number(changes.probeMinutes))) next.probeMinutes = Number(changes.probeMinutes);
    if (changes.cliPaths && typeof changes.cliPaths === 'object') {
      const paths = { ...(next.cliPaths ?? {}) };
      for (const [k, v] of Object.entries(changes.cliPaths)) {
        if (!['claude', 'codex', 'antigravity', 'gemini'].includes(k)) continue;
        const p = String(v ?? '').trim().replace(/^"(.*)"$/, '$1');
        if (!p) { delete paths[k]; continue; }
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw new Error(`No existe el programa ${p}`);
        paths[k] = p;
      }
      next.cliPaths = paths;
    }
    this.state.settings = next;
    if (changes.cliPaths) { this._rescanCLIs(true); this.refreshUsage(); }
    this._projectsChanged();
    for (const t of this.threads.values()) if (this.peers.size) this._schedulePatch(t);
    return {};
  }

  _validPlan(plan) {
    const mode = PLAN_MODES.has(plan?.mode) ? plan.mode : 'ask';
    const targets = (plan?.targets ?? []).filter((x) => this.accountsById.has(String(x.accountId).toUpperCase()))
      .map((x) => ({ accountId: String(x.accountId).toUpperCase(), model: String(x.model || 'default') }));
    return { mode: mode === 'chain' && !targets.length ? 'ask' : mode, targets };
  }

  deleteThread(t, broadcast = true) {
    const r = this._rt(t);
    clearTimeout(r.relayTimer);
    clearTimeout(t._saveTimer);
    this.agents.get(t.id)?.close();
    this.agents.delete(t.id);
    this.threads.delete(t.id);
    this.runtime.delete(t.id);
    this.teams?.forget(t.id);
    fs.rmSync(path.join(this.config.threadsDir, `${t.id}.json`), { force: true });
    if (broadcast) { this._saveState(); this._broadcastSnapshot(); }
    return {};
  }

  _quick(prompt) {
    return quickCompletion(this.accounts, prompt, { cwd: this.config.dataDir, fake: this.config.fakeAgent });
  }

  // MARK: - Turns, worktrees, quick actions and attachments

  restoreTurn(t, itemId) {
    if (this._rt(t).isRunning) throw new Error('Detén el agente antes de restaurar');
    const it = this._item(t, itemId);
    if (!it?.turnBefore) throw new Error('Este turno no tiene instantánea');
    const redo = gitops.snapshot(t.projectPath);
    gitops.restore(t.projectPath, it.turnBefore);
    const quoted = it.text.split('\n')[0].slice(0, 80);
    this._append(t, { id: uuid(), kind: 'notice', text: `Ficheros restaurados a antes de «${quoted}»`, redoTree: redo });
    // The agent's session still remembers what it did: tell it with the next message.
    t.restoreNote = `(Nota de Relevo: el usuario ha restaurado los ficheros del proyecto al estado de antes de su mensaje «${quoted}». Lo que hiciste desde entonces ya no está en disco.)`;
    this._changed(t);
    return {};
  }

  restoreTree(t, tree) {
    if (this._rt(t).isRunning) throw new Error('Detén el agente antes de restaurar');
    if (!t.items.some((i) => i.redoTree === tree)) throw new Error('Instantánea desconocida');
    gitops.restore(t.projectPath, tree);
    this._append(t, { id: uuid(), kind: 'notice', text: 'Restauración deshecha: los ficheros vuelven a como estaban' });
    t.restoreNote = '(Nota de Relevo: el usuario ha deshecho la restauración; los ficheros vuelven a estar como los dejaste.)';
    this._changed(t);
    return {};
  }

  /** A thread in its own git worktree and branch, so its agent doesn't step on the main folder (as on the Mac). */
  createWorktreeThread(projectId) {
    const project = this.projects().find((p) => p.id === projectId);
    if (!project) throw new Error('Proyecto desconocido');
    const short = crypto.randomBytes(3).toString('hex');
    const branch = `relevo/${short}`;
    const dir = path.join(this.config.dataDir, 'worktrees', `${path.basename(project.path)}-${short}`);
    const wt = gitops.addWorktree(project.path, dir, branch);
    const t = this.createThread(projectId);
    t.projectPath = wt.path;
    t.worktree = wt;
    this._append(t, { id: uuid(), kind: 'notice', text: `Worktree en la rama ${branch} (desde ${wt.base ?? 'HEAD'}): los cambios no tocan la carpeta del proyecto hasta que fusiones` });
    this._changed(t);
    return t;
  }

  async mergeWorktree(t, message, remove) {
    if (!t.worktree) throw new Error('Este hilo no está en un worktree');
    if (this._rt(t).isRunning) throw new Error('Detén el agente antes de fusionar');
    const out = await gitops.mergeWorktree(t.worktree, message);
    const { branch, base } = t.worktree;
    if (remove) this.removeWorktree(t, true, false);
    this._append(t, { id: uuid(), kind: 'notice', text: `Rama ${branch} fusionada en ${base}${remove ? '; worktree eliminado' : ''}` });
    this._changed(t);
    return { output: out };
  }

  removeWorktree(t, deleteBranch, notice = true) {
    if (!t.worktree) throw new Error('Este hilo no está en un worktree');
    this.agents.get(t.id)?.close();
    this.agents.delete(t.id);
    gitops.removeWorktree(t.worktree, deleteBranch);
    const { branch, repo } = t.worktree;
    t.projectPath = repo;
    t.worktree = null;
    t.sessionId = null;
    t.handoffPending = t.items.some((i) => i.kind === 'user');
    if (notice) this._append(t, { id: uuid(), kind: 'notice', text: `Worktree eliminado${deleteBranch ? ` y rama ${branch} borrada` : ''}: el hilo sigue en la carpeta del proyecto` });
    this._changed(t);
    return {};
  }

  setQuickActions(projectId, actions) {
    const project = this.projects().find((p) => p.id === projectId);
    if (!project) throw new Error('Proyecto desconocido');
    const list = actions.map((x) => ({ id: x.id || uuid(), name: String(x.name ?? '').trim().slice(0, 40), command: String(x.command ?? '').trim() }))
      .filter((x) => x.name && x.command).slice(0, 20);
    if (list.length) this.state.quickActions[project.path] = list; else delete this.state.quickActions[project.path];
    this._projectsChanged();
    return {};
  }

  /** Runs one of the project's commands (tests, build…) where the thread works; its output can go to the agent. */
  runQuickAction(t, projectId, actionId) {
    const project = this.projects().find((p) => p.id === (t?.projectId ?? projectId));
    const action = project && (this.state.quickActions[project.path] ?? []).find((x) => x.id === actionId);
    if (!action) throw new Error('Acción desconocida');
    const cwd = t?.projectPath ?? project.path;
    return new Promise((resolve) => {
      const shell = process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${action.command}"`], { cwd, env: this.config.agentEnv, windowsVerbatimArguments: true, windowsHide: true })
        : spawn('sh', ['-c', action.command], { cwd, env: this.config.agentEnv, detached: true });
      shell.relevoGroup = process.platform !== 'win32';
      let output = '';
      const add = (d) => { output = (output + d).slice(-200_000); };
      shell.stdout.on('data', add);
      shell.stderr.on('data', add);
      const timer = setTimeout(() => killTree(shell), 10 * 60_000);
      shell.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: e.message, name: action.name }); });
      shell.on('close', (code) => { clearTimeout(timer); resolve({ code, output, name: action.name }); });
    });
  }

  /** An image pasted in the composer, kept in the data folder; the message names its path for the agent. */
  saveUpload(t, name, data) {
    const safe = path.basename(String(name || 'imagen.png')).replace(/[^\w.-]+/g, '_').slice(-60);
    if (!IMAGE_UPLOAD.test(safe)) throw new Error('Solo imágenes PNG, JPEG, GIF o WebP');
    const buf = Buffer.from(String(data ?? ''), 'base64');
    if (!buf.length || buf.length > 10 << 20) throw new Error('La imagen está vacía o pasa de 10 MB');
    const dir = path.join(this.config.dataDir, 'uploads', t.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(file, buf);
    return { path: file };
  }

  /** The Mac's «Traza»: what another agent would get — the request in progress, the files touched and git. */
  workStateMarkdown(t) {
    const users = t.items.filter((i) => i.kind === 'user');
    const last = users.at(-1);
    const parts = [];
    if (last) parts.push(`## Petición en curso\n\n${last.text.trim()}`);
    const lastAssistant = [...t.items].reverse().find((i) => i.kind === 'assistant' && i.text?.trim());
    if (lastAssistant) parts.push(`## Dónde se quedó\n\n${lastAssistant.text.trim().slice(0, 1500)}`);
    const touched = new Map();
    for (const u of users) {
      if (!u.turnBefore || !u.turnAfter) continue;
      for (const f of gitops.changesBetween(t.projectPath, u.turnBefore, u.turnAfter).files) {
        const e = touched.get(f.path) ?? { added: 0, removed: 0 };
        e.added += f.added; e.removed += f.removed;
        touched.set(f.path, e);
      }
    }
    if (touched.size) parts.push(`## Ficheros modificados en este hilo\n\n${[...touched].map(([p, e]) => `- \`${p}\` (+${e.added} −${e.removed})`).join('\n')}`);
    const ws = gitops.workState(t.projectPath);
    if (ws) parts.push(`## Repositorio (git, ahora mismo)\n\n${ws}`);
    return parts.join('\n\n');
  }

  /** AGENTS.md shared by every agent, with CLAUDE.md and GEMINI.md importing it (as on the Mac). */
  setupSharedMemory(projectId) {
    const project = this.projects().find((p) => p.id === projectId);
    if (!project) throw new Error('Proyecto desconocido');
    const file = (n) => path.join(project.path, n);
    if (!fs.existsSync(file('AGENTS.md'))) fs.writeFileSync(file('AGENTS.md'), `# ${project.name}\n\nInstrucciones y contexto compartidos por todos los agentes que trabajan en este proyecto.\n`);
    for (const n of ['CLAUDE.md', 'GEMINI.md']) if (!fs.existsSync(file(n))) fs.writeFileSync(file(n), '@AGENTS.md\n');
    return {};
  }

  // MARK: - Relevo sugiere

  _suggestSoon(t, text) {
    const r = this._rt(t);
    clearTimeout(r.suggestTimer);
    if (!this.settings.suggest || r.suggestionDismissed) return;
    r.suggestTimer = setTimeout(() => this._suggest(t, text), 900);
  }

  /**
   * Which subscription and model suit the request being typed (a smaller «Relevo sugiere»): the size of the
   * task from the text, and the quota left. Only shown when it differs from the selection.
   */
  _suggest(t, text) {
    if (!this.threads.has(t.id)) return;
    const r = this._rt(t);
    const draft = String(text).trim();
    const previous = JSON.stringify(r.suggestion ?? null);
    r.suggestion = null;
    if (draft.length >= 12 && !r.isRunning) {
      const heavy = /refactori|arquitect|rediseñ|migra|investiga|depura|debug|implementa|optimiza|seguridad|concurren|rendimiento|desde cero|diseña|architecture|refactor|migrate|implement|redesign/i;
      const light = /^(qué|que|cómo|como|dónde|donde|por qué|explica|resume|traduce|renombra|corrige (la |el )?(errata|texto|typo)|what|how|where|why|explain|rename|typo)\b/i;
      const level = draft.length > 700 || heavy.test(draft) ? 'heavy' : draft.length < 160 && light.test(draft) ? 'light' : 'normal';
      const used = (a) => Math.max(0, ...(a.status?.windows ?? []).map((w) => w.percent));
      const usable = this.accounts.filter((a) => a.status?.loggedIn !== false && !this._exhausted(a) && used(a) < 97);
      const current = this._account(t);
      // Stay on the current subscription while it has room (switching costs context); else the one with most quota.
      const target = usable.includes(current) && used(current) < 85 ? current : [...usable].sort((x, y) => used(x) - used(y))[0];
      if (target) {
        const tier = { light: ['haiku', 'flash', 'mini'], normal: ['sonnet'], heavy: ['opus', 'pro', 'max'] }[level];
        const pick = tier.map((k) => target.models.find((m) => m.id !== 'default' && m.id.toLowerCase().includes(k))?.id).find(Boolean);
        const model = pick ?? (target.id === t.accountId ? t.model : 'default');
        if (target.id !== t.accountId || model !== t.model) {
          const reasons = [{ light: 'tarea sencilla: basta un modelo rápido', normal: 'tarea normal', heavy: 'tarea compleja: mejor el modelo más capaz' }[level]];
          if (target.id !== t.accountId) reasons.push(current && !usable.includes(current) ? `${current.name} sin cuota` : `${target.name} tiene más cuota libre`);
          r.suggestion = { accountId: target.id, model, reasons, autoApplied: false, byAI: false };
          if (this.settings.suggestMode === 'auto') {
            r.suggestionUndo = { accountId: t.accountId, model: t.model };
            r.suggestion.autoApplied = true;
            this.select(t, target.id, model, false);
          }
        }
      }
    }
    if (JSON.stringify(r.suggestion) !== previous) this._changed(t, false);
  }

  _suggestionAction(t, action) {
    const r = this._rt(t);
    const sg = r.suggestion;
    if (action === 'accept' && sg) {
      r.suggestion = null;
      this.select(t, sg.accountId, sg.model, false);
    } else if (action === 'dismiss') {
      r.suggestionDismissed = true;
      this._changed(t, false);
    } else if (action === 'undo' && r.suggestionUndo) {
      const back = r.suggestionUndo;
      r.suggestionUndo = null;
      r.suggestion = null;
      r.suggestionDismissed = true;
      this.select(t, back.accountId, back.model, false);
    }
  }

  // MARK: - Subscriptions

  _buildAccounts() {
    const old = new Map((this.accounts ?? []).map((a) => [a.id, a]));
    const ctx = { bins: this.config.bins ?? {}, agentEnv: this.config.agentEnv, dataDir: this.config.dataDir };
    this.accounts = this.state.accountList.map((def) => {
      const a = buildAccount(def, ctx);
      if (!a) return null;
      const prev = old.get(def.id);
      if (prev) { a.status = prev.status; a.refreshing = prev.refreshing; }
      const stored = this.state.models[def.id] ?? this.state.models[def.type];
      if (def.type !== 'api' && Array.isArray(stored) && stored.length) a.models = stored;
      return a;
    }).filter(Boolean);
    this.accountsById = new Map(this.accounts.map((a) => [a.id, a]));
    // Subscriptions of providers Relevo no longer offers go away.
    this.state.accountList = this.state.accountList.filter((d) => this.accountsById.has(d.id));
  }

  /** What the apps need to show and edit each subscription (never the key itself). */
  _accountDefs() {
    return this.state.accountList.map((d) => clean({
      id: d.id, type: d.type, preset: d.preset, name: d.name, baseURL: d.baseURL, main: d.main, fast: d.fast, command: d.command,
      args: d.args, models: d.models?.map((m) => m.id), hasKey: d.type === 'api' ? !!d.apiKey : undefined,
    }));
  }

  _defFrom(changes, def = {}) {
    const next = { ...def };
    if (changes.name !== undefined) next.name = String(changes.name).trim().slice(0, 60) || def.name;
    if (changes.apiKey) next.apiKey = String(changes.apiKey).trim();
    if (changes.baseURL !== undefined) next.baseURL = String(changes.baseURL).trim() || undefined;
    if (changes.models !== undefined) {
      const ids = (Array.isArray(changes.models) ? changes.models : String(changes.models).split(',')).map((x) => String(x).trim()).filter(Boolean);
      next.models = ids.length ? ids.map((id) => ({ id, name: id })) : undefined;
    }
    for (const k of ['main', 'fast', 'command']) if (changes[k] !== undefined) next[k] = String(changes[k]).trim() || undefined;
    if (Array.isArray(changes.hiddenModels)) next.hiddenModels = changes.hiddenModels.map(String).filter((id) => id !== 'default');
    if (changes.args !== undefined) next.args = (Array.isArray(changes.args) ? changes.args : String(changes.args).split(' ')).map((x) => String(x).trim()).filter(Boolean);
    return next;
  }

  addAccount(changes) {
    const type = String(changes.type);
    if (!TYPES.includes(type)) throw new Error('Tipo de suscripción desconocido');
    const presets = type === 'api' ? API_PRESETS : type === 'acp' ? ACP_PRESETS : null;
    const preset = presets ? (presets[changes.preset] ? changes.preset : 'custom') : undefined;
    const count = this.state.accountList.filter((d) => d.type === type && d.preset === preset).length;
    const baseName = presets ? presets[preset].name : PROVIDERS[type].name;
    const def = this._defFrom(changes, { id: uuid(), type, preset, name: count ? `${baseName} ${count + 1}` : baseName });
    if (type === 'antigravity' && count) def.isolated = true; // a second Google login needs its own HOME
    if (type === 'api' && preset === 'custom' && !def.baseURL) throw new Error('Falta la URL de la API');
    if (type === 'acp' && preset === 'custom' && !def.command) throw new Error('Falta el comando del agente');
    this.state.accountList.push(def);
    this._accountsChanged();
    this._refreshAccount(this.accountsById.get(def.id));
    return { accountId: def.id };
  }

  updateAccount(id, changes) {
    const i = this.state.accountList.findIndex((d) => d.id === id);
    if (i < 0) throw new Error('Suscripción desconocida');
    this.state.accountList[i] = this._defFrom(changes, this.state.accountList[i]);
    this._closeAgentsOf(id); // they started with the old settings
    this._accountsChanged();
    this._refreshAccount(this.accountsById.get(id));
    return {};
  }

  removeAccount(id) {
    if (!this.state.accountList.some((d) => d.id === id)) throw new Error('Suscripción desconocida');
    this._closeAgentsOf(id);
    this.state.accountList = this.state.accountList.filter((d) => d.id !== id);
    if (this.state.settings.defaultAccountId === id) this.state.settings.defaultAccountId = null;
    this._accountsChanged();
    return {};
  }

  _closeAgentsOf(accountId) {
    for (const [threadId, s] of this.agents) {
      const t = this.threads.get(threadId);
      if (t?.accountId === accountId && !this._rt(t).isRunning) { s.close(true); this.agents.delete(threadId); }
    }
  }

  _accountsChanged() {
    this._buildAccounts();
    this._saveState();
    this._broadcastSnapshot();
    for (const t of this.threads.values()) if (this.peers.size) this._schedulePatch(t);
  }

  /** A short title from what the thread is about (after its first turn, or when asked). */
  async _aiTitle(t, force = false) {
    if (!force && (t.aiTitled || !this.settings.aiTitles)) return {};
    const text = t.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').slice(0, 6)
      .map((i) => `${i.kind === 'user' ? 'Usuario' : 'Asistente'}: ${i.text.slice(0, 1500)}`).join('\n\n');
    if (!text) return {};
    t.aiTitled = true;
    const title = cleanTitle(await this._quick(`Pon un título breve (3 a 7 palabras, sin comillas ni punto final, en el idioma del usuario) a esta conversación con un agente de programación. Responde solo con el título.\n\n${text}`));
    if (title && this.threads.has(t.id)) { t.title = title; this._changed(t); }
    return { title };
  }

  _startLogin(peer, requestId, account) {
    this.logins ??= new Map();
    if (account.loginInTerminal && account.loginDone && !this.config.fakeAgent) return this._terminalLogin(peer, requestId, account);
    for (const dir of [this.config.claudeConfigDir, this.config.codexHome]) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(account.home, { recursive: true });
    const session = new LoginSession({ bin: account.bin, args: account.loginArgs, env: account.env, cwd: this.config.dataDir, doneWhen: account.loginDone });
    this.logins.set(requestId, session);
    const send = (o) => peer.send({ loginOutput: { requestId, accountId: account.id, ...o } });
    session.on('output', (text) => send({ text }));
    session.on('done', ({ ok, error }) => {
      this.logins.delete(requestId);
      send({ done: true, ok, error });
      this._refreshAccount(account);
    });
    peer.once('close', () => session.cancel());
    send({ text: '' });
  }

  /**
   * A sign-in that only works in a real terminal (agy): the apps show the command to run on this machine, and
   * the sign-in is done when the CLI writes its login file.
   */
  _terminalLogin(peer, requestId, account) {
    const same = this.accounts.filter((a) => a.provider === account.provider);
    const arg = same.length > 1 || /\s/.test(account.provider) ? `"${account.name}"` : account.provider;
    const command = `relevo-host login ${arg}`;
    const send = (o) => peer.send({ loginOutput: { requestId, accountId: account.id, ...o } });
    const since = Date.now();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      this.logins.delete(requestId);
      send({ done: true, ok, error });
      if (ok) this._refreshAccount(account);
    };
    const poll = setInterval(() => { if (account.loginDone(since)) finish(true, null); }, 1500);
    const timer = setTimeout(() => finish(false, 'Se ha agotado el tiempo'), 30 * 60_000);
    this.logins.set(requestId, { input() {}, cancel: () => finish(false, 'Cancelado') });
    peer.once('close', () => finish(false, 'Cancelado'));
    send({ terminal: command, text: '' });
  }

  // MARK: - Projects and threads

  projects() {
    if (Date.now() - this.projectsCache.at < 5000) return this.projectsCache.list;
    // Every subfolder of the projects folder (unless removed from Relevo) plus folders added from anywhere.
    const root = this._projectsRoot();
    const hidden = new Set(this.state.hiddenProjects);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
    const paths = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)).map((e) => path.join(root, e.name));
    for (const p of this.state.extraProjects) {
      try { if (fs.statSync(p).isDirectory()) paths.push(p); } catch {}
    }
    const list = [...new Set(paths)].filter((p) => !hidden.has(p))
      .map((p) => clean({ id: uuidFrom(p), name: path.basename(p), path: p, quickActions: this.state.quickActions[p]?.length ? this.state.quickActions[p] : null }))
      .sort((x, y) => x.name.localeCompare(y.name));
    this.projectsCache = { at: Date.now(), list };
    return list;
  }

  _account(t) { return this.accountsById.get(t.accountId) ?? this.accounts[0]; }

  _modelName(account, id) {
    const name = account?.models.find((m) => m.id === id)?.name ?? (!id || id === 'default' ? 'Predeterminado' : id);
    return /^Predeterminado \((.+)\)$/.exec(name)?.[1] ?? name;
  }

  /** The account a new thread starts on: the first signed in with quota left, in the configured order. */
  _defaultAccount() {
    const preferred = this.accountsById.get(this.settings.defaultAccountId);
    if (preferred && preferred.status?.loggedIn !== false && !this._exhausted(preferred)) return preferred;
    return this.accounts.find((a) => a.status?.loggedIn !== false && !this._exhausted(a)) ?? this.accounts[0];
  }

  _exhausted(a) { return (a.status?.windows ?? []).some((w) => w.percent >= 99.5 && (w.resetsAt ?? Infinity) > now()); }

  createThread(projectId) {
    const project = this.projects().find((p) => p.id === projectId);
    if (!project) return null;
    const account = this._defaultAccount();
    const t = {
      id: uuid(), projectId, projectPath: project.path, title: 'Nuevo hilo', createdAt: now(), updatedAt: now(),
      accountId: account?.id, model: 'default', effort: null, mode: this.settings.defaultMode, sessionId: null, handoffPending: false,
      items: [], totalItems: 0, queued: [], queuePaused: false,
    };
    this.threads.set(t.id, t);
    this._saveThread(t);
    this._broadcastSnapshot();
    return t;
  }

  _rt(t) {
    let r = this.runtime.get(t.id);
    if (!r) {
      r = { isRunning: false, statusLine: null, limit: null, approvals: new Map(), keys: new Map(), dirty: new Set(), sendNow: null, finishedAt: null, pendingSwitch: null };
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

  _touch(t, item) { this._rt(t).dirty.add(item.id); }

  send(t, text) {
    if (!text?.trim()) return;
    this.teams.userSpoke(t);
    if (t.attention) { delete t.attention; this._broadcastSnapshot(); } // you've answered
    if (this._rt(t).isRunning) {
      t.queued.push({ id: uuid(), text });
      this._changed(t);
      return;
    }
    this._startTurn(t, text);
  }

  sendNow(t, text, meta = null) {
    if (!text?.trim()) return;
    const r = this._rt(t);
    if (!r.isRunning) { this._startTurn(t, text, false, meta ?? {}); return; }
    r.sendNow = text;
    r.sendNowMeta = meta;
    r.statusLine = meta?.from ? `Interrumpido por ${meta.from.name}…` : 'Interrumpiendo para enviar tu mensaje…';
    this.agents.get(t.id)?.interrupt();
    this._changed(t);
  }

  stop(t) {
    const r = this._rt(t);
    if (!r.isRunning) return;
    t.queuePaused = t.queued.length > 0;
    r.stopRequested = true;
    r.statusLine = 'Deteniendo…';
    this.agents.get(t.id)?.interrupt();
    this._changed(t);
    // An agent that ignores the interrupt (or hasn't started its turn yet) is stopped by force.
    clearTimeout(r.stopTimer);
    r.stopTimer = setTimeout(() => {
      if (!r.isRunning) return;
      this.agents.get(t.id)?.close(true);
      setTimeout(() => {
        if (!r.isRunning) return;
        r.isRunning = false;
        r.statusLine = null;
        r.approvals.clear();
        const stopped = r.turnUserItem && this._item(t, r.turnUserItem);
        if (stopped) stopped.done = true; // stopped by you: not to be resumed after a restart
        this._append(t, { id: uuid(), kind: 'notice', text: 'Detenido' });
        this._changed(t);
      }, 2000);
    }, 8000);
  }

  /**
   * Model or subscription for the thread. Another provider means a new agent that gets the thread's context
   * with the next message (`relay` sends that message right away, to carry on with the task).
   */
  select(t, accountId, model, carryOn) {
    const target = this.accountsById.get(accountId) ?? this._account(t);
    const r = this._rt(t);
    if (target.id === t.accountId) {
      const before = t.model;
      t.model = model || 'default';
      this.agents.get(t.id)?.setModel(t.model);
      if (before !== t.model && t.items.length) this._append(t, { id: uuid(), kind: 'notice', text: `Modelo cambiado a ${this._modelName(target, t.model)}` });
      this._changed(t);
      if (carryOn && !r.isRunning) this._startTurn(t, 'Sigue con la tarea donde lo dejaste.');
      return;
    }
    if (r.isRunning) {
      r.pendingSwitch = { accountId: target.id, model, carryOn };
      r.statusLine = `Cambiará a ${target.name} al terminar este turno`;
      this._changed(t);
      return;
    }
    this.agents.get(t.id)?.close();
    this.agents.delete(t.id);
    const from = this._account(t);
    const fromModel = t.model;
    t.accountId = target.id;
    t.model = model || 'default';
    t.effort = null;
    t.sessionId = null;
    t.handoffPending = t.items.some((i) => i.kind === 'user');
    r.limit = null;
    r.sessionTokens = 0;
    r.context = null;
    this._append(t, {
      id: uuid(), kind: 'notice', accountId: target.id,
      text: `Relevo: ${from.name} · ${this._modelName(from, fromModel)} → ${target.name} · ${this._modelName(target, t.model)}${t.handoffPending ? ' · contexto y traza traspasados' : ''}`,
    });
    this._changed(t);
    if (carryOn && t.handoffPending) this._startTurn(t, 'Sigue con la tarea donde lo dejó el agente anterior.', true);
  }

  _diskProblem(t) {
    const gb = (n) => (n / 1e9).toFixed(1);
    const data = freeBytes(this.config.dataDir), proj = freeBytes(t.projectPath ?? this.config.projectsRoot);
    if (data < this.config.minFreeDataBytes) return `Queda poco espacio para los datos del host (${gb(data)} GB libres en ${this.config.dataDir}).`;
    if (proj < this.config.minFreeProjectsBytes) return `Queda poco espacio en el disco de proyectos (${gb(proj)} GB libres).`;
    return null;
  }

  _startTurn(t, text, pendingRequest = false, meta = {}) {
    const r = this._rt(t);
    const account = this._account(t);
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
    if (!account) {
      this._append(t, { id: uuid(), kind: 'error', text: `No hay ningún agente configurado en ${this.config.name}.` });
      this._changed(t);
      return;
    }
    if (!this.config.fakeAgent && !account.bin && (this._rescanCLIs(true), !this._account(t)?.bin)) {
      this._append(t, { id: uuid(), kind: 'error', text: `No puedo arrancar ${account.agentName}: ${this._missingCLI(account)}` });
      this._changed(t);
      return;
    }
    if (this.pendingRestart) {
      t.queued.unshift({ id: uuid(), text, prompt: meta.prompt, from: meta.from, team: !!meta.from });
      if (!t.resumeAfterRestart) this._append(t, { id: uuid(), kind: 'notice', text: `Relevo se está actualizando a ${this.pendingRestart.version}: lo que está en cola sale en cuanto se reinicie` });
      t.resumeAfterRestart = true;
      this._changed(t);
      this._saveState();
      return;
    }
    if (!this._agentSlot(t)) {
      t.queued.unshift({ id: uuid(), text, prompt: meta.prompt, from: meta.from, team: !!meta.from });
      r.statusLine = `Esperando: ya hay ${this.settings.maxAgents} agentes trabajando en ${this.config.name}`;
      this._changed(t);
      return;
    }
    if (t.title === 'Nuevo hilo') {
      const first = text.trim().split('\n')[0];
      t.title = first.length > 60 ? `${first.slice(0, 57)}…` : first;
    }
    let prompt = meta.prompt ?? text;
    const teamPrefix = this.teams.promptPrefix(t, t.handoffPending);
    if (t.handoffPending) {
      const accounts = new Map(this.accounts.map((a) => [a.id, a]));
      const workState = gitops.workState(t.projectPath);
      const traceFile = saveTrace({ dir: this._traceDir(t), threadId: t.id, title: t.title, items: t.items, accounts, workState });
      prompt = handoffText({ items: t.items, accounts, projectPath: t.projectPath, target: account, pendingRequest, workState, traceFile, fresh: !!t.freshSession }) + text;
      t.freshSession = false;
      t.handoffPending = false;
    }
    if (t.restoreNote) { prompt = `${t.restoreNote}\n\n${prompt}`; t.restoreNote = null; }
    prompt = teamPrefix + prompt;
    // The project as it was before this turn, to show what the turn changed and to go back to it.
    const turnBefore = gitops.snapshot(t.projectPath);
    const userItem = this._append(t, { id: uuid(), kind: 'user', text, turnBefore, from: meta.from, started: true });
    r.turnUserItem = userItem.id;
    r.sentOrders = new Set();
    r.waitingTimer = false;
    r.stopRequested = false;
    r.suggestion = null;
    r.suggestionDismissed = false;
    this._clearLimitTimers(t);
    r.isRunning = true;
    r.limit = null;
    r.turnItems = [];
    r.statusLine = t.items.filter((i) => i.kind === 'user').length > 1 ? 'Pensando…' : `Iniciando ${account.agentName}…`;
    t.updatedAt = now();
    this._agent(t).send(prompt);
    this._changed(t);
  }

  /**
   * Where a handoff's full conversation goes: inside the project (.relevo/trazas, kept out of git), where the
   * next agent can read it without asking; outside a repository, the host's data folder.
   */
  _traceDir(t) {
    if (gitops.exclude(t.projectPath, '/.relevo/')) return path.join(t.projectPath, '.relevo', 'trazas');
    return path.join(this.config.dataDir, 'handoffs');
  }

  /** Room for one more agent process: closes the longest-idle one when needed. */
  _agentSlot(t) {
    if (this.agents.get(t.id)?.alive) return true;
    const alive = [...this.agents.entries()].filter(([, s]) => s.alive);
    if (alive.length < this.settings.maxAgents) return true;
    const idle = alive.filter(([id, s]) => !s.turnActive && !this._rt(this.threads.get(id)).approvals.size && !this._rt(this.threads.get(id)).backgroundTasks?.length)
      .sort(([, a], [, b]) => a.lastActive - b.lastActive);
    if (!idle.length) return false;
    idle[0][1].close(true);
    return true;
  }

  _agent(t) {
    let s = this.agents.get(t.id);
    if (s) return s;
    const r0 = this._rt(t);
    const account = this._account(t);
    const Session = this.config.fakeAgent ? FakeSession : account.Session;
    r0.backgroundTasks = []; // a new process: nothing of the old one is still running
    s = new Session({
      bin: account.bin, args: account.args, cwd: t.projectPath, env: account.env, model: t.model, effort: t.effort, mode: t.mode,
      resumeId: t.sessionId, agentName: account.agentName, loginHint: account.loginHint,
    });
    this.agents.set(t.id, s);
    const r = this._rt(t);
    const item = (key, make) => {
      let id = r.keys.get(key);
      let it = id && this._item(t, id);
      if (!it) { it = this._append(t, make()); r.keys.set(key, it.id); r.turnItems?.push(it.id); }
      return it;
    };
    const assistant = () => ({ id: uuid(), kind: 'assistant', text: '', accountId: account.id, model: t.model });
    s.on('session', (id) => { t.sessionId = id; this._saveThread(t); });
    s.on('models', (models) => { account.models = models; this._saveState(); this._broadcastSnapshot(); });
    s.on('status', (text) => { r.statusLine = text; this._changed(t, false); });
    s.on('textDelta', (key, text) => { r.waitingTimer = false; const it = item(`a:${key}`, assistant); it.text += text; this._touch(t, it); this._changed(t, false); });
    s.on('textFinal', (key, text) => { const it = item(`a:${key}`, assistant); it.text = text; this._touch(t, it); this._changed(t, false); });
    s.on('reasoningDelta', (key, text) => {
      const it = item(`r:${key}`, () => ({ id: uuid(), kind: 'reasoning', text: '' }));
      it.text += text; this._touch(t, it); this._changed(t, false);
    });
    s.on('reasoningFinal', (key, text) => {
      const it = item(`r:${key}`, () => ({ id: uuid(), kind: 'reasoning', text: '' }));
      it.text = text; this._touch(t, it); this._changed(t, false);
    });
    s.on('toolStarted', (key, name, title, input) => {
      const it = item(`t:${key}`, () => ({ id: uuid(), kind: 'tool', text: title, title, toolName: name, toolState: 'running' }));
      // Some agents (Antigravity) announce a tool before its parameters: the real title comes later.
      if (title && title !== name && it.title !== title) { it.title = title; it.text = title; }
      if (input?.command && !it.output) it.output = `$ ${input.command}`;
      if (t.team) {
        const said = (r.turnItems ?? []).map((id) => this._item(t, id)).filter((x) => x?.kind === 'assistant').map((x) => x.text).join('\n\n');
        this.teams.onToolStarted(t, name, title, input, said);
      }
      // Claude's plan, as a checklist: the handoff carries the latest one.
      if (name === 'TodoWrite' && Array.isArray(input?.todos)) {
        it.plan = input.todos.map((x) => `${x.status === 'completed' ? '[x]' : x.status === 'in_progress' ? '[~]' : '[ ]'} ${x.content ?? x.activeForm ?? ''}`).join('\n');
      }
      r.statusLine = title; this._touch(t, it); this._changed(t, false);
    });
    s.on('toolOutput', (key, text) => {
      const it = item(`t:${key}`, () => ({ id: uuid(), kind: 'tool', text: 'Comando', toolState: 'running' }));
      it.output = ((it.output ?? '') + text).slice(-4000); this._touch(t, it); this._changed(t, false);
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
      r.statusLine = it.questions?.length ? 'Esperando tu respuesta…' : 'Esperando tu aprobación…';
      if (this.teams.onApproval(t, it, req)) return;
      this._changed(t);
    });
    s.on('notice', (text) => { this._append(t, { id: uuid(), kind: 'notice', text }); this._changed(t); });
    s.on('backgroundTasks', (list) => { r.backgroundTasks = list; this._changed(t); this._checkRestart(); });
    s.on('context', (used, window) => { r.context = { used, window: window ?? null }; });
    s.on('failure', (f) => {
      this._append(t, { id: uuid(), kind: 'error', text: f.message, accountId: account.id });
      if (f.kind === 'auth') {
        account.status = { ...(account.status ?? {}), loggedIn: false, error: 'Sin sesión: Ajustes › Suscripciones › Iniciar sesión' };
        this._append(t, { id: uuid(), kind: 'notice', text: `Inicia sesión en ${account.name} en ${this.config.name}: Ajustes › Suscripciones (o «relevo-host login» en el host).` });
      }
      if (f.kind === 'limit' || f.kind === 'unavailable') {
        r.limit = { accountId: account.id, message: f.message, resetsAt: f.resetsAt ?? null, isCapacity: f.kind === 'unavailable', isNoPlan: false };
        if (f.kind === 'limit') r.limitHit = true;
      }
      if (f.kind === 'sessionLost') {
        // The CLI lost its session: a fresh one gets the thread's context instead.
        t.sessionId = null;
        t.handoffPending = t.items.some((i) => i.kind === 'user');
        this.agents.delete(t.id);
      }
      if (t.queued.length) t.queuePaused = true;
      this._changed(t);
    });
    s.on('usage', ({ windows, plan }) => {
      account.status = { ...(account.status ?? {}), loggedIn: true, windows, plan: plan ?? account.status?.plan ?? null, updatedAt: now() };
      this._broadcastSnapshot();
    });
    s.on('tokens', (u) => {
      // Antigravity says the conversation's total; the others are added up turn by turn.
      r.sessionTokens = u.conversationTotal ?? ((r.sessionTokens ?? 0) + (u.tokens ?? 0));
      const lastAssistant = [...(r.turnItems ?? [])].reverse().map((id) => this._item(t, id)).find((x) => x?.kind === 'assistant');
      const target = lastAssistant ?? t.items[t.items.length - 1];
      if (!target) return;
      target.usage = clean({ tokens: u.tokens, cacheShare: u.cacheShare, cost: u.cost, costEstimated: true, paid: false });
      this._touch(t, target);
    });
    s.on('turnStarted', (reason) => {
      r.isRunning = true;
      r.turnItems = [];
      r.statusLine = `${account.name} retoma por su cuenta…`;
      if (reason) this._append(t, { id: uuid(), kind: 'notice', text: reason });
      this._changed(t);
    });
    s.on('turnFinished', () => {
      // A turn that ran means the account is signed in, whatever the last probe said.
      if (account.status?.loggedIn === false && !r.limit) this._refreshAccount(account);
      r.isRunning = false;
      r.statusLine = null;
      r.finishedAt = Date.now();
      const userItem = r.turnUserItem && this._item(t, r.turnUserItem);
      if (userItem) userItem.done = true;
      if (userItem?.turnBefore) {
        userItem.turnAfter = gitops.snapshot(t.projectPath);
        // «3 ficheros · +40 −12» under the reply: what this turn changed.
        const files = userItem.turnAfter && userItem.turnAfter !== userItem.turnBefore ? gitops.changesBetween(t.projectPath, userItem.turnBefore, userItem.turnAfter).files : [];
        userItem.turnChanges = files.length ? { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) } : null;
        this._touch(t, userItem);
      }
      for (const [id] of r.approvals) {
        const it = this._item(t, id);
        if (it && !it.resolution) { it.resolution = 'Sin respuesta'; this._touch(t, it); }
      }
      r.approvals.clear();
      r.keys.clear();
      t.updatedAt = now();
      this._changed(t);
      if (t.team && !r.limitHit && !r.sendNow && !r.stopRequested && !r.pendingSwitch) {
        // Only what's new since the last report (a turn the agent resumed by itself continues the same request).
        const start = Math.max(userItem ? t.items.indexOf(userItem) + 1 : 0, r.reportedUpTo?.get(userItem?.id) ?? 0);
        const turn = t.items.slice(start);
        r.reportedUpTo = new Map([[userItem?.id, t.items.length]]);
        this.teams.onTurnFinished(t, {
          text: turn.filter((i) => i.kind === 'assistant' && i.text).map((i) => i.text).join('\n\n'),
          changes: userItem?.turnChanges ?? null,
          errors: turn.filter((i) => i.kind === 'error').map((i) => i.text),
          background: r.backgroundTasks ?? [],
        });
      }
      if (r.pendingSwitch) {
        const { accountId, model, carryOn } = r.pendingSwitch;
        r.pendingSwitch = null;
        this.select(t, accountId, model, carryOn);
        return;
      }
      if (r.sendNow) { const text = r.sendNow, meta = r.sendNowMeta ?? {}; r.sendNow = null; r.sendNowMeta = null; this._startTurn(t, text, false, meta); return; }
      this._checkRestart();
      if (r.limitHit) { r.limitHit = false; this._onLimit(t); return; }
      if (!t.aiTitled && t.items.some((i) => i.kind === 'assistant' && i.text)) this._aiTitle(t).catch(() => {});
      this._next(t);
      for (const other of this.threads.values()) if (other !== t && other.queued.length && !this._rt(other).isRunning && !other.queuePaused) this._next(other);
    });
    return s;
  }

  _next(t) {
    const r = this._rt(t);
    if (r.isRunning || t.queuePaused || !t.queued.length) return;
    const q = t.queued.shift();
    this._startTurn(t, q.text, false, { prompt: q.prompt, from: q.from });
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
    r.statusLine = 'Pensando…';
    this._touch(t, it);
    this._changed(t);
  }

  // MARK: - Running out of quota

  _planSummary(plan) {
    switch (plan?.mode) {
      case 'mostQuota': return 'pasar a la de más cuota';
      case 'wait': return 'esperar a que se reinicie y seguir';
      case 'chain': return plan.targets.map((x) => {
        const a = this.accountsById.get(x.accountId);
        return `${a?.name ?? '?'} · ${a?.models.find((m) => m.id === x.model)?.name ?? x.model}`;
      }).join(', luego ');
      default: return 'avisarme';
    }
  }

  _clearLimitTimers(t) {
    const r = this._rt(t);
    clearTimeout(r.relayTimer);
    r.relayTimer = null;
    r.pendingRelay = null;
    r.resumeAt = null;
  }

  /** The turn hit the quota: follow the thread's plan (or the host's): relay after a countdown, or wait. */
  _onLimit(t) {
    const r = this._rt(t);
    const plan = t.limitPlan ?? this.settings.limitPlan;
    const current = this._account(t);
    const usable = (a) => a && a !== current && a.status?.loggedIn !== false && !this._exhausted(a);
    const used = (a) => Math.max(0, ...(a.status?.windows ?? []).map((w) => w.percent));
    this._clearLimitTimers(t);
    let target = null;
    if (plan.mode === 'mostQuota') {
      const best = this.accounts.filter(usable).sort((x, y) => used(x) - used(y))[0];
      if (best) target = { accountId: best.id, model: best.defaultModel };
    } else if (plan.mode === 'chain') {
      target = plan.targets.find((x) => usable(this.accountsById.get(x.accountId))) ?? null;
    } else if (plan.mode === 'wait') {
      const resets = [r.limit?.resetsAt, ...(current?.status?.windows ?? []).filter((w) => w.percent >= 99).map((w) => w.resetsAt)].filter(Boolean);
      const at = resets.length ? Math.max(...resets) + 30 : null;
      if (!at) return;
      r.resumeAt = at;
      r.relayTimer = setTimeout(() => this._resumeAfterLimit(t), Math.min(2 ** 31 - 1, Math.max(5, at - now()) * 1000));
      this._changed(t);
      return;
    }
    if (!target) return;
    const delay = this.settings.relayDelay;
    r.pendingRelay = { ...target, at: now() + delay };
    r.relayTimer = setTimeout(() => this._relayNow(t), delay * 1000);
    this._changed(t);
  }

  _relayNow(t) {
    const r = this._rt(t);
    const target = r.pendingRelay;
    this._clearLimitTimers(t);
    if (!target) return;
    t.queuePaused = false;
    const to = this.accountsById.get(target.accountId);
    this._append(t, { id: uuid(), kind: 'notice', accountId: target.accountId, text: `Relevo automático a ${to?.name ?? '?'} · ${this._modelName(to, target.model)}` });
    this.select(t, target.accountId, target.model, true);
  }

  _resumeAfterLimit(t) {
    const r = this._rt(t);
    this._clearLimitTimers(t);
    r.limit = null;
    t.queuePaused = false;
    if (!r.isRunning) this._startTurn(t, 'Sigue con la tarea donde lo dejaste.');
  }

  _limitAction(t, action) {
    const r = this._rt(t);
    if (action === 'relayNow') this._relayNow(t);
    else if (action === 'resumeNow') this._resumeAfterLimit(t);
    else if (action === 'cancelRelay' || action === 'cancelResume') { this._clearLimitTimers(t); this._changed(t); }
    else if (r) this._changed(t);
  }

  // MARK: - Limits and housekeeping

  refreshUsage() {
    this._rescanCLIs();
    return Promise.all(this.accounts.map((a) => this._refreshAccount(a)));
  }

  /**
   * The agents' programs: a path set from the apps (Ajustes › Suscripciones) wins; the others are looked for
   * again while any is missing, so a CLI installed after the host started works without restarting it.
   */
  _rescanCLIs(force = false) {
    const custom = this.state.settings.cliPaths ?? {};
    const current = this.config.bins ?? {};
    const missing = Object.values(current).some((b) => !b);
    const found = (force || missing) && this.config.findBins ? this.config.findBins() : current;
    const next = {};
    for (const k of new Set([...Object.keys(current), ...Object.keys(found), ...Object.keys(custom)])) {
      next[k] = custom[k] && fs.existsSync(custom[k]) ? custom[k] : (found[k] ?? current[k] ?? null);
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return false;
    for (const [k, v] of Object.entries(next)) if (v && v !== current[k]) this.log(`${k}: ${v}`);
    this.config.bins = next;
    this._buildAccounts();
    this._broadcastSnapshot();
    return true;
  }

  /** When the iPhone connects: accounts signed out (maybe since logged in over ssh) or not probed lately. */
  _refreshStale() {
    for (const a of this.accounts) {
      if (a.status?.loggedIn === false || !a.status?.updatedAt || now() - a.status.updatedAt > STALE_AFTER_S) this._refreshAccount(a);
    }
  }

  _missingCLI(a) {
    const name = { claude: 'claude', api: 'claude', codex: 'codex', antigravity: 'agy' }[a.def?.type] ?? a.def?.command ?? a.agentName;
    return `no encuentro «${name}» en ${this.config.name}. Instálalo o indica dónde está en Ajustes › Suscripciones › ${a.name} › Programa.`;
  }

  async _refreshAccount(a) {
    if (a.refreshing) return;
    a.refreshing = true;
    this._broadcastSnapshot();
    let result;
    try {
      if (!this.config.fakeAgent && !a.bin) throw new Error(this._missingCLI(a));
      result = this.config.fakeAgent ? fakeProbe() : await a.probe({ bin: a.bin, env: a.env, cwd: this.config.dataDir, home: a.home });
    } catch (e) {
      result = { loggedIn: a.status?.loggedIn ?? null, windows: a.status?.windows ?? [], error: `No he podido consultar la cuenta: ${e.message}` };
    }
    a.refreshing = false;
    if (result.models) a.models = result.models;
    a.status = {
      loggedIn: result.loggedIn, plan: result.plan, email: result.email, windows: result.windows ?? [],
      error: result.error, note: result.note ?? null, updatedAt: now(),
    };
    this._saveState();
    this._broadcastSnapshot();
  }

  _housekeeping() {
    // Idle agent processes hold memory: close them; the next message resumes the same session.
    for (const [id, s] of this.agents) {
      const t = this.threads.get(id);
      if (!t) continue;
      // Never one with something running in the background (closing it would kill its build or emulator).
      if (s.alive && !s.turnActive && !this._rt(t).approvals.size && !this._rt(t).backgroundTasks?.length && Date.now() - s.lastActive > IDLE_CLOSE_MS) s.close(true);
    }
    // Agents' temporary files live on the data disk; remove what's older than a day.
    const dayAgo = Date.now() - 24 * 3600_000;
    try {
      for (const name of fs.readdirSync(this.config.tmpDir)) {
        const p = path.join(this.config.tmpDir, name);
        if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
    // Codex keeps every session's rollout; old ones only matter for resuming threads untouched for a month.
    if (Date.now() - (this.lastPrune ?? 0) > 6 * 3600_000) {
      this.lastPrune = Date.now();
      prune(path.join(this.config.codexHome, 'sessions'), Date.now() - CODEX_SESSIONS_DAYS * 86_400_000);
      prune(path.join(this.config.codexHome, 'log'), Date.now() - 7 * 86_400_000);
    }
  }

  // MARK: - Remote objects

  _remoteAccount(a) {
    const s = a.status;
    return clean({
      id: a.id, kind: a.kind, name: a.name, agentName: a.agentName, symbol: a.symbol, tint: a.tint, usesAPIKey: !!a.usesAPIKey,
      status: s ? clean({
        loggedIn: s.loggedIn, plan: s.plan, email: s.email, error: s.error, note: s.note,
        windows: (s.windows ?? []).map(remoteWindow), noPlan: false, exhausted: this._exhausted(a), updatedAt: s.updatedAt,
      }) : null,
      models: a.models.map((m) => clean({ id: m.id, name: m.name, detail: m.detail, efforts: m.efforts, defaultEffort: m.defaultEffort, hidden: (a.def?.hiddenModels ?? []).includes(m.id) || undefined })),
      defaultModel: a.defaultModel, refreshing: a.refreshing,
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
        let last = null;
        for (let i = t.items.length - 1; i >= 0 && !last; i--) if (t.items[i].kind === 'assistant' || t.items[i].kind === 'user') last = t.items[i];
        return clean({
          id: t.id, projectId: t.projectId, title: t.title, updatedAt: t.updatedAt, isRunning: r.isRunning,
          needsApproval: r.approvals.size > 0, accountId: t.accountId, preview: last?.text?.slice(0, 160) ?? null, isWaiting: !!r.backgroundTasks?.length,
          context: r.context ?? undefined, sessionTokens: r.sessionTokens || undefined,
          worktree: t.worktree ? t.worktree.branch : null, team: t.team ?? null, attention: t.attention ?? null,
        });
      });
    const settings = this.settings;
    return {
      macName: this.config.name, accounts: this.accounts.map((a) => this._remoteAccount(a)), projects, threads,
      autoRelay: settings.limitPlan.mode !== 'ask', pushReady: false,
      // Beyond the shared protocol (the Mac and the iPhone ignore unknown fields).
      hostFeatures: HOST_FEATURES, hostVersion: this.config.version ?? 'dev', hostPlatform: process.platform, hostCLIs: this.config.bins ?? {},
      hostTeams: this.teams.list.map((x) => ({ id: x.id, projectId: x.projectId, goal: x.goal, status: x.status, auto: x.auto, held: x.held.length, decisions: (x.decisions ?? []).map((d) => ({ id: d.id, text: d.text, by: d.by, at: d.at })), members: x.members.map((m) => { const t = this.threads.get(m.threadId); return clean({ threadId: m.threadId, role: m.role, name: m.name, notes: m.notes, accountId: t?.accountId, model: t?.model ?? 'default', task: m.task ?? undefined, stash: m.stash?.length || undefined, fallback: t ? fallbackOf(t.limitPlan) : undefined }); }) })),
      hostSettings: { ...settings, limitPlanSummary: this._planSummary(settings.limitPlan), accounts: this._accountDefs() },
      hostProviders: {
        api: Object.entries(API_PRESETS).map(([id, p]) => ({ id, name: p.name, keyURL: p.keyURL ?? null })),
        acp: Object.entries(ACP_PRESETS).map(([id, p]) => ({ id, name: p.name, login: !!p.login })),
      },
    };
  }

  _runtime(t) {
    const r = this._rt(t);
    const account = this._account(t);
    const candidates = this.accounts
      .filter((a) => a !== account && a.status?.loggedIn !== false && !this._exhausted(a))
      .map((a) => ({ accountId: a.id, model: a.defaultModel }));
    return clean({
      isRunning: r.isRunning, statusLine: r.statusLine, limit: r.limit ? clean(r.limit) : null, mode: t.mode,
      selectedAccountId: account?.id, selectedModel: t.model, selectedEffort: t.effort, relayCandidates: candidates,
      queued: t.queued.map((q) => ({ id: q.id, text: q.text })), queuePaused: t.queuePaused,
      usage: (account?.status?.windows ?? []).map(remoteWindow), backgroundTasks: (r.backgroundTasks ?? []).map((b) => ({ id: b.id, description: b.description, startedAt: b.startedAt })),
      limitPlan: t.limitPlan ? { ...t.limitPlan, summary: this._planSummary(t.limitPlan) } : null,
      defaultLimitPlan: { ...this.settings.limitPlan, summary: this._planSummary(this.settings.limitPlan) },
      pendingRelay: r.pendingRelay ?? null, resumeAt: r.resumeAt ?? null,
      suggestion: r.suggestionDismissed ? null : r.suggestion ?? null,
    });
  }

  _remoteThread(t) {
    return clean({ id: t.id, title: t.title, items: t.items.slice(-SENT_ITEMS), totalItems: t.totalItems, runtime: this._runtime(t), worktree: t.worktree ?? null });
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
      const [itemId] = this._rt(waiting[0]).approvals.keys();
      const it = this._item(waiting[0], itemId);
      if (it) approval = clean({ itemId, title: it.title ?? it.text, detail: it.output, options: it.options ?? [] });
    }
    const account = focus ? this._account(focus) : null;
    return clean({
      phase, threadId: focus?.id, threadTitle: focus?.title ?? '', accountName: account?.name,
      symbol: account?.symbol, tint: account?.tint, model: focus?.model,
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
      const patch = { id: t.id, title: t.title, upserts, totalItems: t.totalItems, runtime: this._runtime(t), worktree: t.worktree ?? null };
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
