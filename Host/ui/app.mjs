// Relevo for desktop: every paired host (this PC, the Mac, a mini PC) in one window. The page talks only to
// the host service on 127.0.0.1 (/ws), which keeps the connections to the hosts; the protocol and its state
// handling are shared with it (state.mjs).

import { applyServerMessage, emptyHostData, Client, uuid } from './state.mjs';
import { markdown, inline, esc } from './markdown.mjs';
import { showMenu, openDialog, confirmDialog, promptDialog, chooseFolder, diffHTML, linkify } from './dialogs.mjs';

// MARK: - State

const app = {
  hosts: new Map(), // id → { info, data }
  pairingLink: null,
  view: { kind: 'empty' }, // { kind: 'thread', host, thread } | { kind: 'limits' } | { kind: 'hosts' }
  ws: null,
  live: false,
  drafts: new Map(load('drafts', [])),
  older: new Map(), // host/thread → items before the transcript the host sent
  requests: new Map(), // requestId → resolve, for replies (`reply`, `image`)
  logins: new Map(), // requestId → handler of `loginOutput`
  images: new Map(), // host/thread/path → data URL (or null while loading)
  filter: '',
  expanded: new Set(),
  showTools: load('showTools', false),
  collapsed: new Set(load('collapsedProjects', [])),
  showAll: new Set(),
  pendingCreate: new Map(),
  notified: new Map(),
  update: null, // this host's program: { current, latest, available, applying, checkedAt, error }
  loadedVersion: null,
};

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const MODES = {
  ask: ['Pedir permiso', 'El agente pide aprobación antes de ejecutar comandos o editar.'],
  autoEdit: ['Auto-editar', 'Edita ficheros sin preguntar; pide permiso para comandos.'],
  full: ['Acceso total', 'Sin confirmaciones. Úsalo solo en proyectos de confianza.'],
  plan: ['Solo planificar', 'Solo lectura: analiza y propone un plan sin tocar nada.'],
};
const EFFORTS = { none: 'Sin razonamiento', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo', ultra: 'Ultra', disabled: 'Desactivado', enabled: 'Activado' };
const GLYPHS = { fish: '◗', asterisk: '✳', hexagon: '⬡', sparkles: '✦', 'sparkle': '✦', moon: '☾', bolt: 'ϟ', key: '⚿', star: '★', diamond: '◆', circle: '●', 'brain': '✺', 'cpu': '▣' };

const effortName = (e) => EFFORTS[String(e).toLowerCase()] ?? (e ? e[0].toUpperCase() + e.slice(1) : 'Auto');
const host = (id) => app.hosts.get(id);
/** The name the host announces (its link may carry an older one). */
const nameOf = (h) => h?.data.snapshot?.macName ?? h?.info.name ?? 'el host';
const snapshotOf = (id) => host(id)?.data.snapshot;
const accountOf = (hostId, accountId) => snapshotOf(hostId)?.accounts.find((a) => a.id === accountId);
const modelOf = (account, id) => account?.models.find((m) => m.id === id);
function modelName(account, id) {
  const name = modelOf(account, id)?.name ?? (!id || id === 'default' ? 'Predeterminado' : id);
  const m = /^Predeterminado \((.+)\)$/.exec(name);
  return m ? m[1] : name;
}
function glyph(account, size = 20) {
  if (!account) return '';
  const g = GLYPHS[account.symbol?.split('.')[0]] ?? account.name?.[0] ?? '•';
  return `<span class="glyph" style="background:${esc(account.tint)};width:${size}px;height:${size}px">${esc(g)}</span>`;
}
function availability(account) {
  const s = account.status;
  if (!s) return null;
  if (s.loggedIn === false) return 'sin sesión';
  if (s.noPlan) return 'plan sin acceso';
  if (s.exhausted) return 'agotada';
  if (s.windows?.length) return `${Math.round(Math.max(...s.windows.map((w) => w.percent)))} % usado`;
  return null;
}

function resetText(at) {
  if (!at) return null;
  const d = new Date(at * 1000), now = new Date();
  if (d <= now) return 'ya disponible';
  const time = d.toLocaleTimeString('es-ES', { hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `a las ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `mañana ${time}`;
  if (d - now < 7 * 86_400_000) return `${d.toLocaleDateString('es-ES', { weekday: 'short' })} ${time}`;
  return d.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function relTime(at) {
  const s = Date.now() / 1000 - at;
  if (s < 60) return 'ahora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d`;
  return new Date(at * 1000).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}
const countdown = (at) => Math.max(0, Math.ceil(at - Date.now() / 1000));
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)} k` : String(n));
const barClass = (p) => (p >= 90 ? 'high' : p >= 70 ? 'mid' : '');

// MARK: - Connection to the local service

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  app.ws = ws;
  ws.onopen = () => { app.live = true; document.getElementById('offline').hidden = true; };
  ws.binaryType = 'arraybuffer'; // the host frames JSON as binary, as for the iPhone
  const decoder = new TextDecoder();
  ws.onmessage = (e) => {
    try { onEvent(JSON.parse(typeof e.data === 'string' ? e.data : decoder.decode(e.data))); } catch (err) { console.error(err); }
  };
  ws.onclose = () => {
    app.live = false;
    document.getElementById('offline').hidden = false;
    setTimeout(connect, 1500);
  };
}

function post(event) {
  if (app.ws?.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(event));
  else toast('Sin conexión con el servicio de Relevo de este equipo');
}
const sendTo = (hostId, message) => post({ type: 'client', host: hostId, message });

/** Features a host has beyond the shared protocol (the Node host lists them; the Mac doesn't). */
const has = (hostId, feature) => snapshotOf(hostId)?.hostFeatures?.includes(feature) ?? false;

/** Sends a request with a fresh requestId and resolves the host's reply ({ ok, error, … }). */
function request(hostId, message, timeout = 90_000) {
  const [name] = Object.keys(message);
  const requestId = uuid();
  message[name] = { ...message[name], requestId };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { app.requests.delete(requestId); resolve({ ok: false, error: 'El host no ha respondido a tiempo' }); }, timeout);
    app.requests.set(requestId, (reply) => { clearTimeout(timer); app.requests.delete(requestId); resolve(reply); });
    sendTo(hostId, message);
  });
}

let draftsTimer = 0;
function saveDrafts() {
  clearTimeout(draftsTimer);
  draftsTimer = setTimeout(() => save('drafts', [...app.drafts].filter(([, v]) => v.trim()).slice(-50)), 500);
}

function adopt(h) {
  const data = emptyHostData();
  data.snapshot = h.snapshot;
  data.activity = h.activity;
  for (const t of h.threads ?? []) data.threads.set(t.id, t);
  const { snapshot, threads, activity, ...info } = h;
  app.hosts.set(h.id, { info, data });
  rememberStates(h.id, true);
}

function onEvent(ev) {
  switch (ev.type) {
    case 'init': {
      app.hosts.clear();
      for (const h of ev.hosts) adopt(h);
      app.pairingLink = ev.pairingLink;
      // After an update the service restarts with a new page: load it instead of running the old one.
      if (app.loadedVersion && ev.update?.current && ev.update.current !== app.loadedVersion) { location.reload(); return; }
      app.loadedVersion = ev.update?.current ?? null;
      app.update = ev.update ?? null;
      if (app.view.kind === 'empty') restoreFromHash();
      if (app.view.kind === 'thread') sendTo(app.view.host, Client.subscribe(app.view.thread));
      render();
      break;
    }
    case 'host': {
      const h = host(ev.host.id);
      if (!h) break;
      const was = h.info.state;
      h.info = ev.host;
      if (was !== 'connected' && ev.host.state === 'connected' && app.view.kind === 'thread' && app.view.host === ev.host.id) {
        sendTo(ev.host.id, Client.subscribe(app.view.thread));
      }
      render();
      break;
    }
    case 'hostAdded': adopt(ev.host); toast(`Host añadido: ${nameOf(host(ev.host.id))}`); render(); break;
    case 'hostRemoved':
      app.hosts.delete(ev.host);
      if (app.view.host === ev.host) setView({ kind: 'hosts' });
      render();
      break;
    case 'toast': toast(ev.text); break;
    case 'update': app.update = ev.update; renderSidebar(); if (app.view.kind === 'hosts') renderMain(); break;
    case 'server': onServer(ev.host, ev.message); break;
    default: break;
  }
}

function onServer(hostId, msg) {
  const h = host(hostId);
  if (!h) return;
  const name = applyServerMessage(h.data, msg);
  const a = msg[name] ?? {};
  switch (name) {
    case 'snapshot': notifyChanges(hostId); render(); break;
    case 'thread':
    case 'threadPatch':
      if (app.view.kind === 'thread' && app.view.host === hostId && app.view.thread === a._0.id) renderMain();
      break;
    case 'created': {
      const resolve = app.pendingCreate.get(a.requestId);
      if (!resolve) break;
      app.pendingCreate.delete(a.requestId);
      resolve(a.threadId);
      break;
    }
    case 'toast': toast(a._0); break;
    case 'image':
    case 'reply': app.requests.get(a.requestId)?.(a); break;
    case 'loginOutput': app.logins.get(a.requestId)?.(a); break;
    default: break;
  }
}

// MARK: - Notifications

function rememberStates(hostId, silent) {
  const snap = snapshotOf(hostId);
  for (const t of snap?.threads ?? []) {
    const key = `${hostId}/${t.id}`;
    const prev = app.notified.get(key);
    app.notified.set(key, { running: t.isRunning, approval: t.needsApproval });
    if (silent || !prev) continue;
    const watching = !document.hidden && document.hasFocus() && app.view.kind === 'thread' && app.view.thread === t.id;
    if (watching) continue;
    if (!prev.approval && t.needsApproval) notify(hostId, t, 'Necesita tu respuesta');
    else if (prev.running && !t.isRunning && !t.needsApproval) notify(hostId, t, t.isWaiting ? 'Esperando tareas en segundo plano' : 'Ha terminado');
  }
  updateTitle();
}
const notifyChanges = (hostId) => rememberStates(hostId, false);

function notify(hostId, t, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(t.title || 'Relevo', { body: `${body} · ${nameOf(host(hostId))}`, icon: 'icon.png', tag: `${hostId}/${t.id}` });
  n.onclick = () => { window.focus(); openThread(hostId, t.id); n.close(); };
}

function updateTitle() {
  let n = 0;
  for (const h of app.hosts.values()) n += h.data.snapshot?.threads.filter((t) => t.needsApproval).length ?? 0;
  document.title = n ? `(${n}) Relevo` : 'Relevo';
}

// MARK: - Navigation

function setView(view) {
  const prev = app.view;
  if (prev.kind === 'thread' && (view.kind !== 'thread' || view.host !== prev.host)) sendTo(prev.host, Client.subscribe(null));
  app.view = view;
  if (view.kind === 'thread') {
    sendTo(view.host, Client.subscribe(view.thread));
    history.replaceState(null, '', `#/${encodeURIComponent(view.host)}/${view.thread}`);
  } else {
    history.replaceState(null, '', view.kind === 'empty' ? '#' : `#/${view.kind}`);
  }
  mainKey = null;
  render();
}
const openThread = (hostId, threadId) => setView({ kind: 'thread', host: hostId, thread: threadId });

function viewFromHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts.length === 2 && host(parts[0])) return { kind: 'thread', host: parts[0], thread: parts[1] };
  if (['limits', 'hosts', 'usage', 'settings'].includes(parts[0])) return { kind: parts[0] };
  return { kind: 'empty' };
}
function restoreFromHash() { app.view = viewFromHash(); }
window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  if (v.kind !== app.view.kind || v.thread !== app.view.thread || v.host !== app.view.host) setView(v);
});

/** Creates a thread on the host; resolves its id (null if the host didn't). */
function createThread(hostId, projectId) {
  const requestId = uuid();
  return new Promise((resolve) => {
    app.pendingCreate.set(requestId, resolve);
    sendTo(hostId, Client.newThread(projectId, requestId));
    setTimeout(() => { if (app.pendingCreate.delete(requestId)) resolve(null); }, 8000);
  });
}

async function newThread(hostId, projectId) {
  const id = await createThread(hostId, projectId);
  if (!id) { toast('El host no ha creado el hilo'); return; }
  openThread(hostId, id);
  setTimeout(() => document.getElementById('draft')?.focus(), 50);
}

// MARK: - Rendering

let frame = 0;
function render() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderSidebar();
    renderMain();
  });
}

function renderSidebar() {
  const out = [];
  for (const [id, h] of app.hosts) {
    const { info, data } = h;
    const snap = data.snapshot;
    out.push(`<section class="host"><div class="host-head"><span class="dot ${info.state}"></span><span class="name" title="${esc(nameOf(h))}">${esc(nameOf(h))}${info.local ? ' · este equipo' : ''}</span>`
      + (has(id, 'projects') ? `<button class="icon-btn small" data-add-project="${esc(id)}" title="Añadir proyecto">+</button>` : '') + '</div>');
    if (info.state !== 'connected') out.push(`<div class="host-reason">${esc(info.state === 'connecting' ? 'Conectando…' : info.reason ?? 'Sin conectar')}</div>`);
    if (snap) {
      if (!snap.projects.length) out.push('<div class="side-empty">Sin proyectos: crea carpetas en la de proyectos del host.</div>');
      for (const p of [...snap.projects].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = `${id}/${p.id}`;
        const collapsed = app.collapsed.has(key);
        const q = app.filter.toLowerCase();
        const threads = snap.threads.filter((t) => t.projectId === p.id && (!q || t.title.toLowerCase().includes(q) || (t.preview ?? '').toLowerCase().includes(q) || p.name.toLowerCase().includes(q)))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        if (q && !threads.length) continue;
        out.push(`<div class="project${collapsed && !q ? ' collapsed' : ''}"><button class="project-name" data-toggle-project="${esc(key)}" title="${esc(p.path)}">${esc(p.name)}</button>`
          + `<button class="icon-btn small hover" data-project-menu="${esc(p.id)}" data-host="${esc(id)}" title="Más acciones">⋯</button>`
          + `<button class="icon-btn" data-new-thread="${esc(p.id)}" data-host="${esc(id)}" title="Nuevo hilo en ${esc(p.name)}">+</button></div>`);
        if (collapsed && !q) continue;
        const shown = app.showAll.has(key) || q ? threads : threads.slice(0, 6);
        for (const t of shown) {
          const active = app.view.kind === 'thread' && app.view.host === id && app.view.thread === t.id;
          const acct = snap.accounts.find((a) => a.id === t.accountId);
          const badge = t.needsApproval ? '<span class="badge approval">!</span>'
            : t.isRunning ? '<span class="spinner" title="Trabajando"></span>'
              : t.isWaiting ? '<span class="badge wait" title="Esperando tareas en segundo plano">…</span>' : '';
          out.push(`<button class="thread${active ? ' active' : ''}" data-open-thread="${esc(t.id)}" data-host="${esc(id)}" data-project="${esc(p.id)}" title="${esc(t.preview ?? t.title)}">`
            + `<span class="tdot" style="background:${esc(acct?.tint ?? 'var(--faint)')}"></span><span class="ttitle">${esc(t.title)}</span>${badge}<span class="time">${relTime(t.updatedAt)}</span></button>`);
        }
        if (threads.length > 6 && !q) out.push(`<button class="more" data-show-all="${esc(key)}">${app.showAll.has(key) ? 'Ver menos' : `Ver los ${threads.length}`}</button>`);
      }
    }
    out.push('</section>');
  }
  if (!app.hosts.size) out.push('<div class="side-empty">Sin hosts todavía.</div>');
  document.getElementById('hosts').innerHTML = out.join('');
  const u = app.update;
  document.getElementById('update-slot').innerHTML = u?.applying
    ? '<div class="update-pill"><span class="spinner"></span><span class="text">Actualizando Relevo…</span></div>'
    : u?.available ? `<div class="update-pill"><span class="text">Nueva versión: <b>${esc(u.latest)}</b></span><button class="btn primary" data-apply-update>Actualizar</button></div>` : '';
  for (const b of document.querySelectorAll('.side-link')) b.classList.toggle('active', b.dataset.view === app.view.kind);
}

let mainKey = null;
function renderMain() {
  const main = document.getElementById('main');
  const v = app.view;
  const key = v.kind === 'thread' ? `thread:${v.host}:${v.thread}` : v.kind;
  if (key !== mainKey) {
    mainKey = key;
    if (v.kind === 'thread') buildThreadView(main);
    else main.innerHTML = '';
  }
  if (v.kind === 'thread') updateThreadView();
  else if (v.kind === 'limits') main.innerHTML = limitsHTML();
  else if (v.kind === 'hosts') renderHostsView(main);
  else if (v.kind === 'usage') renderUsageView(main);
  else if (v.kind === 'settings') renderSettingsView(main);
  else main.innerHTML = emptyHTML();
}

function emptyHTML() {
  const connected = [...app.hosts.values()].filter((h) => h.info.state === 'connected').length;
  const hint = !app.live ? 'Conectando con el servicio de este equipo…'
    : !app.hosts.size ? 'Añade un host en «Hosts».'
      : connected ? 'Elige un hilo a la izquierda, o crea uno con + junto a un proyecto.' : 'Esperando a que algún host conecte.';
  return `<div class="empty"><h2>Relevo</h2><p>${hint}</p></div>`;
}

// MARK: - Thread view

let threadEls = null;
let rowCache = new Map();

function buildThreadView(main) {
  main.innerHTML = `
    <header class="thread-head">
      <div class="titles"><h1 id="t-title"></h1><div class="sub" id="t-sub"></div></div>
      <div class="head-actions" id="t-actions"></div>
      <label class="toggle" title="Mostrar cada llamada a herramienta en vez de resumirlas"><input type="checkbox" id="show-tools"> Herramientas</label>
    </header>
    <div class="transcript" id="transcript"><div class="hidden-note" id="t-hidden"></div><div class="items" id="t-items"></div></div>
    <div class="dock"><div class="dock-inner">
      <div id="t-banners"></div>
      <div id="t-queue"></div>
      <div class="composer">
        <div class="attachments" id="t-attachments"></div>
        <textarea id="draft" rows="2" placeholder="Escribe un mensaje…"></textarea>
        <div class="composer-bar">
          <select id="sel-model" title="Suscripción y modelo"></select>
          <select id="sel-effort" title="Razonamiento"></select>
          <select id="sel-mode" title="Permisos"></select>
          <select id="sel-plan" title="Si se acaba la cuota"></select>
          <div class="meters" id="t-meters"></div>
          <span class="spacer"></span>
          <button class="btn danger" id="btn-stop" hidden>Detener</button>
          <button class="btn" id="btn-now" hidden title="Interrumpe al agente y envía esto ya (Ctrl+Intro)">Enviar ya</button>
          <button class="btn primary" id="btn-send">Enviar</button>
        </div>
      </div>
      <div class="hint" id="t-hint"></div>
    </div></div>`;
  threadEls = {
    title: main.querySelector('#t-title'), sub: main.querySelector('#t-sub'), transcript: main.querySelector('#transcript'),
    items: main.querySelector('#t-items'), hidden: main.querySelector('#t-hidden'), banners: main.querySelector('#t-banners'),
    queue: main.querySelector('#t-queue'), draft: main.querySelector('#draft'), model: main.querySelector('#sel-model'),
    effort: main.querySelector('#sel-effort'), mode: main.querySelector('#sel-mode'), plan: main.querySelector('#sel-plan'),
    meters: main.querySelector('#t-meters'), stop: main.querySelector('#btn-stop'), now: main.querySelector('#btn-now'),
    send: main.querySelector('#btn-send'), hint: main.querySelector('#t-hint'), tools: main.querySelector('#show-tools'),
    actions: main.querySelector('#t-actions'),
    signatures: {},
  };
  rowCache = new Map();
  const { hostId, threadId } = current();
  const draftKey = `${hostId}/${threadId}`;
  threadEls.draft.value = app.drafts.get(draftKey) ?? '';
  threadEls.tools.checked = app.showTools;
  threadEls.tools.onchange = () => { app.showTools = threadEls.tools.checked; save('showTools', app.showTools); renderMain(); };
  let draftTimer = 0;
  threadEls.draft.oninput = () => {
    app.drafts.set(draftKey, threadEls.draft.value);
    saveDrafts();
    autosize();
    updateComposer();
    clearTimeout(draftTimer);
    // The Mac classifies what you're typing («Relevo sugiere»); other hosts ignore it.
    draftTimer = setTimeout(() => sendTo(hostId, Client.setDraft(threadId, threadEls.draft.value)), 700);
  };
  threadEls.draft.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && isRunning()) sendDraft(true); else sendDraft(false);
  };
  threadEls.send.onclick = () => sendDraft(false);
  threadEls.now.onclick = () => sendDraft(true);
  threadEls.stop.onclick = () => sendTo(hostId, Client.stop(threadId));
  threadEls.model.onchange = () => {
    const [accountId, model] = threadEls.model.value.split('|');
    sendTo(hostId, Client.select(threadId, accountId, model));
  };
  threadEls.effort.onchange = () => sendTo(hostId, Client.setEffort(threadId, threadEls.effort.value || null));
  threadEls.mode.onchange = () => sendTo(hostId, Client.setMode(threadId, threadEls.mode.value));
  threadEls.plan.onchange = () => {
    const v = threadEls.plan.value;
    if (v === 'default') sendTo(hostId, Client.setLimitPlan(threadId, null));
    else if (v.startsWith('chain|')) {
      const [, accountId, model] = v.split('|');
      sendTo(hostId, Client.setLimitPlan(threadId, { mode: 'chain', targets: [{ accountId, model }] }));
    } else if (v !== 'current') sendTo(hostId, Client.setLimitPlan(threadId, { mode: v, targets: [] }));
  };
  threadEls.transcript.onscroll = () => { threadEls.stick = nearBottom(); };
  attachments.length = 0;
  renderAttachments();
  // Images pasted or dropped on the composer go to the host; the message names their path for the agent.
  const composer = main.querySelector('.composer');
  threadEls.draft.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); attach(files); }
  });
  composer.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); composer.classList.add('drop'); } });
  composer.addEventListener('dragleave', () => composer.classList.remove('drop'));
  composer.addEventListener('drop', (e) => {
    composer.classList.remove('drop');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); attach(files); }
  });
  threadEls.stick = true;
  autosize();
  setTimeout(() => threadEls?.draft.focus(), 0);
}

function current() {
  const hostId = app.view.host, threadId = app.view.thread;
  const h = host(hostId);
  return { hostId, threadId, h, thread: h?.data.threads.get(threadId), summary: h?.data.snapshot?.threads.find((t) => t.id === threadId) };
}
const isRunning = () => current().thread?.runtime?.isRunning ?? false;
const nearBottom = () => { const t = threadEls.transcript; return t.scrollHeight - t.scrollTop - t.clientHeight < 80; };

function autosize() {
  const d = threadEls.draft;
  d.style.height = 'auto';
  d.style.height = `${Math.min(260, Math.max(52, d.scrollHeight))}px`;
}

function canSend() {
  const { h, thread } = current();
  if (h?.info.state !== 'connected' || (!threadEls.draft.value.trim() && !attachments.some((a) => a.path))) return false;
  if (attachments.some((a) => !a.path && !a.error)) return false; // still uploading
  return !thread?.runtime?.isRunning || thread.runtime.queued !== undefined;
}

function sendDraft(now) {
  if (!canSend()) return;
  const { hostId, threadId } = current();
  const files = attachments.filter((a) => a.path).map((a) => `[Imagen adjunta: ${a.path}]`);
  const text = [threadEls.draft.value.trim(), ...files].filter(Boolean).join('\n\n');
  attachments.length = 0;
  renderAttachments();
  sendTo(hostId, now ? Client.sendNow(threadId, text) : Client.send(threadId, text));
  threadEls.draft.value = '';
  app.drafts.delete(`${hostId}/${threadId}`);
  saveDrafts();
  threadEls.stick = true;
  autosize();
  updateComposer();
}

function updateThreadView() {
  const { hostId, threadId, h, thread, summary } = current();
  if (!h) return;
  const runtime = thread?.runtime;
  const account = accountOf(hostId, runtime?.selectedAccountId ?? summary?.accountId);
  const project = h.data.snapshot?.projects.find((p) => p.id === summary?.projectId);
  threadEls.title.textContent = thread?.title ?? summary?.title ?? 'Hilo';
  threadEls.sub.textContent = [nameOf(h), project?.name, account ? `${account.name} · ${modelName(account, runtime?.selectedModel)}` : null].filter(Boolean).join(' · ');
  const wt = thread?.worktree;
  const quick = project?.quickActions?.length || has(hostId, 'quickActions');
  const actions = [wt ? `<span class="badge-wt" title="${esc(wt.path)}">⑂ ${esc(wt.branch)}</span>` : '',
    has(hostId, 'git') ? '<button class="btn small" data-git title="Cambios en el proyecto, diff y commit">Cambios</button>' : '',
    quick ? '<button class="btn small" data-quick-menu title="Acciones rápidas del proyecto">Acciones</button>' : '',
    '<button class="btn small" data-thread-usage title="Tokens y coste de este hilo">Consumo</button>',
    `<button class="btn small" data-thread-menu title="Más acciones">⋯</button>`].join('');
  if (threadEls.actions.dataset.html !== actions) { threadEls.actions.innerHTML = actions; threadEls.actions.dataset.html = actions; }
  const stick = threadEls.stick;
  renderTranscript(hostId, thread);
  threadEls.banners.innerHTML = bannersHTML(hostId, runtime);
  threadEls.queue.innerHTML = queueHTML(runtime);
  updateComposer();
  if (stick) threadEls.transcript.scrollTop = threadEls.transcript.scrollHeight;
}

function rowsOf(items) {
  // A reply that has started but has no text yet would only be an empty gap at the bottom.
  items = items.filter((it) => !(it.kind === 'assistant' && !it.usage && !it.text.trim()));
  if (app.showTools) return items.map((item) => ({ key: item.id, item }));
  const rows = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const tools = run.filter((i) => i.kind === 'tool');
    if (!tools.length) rows.push(...run.map((item) => ({ key: item.id, item })));
    else {
      const key = `group:${run[0].id}`;
      rows.push({ key, group: run });
      if (app.expanded.has(key)) rows.push(...run.map((item) => ({ key: item.id, item })));
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'reasoning') run.push(item);
    else { flush(); rows.push({ key: item.id, item }); }
  }
  flush();
  return rows;
}

function renderTranscript(hostId, thread) {
  const container = threadEls.items;
  if (!thread) {
    container.innerHTML = '<div class="notice"><span class="spinner"></span></div>';
    rowCache = new Map();
    threadEls.hidden.textContent = '';
    return;
  }
  const key = `${hostId}/${thread.id}`;
  const older = app.older.get(key) ?? [];
  const hidden = Math.max(0, thread.totalItems - thread.items.length - older.length);
  const note = hidden ? `${hidden} elementos anteriores${has(hostId, 'history') ? ' · <button class="link" data-load-older>Cargar más</button>' : ' no se muestran'}` : '';
  if (threadEls.hidden.dataset.html !== note) { threadEls.hidden.innerHTML = note; threadEls.hidden.dataset.html = note; }
  const allItems = older.length ? [...older, ...thread.items] : thread.items;
  // The first assistant item of each turn shows who answered.
  const headers = new Set();
  let need = true;
  for (const it of allItems) {
    if (it.kind === 'user' || it.kind === 'notice') need = true;
    else if (it.kind === 'assistant' && need) { headers.add(it.id); need = false; }
  }
  if (container.querySelector('.notice > .spinner')) container.innerHTML = '';
  const rows = rowsOf(allItems);
  const next = new Map();
  let prev = null;
  for (const row of rows) {
    const version = JSON.stringify([row.item ?? row.group, app.expanded.has(row.key), headers.has(row.key)]);
    let entry = rowCache.get(row.key);
    if (!entry || entry.version !== version) {
      const el = document.createElement('div');
      el.className = 'row';
      el.dataset.key = row.key;
      el.innerHTML = row.group ? groupHTML(row) : itemHTML(hostId, row.item, headers.has(row.key));
      if (entry) entry.el.replaceWith(el);
      entry = { el, version };
    }
    next.set(row.key, entry);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (want !== entry.el) container.insertBefore(entry.el, want);
    prev = entry.el;
  }
  for (const [k, entry] of rowCache) if (!next.has(k)) entry.el.remove();
  rowCache = next;
  hydrateImages(hostId, thread.id);
}

function groupHTML(row) {
  const tools = row.group.filter((i) => i.kind === 'tool');
  const names = [];
  for (const t of tools) {
    const n = t.toolName ?? t.title?.split(' ')[0] ?? 'Herramienta';
    if (!names.includes(n)) names.push(n);
  }
  const failed = tools.filter((t) => t.toolState === 'failed').length;
  const running = tools.some((t) => t.toolState === 'running');
  const count = tools.length === 1 ? '1 acción' : `${tools.length} acciones`;
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
  const open = app.expanded.has(row.key);
  return `<div class="fold"><button class="fold-head" data-toggle="${esc(row.key)}">${running ? '<span class="spinner"></span>' : `<span class="state-icon ${failed ? 'failed' : 'done'}">${failed ? '✕' : '✓'}</span>`}`
    + `<span class="label"><b>${count}</b> · ${esc(list)}${failed ? ` · ${failed} con error` : ''}</span><span class="chev${open ? ' open' : ''}"></span></button></div>`;
}

function itemHTML(hostId, it, header) {
  const open = app.expanded.has(it.id);
  switch (it.kind) {
    case 'user': {
      const turn = it.turnBefore && has(hostId, 'turns')
        ? `<div class="turn-actions"><button class="link" data-turn-changes="${esc(it.id)}">Cambios del turno</button><button class="link" data-turn-restore="${esc(it.id)}">Restaurar a antes…</button></div>` : '';
      return `<div class="msg user"><div class="bubble">${esc(it.text)}${imagesHTML(hostId, it.text)}</div>${turn}</div>`;
    }
    case 'assistant': {
      const acct = accountOf(hostId, it.accountId);
      const head = header && acct ? `<div class="author">${glyph(acct)}${esc(acct.agentName ?? acct.name)}${it.model && it.model !== 'default' ? ` · ${esc(modelName(acct, it.model))}` : ''}</div>` : '';
      return `<div class="msg assistant">${head}<div class="md">${markdown(it.text)}</div>${imagesHTML(hostId, it.text)}${it.usage ? usageHTML(it.usage) : ''}</div>`;
    }
    case 'reasoning':
      return `<div class="fold"><button class="fold-head" data-toggle="${esc(it.id)}"><span class="state-icon">💭</span><span class="label">${esc(firstLine(it.text) || 'Razonamiento')}</span><span class="chev${open ? ' open' : ''}"></span></button>`
        + (open ? `<div class="fold-body md muted">${markdown(it.text)}</div>` : '') + '</div>';
    case 'tool': {
      const state = it.toolState === 'running' ? '<span class="spinner"></span>' : `<span class="state-icon ${it.toolState}">${it.toolState === 'failed' ? '✕' : '✓'}</span>`;
      const label = it.toolName && it.title && !it.title.startsWith(it.toolName) ? `<b>${esc(it.toolName)}</b> ${esc(it.title)}` : `<b>${esc(it.title ?? it.text)}</b>`;
      const body = open && it.output ? `<div class="fold-body"><pre class="out">${esc(it.output)}</pre></div>` : '';
      return `<div class="fold"><button class="fold-head" data-toggle="${esc(it.id)}"${it.output ? '' : ' disabled'}>${state}<span class="label">${label}</span>${it.output ? `<span class="chev${open ? ' open' : ''}"></span>` : ''}</button>${body}</div>`;
    }
    case 'notice': return `<div class="notice">${inline(it.text)}${it.redoTree ? ` · <button class="link" data-redo-tree="${esc(it.redoTree)}">Deshacer</button>` : ''}</div>`;
    case 'error': return `<div class="error-card">${esc(it.text)}</div>`;
    case 'approval': return approvalHTML(it);
    default: return `<div class="notice">${esc(it.text)}</div>`;
  }
}

const firstLine = (s) => String(s ?? '').trim().split('\n')[0].replace(/^[#*\s]+/, '').slice(0, 140);

function usageHTML(u) {
  const parts = [`${tokens(u.tokens)} tokens`];
  if (u.cacheShare) parts.push(`${Math.round(u.cacheShare * 100)} % de caché`);
  if (u.cost) parts.push(`${u.costEstimated ? '≈ ' : ''}${u.cost.toFixed(u.cost < 0.1 ? 3 : 2)} $${u.paid ? '' : ' (equivalente API)'}`);
  if (u.context && u.contextWindow) parts.push(`contexto ${Math.round((u.context / u.contextWindow) * 100)} %`);
  if (u.switchLabel) parts.push(u.switchLabel);
  return `<div class="usage-line" title="${esc(u.switchDetail ?? '')}">${esc(parts.join(' · '))}</div>`;
}

function approvalHTML(it) {
  const pending = !it.resolution;
  let html = `<div class="card${pending ? ' attention' : ''}"><div class="card-title">${esc(it.title ?? it.text)}</div>`;
  if (it.output) html += `<pre class="out">${esc(it.output)}</pre>`;
  if (it.questions?.length) {
    html += `<form data-answer="${esc(it.id)}">`;
    it.questions.forEach((q, qi) => {
      html += `<div class="question">${q.header ? `<div class="qhead">${esc(q.header)}</div>` : ''}<div class="qtext">${esc(q.question)}</div>`;
      for (const [oi, o] of q.options.entries()) {
        const answered = it.answers?.[q.question]?.split(', ').includes(o.label);
        html += `<label class="option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}" value="${oi}"${answered ? ' checked' : ''}${pending ? '' : ' disabled'}>`
          + `<span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`;
      }
      if (pending) html += `<input type="text" class="other" name="o${qi}" placeholder="Otra respuesta…">`;
      else if (it.answers?.[q.question] && !q.options.some((o) => o.label === it.answers[q.question])) html += `<div class="resolution">Respuesta: ${esc(it.answers[q.question])}</div>`;
      html += '</div>';
    });
    if (pending) html += '<div class="actions"><button class="btn primary" type="submit">Responder</button></div>';
    html += '</form>';
  } else if (pending && it.options?.length) {
    html += `<div class="actions">${it.options.map((o) => `<button class="btn${o.isAllow ? ' primary' : ''}" data-approve="${esc(it.id)}" data-option="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</div>`;
  }
  if (it.resolution) html += `<div class="resolution">${esc(it.resolution)}</div>`;
  return `${html}</div>`;
}

function bannersHTML(hostId, rt) {
  if (!rt) return '';
  const out = [];
  const acctName = (id) => accountOf(hostId, id)?.name ?? 'otra suscripción';
  const target = (c) => `${acctName(c.accountId)} · ${modelName(accountOf(hostId, c.accountId), c.model)}`;
  if (rt.pendingRelay) {
    out.push(`<div class="banner limit"><span class="text">Sin cuota: paso a <b>${esc(target(rt.pendingRelay))}</b> en ${countdown(rt.pendingRelay.at)} s</span>`
      + '<button class="btn primary" data-limit="relayNow">Ya</button><button class="btn" data-limit="cancelRelay">No pasar</button></div>');
  } else if (rt.resumeAt) {
    out.push(`<div class="banner warn"><span class="text">Sin cuota: sigo con el mismo agente ${esc(resetText(rt.resumeAt) ?? '')}</span>`
      + '<button class="btn" data-limit="resumeNow">Seguir ya</button><button class="btn" data-limit="cancelResume">No esperar</button></div>');
  } else if (rt.limit) {
    const l = rt.limit;
    const when = resetText(l.resetsAt);
    const relays = (rt.relayCandidates ?? []).slice(0, 4).map((c) => `<button class="btn" data-relay="${esc(c.accountId)}" data-model="${esc(c.model)}">Relevar a ${esc(target(c))}</button>`).join('');
    out.push(`<div class="banner limit"><span class="text"><b>${esc(acctName(l.accountId))}</b>: ${esc(l.message)}${when ? ` · se reinicia ${esc(when)}` : ''}</span>${relays}</div>`);
  }
  if (rt.suggestion) {
    const s = rt.suggestion;
    const what = `${target(s)}${s.effort ? ` · ${effortName(s.effort)}` : ''}`;
    const reasons = s.reasons?.length ? ` — ${s.reasons.join(' · ')}` : '';
    out.push(s.autoApplied
      ? `<div class="banner suggest"><span class="text">Relevo ha elegido <b>${esc(what)}</b>${esc(reasons)}${s.byAI ? ' (IA)' : ''}</span><button class="btn" data-suggestion="undo">Deshacer</button></div>`
      : `<div class="banner suggest"><span class="text">Relevo sugiere <b>${esc(what)}</b>${esc(reasons)}${s.byAI ? ' (IA)' : ''}</span><button class="btn primary" data-suggestion="accept">Usar</button><button class="btn" data-suggestion="dismiss">Descartar</button></div>`);
  }
  if (rt.backgroundTasks?.length && !rt.isRunning) {
    out.push(`<div class="banner"><span class="spinner"></span><span class="text">Esperando ${rt.backgroundTasks.length === 1 ? 'una tarea' : `${rt.backgroundTasks.length} tareas`} en segundo plano: ${esc(rt.backgroundTasks.map((b) => b.description).join(' · '))}</span></div>`);
  }
  if (rt.isRunning) out.push(`<div class="status"><span class="spinner"></span>${esc(rt.statusLine ?? 'Trabajando…')}</div>`);
  return out.join('');
}

function queueHTML(rt) {
  const queued = rt?.queued ?? [];
  if (!queued.length) return '';
  const head = rt.queuePaused
    ? '<div class="banner warn"><span class="text">La cola está en pausa (el último turno no terminó bien)</span><button class="btn" data-resume-queue>Reanudar</button></div>' : '';
  return head + queued.map((q) => `<div class="queued"><span class="text" title="${esc(q.text)}">⏳ ${esc(q.text)}</span>`
    + `<button class="btn" data-queued-now="${esc(q.id)}">Enviar ya</button><button class="btn" data-dequeue="${esc(q.id)}" title="Quitar de la cola">✕</button></div>`).join('');
}

/** Rebuilds a select's options only when they change, so an open dropdown isn't reset by every patch. */
function setOptions(select, options, value, signatureKey) {
  const signature = JSON.stringify(options);
  if (threadEls.signatures[signatureKey] !== signature) {
    threadEls.signatures[signatureKey] = signature;
    select.innerHTML = options.map((o) => (o.group !== undefined
      ? `<optgroup label="${esc(o.group)}">${o.options.map(optionHTML).join('')}</optgroup>` : optionHTML(o))).join('');
  }
  if (document.activeElement !== select) select.value = value;
}
const optionHTML = (o) => `<option value="${esc(o.value)}"${o.disabled ? ' disabled' : ''} title="${esc(o.title ?? '')}">${esc(o.label)}</option>`;

function updateComposer() {
  if (!threadEls) return;
  const { hostId, h, thread } = current();
  const rt = thread?.runtime;
  const snap = h?.data.snapshot;
  const accounts = snap?.accounts ?? [];
  const connected = h?.info.state === 'connected';
  const running = rt?.isRunning ?? false;

  const selAccount = accounts.find((a) => a.id === rt?.selectedAccountId);
  setOptions(threadEls.model, accounts.map((a) => {
    const note = availability(a);
    return {
      group: `${a.name}${note ? ` (${note})` : ''}`,
      options: a.models.filter((m) => !m.hidden || (a.id === rt?.selectedAccountId && m.id === rt?.selectedModel))
        .map((m) => ({ value: `${a.id}|${m.id}`, label: `${a.name} · ${m.name}`, title: m.detail })),
    };
  }), `${rt?.selectedAccountId}|${rt?.selectedModel}`, 'model');
  threadEls.model.disabled = !rt || !connected;

  const model = modelOf(selAccount, rt?.selectedModel);
  const efforts = model?.efforts ?? [];
  threadEls.effort.hidden = !efforts.length;
  setOptions(threadEls.effort, [{ value: '', label: `Razonamiento: ${model?.defaultEffort ? `${effortName(model.defaultEffort)} (auto)` : 'auto'}` },
    ...efforts.map((e) => ({ value: e, label: `Razonamiento: ${effortName(e)}` }))], rt?.selectedEffort ?? '', 'effort');

  setOptions(threadEls.mode, Object.entries(MODES).map(([value, [label, title]]) => ({ value, label, title })), rt?.mode ?? 'autoEdit', 'mode');
  threadEls.mode.disabled = !rt || !connected;
  threadEls.effort.disabled = !rt || !connected;

  // What to do when the quota runs out: only hosts that support it send a default plan.
  const def = rt?.defaultLimitPlan, own = rt?.limitPlan;
  threadEls.plan.hidden = !def;
  if (def) {
    const opts = [{ value: 'default', label: `Sin cuota: como en el host (${def.summary ?? def.mode})` },
      { value: 'mostQuota', label: 'Sin cuota: pasar a la de más cuota' },
      { value: 'wait', label: 'Sin cuota: esperar y seguir' },
      { value: 'ask', label: 'Sin cuota: avisarme' }];
    for (const a of accounts) for (const m of a.models.filter((x) => !x.hidden)) opts.push({ value: `chain|${a.id}|${m.id}`, label: `Sin cuota: pasar a ${a.name} · ${m.name}` });
    let value = own ? own.mode : 'default';
    if (own?.mode === 'chain') {
      value = own.targets.length === 1 ? `chain|${own.targets[0].accountId}|${own.targets[0].model}` : 'current';
      if (value === 'current') opts.push({ value: 'current', label: `Sin cuota: en orden (${own.summary ?? ''})` });
    }
    setOptions(threadEls.plan, opts, value, 'plan');
  }

  const windows = rt?.usage ?? selAccount?.status?.windows ?? [];
  const note = rt?.usageNote ?? (windows.length ? null : selAccount?.status?.note);
  threadEls.meters.innerHTML = windows.slice(0, 3).map((w) => `<span class="meter" title="${esc(`${w.label}: ${Math.round(w.percent)} %${w.resetsAt ? ` · se reinicia ${resetText(w.resetsAt)}` : ''}`)}">`
    + `${esc(w.label)} <span class="bar ${barClass(w.percent)}"><i style="width:${Math.min(100, w.percent)}%"></i></span>${Math.round(w.percent)} %</span>`).join('')
    + (note ? `<span class="meter">${esc(note)}</span>` : '');

  threadEls.stop.hidden = !running;
  threadEls.now.hidden = !running;
  const ok = canSend();
  threadEls.send.disabled = !ok;
  threadEls.now.disabled = !ok;
  threadEls.send.textContent = running ? 'A la cola' : 'Enviar';
  threadEls.draft.placeholder = !connected ? `Sin conexión con ${nameOf(h)}` : running ? 'Escribe y se enviará al terminar el turno…' : 'Escribe un mensaje…';
  threadEls.hint.textContent = running ? 'Intro: a la cola · Ctrl+Intro: interrumpir y enviar ya · Mayús+Intro: nueva línea' : 'Intro: enviar · Mayús+Intro: nueva línea';
}

// MARK: - Limits

function limitsHTML() {
  const out = ['<div class="view"><h1>Límites</h1><p class="lead">Cuota de cada suscripción en cada host.</p>'];
  for (const [id, h] of app.hosts) {
    const snap = h.data.snapshot;
    out.push(`<div class="section-head"><span class="dot ${h.info.state}"></span><h2>${esc(nameOf(h))}</h2>`
      + `<button class="btn" data-refresh="${esc(id)}"${h.info.state === 'connected' ? '' : ' disabled'}>Actualizar</button></div>`);
    if (!snap) { out.push(`<p class="note">${esc(h.info.reason ?? 'Sin datos todavía')}</p>`); continue; }
    if (!snap.accounts.length) { out.push('<p class="note">Este host no tiene agentes configurados.</p>'); continue; }
    out.push('<div class="grid">');
    for (const a of snap.accounts) {
      const s = a.status;
      const sub = [s?.plan, s?.email].filter(Boolean).join(' · ');
      out.push(`<div class="card acct"><div class="acct-head">${glyph(a, 28)}<div class="who"><b>${esc(a.name)}</b><span>${esc(sub || a.agentName)}</span></div>${a.refreshing ? '<span class="spinner"></span>' : ''}</div>`);
      if (s?.loggedIn === false) out.push('<div class="note bad">Sin sesión en este host</div>');
      if (s?.noPlan) out.push('<div class="note bad">El plan no incluye este agente</div>');
      for (const w of s?.windows ?? []) {
        const when = resetText(w.resetsAt);
        out.push(`<div class="win"><div class="win-top"><b>${esc(w.label)}</b><span>${Math.round(w.percent)} %${when ? ` · ${esc(when)}` : ''}</span></div>`
          + `<div class="bar ${barClass(w.percent)}"><i style="width:${Math.min(100, w.percent)}%"></i></div>${w.detail ? `<div class="note">${esc(w.detail)}</div>` : ''}</div>`);
      }
      if (s?.note) out.push(`<div class="note">${esc(s.note)}</div>`);
      if (s?.error) out.push(`<div class="note bad">${esc(s.error)}</div>`);
      if (!s) out.push('<div class="note">Comprobando…</div>');
      if (s?.updatedAt) out.push(`<div class="note">Actualizado hace ${relTime(s.updatedAt)}</div>`);
      out.push('</div>');
    }
    out.push('</div>');
  }
  out.push('</div>');
  return out.join('');
}

// MARK: - Hosts

function renderHostsView(main) {
  // Keep what's being typed in the link field across updates.
  const typed = main.querySelector('#pair-link')?.value ?? '';
  const focused = document.activeElement?.id === 'pair-link';
  const out = ['<div class="view"><h1>Hosts</h1><p class="lead">Cada equipo donde corren agentes: este, el Mac, un mini PC… Relevo se conecta a todos a la vez.</p><div class="stack">'];
  for (const [id, h] of app.hosts) {
    const i = h.info;
    const status = i.state === 'connected' ? `Conectado${i.via ? ` · ${i.via}` : ''}` : i.state === 'connecting' ? 'Conectando…' : i.reason ?? 'Sin conectar';
    out.push(`<div class="card host-row"><span class="dot ${i.state}"></span><div class="who"><b>${esc(nameOf(h))}</b><span>${esc(status)}</span></div>`
      + `<button class="btn" data-reconnect="${esc(id)}">Reconectar</button>`
      + (i.local ? '' : `<button class="btn danger" data-remove="${esc(id)}">Quitar</button>`) + '</div>');
  }
  out.push('</div><div class="section-head"><h2>Añadir un host</h2></div><div class="stack">'
    + '<p class="note">En el Mac: Ajustes › iPhone › copiar enlace. En un host sin pantalla: <code>relevo-host pair</code>. Pega aquí el enlace <code>relevocompanion://pair?…</code>.</p>'
    + `<div class="paste"><input type="text" id="pair-link" placeholder="relevocompanion://pair?…" value="${esc(typed)}" autocomplete="off" spellcheck="false"><button class="btn primary" id="pair-add">Añadir</button></div></div>`);
  if (app.pairingLink) {
    out.push('<div class="section-head"><h2>Vincular el iPhone con este equipo</h2></div><div class="stack">'
      + '<p class="note">En Relevo Companion: Ajustes › Hosts › Añadir otro host › Pegar. El enlace lleva la clave: no lo compartas.</p>'
      + '<div class="paste"><input type="text" id="own-link" readonly value="••••••••••••••••••••••••"><button class="btn" id="copy-link">Copiar enlace</button></div></div>');
  }
  const u = app.update;
  if (u) {
    const checked = u.checkedAt ? ` · comprobado hace ${relTime(u.checkedAt)}` : '';
    const state = u.applying ? 'Instalando y reiniciando…'
      : u.available ? `Hay una versión nueva: <b>${esc(u.latest)}</b>`
        : u.latest ? `Al día (última publicada: ${esc(u.latest)})` : u.checkedAt ? 'El repositorio aún no tiene versiones publicadas' : 'Sin comprobar todavía';
    out.push('<div class="section-head"><h2>Actualizaciones</h2></div><div class="stack">'
      + `<p class="note">Versión instalada en este equipo: <b>${esc(u.current)}</b>${checked}. ${state}</p>`
      + (u.error ? `<p class="note bad">${esc(u.error)}</p>` : '')
      + `<div class="actions"><button class="btn" data-check-update${u.applying ? ' disabled' : ''}>Buscar actualizaciones</button>`
      + (u.available ? `<button class="btn primary" data-apply-update${u.applying ? ' disabled' : ''}>Actualizar a ${esc(u.latest)}</button>` : '')
      + '</div><p class="note">Al actualizar, el servicio se reinicia y la ventana se recarga sola. Los turnos que estén en marcha en este equipo se interrumpen: el hilo sigue cuando le escribas.</p></div>');
  }
  if ('Notification' in window && Notification.permission !== 'granted') {
    out.push('<div class="section-head"><h2>Avisos</h2></div><div class="stack"><p class="note">Avisos de Windows cuando un hilo termina o necesita tu respuesta y no lo estás mirando.</p>'
      + `<div><button class="btn" id="enable-notifications"${Notification.permission === 'denied' ? ' disabled' : ''}>${Notification.permission === 'denied' ? 'Bloqueados en el navegador' : 'Activar avisos'}</button></div></div>`);
  }
  out.push('</div>');
  main.innerHTML = out.join('');
  const input = main.querySelector('#pair-link');
  if (focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  const add = () => { if (input.value.trim()) { post({ type: 'pair', link: input.value.trim() }); input.value = ''; } };
  main.querySelector('#pair-add').onclick = add;
  input.onkeydown = (e) => { if (e.key === 'Enter') add(); };
  const copy = main.querySelector('#copy-link');
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(app.pairingLink); toast('Enlace copiado'); } catch { toast('No he podido copiarlo'); }
  };
  const enable = main.querySelector('#enable-notifications');
  if (enable) enable.onclick = async () => { await Notification.requestPermission(); renderMain(); };
}

// MARK: - Actions

document.addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el || el.disabled) return;
  const d = el.dataset;
  const { hostId, threadId } = app.view.kind === 'thread' ? current() : {};
  if (d.view) setView(app.view.kind === d.view ? { kind: 'empty' } : { kind: d.view });
  else if (d.openThread) openThread(d.host, d.openThread);
  else if (d.newThread) newThread(d.host, d.newThread);
  else if (d.toggleProject) {
    if (!app.collapsed.delete(d.toggleProject)) app.collapsed.add(d.toggleProject);
    save('collapsedProjects', [...app.collapsed]);
    renderSidebar();
  } else if (d.showAll) {
    if (!app.showAll.delete(d.showAll)) app.showAll.add(d.showAll);
    renderSidebar();
  } else if (d.toggle) {
    if (!app.expanded.delete(d.toggle)) app.expanded.add(d.toggle);
    threadEls.stick = false;
    renderMain();
  } else if (d.approve) sendTo(hostId, Client.approve(threadId, d.approve, d.option));
  else if (d.relay) sendTo(hostId, Client.relay(threadId, d.relay, d.model));
  else if (d.limit) sendTo(hostId, Client.limitAction(threadId, d.limit));
  else if (d.suggestion) sendTo(hostId, Client.suggestion(threadId, d.suggestion));
  else if (d.queuedNow) sendTo(hostId, Client.sendQueuedNow(threadId, d.queuedNow));
  else if (d.dequeue) sendTo(hostId, Client.dequeue(threadId, d.dequeue));
  else if (d.resumeQueue !== undefined) sendTo(hostId, Client.resumeQueue(threadId));
  else if (d.refresh) { sendTo(d.refresh, Client.refreshUsage()); toast('Comprobando la cuota…'); }
  else if (d.reconnect) post({ type: 'reconnect', host: d.reconnect });
  else if (d.addProject) addProjectDialog(d.addProject);
  else if (d.projectMenu) { const r = el.getBoundingClientRect(); projectMenu(d.host, d.projectMenu, r.left, r.bottom); }
  else if (d.threadMenu !== undefined) { const r = el.getBoundingClientRect(); threadMenu(hostId, threadId, r.left, r.bottom); }
  else if (d.git !== undefined) gitDialog(hostId, threadId);
  else if (d.threadUsage !== undefined) threadUsageDialog(hostId, threadId);
  else if (d.loadOlder !== undefined) loadOlder(hostId, threadId);
  else if (d.image) imageViewer(d.image, d.imgHost, d.imgThread);
  else if (d.login) loginDialog(d.loginHost, d.login);
  else if (d.turnChanges) turnChangesDialog(hostId, threadId, d.turnChanges);
  else if (d.turnRestore) restoreTurn(hostId, threadId, d.turnRestore);
  else if (d.redoTree) request(hostId, { restoreTree: { threadId, tree: d.redoTree } }).then((r) => toast(r.ok ? 'Restauración deshecha' : r.error));
  else if (d.quickMenu !== undefined) { const r = el.getBoundingClientRect(); quickMenu(hostId, threadId, r.left, r.bottom); }
  else if (d.removeAttachment) { attachments.splice(Number(d.removeAttachment), 1); renderAttachments(); }
  else if (d.addAccount) accountDialog(d.addAccount);
  else if (d.editAccount) accountDialog(d.accountHost, d.editAccount);
  else if (d.removeAccount) removeAccount(d.accountHost, d.removeAccount);
  else if (d.checkUpdate !== undefined) { post({ type: 'checkUpdate' }); toast('Buscando actualizaciones…'); }
  else if (d.applyUpdate !== undefined) {
    const running = [...app.hosts.values()].filter((h) => h.info.local).flatMap((h) => h.data.snapshot?.threads ?? []).filter((t) => t.isRunning).length;
    const warn = running ? `\n\n${running === 1 ? 'Hay un hilo trabajando' : `Hay ${running} hilos trabajando`} en este equipo: se interrumpirá${running === 1 ? '' : 'n'}.` : '';
    if (confirm(`¿Actualizar Relevo a ${app.update?.latest}? El servicio se reiniciará.${warn}`)) post({ type: 'applyUpdate' });
  }
  else if (d.remove) {
    const name = nameOf(host(d.remove));
    if (confirm(`¿Quitar ${name}? Para volver a añadirlo necesitarás su enlace de vinculación.`)) post({ type: 'remove', host: d.remove });
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-answer]');
  if (!form) return;
  e.preventDefault();
  const { hostId, threadId, thread } = current();
  const item = thread?.items.find((i) => i.id === form.dataset.answer);
  if (!item) return;
  const answers = {};
  item.questions.forEach((q, qi) => {
    const other = form.elements[`o${qi}`]?.value.trim();
    const picked = [...form.querySelectorAll(`input[name="q${qi}"]:checked`)].map((i) => q.options[Number(i.value)].label);
    const a = other || picked.join(', ');
    if (a) answers[q.question] = a;
  });
  if (Object.keys(answers).length < item.questions.length) { toast('Responde a todas las preguntas'); return; }
  sendTo(hostId, Client.answer(threadId, item.id, answers));
});

let toastTimer = 0;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// Countdowns (relay in N s) and relative times move on their own.
setInterval(() => {
  if (app.view.kind === 'thread') {
    const rt = current().thread?.runtime;
    if (rt?.pendingRelay || rt?.resumeAt) threadEls.banners.innerHTML = bannersHTML(current().hostId, rt);
  }
}, 1000);
setInterval(renderSidebar, 60_000);
document.addEventListener('visibilitychange', updateTitle);


// MARK: - Projects and threads (menus and dialogs)

const req = (hostId) => (message) => request(hostId, message);
const copy = async (text, done = 'Copiado') => {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('No he podido copiarlo'); }
};
/** VS Code opens local folders through its URL scheme (only for the host on this machine). */
const vscodeURL = (p) => `vscode://file/${encodeURI(String(p).replaceAll('\\', '/')).replace(/^\/?/, '/').replace(/^\/([A-Za-z]:)/, '$1')}`;

function projectMenu(hostId, projectId, x, y) {
  const h = host(hostId);
  const p = h?.data.snapshot?.projects.find((pr) => pr.id === projectId);
  if (!p) return;
  const items = [
    { label: 'Nuevo hilo', action: () => newThread(hostId, projectId) },
    { label: 'Comparar agentes…', action: () => compareDialog(hostId, projectId) },
  ];
  if (has(hostId, 'worktrees')) items.splice(1, 0, { label: 'Nuevo hilo en un worktree', action: async () => {
    const r = await request(hostId, { newWorktreeThread: { projectId } });
    if (r.ok) openThread(hostId, r.threadId); else toast(r.error);
  } });
  if (has(hostId, 'quickActions')) items.push({ label: 'Acciones rápidas…', action: () => quickActionsEditor(hostId, projectId) });
  items.push('-');
  if (h.info.local) items.push({ label: 'Abrir en VS Code', action: () => { location.href = vscodeURL(p.path); } });
  items.push({ label: 'Copiar ruta', action: () => copy(p.path, 'Ruta copiada') });
  if (has(hostId, 'projects')) {
    items.push('-',
      { label: 'Quitar de Relevo…', action: async () => {
        if (await confirmDialog({ title: `Quitar ${p.name}`, text: `Deja de aparecer en Relevo; la carpeta y sus hilos no se borran (vuelve a añadirla para recuperarlos).`, confirm: 'Quitar' })) {
          const r = await request(hostId, { removeProject: { projectId, deleteThreads: false } });
          toast(r.ok ? `${p.name} quitado` : r.error);
        }
      } },
      { label: 'Quitar y borrar sus hilos…', danger: true, action: async () => {
        if (await confirmDialog({ title: `Quitar ${p.name} y borrar sus hilos`, text: 'Los hilos de este proyecto se borran de Relevo para siempre. La carpeta del proyecto no se toca.', confirm: 'Borrar hilos', danger: true })) {
          const r = await request(hostId, { removeProject: { projectId, deleteThreads: true } });
          toast(r.ok ? `${p.name} quitado y sus hilos borrados` : r.error);
        }
      } });
  }
  showMenu(x, y, items);
}

function threadMenu(hostId, threadId, x, y) {
  const t = snapshotOf(hostId)?.threads.find((th) => th.id === threadId);
  if (!t) return;
  const items = [{ label: 'Abrir', action: () => openThread(hostId, threadId) }];
  const full = host(hostId)?.data.threads.get(threadId);
  const wt = full?.worktree;
  if (wt) {
    items.push('-', { label: `Fusionar ${wt.branch} en ${wt.base ?? 'la rama base'}…`, action: () => mergeWorktreeDialog(hostId, threadId, wt) },
      { label: 'Eliminar worktree…', danger: true, action: async () => {
        if (!await confirmDialog({ title: 'Eliminar worktree', text: `Se borran la carpeta del worktree y la rama ${wt.branch} con sus cambios sin fusionar. El hilo sigue en la carpeta del proyecto.`, confirm: 'Eliminar', danger: true })) return;
        const r = await request(hostId, { removeWorktree: { threadId, deleteBranch: true } });
        toast(r.ok ? 'Worktree eliminado' : r.error);
      } });
  }
  if (has(hostId, 'threads')) {
    items.push(
      { label: 'Renombrar…', action: async () => {
        const title = await promptDialog({ title: 'Renombrar hilo', label: 'Título', value: t.title });
        if (title) { const r = await request(hostId, { renameThread: { threadId, title } }); if (!r.ok) toast(r.error); }
      } },
      { label: 'Regenerar título con IA', action: async () => {
        toast('Pidiendo un título…');
        const r = await request(hostId, { regenerateTitle: { threadId } });
        toast(r.ok ? `Título: ${r.title}` : r.error);
      } },
      '-',
      { label: 'Eliminar hilo…', danger: true, action: async () => {
        if (!await confirmDialog({ title: 'Eliminar hilo', text: `«${t.title}» y su conversación se borran de Relevo para siempre. Los cambios en ficheros no se tocan.`, confirm: 'Eliminar', danger: true })) return;
        const r = await request(hostId, { deleteThread: { threadId } });
        if (!r.ok) { toast(r.error); return; }
        if (app.view.thread === threadId) setView({ kind: 'empty' });
      } });
  }
  showMenu(x, y, items);
}

document.addEventListener('contextmenu', (e) => {
  const thread = e.target.closest('.thread[data-open-thread]');
  if (thread) { e.preventDefault(); threadMenu(thread.dataset.host, thread.dataset.openThread, e.clientX, e.clientY); return; }
  const project = e.target.closest('.project');
  const menuBtn = project?.querySelector('[data-project-menu]');
  if (menuBtn) { e.preventDefault(); projectMenu(menuBtn.dataset.host, menuBtn.dataset.projectMenu, e.clientX, e.clientY); }
});

document.getElementById('filter').addEventListener('input', (e) => { app.filter = e.target.value.trim(); renderSidebar(); });

function addProjectDialog(hostId) {
  const root = snapshotOf(hostId)?.hostSettings?.projectsRoot ?? '';
  const d = openDialog({ title: `Añadir proyecto en ${nameOf(host(hostId))}`, body: `
    <div class="choice-grid">
      <section class="choice"><h3>Abrir carpeta existente</h3><p class="note">Cualquier carpeta del equipo: se añade tal cual, con sus ficheros y su git.</p>
        <button class="btn primary" data-pick>Elegir carpeta…</button></section>
      <section class="choice"><h3>Crear proyecto nuevo</h3><p class="note">Una carpeta nueva dentro de <code>${esc(root)}</code>.</p>
        <label class="field"><span>Nombre</span><input type="text" data-name placeholder="mi-proyecto"></label>
        <label class="check"><input type="checkbox" data-git checked> Iniciar un repositorio git</label>
        <button class="btn" data-create>Crear</button></section>
    </div>` });
  d.el.querySelector('[data-pick]').onclick = async () => {
    const path = await chooseFolder({ title: 'Elegir la carpeta del proyecto', request: req(hostId), confirm: 'Añadir esta carpeta' });
    if (!path) return;
    const r = await request(hostId, { addProject: { path } });
    toast(r.ok ? 'Proyecto añadido' : r.error);
    if (r.ok) d.close();
  };
  d.el.querySelector('[data-create]').onclick = async () => {
    const name = d.el.querySelector('[data-name]').value.trim();
    if (!name) { toast('Ponle un nombre'); return; }
    const r = await request(hostId, { createProject: { name, git: d.el.querySelector('[data-git]').checked } });
    toast(r.ok ? `Proyecto ${name} creado` : r.error);
    if (r.ok) d.close();
  };
}

/** The same request to several agents at once, each in its own thread, to compare (as the Mac's «Comparar»). */
function compareDialog(hostId, projectId) {
  const accounts = snapshotOf(hostId)?.accounts ?? [];
  const options = accounts.flatMap((a) => a.models.filter((m) => !m.hidden).map((m) => ({ a, m })));
  // The default model of the first two subscriptions.
  const preselected = accounts.slice(0, 2).map((a) => options.findIndex((o) => o.a === a)).filter((i) => i >= 0);
  const d = openDialog({ title: 'La misma tarea a varios agentes', wide: true, body: `
    <p class="note">Cada agente trabaja en su propio hilo sobre la misma carpeta: mejor para preguntas, revisiones y planes que para cambios que choquen. Gasta cuota de cada suscripción.</p>
    <label class="field"><span>Tarea</span><textarea rows="5" data-prompt placeholder="¿Qué quieres que hagan?"></textarea></label>
    <div class="pick-list">${options.map(({ a, m }, i) => `<label class="check"><input type="checkbox" value="${i}"${preselected.includes(i) ? ' checked' : ''}> ${glyph(a, 16)} ${esc(a.name)} · ${esc(m.name)}${availability(a) ? ` <span class="note">(${esc(availability(a))})</span>` : ''}</label>`).join('')}</div>
    <div class="actions end"><button class="btn" data-close-btn>Cancelar</button><button class="btn primary" data-launch>Lanzar</button></div>` });
  d.el.querySelector('[data-close-btn]').onclick = d.close;
  d.el.querySelector('[data-launch]').onclick = async () => {
    const prompt = d.el.querySelector('[data-prompt]').value.trim();
    const chosen = [...d.el.querySelectorAll('.pick-list input:checked')].map((i) => options[Number(i.value)]);
    if (!prompt) { toast('Escribe la tarea'); return; }
    if (chosen.length < 2 || chosen.length > 4) { toast('Elige entre 2 y 4 agentes'); return; }
    d.close();
    const ids = [];
    for (const { a, m } of chosen) {
      const id = await createThread(hostId, projectId);
      if (!id) continue;
      sendTo(hostId, Client.select(id, a.id, m.id));
      sendTo(hostId, Client.send(id, prompt));
      ids.push(id);
    }
    toast(`${ids.length} agentes trabajando`);
    if (ids[0]) openThread(hostId, ids[0]);
  };
}

// MARK: - Git

async function gitDialog(hostId, threadId) {
  const d = openDialog({ title: 'Cambios del proyecto', wide: true, body: `
    <div class="git"><div class="git-files"><div class="note pad">Cargando…</div></div><div class="git-diff"></div></div>
    <div class="git-commit">
      <textarea rows="3" data-message placeholder="Mensaje del commit"></textarea>
      <div class="actions"><button class="btn" data-ai>Escribir con IA</button><span class="note grow" data-branch></span>
        <button class="btn" data-refresh>Actualizar</button><button class="btn" data-commit>Commit</button><button class="btn primary" data-push>Commit y push</button></div>
      <pre class="out" data-output hidden></pre>
      <div class="pr" data-pr></div>
    </div>` });
  const $ = (s) => d.el.querySelector(s);
  let selected = null;
  const loadPR = async () => {
    if (!has(hostId, 'pullRequests')) return;
    const box = $('[data-pr]');
    const r = await request(hostId, { pullRequest: { threadId } });
    if (!r.ok) { box.innerHTML = `<span class="note">PR: ${esc(r.error)}</span>`; return; }
    if (!r.pr) {
      box.innerHTML = '<span class="note grow">Esta rama no tiene pull request.</span><button class="btn small" data-create-pr>Crear PR</button>';
      box.querySelector('[data-create-pr]').onclick = async (e) => {
        e.target.disabled = true;
        const c = await request(hostId, { createPullRequest: { threadId } }, 180_000);
        toast(c.ok ? 'PR creada' : c.error);
        loadPR();
      };
      return;
    }
    const pr = r.pr;
    const checks = pr.checks.failed ? `<i class="del">✕ ${pr.checks.failed}</i>` : pr.checks.pending ? `⏳ ${pr.checks.pending}` : pr.checks.passed ? `<i class="add">✓ ${pr.checks.passed}</i>` : '';
    box.innerHTML = `<a href="${esc(pr.url)}" target="_blank" rel="noopener"><b>#${pr.number}</b> ${esc(pr.title)}</a><span class="note">${esc({ OPEN: 'abierta', MERGED: 'fusionada', CLOSED: 'cerrada' }[pr.state] ?? pr.state)}${pr.draft ? ' · borrador' : ''}${pr.review ? ` · ${esc({ APPROVED: 'aprobada', CHANGES_REQUESTED: 'piden cambios', REVIEW_REQUIRED: 'falta revisión' }[pr.review] ?? pr.review)}` : ''}</span><span>${checks}</span>`;
  };
  loadPR();
  const showDiff = async (path) => {
    selected = path;
    for (const b of d.el.querySelectorAll('.git-file')) b.classList.toggle('active', (b.dataset.path || null) === path);
    $('.git-diff').innerHTML = '<div class="note pad">Cargando…</div>';
    const r = await request(hostId, { gitDiff: { threadId, path } });
    $('.git-diff').innerHTML = r.ok ? diffHTML(r.diff) : `<div class="note bad pad">${esc(r.error)}</div>`;
  };
  const load = async () => {
    const r = await request(hostId, { gitStatus: { threadId } });
    if (!r.ok) { $('.git-files').innerHTML = `<div class="note bad pad">${esc(r.error)}</div>`; return; }
    const g = r.git;
    if (!g.repo) {
      $('.git-files').innerHTML = '<div class="note pad">Esta carpeta no es un repositorio git.</div>';
      for (const b of d.el.querySelectorAll('.git-commit button')) b.disabled = true;
      return;
    }
    $('[data-branch]').textContent = `Rama ${g.branch ?? '?'}${g.upstream ? ` → ${g.upstream}` : ''}${g.ahead ? ` · ${g.ahead} sin subir` : ''}${g.behind ? ` · ${g.behind} por bajar` : ''}`;
    const total = g.files.reduce((n, f) => [n[0] + f.added, n[1] + f.removed], [0, 0]);
    $('.git-files').innerHTML = g.files.length
      ? `<button class="git-file" data-path=""><b>Todos (${g.files.length})</b><span class="nums"><i class="add">+${total[0]}</i> <i class="del">−${total[1]}</i></span></button>`
        + g.files.map((f) => `<button class="git-file" data-path="${esc(f.path)}" title="${esc(f.path)}"><span class="kind ${f.kind}">${{ new: 'N', deleted: 'B', added: 'A', renamed: 'R' }[f.kind] ?? 'M'}</span><span class="fname">${esc(f.path)}</span><span class="nums">${f.binary ? 'binario' : `<i class="add">+${f.added}</i> <i class="del">−${f.removed}</i>`}</span></button>`).join('')
      : '<div class="note pad">No hay cambios sin commit.</div>';
    if (g.files.length) showDiff(selected); else $('.git-diff').innerHTML = '';
  };
  d.el.addEventListener('click', (e) => { const f = e.target.closest('.git-file'); if (f) showDiff(f.dataset.path || null); });
  $('[data-refresh]').onclick = load;
  $('[data-ai]').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Escribiendo…';
    const r = await request(hostId, { gitMessage: { threadId } });
    e.target.disabled = false; e.target.textContent = 'Escribir con IA';
    if (r.ok) $('[data-message]').value = r.message; else toast(r.error);
  };
  const commit = async (push) => {
    const message = $('[data-message]').value.trim();
    if (!message) { toast('Escribe el mensaje del commit'); return; }
    for (const b of d.el.querySelectorAll('.git-commit button')) b.disabled = true;
    const r = await request(hostId, { gitCommit: { threadId, message, push } }, 180_000);
    for (const b of d.el.querySelectorAll('.git-commit button')) b.disabled = false;
    $('[data-output]').hidden = false;
    $('[data-output]').textContent = r.ok ? r.output : r.error;
    if (r.ok) { $('[data-message]').value = ''; toast(push ? 'Commit y push hechos' : 'Commit hecho'); }
    load();
  };
  $('[data-commit]').onclick = () => commit(false);
  $('[data-push]').onclick = () => commit(true);
  load();
}

// MARK: - Usage

function threadUsageDialog(hostId, threadId) {
  const thread = host(hostId)?.data.threads.get(threadId);
  const items = [...(app.older.get(`${hostId}/${threadId}`) ?? []), ...(thread?.items ?? [])].filter((i) => i.usage);
  const byModel = new Map();
  let total = 0, cost = 0;
  for (const it of items) {
    const acct = accountOf(hostId, it.accountId);
    const k = `${acct?.name ?? '?'} · ${modelName(acct, it.model)}`;
    const e = byModel.get(k) ?? { turns: 0, tokens: 0, cost: 0 };
    e.turns++; e.tokens += it.usage.tokens; e.cost += it.usage.cost ?? 0;
    byModel.set(k, e);
    total += it.usage.tokens; cost += it.usage.cost ?? 0;
  }
  const last = items.at(-1)?.usage;
  openDialog({ title: 'Consumo del hilo', body: items.length ? `
    <div class="stats"><div><b>${items.length}</b><span>turnos</span></div><div><b>${tokens(total)}</b><span>tokens</span></div><div><b>${cost.toFixed(2)} $</b><span>coste (equiv. API)</span></div>
      ${last?.context && last?.contextWindow ? `<div><b>${Math.round((last.context / last.contextWindow) * 100)} %</b><span>contexto ocupado</span></div>` : ''}</div>
    <table class="table-plain"><thead><tr><th>Suscripción y modelo</th><th>Turnos</th><th>Tokens</th><th>Coste</th></tr></thead><tbody>
      ${[...byModel].map(([k, e]) => `<tr><td>${esc(k)}</td><td>${e.turns}</td><td>${tokens(e.tokens)}</td><td>${e.cost.toFixed(2)} $</td></tr>`).join('')}
    </tbody></table>` : '<p class="note">Aún no hay turnos con datos de tokens en este hilo.</p>' });
}

const usageState = { host: null, days: 30, report: null, loading: false, error: null };

function renderUsageView(main) {
  const hosts = [...app.hosts.entries()].filter(([id]) => has(id, 'usage'));
  if (!usageState.host || !host(usageState.host)) usageState.host = hosts[0]?.[0] ?? null;
  const r = usageState.report;
  const out = [`<div class="view"><h1>Consumo</h1><p class="lead">Tokens y coste por modelo, día e hilo.</p>
    <div class="toolbar"><select data-usage-host>${hosts.map(([id, h]) => `<option value="${esc(id)}"${id === usageState.host ? ' selected' : ''}>${esc(nameOf(h))}</option>`).join('')}</select>
    <select data-usage-days>${[[7, '7 días'], [30, '30 días'], [90, '90 días'], [0, 'Todo']].map(([v, l]) => `<option value="${v}"${v === usageState.days ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <button class="btn" data-usage-refresh>Actualizar</button></div>`];
  if (!hosts.length) out.push('<p class="note">Ningún host conectado da estadísticas de consumo (la app del Mac tiene las suyas).</p>');
  else if (usageState.loading) out.push('<p class="note">Calculando…</p>');
  else if (usageState.error) out.push(`<p class="note bad">${esc(usageState.error)}</p>`);
  else if (r && !r.total.turns) out.push('<p class="note">Aún no hay datos de consumo en este periodo.</p>');
  else if (r) {
    const maxDay = Math.max(1, ...r.byDay.map((x) => x.tokens));
    out.push(`<div class="stats"><div><b>${r.total.turns}</b><span>turnos</span></div><div><b>${tokens(r.total.tokens)}</b><span>tokens</span></div><div><b>${r.total.cost.toFixed(2)} $</b><span>coste (equiv. API)</span></div></div>
      <h2 class="h2">Por día</h2><div class="days">${r.byDay.map((x) => `<div class="day" title="${esc(`${x.day}: ${tokens(x.tokens)} tokens · ${x.cost.toFixed(2)} $ · ${x.turns} turnos`)}"><i style="height:${Math.max(2, (x.tokens / maxDay) * 100)}%"></i><span>${x.day.slice(8)}</span></div>`).join('')}</div>
      <h2 class="h2">Por suscripción y modelo</h2><table class="table-plain"><thead><tr><th>Suscripción</th><th>Modelo</th><th>Turnos</th><th>Tokens</th><th>Coste</th></tr></thead><tbody>
      ${r.byModel.map((m) => `<tr><td>${esc(m.accountName)}</td><td>${esc(modelName(accountOf(usageState.host, m.accountId), m.model))}</td><td>${m.turns}</td><td>${tokens(m.tokens)}</td><td>${m.cost.toFixed(2)} $</td></tr>`).join('')}</tbody></table>
      <h2 class="h2">Hilos que más gastan</h2><table class="table-plain"><thead><tr><th>Hilo</th><th>Turnos</th><th>Tokens</th><th>Coste</th></tr></thead><tbody>
      ${r.byThread.map((t) => `<tr><td><button class="link" data-open-thread="${esc(t.threadId)}" data-host="${esc(usageState.host)}">${esc(t.title)}</button></td><td>${t.turns}</td><td>${tokens(t.tokens)}</td><td>${t.cost.toFixed(2)} $</td></tr>`).join('')}</tbody></table>`);
  }
  out.push('</div>');
  main.innerHTML = out.join('');
  main.querySelector('[data-usage-host]')?.addEventListener('change', (e) => { usageState.host = e.target.value; loadUsage(); });
  main.querySelector('[data-usage-days]')?.addEventListener('change', (e) => { usageState.days = Number(e.target.value); loadUsage(); });
  main.querySelector('[data-usage-refresh]')?.addEventListener('click', loadUsage);
  if (!r && !usageState.loading && !usageState.error && usageState.host) loadUsage();
}

async function loadUsage() {
  if (!usageState.host) return;
  usageState.loading = true; usageState.error = null; renderMain();
  const r = await request(usageState.host, { usageReport: { days: usageState.days } });
  usageState.loading = false;
  usageState.report = r.ok ? r.usage : null;
  usageState.error = r.ok ? null : r.error;
  if (app.view.kind === 'usage') renderMain();
}

// MARK: - Settings and sign-in

function renderSettingsView(main) {
  const hosts = [...app.hosts.entries()].filter(([id]) => has(id, 'settings'));
  // The forms are built once per visit: snapshots arriving while you edit mustn't reset them.
  const signature = hosts.map(([id, h]) => `${id}:${(h.data.snapshot.hostSettings?.accounts ?? []).map((a) => `${a.id}${a.name}`).join('|')}`).join(',');
  if (main.dataset.settings !== signature || !main.querySelector('.settings-view')) {
    main.dataset.settings = signature;
    main.innerHTML = `<div class="view settings-view"><h1>Ajustes</h1><p class="lead">De cada host donde corren los agentes. Los del Mac están en su propia app.</p>
      ${hosts.length ? hosts.map(([id, h]) => settingsFormHTML(id, h)).join('') : '<p class="note">Ningún host conectado se puede configurar desde aquí.</p>'}</div>`;
    for (const [id] of hosts) bindSettingsForm(main.querySelector(`form[data-settings="${CSS.escape(id)}"]`), id);
  }
  for (const [id] of hosts) {
    const box = main.querySelector(`[data-accounts="${CSS.escape(id)}"]`);
    if (box) box.innerHTML = accountsHTML(id);
  }
}

function settingsFormHTML(hostId, h) {
  const st = h.data.snapshot.hostSettings ?? {};
  const accounts = h.data.snapshot.accounts;
  const planValue = st.limitPlan?.mode === 'chain' && st.limitPlan.targets?.length === 1 ? `chain|${st.limitPlan.targets[0].accountId}|${st.limitPlan.targets[0].model}` : st.limitPlan?.mode ?? 'ask';
  const planOptions = [['ask', 'Avisarme y decidir yo'], ['mostQuota', 'Pasar a la de más cuota'], ['wait', 'Esperar a que se reinicie y seguir'],
    ...accounts.flatMap((a) => a.models.filter((m) => !m.hidden).map((m) => [`chain|${a.id}|${m.id}`, `Pasar a ${a.name} · ${m.name}`]))];
  return `<form class="card settings" data-settings="${esc(hostId)}">
    <div class="section-head"><span class="dot ${h.info.state}"></span><h2>${esc(nameOf(h))}</h2><span class="note">${esc(h.data.snapshot.hostVersion ?? '')}</span></div>
    <label class="field"><span>Carpeta de proyectos</span><div class="paste"><input type="text" name="projectsRoot" value="${esc(st.projectsRoot ?? '')}" spellcheck="false"><button type="button" class="btn" data-choose-root>Elegir…</button></div>
      <small>Sus subcarpetas aparecen como proyectos. Puedes añadir más carpetas de cualquier sitio con + junto al nombre del host.</small></label>
    <div class="row2">
      <label class="field"><span>Suscripción por defecto</span><select name="defaultAccountId"><option value="">La primera con sesión y cuota</option>${accounts.map((a) => `<option value="${esc(a.id)}"${a.id === st.defaultAccountId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Permisos por defecto</span><select name="defaultMode">${Object.entries(MODES).map(([v, [l]]) => `<option value="${v}"${v === st.defaultMode ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="row2">
      <label class="field"><span>Si se acaba la cuota</span><select name="limitPlan">${planOptions.map(([v, l]) => `<option value="${esc(v)}"${v === planValue ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field"><span>Segundos antes de relevar</span><input type="number" name="relayDelay" min="0" max="300" value="${st.relayDelay ?? 10}"></label>
    </div>
    <div class="row2">
      <label class="field"><span>Agentes trabajando a la vez</span><input type="number" name="maxAgents" min="1" max="8" value="${st.maxAgents ?? 2}"></label>
      <label class="check field-check"><input type="checkbox" name="aiTitles"${st.aiTitles !== false ? ' checked' : ''}> Poner el tema como título con IA (modelo barato)</label>
    </div>
    <label class="check"><input type="checkbox" name="suggest"${st.suggest !== false ? ' checked' : ''}> Relevo sugiere: proponer suscripción y modelo según la tarea que escribes</label>
    <div class="actions end"><button class="btn primary" type="submit">Guardar</button></div>
    <div class="section-head"><h3 class="h3 grow">Suscripciones</h3>${h.data.snapshot.hostFeatures?.includes('accounts') ? `<button type="button" class="btn small" data-add-account="${esc(hostId)}">Añadir suscripción</button>` : ''}</div>
    <div data-accounts="${esc(hostId)}"></div>
  </form>`;
}

function accountsHTML(hostId) {
  const accounts = snapshotOf(hostId)?.accounts ?? [];
  if (!accounts.length) return '<p class="note">Sin agentes: instala Claude Code o Codex en el host.</p>';
  return accounts.map((a) => {
    const s = a.status;
    const state = s?.loggedIn === false ? '<span class="note bad">Sin sesión</span>' : s?.loggedIn ? `<span class="note">Con sesión${s.email ? ` · ${esc(s.email)}` : ''}${s.plan ? ` · ${esc(s.plan)}` : ''}</span>` : '<span class="note">Comprobando…</span>';
    const def = snapshotOf(hostId)?.hostSettings?.accounts?.find((x) => x.id === a.id);
    const canLogin = has(hostId, 'login') && !a.usesAPIKey && (def?.type !== 'acp' || snapshotOf(hostId)?.hostProviders?.acp.find((p) => p.id === def.preset)?.login);
    return `<div class="acct-row">${glyph(a, 24)}<div class="grow"><b>${esc(a.name)}</b> ${state}${s?.error && s.loggedIn !== false ? `<div class="note bad">${esc(s.error)}</div>` : ''}</div>`
      + (canLogin ? `<button type="button" class="btn small${s?.loggedIn === false ? ' primary' : ''}" data-login="${esc(a.id)}" data-login-host="${esc(hostId)}">${s?.loggedIn === false ? 'Iniciar sesión' : 'Volver a iniciar sesión'}</button>` : '')
      + (def ? `<button type="button" class="btn small" data-edit-account="${esc(a.id)}" data-account-host="${esc(hostId)}">Editar</button><button type="button" class="btn small danger" data-remove-account="${esc(a.id)}" data-account-host="${esc(hostId)}">Quitar</button>` : '') + '</div>';
  }).join('');
}

function bindSettingsForm(form, hostId) {
  if (!form) return;
  form.querySelector('[data-choose-root]').onclick = async () => {
    const p = await chooseFolder({ title: 'Carpeta de proyectos', start: form.projectsRoot.value, request: req(hostId) });
    if (p) form.projectsRoot.value = p;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const plan = form.limitPlan.value;
    const limitPlan = plan.startsWith('chain|') ? { mode: 'chain', targets: [{ accountId: plan.split('|')[1], model: plan.split('|')[2] }] } : { mode: plan, targets: [] };
    const settings = {
      projectsRoot: form.projectsRoot.value.trim(), defaultAccountId: form.defaultAccountId.value || null, defaultMode: form.defaultMode.value,
      limitPlan, relayDelay: Number(form.relayDelay.value), maxAgents: Number(form.maxAgents.value), aiTitles: form.aiTitles.checked,
      suggest: form.suggest.checked,
    };
    const r = await request(hostId, { setSettings: { settings } });
    toast(r.ok ? 'Ajustes guardados' : r.error);
  };
}

function loginDialog(hostId, accountId) {
  const account = accountOf(hostId, accountId);
  const requestId = uuid();
  let finished = false;
  const d = openDialog({ title: `Iniciar sesión en ${account?.name ?? 'la suscripción'}`, wide: true, onClose: () => {
    app.logins.delete(requestId);
    if (!finished) sendTo(hostId, { loginCancel: { requestId } });
  }, body: `
    <p class="note">Abre el enlace, entra con tu cuenta y, si te muestra un código, pégalo abajo. La sesión queda guardada en ${esc(nameOf(host(hostId)))}, aparte de la de tu terminal.</p>
    <div class="actions"><button class="btn primary" data-open-link disabled>Abrir el enlace</button><button class="btn" data-copy-link disabled>Copiar enlace</button><span class="note grow" data-state>Arrancando…</span></div>
    <pre class="out login-out" data-out></pre>
    <div class="paste"><input type="text" data-code placeholder="Código (si te lo pide)" autocomplete="off" spellcheck="false"><button class="btn" data-send-code>Enviar</button></div>` });
  const $ = (s) => d.el.querySelector(s);
  let output = '', link = null;
  app.logins.set(requestId, (m) => {
    if (m.text) {
      output += m.text;
      $('[data-out]').innerHTML = linkify(output);
      $('[data-out]').scrollTop = $('[data-out]').scrollHeight;
      const found = output.match(/https?:\/\/[^\s<>"']+/g);
      if (found && !link) {
        link = found.find((u) => /oauth|auth|login|device|activate/i.test(u)) ?? found[0];
        $('[data-open-link]').disabled = false; $('[data-copy-link]').disabled = false;
        $('[data-state]').textContent = 'Esperando a que inicies sesión…';
      }
    }
    if (m.done) {
      finished = true;
      $('[data-state]').textContent = m.ok ? 'Sesión iniciada ✓' : `No se ha completado: ${m.error ?? ''}`;
      $('[data-state]').className = m.ok ? 'note ok grow' : 'note bad grow';
      if (m.ok) setTimeout(d.close, 1500);
    }
  });
  app.requests.set(requestId, (r) => { if (r.ok === false) { finished = true; $('[data-state]').textContent = r.error; } });
  $('[data-open-link]').onclick = () => window.open(link, '_blank', 'noopener');
  $('[data-copy-link]').onclick = () => copy(link, 'Enlace copiado');
  const sendCode = () => {
    const code = $('[data-code]').value.trim();
    if (!code) return;
    sendTo(hostId, { loginInput: { requestId, text: code } });
    $('[data-code]').value = '';
    $('[data-state]').textContent = 'Código enviado…';
  };
  $('[data-send-code]').onclick = sendCode;
  $('[data-code]').onkeydown = (e) => { if (e.key === 'Enter') sendCode(); };
  sendTo(hostId, { login: { requestId, accountId } });
}

// MARK: - History and images

async function loadOlder(hostId, threadId) {
  const key = `${hostId}/${threadId}`;
  const thread = host(hostId)?.data.threads.get(threadId);
  const older = app.older.get(key) ?? [];
  const r = await request(hostId, { loadOlder: { threadId, have: older.length + (thread?.items.length ?? 0) } });
  if (!r.ok) { toast(r.error); return; }
  if (r.items.length) app.older.set(key, [...r.items, ...older]);
  if (threadEls) threadEls.stick = false;
  renderMain();
}

const IMAGE_PATH = /(?:^|[\s(`'"*])((?:[A-Za-z]:[\\/]|~?\/|\.{1,2}[\\/])?[\w.\-\\/]*[\w-]\.(?:png|jpe?g|gif|webp|svg))(?=$|[\s)\]`'".,;:*])/gim;

/** Thumbnails for the images a message names (the host serves only files the thread mentions). */
function imagesHTML(hostId, text) {
  const paths = [...new Set([...String(text ?? '').matchAll(IMAGE_PATH)].map((m) => m[1]))].slice(0, 6);
  if (!paths.length) return '';
  const threadId = app.view.thread;
  return `<div class="thumbs">${paths.map((p) => `<button class="thumb" data-image="${esc(p)}" data-img-host="${esc(hostId)}" data-img-thread="${esc(threadId)}" title="${esc(p)}"><span class="thumb-name">${esc(p.split(/[\\/]/).pop())}</span></button>`).join('')}</div>`;
}

async function imageData(hostId, threadId, path, maxPixel) {
  const key = `${hostId}/${threadId}/${maxPixel}/${path}`;
  if (app.images.has(key)) return app.images.get(key);
  const pending = request(hostId, { fetchImage: { threadId, path, maxPixel } }, 30_000).then((r) => {
    if (!r.data) return null;
    const ext = path.split('.').pop().toLowerCase();
    const mime = !has(hostId, 'images') ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${r.data}`;
  });
  app.images.set(key, pending);
  return pending;
}

function hydrateImages(hostId, threadId) {
  for (const b of threadEls?.items.querySelectorAll('.thumb:not([data-ready])') ?? []) {
    b.dataset.ready = '1';
    imageData(hostId, threadId, b.dataset.image, 480).then((url) => {
      if (url) b.insertAdjacentHTML('afterbegin', `<img src="${url}" alt="">`);
      else b.classList.add('missing');
    });
  }
}

async function imageViewer(path, hostId, threadId) {
  const d = openDialog({ title: path.split(/[\\/]/).pop(), wide: true, body: '<div class="viewer"><span class="spinner"></span></div>' });
  const url = await imageData(hostId, threadId, path, 2400);
  d.el.querySelector('.viewer').innerHTML = url ? `<img src="${url}" alt="">` : '<p class="note">No se ha podido cargar la imagen.</p>';
}

// MARK: - Attachments

const attachments = []; // { name, path?, error?, preview }

async function attach(files) {
  const { hostId, threadId } = current();
  if (!has(hostId, 'attachments')) { toast(`${nameOf(host(hostId))} no admite imágenes adjuntas`); return; }
  for (const file of files.slice(0, 6)) {
    if (file.size > 10 << 20) { toast(`${file.name || 'La imagen'} pasa de 10 MB`); continue; }
    const entry = { name: file.name || `captura-${Date.now()}.png`, preview: URL.createObjectURL(file) };
    attachments.push(entry);
    renderAttachments();
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const name = /\.\w+$/.test(entry.name) ? entry.name : `${entry.name}.${ext}`;
    const r = await request(hostId, { uploadImage: { threadId, name, data } });
    if (r.ok) entry.path = r.path; else { entry.error = r.error; toast(r.error); }
    renderAttachments();
  }
}

function renderAttachments() {
  const box = threadEls?.main?.querySelector?.('#t-attachments') ?? document.getElementById('t-attachments');
  if (!box) return;
  box.innerHTML = attachments.map((a, i) => `<span class="chip-img${a.error ? ' bad' : ''}"><img src="${a.preview}" alt="">${esc(a.name)}${!a.path && !a.error ? ' <span class="spinner"></span>' : ''}<button class="icon-btn small" data-remove-attachment="${i}" title="Quitar">✕</button></span>`).join('');
  updateComposer();
}

// MARK: - Turns: what each changed, and going back

async function turnChangesDialog(hostId, threadId, itemId) {
  const d = openDialog({ title: 'Cambios de este turno', wide: true, body: '<div class="note pad">Cargando…</div>' });
  const r = await request(hostId, { turnChanges: { threadId, itemId } });
  if (!r.ok) { d.el.innerHTML = `<p class="note bad">${esc(r.error)}</p>`; return; }
  const c = r.changes;
  d.el.innerHTML = `<p class="note">${r.finished ? 'Lo que cambió el agente durante este turno.' : 'El turno sigue en marcha: cambios hasta ahora.'} ${c.files.length} ${c.files.length === 1 ? 'fichero' : 'ficheros'}.</p>
    <div class="git-diff tall">${diffHTML(c.diff)}</div>
    <div class="actions end"><button class="btn danger" data-restore-here>Restaurar a antes de este turno…</button></div>`;
  d.el.querySelector('[data-restore-here]').onclick = () => { d.close(); restoreTurn(hostId, threadId, itemId); };
}

async function restoreTurn(hostId, threadId, itemId) {
  if (!await confirmDialog({ title: 'Restaurar a antes de este turno', text: 'Los ficheros del proyecto vuelven a como estaban antes de este mensaje (lo hecho después se deshace, también a mano). Se guarda el estado actual: podrás deshacerlo. La conversación no se borra; el agente recibe una nota con tu siguiente mensaje.', confirm: 'Restaurar', danger: true })) return;
  const r = await request(hostId, { restoreTurn: { threadId, itemId } });
  toast(r.ok ? 'Ficheros restaurados' : r.error);
}

// MARK: - Worktrees

function mergeWorktreeDialog(hostId, threadId, wt) {
  const d = openDialog({ title: `Fusionar ${wt.branch} en ${wt.base ?? 'la rama base'}`, body: `
    <p class="note">Se hace commit de los cambios del worktree en su rama y se fusiona en <b>${esc(wt.base ?? '?')}</b> en la carpeta del proyecto (que debe estar en esa rama).</p>
    <label class="field"><span>Mensaje del commit (si hay cambios sin commit)</span><input type="text" data-msg value="Cambios de ${esc(wt.branch)}"></label>
    <label class="check"><input type="checkbox" data-remove checked> Después, eliminar el worktree y su rama</label>
    <pre class="out" data-output hidden></pre>
    <div class="actions end"><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>Fusionar</button></div>` });
  d.el.querySelector('[data-no]').onclick = d.close;
  d.el.querySelector('[data-yes]').onclick = async (e) => {
    e.target.disabled = true;
    const r = await request(hostId, { mergeWorktree: { threadId, message: d.el.querySelector('[data-msg]').value, remove: d.el.querySelector('[data-remove]').checked } }, 180_000);
    e.target.disabled = false;
    if (r.ok) { toast('Rama fusionada'); d.close(); return; }
    const out = d.el.querySelector('[data-output]');
    out.hidden = false;
    out.textContent = r.error;
  };
}

// MARK: - Quick actions

function quickMenu(hostId, threadId, x, y) {
  const t = snapshotOf(hostId)?.threads.find((th) => th.id === threadId);
  const project = snapshotOf(hostId)?.projects.find((p) => p.id === t?.projectId);
  if (!project) return;
  const items = (project.quickActions ?? []).map((qa) => ({ label: qa.name, action: () => runQuickAction(hostId, threadId, qa) }));
  if (items.length) items.push('-');
  items.push({ label: 'Editar acciones…', action: () => quickActionsEditor(hostId, project.id) });
  showMenu(x, y, items);
}

function quickActionsEditor(hostId, projectId) {
  const project = snapshotOf(hostId)?.projects.find((p) => p.id === projectId);
  if (!project) return;
  const rows = (list) => list.map((qa) => `<div class="qa-row" data-id="${esc(qa.id ?? '')}"><input type="text" class="qa-name" placeholder="Nombre" value="${esc(qa.name)}"><input type="text" class="qa-cmd" placeholder="Comando (p. ej. npm test)" value="${esc(qa.command)}" spellcheck="false"><button class="icon-btn small" data-qa-del title="Quitar">✕</button></div>`).join('');
  const d = openDialog({ title: `Acciones de ${project.name}`, wide: true, body: `
    <p class="note">Comandos que lanzas con un clic desde el hilo (en su carpeta, o en su worktree). Su salida puedes enviarla al agente.</p>
    <div class="qa-list">${rows(project.quickActions?.length ? project.quickActions : [{ name: '', command: '' }])}</div>
    <div class="actions"><button class="btn" data-qa-add>Añadir acción</button><span class="grow"></span><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>Guardar</button></div>` });
  const list = d.el.querySelector('.qa-list');
  d.el.querySelector('[data-qa-add]').onclick = () => list.insertAdjacentHTML('beforeend', rows([{ name: '', command: '' }]));
  list.addEventListener('click', (e) => { if (e.target.closest('[data-qa-del]')) e.target.closest('.qa-row').remove(); });
  d.el.querySelector('[data-no]').onclick = d.close;
  d.el.querySelector('[data-yes]').onclick = async () => {
    const actions = [...list.querySelectorAll('.qa-row')].map((r) => ({ id: r.dataset.id || undefined, name: r.querySelector('.qa-name').value, command: r.querySelector('.qa-cmd').value }));
    const r = await request(hostId, { setQuickActions: { projectId, actions } });
    toast(r.ok ? 'Acciones guardadas' : r.error);
    if (r.ok) d.close();
  };
}

async function runQuickAction(hostId, threadId, qa) {
  const d = openDialog({ title: qa.name, wide: true, body: `<p class="note"><code>${esc(qa.command)}</code></p><pre class="out tall" data-out>Ejecutando…</pre>
    <div class="actions end"><span class="note grow" data-state><span class="spinner"></span></span><button class="btn" data-again disabled>Repetir</button><button class="btn primary" data-send disabled>Enviar al agente</button></div>` });
  const run = async () => {
    d.el.querySelector('[data-out]').textContent = 'Ejecutando…';
    d.el.querySelector('[data-state]').innerHTML = '<span class="spinner"></span>';
    for (const b of d.el.querySelectorAll('[data-again], [data-send]')) b.disabled = true;
    const r = await request(hostId, { runQuickAction: { threadId, actionId: qa.id } }, 11 * 60_000);
    const out = r.ok ? r.output || '(sin salida)' : r.error;
    d.el.querySelector('[data-out]').textContent = out;
    d.el.querySelector('[data-state]').textContent = r.ok ? (r.code === 0 ? 'Terminó bien' : `Falló (${r.code})`) : 'Error';
    d.el.querySelector('[data-state]').className = `note grow ${r.ok && r.code === 0 ? 'ok' : 'bad'}`;
    for (const b of d.el.querySelectorAll('[data-again], [data-send]')) b.disabled = false;
    d.el.querySelector('[data-send]').onclick = () => {
      const tail = out.length > 12_000 ? `…\n${out.slice(-12_000)}` : out;
      sendTo(hostId, Client.send(threadId, `Salida de «${qa.name}» (\`${qa.command}\`, ${r.ok && r.code === 0 ? 'terminó bien' : `código ${r.code ?? '?'}`}):\n\n\`\`\`\n${tail}\n\`\`\``));
      toast('Enviado al agente');
      d.close();
    };
  };
  d.el.querySelector('[data-again]').onclick = run;
  run();
}

// MARK: - Subscriptions

function accountDialog(hostId, accountId) {
  const snap = snapshotOf(hostId);
  const def = accountId ? snap?.hostSettings?.accounts?.find((x) => x.id === accountId) : null;
  const providers = snap?.hostProviders ?? { api: [], acp: [] };
  const choices = [['claude', 'Claude (otra cuenta)'], ['codex', 'Codex / ChatGPT (otra cuenta)'],
    ...providers.api.map((p) => [`api:${p.id}`, `${p.name} (API key, pago por uso)`]),
    ...providers.acp.map((p) => [`acp:${p.id}`, `${p.name} (agente ACP)`])];
  const kindOf = (v) => ({ type: v.split(':')[0], preset: v.split(':')[1] });
  const current = def ? `${def.type}${def.preset ? `:${def.preset}` : ''}` : 'claude';
  const d = openDialog({ title: def ? `Editar ${def.name}` : 'Añadir suscripción', body: `
    ${def ? '' : `<label class="field"><span>Tipo</span><select data-kind>${choices.map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`}
    <label class="field"><span>Nombre</span><input type="text" data-f="name" value="${esc(def?.name ?? '')}" placeholder="Por defecto, el del proveedor"></label>
    <div data-fields></div>
    <div class="actions end"><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>${def ? 'Guardar' : 'Añadir'}</button></div>` });
  const fields = () => {
    const { type, preset } = kindOf(def ? current : d.el.querySelector('[data-kind]').value);
    const api = providers.api.find((p) => p.id === preset);
    let html = '';
    if (type === 'claude' || type === 'codex') html = '<p class="note">Una cuenta más, con su propia carpeta de sesión en el host. Después, «Iniciar sesión».</p>';
    if (type === 'api') {
      html = `<label class="field"><span>API key${def?.hasKey ? ' (guardada: déjala vacía para no cambiarla)' : ''}</span><input type="password" data-f="apiKey" autocomplete="off" placeholder="${def?.hasKey ? '••••••••' : 'sk-…'}"></label>`
        + (api?.keyURL ? `<p class="note">Consíguela en <a href="${esc(api.keyURL)}" target="_blank" rel="noopener">${esc(api.keyURL)}</a>. Se guarda en el host y solo se envía a la API del proveedor.</p>` : '');
      if (preset === 'custom') {
        html += `<label class="field"><span>URL de la API (compatible con Anthropic)</span><input type="text" data-f="baseURL" value="${esc(def?.baseURL ?? '')}" placeholder="https://…/anthropic"></label>
          <label class="field"><span>Modelos (separados por comas)</span><input type="text" data-f="models" value="${esc(def?.models?.join(', ') ?? '')}"></label>
          <div class="row2"><label class="field"><span>Modelo principal</span><input type="text" data-f="main" value="${esc(def?.main ?? '')}"></label><label class="field"><span>Modelo rápido</span><input type="text" data-f="fast" value="${esc(def?.fast ?? '')}"></label></div>`;
      }
    }
    if (type === 'acp') {
      html = preset === 'custom'
        ? `<label class="field"><span>Comando</span><input type="text" data-f="command" value="${esc(def?.command ?? '')}" placeholder="ruta al ejecutable"></label>
           <label class="field"><span>Argumentos para ACP</span><input type="text" data-f="args" value="${esc(def?.args?.join(' ') ?? '')}" placeholder="--acp"></label>`
        : `<p class="note">${preset === 'gemini' ? 'Usa Gemini CLI (`gemini`) instalado en el host; inicia sesión abriéndolo una vez en una terminal.' : 'Usa la CLI del agente instalada en el host; después, «Iniciar sesión».'}</p>`;
    }
    d.el.querySelector('[data-fields]').innerHTML = html;
  };
  d.el.querySelector('[data-kind]')?.addEventListener('change', fields);
  fields();
  d.el.querySelector('[data-no]').onclick = d.close;
  d.el.querySelector('[data-yes]').onclick = async () => {
    const account = {};
    for (const input of d.el.querySelectorAll('[data-f]')) if (input.value.trim() || input.dataset.f !== 'apiKey') account[input.dataset.f] = input.value.trim();
    if (!account.name) delete account.name;
    let r;
    if (def) r = await request(hostId, { updateAccount: { accountId, account } });
    else {
      const { type, preset } = kindOf(d.el.querySelector('[data-kind]').value);
      r = await request(hostId, { addAccount: { account: { ...account, type, preset } } });
    }
    toast(r.ok ? (def ? 'Suscripción guardada' : 'Suscripción añadida') : r.error);
    if (r.ok) d.close();
  };
}

async function removeAccount(hostId, accountId) {
  const a = accountOf(hostId, accountId);
  if (!await confirmDialog({ title: `Quitar ${a?.name ?? 'la suscripción'}`, text: 'Deja de usarse en este host; los hilos que la usaban pasan a otra. Su carpeta de sesión se conserva en el host.', confirm: 'Quitar', danger: true })) return;
  const r = await request(hostId, { removeAccount: { accountId } });
  toast(r.ok ? 'Suscripción quitada' : r.error);
}

// Everything above is defined: start.
connect();
render();
