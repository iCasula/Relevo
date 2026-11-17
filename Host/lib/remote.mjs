// The desktop app's side of the host: connects to every paired host (this one included) as an iPhone would,
// keeps what each shares, and relays it to the app's pages over 127.0.0.1. One page can then drive the Mac,
// the mini PC and this PC at once, with the same protocol and the same host code on every platform.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { connectCompanion } from './transport.mjs';
import { applyServerMessage, emptyHostData, parsePairingLink, Client, DEFAULT_PORT } from '../ui/state.mjs';

const WELCOME_TIMEOUT_MS = 8000;
const REASONS = {
  key: 'Este host no reconoce el equipo: vuelve a vincularlo con un enlace nuevo',
  refused: 'El host no acepta conexiones (¿está en marcha?)',
  unreachable: 'No llego al host (¿apagado, dormido o fuera de la red o la VPN?)',
};

const secretOf = (key) => Buffer.from(key.replaceAll('-', '+').replaceAll('_', '/'), 'base64');

/** One paired host: connects, reconnects with backoff, and keeps its snapshot and transcripts. */
export class RemoteHost extends EventEmitter {
  constructor(info, { device, local = false }) {
    super();
    this.info = info;
    this.device = device;
    this.local = local;
    this.data = emptyHostData();
    this.state = 'offline';
    this.reason = 'Sin conectar';
    this.via = null;
    this.peer = null;
    this.subscribed = null;
    this.failures = 0;
    this.generation = 0;
    this.retryTimer = null;
    this.stopped = false;
  }

  get id() { return this.info.serverId; }

  describe() {
    return {
      id: this.id, name: this.data.snapshot?.macName ?? this.info.name, local: this.local,
      state: this.state, reason: this.state === 'connected' ? null : this.reason, via: this.via,
    };
  }

  /** The page's view: identity, connection and everything the host shared so far. */
  dump() {
    return { ...this.describe(), snapshot: this.data.snapshot, threads: [...this.data.threads.values()], activity: this.data.activity };
  }

  start() { this._connect(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.peer?.close();
    this.peer = null;
  }

  /** Tries at once, forgetting the backoff (a page asked, or the pairing changed). */
  reconnect() {
    clearTimeout(this.retryTimer);
    this.failures = 0;
    this.generation++;
    this.peer?.close();
    this.peer = null;
    this._connect();
  }

  send(message) {
    if (this.state !== 'connected' || !this.peer) return false;
    this.peer.send(message);
    return true;
  }

  subscribe(threadId) {
    this.subscribed = threadId ?? null;
    this.send(Client.subscribe(this.subscribed));
  }

  _endpoints() {
    if (this.local) return ['127.0.0.1'];
    return [...new Set([this.info.host, ...(this.info.addresses ?? [])].filter(Boolean))];
  }

  _setState(state, reason = null) {
    this.state = state;
    if (reason) this.reason = reason;
    this.emit('state');
  }

  async _connect() {
    if (this.stopped || this.peer) return;
    const generation = ++this.generation;
    const endpoints = this._endpoints();
    this._setState('connecting');
    const port = this.info.port ?? DEFAULT_PORT;
    const secret = secretOf(this.info.key);
    // Every address at once; the first to finish the handshake wins and the rest are closed.
    const result = await new Promise((resolve) => {
      if (!endpoints.length) { resolve({ errors: [{ reason: 'unreachable' }] }); return; }
      let pending = endpoints.length, won = false;
      const errors = [];
      for (const host of endpoints) {
        connectCompanion({ host, port, serverId: this.id, secret }).then((peer) => {
          pending--;
          if (won || this.stopped || generation !== this.generation) { peer.close(); return; }
          won = true;
          resolve({ peer, via: host });
        }, (e) => {
          errors.push(e);
          if (--pending === 0 && !won) resolve({ errors });
        });
      }
    });
    if (this.stopped || generation !== this.generation) { result.peer?.close(); return; }
    if (!result.peer) {
      const reasons = result.errors.map((e) => e.reason);
      const reason = ['key', 'refused', 'unreachable'].find((r) => reasons.includes(r)) ?? 'unreachable';
      this._retry(REASONS[reason]);
      return;
    }
    const { peer, via } = result;
    this.peer = peer;
    this.via = this.local ? 'este equipo' : via;
    const welcomeTimer = setTimeout(() => { if (this.peer === peer && this.state !== 'connected') this._lost(peer, 'El host no responde'); }, WELCOME_TIMEOUT_MS);
    peer.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (this.peer !== peer) return;
      if (applyServerMessage(this.data, msg) === 'welcome') {
        clearTimeout(welcomeTimer);
        this.failures = 0;
        this._setState('connected');
      }
      if (msg.addresses) this._learn(msg.addresses);
      this.emit('message', msg);
    });
    peer.on('close', () => { clearTimeout(welcomeTimer); this._lost(peer, 'El host ha cerrado la conexión'); });
    peer.send(Client.hello(this.device));
    if (this.subscribed) peer.send(Client.subscribe(this.subscribed));
  }

  _lost(peer, reason) {
    if (this.peer !== peer) return;
    this.peer = null;
    peer.close();
    this._retry(reason);
  }

  _retry(reason) {
    this.via = null;
    this._setState('offline', reason);
    if (this.stopped) return;
    this.failures++;
    const delay = Math.min(30, 1.5 * 2 ** Math.min(this.failures - 1, 5)) * 1000;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), delay);
  }

  /** The host's current addresses, for the next connection through a VPN (a port typed by hand stays). */
  _learn({ hosts, port }) {
    if (this.local) return;
    const addresses = [...(hosts ?? [])].sort();
    const newPort = this.info.host ? this.info.port : port;
    if (JSON.stringify(addresses) === JSON.stringify(this.info.addresses) && newPort === this.info.port) return;
    this.info = { ...this.info, addresses, port: newPort };
    this.emit('info');
  }
}

/**
 * Every paired host plus this one, and the pages showing them. Pages get `init` with everything on connect,
 * then `host` (connection), `server` (a host's message, applied to the same state as here), `hostAdded`,
 * `hostRemoved` and `toast`.
 */
export class Gateway {
  constructor({ dataDir, localLink, device, version = 'dev', log = () => {} }) {
    this.file = path.join(dataDir, 'desktop', 'hosts.json');
    /** This host's program: installed version, newest release tag, whether one is being installed. */
    this.update = { current: version, latest: null, available: false, applying: false, checkedAt: null, error: null };
    this.onCheckUpdate = null;
    this.onApplyUpdate = null;
    this.device = device;
    this.log = log;
    this.localLink = localLink;
    this.hosts = new Map();
    this.pages = new Set();
    const local = localLink ? parsePairingLink(localLink) : null;
    if (local) this._add(local, true);
    let stored = [];
    try { stored = JSON.parse(fs.readFileSync(this.file, 'utf8')).hosts ?? []; } catch {}
    for (const info of stored) if (!this.hosts.has(info.serverId)) this._add(info, false);
  }

  start() { for (const h of this.hosts.values()) h.start(); }

  stop() { for (const h of this.hosts.values()) h.stop(); }

  _add(info, local) {
    const h = new RemoteHost(info, { device: this.device, local });
    h.on('state', () => this._broadcast({ type: 'host', host: h.describe() }));
    h.on('message', (message) => this._broadcast({ type: 'server', host: h.id, message }));
    h.on('info', () => this._save());
    this.hosts.set(h.id, h);
    return h;
  }

  _save() {
    const hosts = [...this.hosts.values()].filter((h) => !h.local).map((h) => h.info);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  _broadcast(event) { for (const page of this.pages) page.send(event); }

  setUpdate(update) {
    this.update = { ...this.update, ...update };
    this._broadcast({ type: 'update', update: this.update });
  }

  /** A page connected (WebSocketPeer on 127.0.0.1). */
  attach(page) {
    this.pages.add(page);
    page.on('close', () => this.pages.delete(page));
    page.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      try { this._handle(page, m); } catch (e) { this.log(`desktop: ${e.stack ?? e}`); }
    });
    page.send({ type: 'init', hosts: [...this.hosts.values()].map((h) => h.dump()), pairingLink: this.localLink, update: this.update });
  }

  _handle(page, m) {
    const h = m.host ? this.hosts.get(m.host) : null;
    switch (m.type) {
      case 'client': {
        if (!h) return;
        const [name] = Object.keys(m.message ?? {});
        if (name === 'subscribe') { h.subscribe(m.message.subscribe.threadId ?? null); return; }
        if (!h.send(m.message)) page.send({ type: 'toast', text: `Sin conexión con ${h.describe().name}` });
        return;
      }
      case 'pair': {
        const info = parsePairingLink(m.link);
        if (!info) { page.send({ type: 'toast', text: 'Ese enlace no es de vinculación de Relevo (relevocompanion://pair?…)' }); return; }
        const existing = this.hosts.get(info.serverId);
        if (existing?.local) { page.send({ type: 'toast', text: 'Ese es el host de este equipo: ya está' }); return; }
        if (existing) {
          existing.info = { ...existing.info, ...info };
          existing.reconnect();
        } else {
          this._add(info, false).start();
        }
        this._save();
        this._broadcast({ type: 'hostAdded', host: this.hosts.get(info.serverId).dump() });
        return;
      }
      case 'remove': {
        if (!h || h.local) return;
        h.stop();
        this.hosts.delete(h.id);
        this._save();
        this._broadcast({ type: 'hostRemoved', host: h.id });
        return;
      }
      case 'reconnect': h?.reconnect(); return;
      case 'checkUpdate': this.onCheckUpdate?.(); return;
      case 'applyUpdate': this.onApplyUpdate?.(); return;
      default: return;
    }
  }
}
