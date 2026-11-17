// Relevo for desktop: every paired host (this PC, the Mac, a mini PC) in one window. The page talks only to
// the host service on 127.0.0.1 (/ws), which keeps the connections to the hosts; the protocol and its state
// handling are shared with it (state.mjs).

import { applyServerMessage, emptyHostData, Client, uuid } from './state.mjs';
import { markdown, inline, esc } from './markdown.mjs';

// MARK: - State

const app = {
  hosts: new Map(), // id → { info, data }
  pairingLink: null,
  view: { kind: 'empty' }, // { kind: 'thread', host, thread } | { kind: 'limits' } | { kind: 'hosts' }
  ws: null,
  live: false,
  drafts: new Map(),
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
const GLYPHS = { asterisk: '✳', hexagon: '⬡', sparkles: '✦', 'sparkle': '✦', moon: '☾', bolt: 'ϟ', key: '⚿', star: '★', diamond: '◆', circle: '●', 'brain': '✺', 'cpu': '▣' };

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
      if (!app.pendingCreate.has(a.requestId)) break;
      app.pendingCreate.delete(a.requestId);
      openThread(hostId, a.threadId);
      setTimeout(() => document.getElementById('draft')?.focus(), 50);
      break;
    }
    case 'toast': toast(a._0); break;
    case 'image': if (a.error) toast(a.error); break;
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
  if (parts[0] === 'limits' || parts[0] === 'hosts') return { kind: parts[0] };
  return { kind: 'empty' };
}
function restoreFromHash() { app.view = viewFromHash(); }
window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  if (v.kind !== app.view.kind || v.thread !== app.view.thread || v.host !== app.view.host) setView(v);
});

function newThread(hostId, projectId) {
  const requestId = uuid();
  app.pendingCreate.set(requestId, hostId);
  sendTo(hostId, Client.newThread(projectId, requestId));
  setTimeout(() => { if (app.pendingCreate.delete(requestId)) toast('El host no ha creado el hilo'); }, 8000);
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
    out.push(`<section class="host"><div class="host-head"><span class="dot ${info.state}"></span><span class="name" title="${esc(nameOf(h))}">${esc(nameOf(h))}${info.local ? ' · este equipo' : ''}</span></div>`);
    if (info.state !== 'connected') out.push(`<div class="host-reason">${esc(info.state === 'connecting' ? 'Conectando…' : info.reason ?? 'Sin conectar')}</div>`);
    if (snap) {
      if (!snap.projects.length) out.push('<div class="side-empty">Sin proyectos: crea carpetas en la de proyectos del host.</div>');
      for (const p of [...snap.projects].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = `${id}/${p.id}`;
        const collapsed = app.collapsed.has(key);
        out.push(`<div class="project${collapsed ? ' collapsed' : ''}"><button class="project-name" data-toggle-project="${esc(key)}" title="${esc(p.path)}">${esc(p.name)}</button>`
          + `<button class="icon-btn" data-new-thread="${esc(p.id)}" data-host="${esc(id)}" title="Nuevo hilo en ${esc(p.name)}">+</button></div>`);
        if (collapsed) continue;
        const threads = snap.threads.filter((t) => t.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
        const shown = app.showAll.has(key) ? threads : threads.slice(0, 6);
        for (const t of shown) {
          const active = app.view.kind === 'thread' && app.view.host === id && app.view.thread === t.id;
          const acct = snap.accounts.find((a) => a.id === t.accountId);
          const badge = t.needsApproval ? '<span class="badge approval">!</span>'
            : t.isRunning ? '<span class="spinner" title="Trabajando"></span>'
              : t.isWaiting ? '<span class="badge wait" title="Esperando tareas en segundo plano">…</span>' : '';
          out.push(`<button class="thread${active ? ' active' : ''}" data-open-thread="${esc(t.id)}" data-host="${esc(id)}" title="${esc(t.preview ?? t.title)}">`
            + `<span class="tdot" style="background:${esc(acct?.tint ?? 'var(--faint)')}"></span><span class="ttitle">${esc(t.title)}</span>${badge}<span class="time">${relTime(t.updatedAt)}</span></button>`);
        }
        if (threads.length > 6) out.push(`<button class="more" data-show-all="${esc(key)}">${app.showAll.has(key) ? 'Ver menos' : `Ver los ${threads.length}`}</button>`);
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
      <label class="toggle" title="Mostrar cada llamada a herramienta en vez de resumirlas"><input type="checkbox" id="show-tools"> Herramientas</label>
    </header>
    <div class="transcript" id="transcript"><div class="hidden-note" id="t-hidden"></div><div class="items" id="t-items"></div></div>
    <div class="dock"><div class="dock-inner">
      <div id="t-banners"></div>
      <div id="t-queue"></div>
      <div class="composer">
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
  if (h?.info.state !== 'connected' || !threadEls.draft.value.trim()) return false;
  return !thread?.runtime?.isRunning || thread.runtime.queued !== undefined;
}

function sendDraft(now) {
  if (!canSend()) return;
  const { hostId, threadId } = current();
  const text = threadEls.draft.value.trim();
  sendTo(hostId, now ? Client.sendNow(threadId, text) : Client.send(threadId, text));
  threadEls.draft.value = '';
  app.drafts.delete(`${hostId}/${threadId}`);
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
  const hidden = Math.max(0, thread.totalItems - thread.items.length);
  threadEls.hidden.textContent = hidden ? `${hidden} elementos anteriores no se muestran` : '';
  // The first assistant item of each turn shows who answered.
  const headers = new Set();
  let need = true;
  for (const it of thread.items) {
    if (it.kind === 'user' || it.kind === 'notice') need = true;
    else if (it.kind === 'assistant' && need) { headers.add(it.id); need = false; }
  }
  if (container.querySelector('.notice > .spinner')) container.innerHTML = '';
  const rows = rowsOf(thread.items);
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
  for (const [key, entry] of rowCache) if (!next.has(key)) entry.el.remove();
  rowCache = next;
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
    case 'user': return `<div class="msg user"><div class="bubble">${esc(it.text)}</div></div>`;
    case 'assistant': {
      const acct = accountOf(hostId, it.accountId);
      const head = header && acct ? `<div class="author">${glyph(acct)}${esc(acct.agentName ?? acct.name)}${it.model && it.model !== 'default' ? ` · ${esc(modelName(acct, it.model))}` : ''}</div>` : '';
      return `<div class="msg assistant">${head}<div class="md">${markdown(it.text)}</div>${it.usage ? usageHTML(it.usage) : ''}</div>`;
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
    case 'notice': return `<div class="notice">${inline(it.text)}</div>`;
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
      + '</div><p class="note">Al actualizar, el servicio se reinicia y la ventana se recarga sola. Los hilos en curso se retoman después.</p></div>');
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

connect();
render();
