// State and plumbing of the desktop app: the connection to this machine's Relevo service (/ws), every paired
// host's shared state, requests with replies, and the Mac's formatters (Formatters, TokenFormat).

import { applyServerMessage, emptyHostData, Client, uuid } from './state.mjs';
import { toast } from './kit.mjs';

export { Client, uuid, toast };

export const app = {
  hosts: new Map(), // id → { info, data }
  pairingLink: null,
  update: null,
  loadedVersion: null,
  live: false,
  ws: null,
  sel: load('selection', null), // { host, thread }
  expanded: new Set(load('expandedProjects', null) ?? []), // host/project keys (absent = expanded)
  collapsedProjects: new Set(load('collapsedProjects2', [])),
  /** Image previews you closed («itemId|path»). */
  hiddenImages: new Set(load('hiddenImages', [])),
  showTools: load('showTools', true),
  showTurnUsage: load('showTurnUsage', true),
  drafts: new Map(load('drafts', [])),
  older: new Map(),
  requests: new Map(),
  logins: new Map(),
  images: new Map(),
  pendingCreate: new Map(),
  notified: new Map(),
  expandedItems: new Set(),
  sidebarWidth: load('sidebarWidth', 280),
  sidebarHidden: load('sidebarHidden', false),
};

export function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/** Re-render hooks set by the main window (keeps modules free of import cycles at load time). */
export const hooks = { render() {}, renderThread() {}, onServer() {}, onInit() {} };

// MARK: - Lookups

export const host = (id) => app.hosts.get(id);
export const snap = (id) => host(id)?.data.snapshot;
export const nameOf = (h) => h?.data.snapshot?.macName ?? h?.info.name ?? 'el host';
export const has = (hostId, feature) => snap(hostId)?.hostFeatures?.includes(feature) ?? false;
export const accountOf = (hostId, id) => snap(hostId)?.accounts.find((a) => a.id === id);
export const modelOf = (account, id) => account?.models.find((m) => m.id === id);
export function modelName(account, id) {
  const name = modelOf(account, id)?.name ?? (!id || id === 'default' ? 'Predeterminado' : id);
  return /^Predeterminado \((.+)\)$/.exec(name)?.[1] ?? name;
}
export const visibleModels = (account) => (account?.models ?? []).filter((m) => !m.hidden);
// Antigravity's families (Gemini, Claude/GPT) have their own quotas: the account has the room of the freest one.
export const maxPercent = (account) => {
  const ws = account?.status?.windows ?? [];
  if (account?.kind === 'gemini' && ws.length > 1) return Math.max(0, Math.min(...ws.map((w) => w.percent)));
  return Math.max(0, ...ws.map((w) => w.percent));
};
/** «40% usado», or per family on Antigravity («Gemini 0% · Claude/GPT 100%»). */
export const usageText = (account) => {
  const ws = account?.status?.windows ?? [];
  if (account?.kind === 'gemini' && ws.length > 1) return ws.map((w) => `${w.label} ${Math.round(w.percent)}%`).join(' · ');
  return `${Math.round(maxPercent(account))}% usado`;
};
export const threadOf = (hostId, threadId) => host(hostId)?.data.threads.get(threadId);
export const summaryOf = (hostId, threadId) => snap(hostId)?.threads.find((t) => t.id === threadId);
export const projectOf = (hostId, projectId) => snap(hostId)?.projects.find((p) => p.id === projectId);
export const localHost = () => [...app.hosts.values()].find((h) => h.info.local);
export const accountsAll = () => [...app.hosts.entries()].flatMap(([id, h]) => (h.data.snapshot?.accounts ?? []).map((a) => ({ hostId: id, account: a })));

// MARK: - Connection

export function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  app.ws = ws;
  ws.onopen = () => { app.live = true; document.getElementById('offline').hidden = true; };
  ws.onmessage = (e) => {
    try { onEvent(JSON.parse(typeof e.data === 'string' ? e.data : decoder.decode(e.data))); } catch (err) { console.error(err); }
  };
  ws.onclose = () => {
    app.live = false;
    document.getElementById('offline').hidden = false;
    setTimeout(connect, 1500);
  };
}

export function post(event) {
  if (app.ws?.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(event));
  else toast('Sin conexión con el servicio de Relevo de este equipo');
}
export const sendTo = (hostId, message) => post({ type: 'client', host: hostId, message });

/** A request with a fresh requestId; resolves the host's reply ({ ok, error, … }). */
export function request(hostId, message, timeout = 90_000) {
  const [name] = Object.keys(message);
  const requestId = uuid();
  message[name] = { ...message[name], requestId };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { app.requests.delete(requestId); resolve({ ok: false, error: 'El host no ha respondido a tiempo' }); }, timeout);
    app.requests.set(requestId, (reply) => { clearTimeout(timer); app.requests.delete(requestId); resolve(reply); });
    sendTo(hostId, message);
  });
}
export const requester = (hostId) => (message) => request(hostId, message);

/** Creates a thread; resolves its id (null if the host didn't). */
export function createThread(hostId, projectId) {
  const requestId = uuid();
  return new Promise((resolve) => {
    app.pendingCreate.set(requestId, resolve);
    sendTo(hostId, Client.newThread(projectId, requestId));
    setTimeout(() => { if (app.pendingCreate.delete(requestId)) resolve(null); }, 8000);
  });
}

function adopt(h) {
  const data = emptyHostData();
  data.snapshot = h.snapshot;
  data.activity = h.activity;
  for (const t of h.threads ?? []) data.threads.set(t.id, t);
  const { snapshot, threads, activity, ...info } = h;
  app.hosts.set(h.id, { info, data });
}

function onEvent(ev) {
  switch (ev.type) {
    case 'init':
      if (app.loadedVersion && ev.update?.current && ev.update.current !== app.loadedVersion) { location.reload(); return; }
      app.loadedVersion = ev.update?.current ?? null;
      app.update = ev.update ?? null;
      app.hosts.clear();
      for (const h of ev.hosts) adopt(h);
      app.pairingLink = ev.pairingLink;
      hooks.onInit();
      hooks.render();
      break;
    case 'host': {
      const h = host(ev.host.id);
      if (!h) break;
      const was = h.info.state;
      h.info = ev.host;
      if (was !== 'connected' && ev.host.state === 'connected' && app.sel?.host === ev.host.id) sendTo(ev.host.id, Client.subscribe(app.sel.thread));
      hooks.render();
      break;
    }
    case 'hostAdded': adopt(ev.host); hooks.render(); break;
    case 'hostRemoved': app.hosts.delete(ev.host); hooks.render(); break;
    case 'toast': toast(ev.text); break;
    case 'update': app.update = ev.update; hooks.render(); break;
    case 'server': {
      const h = host(ev.host);
      if (!h) break;
      const msg = ev.message;
      const name = applyServerMessage(h.data, msg);
      const a = msg[name] ?? {};
      if (name === 'created') { const resolve = app.pendingCreate.get(a.requestId); if (resolve) { app.pendingCreate.delete(a.requestId); resolve(a.threadId); } }
      else if (name === 'reply' || name === 'image') app.requests.get(a.requestId)?.(a);
      else if (name === 'loginOutput') app.logins.get(a.requestId)?.(a);
      else if (name === 'toast') toast(a._0);
      hooks.onServer(ev.host, name, a);
      break;
    }
    default: break;
  }
}

// MARK: - Formatters (MainView.swift Formatters, TokenUsage.swift)

const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

/** 950 · 4,2k · 12k · 350k · 4,2M */
export function shortTokens(n) {
  n = Math.round(n || 0);
  if (n < 1000) return String(n);
  if (n < 10_000) return `${nf1.format(n / 1000)}k`;
  if (n < 1_000_000) return `${nf0.format(n / 1000)}k`;
  return `${nf1.format(n / 1_000_000)}M`;
}
/** $0,042 · $1,25 · $120 */
export function usd(v) {
  v = v || 0;
  const digits = v < 0.1 ? 3 : v < 100 ? 2 : 0;
  return `$${new Intl.NumberFormat('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)}`;
}
export const pct = (v) => `${Math.round(v)} %`;
export const grouped = (n) => new Intl.NumberFormat('es-ES').format(Math.round(n || 0));

/** "ya disponible" · "a las 14:30" · "mañana 9:00" · "lun 9:00" · "17 nov 2026, 14:30" */
export function reset(at) {
  if (!at) return null;
  const d = new Date(at * 1000), now = new Date();
  if (d <= now) return 'ya disponible';
  const time = d.toLocaleTimeString('es-ES', { hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `a las ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `mañana ${time}`;
  if (d - now < 7 * 86_400_000) return `${d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '')} ${time}`;
  return d.toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const rtf = new Intl.RelativeTimeFormat('es', { style: 'short', numeric: 'auto' });
/** "hace 5 min", "hace 2 h", "hace 3 días" (RelativeDateTimeFormatter .short) */
export function relative(at) {
  const s = at - Date.now() / 1000;
  const a = Math.abs(s);
  if (a < 60) return rtf.format(Math.round(s), 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return rtf.format(Math.round(s / (30 * 86_400)), 'month');
}

/** Time of a message: "14:05" today, "ayer 14:05", "12 nov 14:05" (seconds since 1970). */
export function clock(at) {
  if (!at) return '';
  const d = new Date(at * 1000), today = new Date();
  const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(today) - day(d)) / 86_400_000);
  if (diff === 0) return hm;
  if (diff === 1) return `ayer ${hm}`;
  return `${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })} ${hm}`;
}
export const fullDate = (at) => (at ? new Date(at * 1000).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'medium' }) : '');

export const usageColor = (p) => (p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--orange)' : 'var(--usage-green)');

export const EFFORTS = { none: 'Sin razonamiento', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo', ultra: 'Ultra', disabled: 'Desactivado', enabled: 'Activado' };
export const effortName = (e) => EFFORTS[String(e).toLowerCase()] ?? (e ? e[0].toUpperCase() + e.slice(1) : 'Auto');
export const MODES = [
  ['ask', 'Pedir permiso', 'hand.raised', 'El agente pide aprobación antes de ejecutar comandos o editar.'],
  ['autoEdit', 'Auto-editar', 'pencil.line', 'Edita ficheros del proyecto sin preguntar; pide permiso para comandos.'],
  ['full', 'Acceso total', 'bolt.shield', 'Sin confirmaciones. Úsalo solo en proyectos de confianza.'],
  ['plan', 'Solo planificar', 'list.bullet.clipboard', 'Solo lectura: analiza y propone un plan sin tocar nada.'],
];
export const PLAN_SUMMARY = { ask: 'avisarme', mostQuota: 'la de más cuota', wait: 'esperar al reinicio', smart: 'automático' };
export const CHART_COLORS = {
  gemini: ['#2a78d6', '#3987e5'], claude: ['#eb6834', '#d95926'], codex: ['#1baf7a', '#199e70'], deepseek: ['#eda100', '#c98500'],
  anthropic: ['#c96442', '#d4734f'], other: ['#e34948', '#e66767'],
};
export const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const chartColor = (provider) => (CHART_COLORS[provider] ?? CHART_COLORS.other)[isDark() ? 1 : 0];
export const providerOf = (kind = '') => (kind.startsWith('api:') ? kind.slice(4) : kind.split(':')[0]) || 'other';

/** Copy text to the clipboard with the Mac's toast. */
export async function copyText(text, done = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('No he podido copiarlo'); }
}
