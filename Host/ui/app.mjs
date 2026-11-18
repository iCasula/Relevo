// Relevo for desktop: a clone of the Mac app's main window (MainView, SidebarView, ThreadView, ComposerView,
// ItemViews), driving every paired host — this PC, the Mac, a mini PC — through this machine's Relevo service.

import { esc, markdown, inline } from './markdown.mjs';
import { icon, badge, toolSymbol } from './icons.mjs';
import { showMenu, closeMenus, openPopover, alertSheet, promptSheet, toast } from './kit.mjs';
import {
  app, hooks, save, host, snap, nameOf, has, accountOf, modelOf, modelName, visibleModels, maxPercent, threadOf, summaryOf, projectOf,
  connect, post, sendTo, request, createThread, Client, uuid, shortTokens, usd, pct, reset, relative, usageColor, effortName, MODES,
  PLAN_SUMMARY, copyText,
} from './core.mjs';
import * as sheets from './sheets.mjs';
import { usageBar, statusLabel, imageData, running } from './widgets.mjs';

const $ = (q, root = document) => root.querySelector(q);
const sel = () => app.sel;
const current = () => {
  const s = app.sel;
  if (!s) return {};
  const h = host(s.host);
  return { hostId: s.host, threadId: s.thread, h, thread: threadOf(s.host, s.thread), summary: summaryOf(s.host, s.thread) };
};

// MARK: - Selection and navigation

function select(hostId, threadId) {
  const prev = app.sel;
  if (prev && prev.host !== hostId) sendTo(prev.host, Client.subscribe(null));
  app.sel = threadId ? { host: hostId, thread: threadId } : null;
  save('selection', app.sel);
  if (app.sel) sendTo(hostId, Client.subscribe(threadId));
  threadKey = null;
  render();
  if (app.sel) setTimeout(() => $('#draft')?.focus(), 30);
}
sheets.bind({ select, render: () => render(), currentHost: () => app.sel?.host ?? null });

/** The project new threads go to: the selected thread's, else the first one (Mac: store.newThread). */
function targetProject() {
  const { hostId, summary } = current();
  if (hostId && summary) return { hostId, projectId: summary.projectId };
  for (const [id, h] of app.hosts) { const p = h.data.snapshot?.projects[0]; if (p) return { hostId: id, projectId: p.id }; }
  return null;
}

async function newThread(hostId, projectId, worktree = false) {
  if (!hostId) { const t = targetProject(); if (!t) { sheets.openNewProject(); return; } ({ hostId, projectId } = t); }
  // Reuse an empty thread of that project, as the Mac does.
  const empty = !worktree && snap(hostId)?.threads.find((t) => t.projectId === projectId && t.title === 'Nuevo hilo' && !t.preview);
  if (empty) { select(hostId, empty.id); return; }
  if (worktree && has(hostId, 'worktrees')) {
    const r = await request(hostId, { newWorktreeThread: { projectId } });
    if (r.ok) select(hostId, r.threadId); else toast(r.error);
    return;
  }
  const id = await createThread(hostId, projectId);
  if (id) select(hostId, id); else toast('El host no ha creado el hilo');
}

// MARK: - Rendering

let frame = 0;
function render() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderSidebar();
    renderUpdate();
    renderLimits();
    renderDetail();
    updateTitle();
  });
}
hooks.render = render;
hooks.onInit = () => {
  if (app.sel && !host(app.sel.host)) app.sel = null;
  if (app.sel) sendTo(app.sel.host, Client.subscribe(app.sel.thread));
};
hooks.onServer = (hostId, name, a) => {
  if (name === 'snapshot') { notifyChanges(hostId); render(); }
  else if ((name === 'thread' || name === 'threadPatch') && app.sel?.host === hostId && app.sel.thread === a._0?.id) renderThread();
  else if (name === 'activity') {}
};

function updateTitle() {
  const { thread, summary } = current();
  document.title = thread?.title ?? summary?.title ?? 'Relevo';
}

// MARK: - Sidebar (SidebarView)

function renderSidebar() {
  const sb = $('#sidebar');
  sb.classList.toggle('collapsed', !!app.sidebarHidden);
  sb.style.width = `${app.sidebarWidth}px`;
  $('#side-top').innerHTML = `<button class="tb-btn" data-cmd="toggleSidebar" title="Ocultar barra lateral (Ctrl+Mayús+S)">${icon('sidebar.left', { size: 17 })}</button>`;
  const out = [
    `<button class="side-action" data-cmd="newThread">${icon('square.and.pencil', { size: 15 })}<span>Nuevo hilo</span><span class="hint">Ctrl+N</span></button>`,
    `<button class="side-action" data-cmd="addProject">${icon('folder.badge.plus', { size: 15 })}<span>Añadir proyecto</span><span class="hint">Ctrl+O</span></button>`,
  ];
  const several = app.hosts.size > 1;
  for (const [hostId, h] of app.hosts) {
    const s = h.data.snapshot;
    const state = h.info.state === 'connected' ? '' : h.info.state === 'connecting' ? ' · conectando…' : ` · ${h.info.reason ?? 'sin conectar'}`;
    out.push(`<div class="side-section" title="${esc(h.info.reason ?? '')}">${several || !h.info.local ? esc(nameOf(h)) : 'Proyectos'}<span class="host-state">${esc(state)}</span></div>`);
    if (!s) continue;
    if (!s.projects.length) { out.push('<div class="side-empty">Aún no hay proyectos</div>'); continue; }
    for (const p of s.projects) {
      const key = `${hostId}/${p.id}`;
      const open = !app.collapsedProjects.has(key);
      out.push(`<div class="proj-row${open ? ' open' : ''}" data-project="${esc(p.id)}" data-host="${esc(hostId)}" title="${esc(p.path)}">`
        + `<button class="disclosure" data-toggle-project="${esc(key)}">${icon('chevron.right', { size: 10 })}</button>`
        + `${icon('folder', { size: 15, cls: 'folder' })}<span class="name">${esc(p.name)}</span>`
        + `<button class="new-in" data-new-in="${esc(p.id)}" data-host="${esc(hostId)}" title="Nuevo hilo en ${esc(p.name)}">${icon('square.and.pencil', { size: 11 })}</button></div>`);
      if (!open) continue;
      const threads = s.threads.filter((t) => t.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
      if (!threads.length) out.push(`<button class="start-thread" data-new-in="${esc(p.id)}" data-host="${esc(hostId)}">Empieza un hilo</button>`);
      // A team's threads together, in the team's order, where its most recent one would be.
      const shown = new Set();
      for (const t of threads) {
        if (shown.has(t.id)) continue;
        const team = t.team && s.hostTeams?.find((x) => x.id === t.team.id);
        const group = team ? team.members.map((m) => threads.find((x) => x.id === m.threadId)).filter(Boolean) : [t];
        for (const x of group) { shown.add(x.id); out.push(threadRowHTML(hostId, s, x, team && x !== group[0])); }
      }
    }
  }
  if (!app.hosts.size) out.push('<div class="side-section">Proyectos</div><div class="side-empty">Aún no hay proyectos</div>');
  $('#side-list').innerHTML = out.join('');
}

function threadRowHTML(hostId, s, t, nested = false) {
  const selected = app.sel?.host === hostId && app.sel.thread === t.id;
  const acct = s.accounts.find((a) => a.id === t.accountId);
  const ran = !!t.preview;
  const dot = ran ? `<span class="pdot" style="background:${esc(acct?.tint ?? 'var(--tertiary)')}"></span>` : '<span class="pdot empty"></span>';
  const extra = t.worktree ? `<span title="Worktree propio · ${esc(t.worktree)}">${icon('square.stack.3d.down.right', { size: 10, cls: 'small' })}</span>` : '';
  const live = threadOf(hostId, t.id)?.runtime;
  const status = t.isRunning ? '<span class="spinner"></span>'
    : live?.limit ? `<span class="orange">${icon('hourglass', { size: 10 })}</span>`
      : t.isWaiting ? `<span class="muted" title="Esperando a una tarea en segundo plano">${icon('clock', { size: 10 })}</span>`
        : `<span class="when">${esc(relative(t.updatedAt))}</span>`;
  const chip = t.team ? `<span class="role-chip r-${esc(t.team.role)}" title="${esc(t.team.name)} de un equipo">${esc(t.team.role === 'executor' ? t.team.name.replace('Ejecutor', 'Ej.') : ROLE[t.team.role]?.short ?? '')}</span>` : '';
  return `<button class="thread-row${selected ? ' selected' : ''}${nested ? ' nested' : ''}" data-thread="${esc(t.id)}" data-host="${esc(hostId)}" title="${esc(t.title)}">${dot}${extra}${chip}<span class="title">${esc(t.team ? t.title.replace(/^[^·]+·\s*/, '') : t.title)}</span>${status}</button>`;
}

// MARK: - «Límites» footer (UsageFooter) — always visible


function accountUsageHTML(hostId, a) {
  const s = a.status;
  const exhausted = s?.exhausted;
  const statusIc = a.refreshing ? '<span class="spinner"></span>'
    : s?.noPlan ? `<span class="orange">${icon('creditcard.trianglebadge.exclamationmark', { size: 10 })}</span>`
      : exhausted ? `<span class="red">${icon('hourglass', { size: 10 })}</span>`
        : s?.loggedIn === false ? `<span class="orange">${icon('person.crop.circle.badge.exclamationmark', { size: 10 })}</span>` : '';
  let body;
  if (s?.windows?.length) body = s.windows.slice(0, 2).map((w) => usageBar(w)).join('');
  else if (s?.loggedIn === false) body = '<div class="acct-note warn">Sin sesión · pulsa para iniciar</div>';
  else if (s?.noPlan) body = `<div class="acct-note warn">${esc(s.error ?? 'El plan no incluye este servicio')}</div>`;
  else if (s?.error) body = `<div class="acct-note">${esc(s.error)}</div>`;
  else if (s?.note) body = `<div class="acct-note">${esc(s.note)}</div>`;
  else body = '';
  return `<button class="acct-usage" data-account-pop="${esc(a.id)}" data-host="${esc(hostId)}"><div class="acct-head">${badge(a, 14)}<span class="name">${esc(a.name)}</span><span class="email">${esc(s?.email ?? '')}</span>${s?.plan ? `<span class="plan-pill">${esc(s.plan)}</span>` : ''}${statusIc}</div>${body}</button>`;
}

/** A new version: offered here, and once installed, how many agents the restart is waiting for. */
function renderUpdate() {
  const u = app.update;
  const el = $('#update-strip');
  let html = '';
  if (u?.pendingRestart) {
    const { version, busy } = u.pendingRestart;
    html = busy
      ? `<div class="u-text">${icon('arrow.triangle.2.circlepath', { size: 12 })}<span><b>Relevo ${esc(version)}</b> instalado · se reinicia cuando ${busy === 1 ? 'termine el agente que trabaja' : `terminen los ${busy} agentes que trabajan`}</span></div><button class="btn small" data-cmd="restartNow">Reiniciar ahora</button>`
      : `<div class="u-text"><span class="spinner"></span><span>Reiniciando con Relevo ${esc(version)}…</span></div>`;
  } else if (u?.applying) {
    html = `<div class="u-text"><span class="spinner"></span><span>Instalando Relevo ${esc(u.latest ?? '')}…</span></div>`;
  } else if (u?.available && u.latest) {
    html = `<div class="u-text">${icon('sparkles', { size: 12 })}<span>Hay una versión nueva: <b>${esc(u.latest)}</b></span></div><button class="btn small primary" data-cmd="applyUpdate">Actualizar</button>`;
  }
  if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; el.classList.toggle('hidden', !html); }
}

function renderLimits() {
  const out = [`<div class="limits-head"><span class="t">Límites</span>`
    + `<button class="tb-btn" data-cmd="usage" title="Consumo de tokens (Ctrl+Alt+U)">${icon('chart.bar.xaxis', { size: 13 })}</button>`
    + `<button class="tb-btn" data-cmd="refreshAll" title="Actualizar límites (Ctrl+Mayús+R)">${icon('arrow.clockwise', { size: 13 })}</button>`
    + `<button class="tb-btn" data-cmd="settings" title="Suscripciones y ajustes">${icon('gearshape', { size: 13 })}</button></div>`];
  let any = false;
  const several = app.hosts.size > 1;
  for (const [hostId, h] of app.hosts) {
    const accounts = h.data.snapshot?.accounts ?? [];
    if (!accounts.length) continue;
    if (several) out.push(`<div class="limits-host">${esc(nameOf(h))}</div>`);
    for (const a of accounts) { out.push(accountUsageHTML(hostId, a)); any = true; }
  }
  if (!any) out.push('<div class="acct-note">Añade una suscripción en Ajustes</div>');
  $('#limits').innerHTML = out.join('');
}

/** AccountDetailPopover: the account's windows, resets, refresh and sign-in. */
function accountPopover(anchor, hostId, accountId) {
  const a = accountOf(hostId, accountId);
  if (!a) return;
  const s = a.status ?? {};
  const sub = [a.agentName, s.plan, s.email].filter(Boolean).join(' · ');
  const windows = (s.windows ?? []).map((w) => usageBar(w, true) + (w.resetsAt ? `<div class="reset-line">Se reinicia ${esc(reset(w.resetsAt))}${w.detail ? ` · ${esc(w.detail)}` : ''}</div>` : '')).join('');
  const exhausted = s.exhausted ? `<div class="red caption">${icon('hourglass', { size: 10 })} Límite alcanzado${(s.windows ?? []).find((w) => w.percent >= 99.5)?.resetsAt ? ` · disponible ${esc(reset((s.windows ?? []).find((w) => w.percent >= 99.5).resetsAt))}` : ''}</div>` : '';
  const p = openPopover(anchor, `
    <div class="pop-head">${badge(a, 22)}<div><div class="n">${esc(a.name)}</div><div class="s">${esc(sub)}</div></div></div>
    <div style="display:flex;flex-direction:column;gap:8px">${windows || `<div class="muted">${esc(s.error ?? 'Sin datos de uso todavía')}</div>`}</div>
    ${s.note ? `<div class="caption">${icon('info.circle', { size: 10 })} ${esc(s.note)}</div>` : ''}${exhausted}
    <div class="pop-sep"></div>
    <div class="pop-foot"><span class="grow">${s.updatedAt ? `Actualizado ${esc(relative(s.updatedAt))}` : ''}</span>
      ${has(hostId, 'login') && !a.usesAPIKey ? '<button class="btn small" data-pop-login>Iniciar sesión</button>' : ''}
      <button class="btn small" data-pop-refresh${a.refreshing ? ' disabled' : ''}>${icon('arrow.clockwise', { size: 10 })} Actualizar</button></div>`, { width: 340, edge: 'right' });
  if (!p) return;
  p.el.querySelector('[data-pop-refresh]').onclick = () => { sendTo(hostId, Client.refreshUsage()); p.close(); };
  const login = p.el.querySelector('[data-pop-login]');
  if (login) login.onclick = () => { p.close(); sheets.openLogin(hostId, accountId); };
}

// MARK: - Detail column

let threadKey = null;
let T = null; // the thread view's elements

function renderDetail() {
  const detail = $('#detail');
  const { hostId, threadId, h, thread, summary } = current();
  if (!hostId || !h || (!summary && !thread)) {
    threadKey = null;
    T = null;
    const anyProjects = [...app.hosts.values()].some((x) => x.data.snapshot?.projects.length);
    const html = `<div class="toolbar"><div class="titles"><div class="wtitle">Relevo</div></div></div>`
      + (!app.live ? '<div class="center"><span class="spinner big"></span><div>Conectando con el servicio de Relevo…</div></div>'
        : !anyProjects ? welcomeHTML() : `<div class="center">${icon('bubble.left.and.text.bubble.right', { size: 36, cls: 'big-ic' })}<div>Elige un hilo o empieza uno nuevo</div><button class="btn" data-cmd="newThread">Nuevo hilo</button></div>`);
    // Only when it changes: a redraw would wipe what's being typed (the pairing link).
    if (detail.dataset.sig !== html) { detail.innerHTML = html; detail.dataset.sig = html; }
    return;
  }
  detail.dataset.sig = '';
  const key = `${hostId}/${threadId}`;
  if (threadKey !== key) { threadKey = key; buildThread(detail); }
  renderThread();
}

function welcomeHTML() {
  if (!app.hosts.size) {
    // The desktop app alone (relevo-host desktop): nothing to show until it's paired with a host.
    return `<div class="center welcome"><div style="display:flex;flex-direction:column;align-items:center;gap:10px">
        ${icon('dot.radiowaves.left.and.right', { size: 40, cls: 'big-ic' })}<h1>Conecta con tus hosts</h1>
        <p>Esta ventana gestiona los agentes de otros equipos: tu PC con Windows, un servidor, el Mac…\nPega el enlace de emparejamiento de cada uno.</p></div>
      <div style="display:flex;gap:8px;width:min(560px,90%)"><input class="field-input grow mono" id="welcome-link" placeholder="relevocompanion://pair?…"><button class="btn primary" data-cmd="pairWelcome">Conectar</button></div>
      <div class="caption" style="max-width:560px;text-align:center">${sheets.PAIR_HELP}</div></div>`;
  }
  const accounts = [...app.hosts.entries()].flatMap(([id, h]) => (h.data.snapshot?.accounts ?? []).map((a) => [id, a]));
  const kinds = [...new Map(accounts.map(([, a]) => [a.kind.split(':')[0], a])).values()];
  return `<div class="center welcome"><div style="display:flex;flex-direction:column;align-items:center;gap:10px">
      <span class="badges-stack">${kinds.map((a) => badge(a, 40)).join('')}</span><h1>Relevo</h1>
      <p>Todas tus suscripciones de IA en un mismo sitio.\nCambia de agente cuando llegues a un límite sin perder el contexto.</p></div>
    <div style="display:flex;gap:12px"><button class="btn primary large" data-cmd="addProject">${icon('folder.badge.plus', { size: 14 })} Añadir proyecto</button>
      <button class="btn large" data-cmd="settings">${icon('person.crop.circle.badge.checkmark', { size: 14 })} Suscripciones</button></div>
    ${accounts.length ? `<div class="accts">${accounts.map(([, a]) => `<div class="r">${badge(a, 18)}<span class="n">${esc(a.name)}</span>${statusLabel(a)}</div>`).join('')}</div>` : ''}</div>`;
}


// MARK: - Thread view (ThreadView)

function buildThread(detail) {
  detail.innerHTML = `
    <div class="toolbar" id="t-toolbar"></div>
    <div class="teambar" id="t-team"></div>
    <div class="transcript-wrap"><div class="transcript" id="t-scroll"><div class="rows" id="t-rows"></div></div>
      <button class="jump hidden" id="t-jump" title="Ir al último mensaje">${icon('arrow.down', { size: 15 })}</button></div>
    <div class="dock" id="t-dock">
      <div id="t-banner"></div><div id="t-queue"></div>
      <div class="composer" id="t-composer">
        <div class="attachments" id="t-attachments"></div>
        <textarea id="draft" rows="1"></textarea>
        <div class="controls" id="t-controls"></div>
      </div>
    </div>`;
  T = {
    toolbar: $('#t-toolbar'), team: $('#t-team'), scroll: $('#t-scroll'), rows: $('#t-rows'), jump: $('#t-jump'), banner: $('#t-banner'), queue: $('#t-queue'),
    composer: $('#t-composer'), draft: $('#draft'), controls: $('#t-controls'), attachments: $('#t-attachments'), cache: new Map(), stick: true, sig: {},
  };
  const { hostId, threadId } = current();
  const key = `${hostId}/${threadId}`;
  T.draft.value = app.drafts.get(key) ?? '';
  autosize();
  let draftTimer = 0;
  T.draft.addEventListener('input', () => {
    app.drafts.set(key, T.draft.value);
    saveDrafts();
    autosize();
    renderControls();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => sendTo(hostId, Client.setDraft(threadId, T.draft.value)), 700);
  });
  T.draft.addEventListener('focus', () => T.composer.classList.add('focus'));
  T.draft.addEventListener('blur', () => T.composer.classList.remove('focus'));
  T.draft.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
    e.preventDefault();
    sendDraft(e.ctrlKey || e.metaKey);
  });
  T.draft.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); attach(files); }
  });
  T.composer.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); T.composer.classList.add('drop'); } });
  T.composer.addEventListener('dragleave', () => T.composer.classList.remove('drop'));
  T.composer.addEventListener('drop', (e) => {
    T.composer.classList.remove('drop');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); attach(files); }
  });
  T.scroll.addEventListener('scroll', () => {
    T.stick = T.scroll.scrollHeight - T.scroll.scrollTop - T.scroll.clientHeight < 24;
    T.jump.classList.toggle('hidden', T.stick);
  });
  T.jump.onclick = () => { T.stick = true; T.scroll.scrollTo({ top: T.scroll.scrollHeight, behavior: 'smooth' }); };
  attachments.length = 0;
  renderAttachments();
}

let draftsTimer = 0;
function saveDrafts() {
  clearTimeout(draftsTimer);
  draftsTimer = setTimeout(() => save('drafts', [...app.drafts].filter(([, v]) => v.trim()).slice(-50)), 500);
}

function autosize() {
  T.draft.style.height = 'auto';
  T.draft.style.height = `${Math.min(220, Math.max(38, T.draft.scrollHeight))}px`;
}

function renderThread() {
  if (!T) { render(); return; }
  const { hostId, thread, summary } = current();
  if (!summary && !thread) { render(); return; }
  renderToolbar();
  renderTeamBar();
  renderTranscript();
  renderBanner();
  renderQueue();
  renderControls();
  T.draft.placeholder = thread?.runtime?.isRunning ? 'Escribe el siguiente mensaje: se enviará cuando termine el turno…'
    : (thread?.items.length ?? 0) === 0 ? 'Pide un cambio, haz una pregunta o arranca un proyecto…' : 'Responde o pide algo más…';
  if (T.stick) T.scroll.scrollTop = T.scroll.scrollHeight;
  updateTitle();
  void hostId;
}
hooks.renderThread = renderThread;

// Toolbar items, in the Mac's order: tools · Traza · Consumo · Git · Acciones · Varios agentes · Relevo · Proyecto.
function renderToolbar() {
  const { hostId, thread, summary } = current();
  const project = projectOf(hostId, summary?.projectId);
  const wt = thread?.worktree;
  const path = wt?.path ?? project?.path ?? '';
  const noItems = !thread?.items.length;
  const hasUser = thread?.items.some((i) => i.kind === 'user');
  const caret = icon('chevron.down', { size: 9, cls: 'caret' });
  const html = `<div class="titles"><div class="wtitle">${esc(thread?.title ?? summary?.title ?? 'Hilo')}</div><div class="wsub">${esc(abbreviate(path))}${app.hosts.size > 1 ? ` · ${esc(nameOf(host(hostId)))}` : ''}</div></div>`
    + `<button class="tb-btn" data-cmd="toggleTools" title="${app.showTools ? 'Agrupar los comandos y herramientas del agente en una línea por tanda (Ctrl+Alt+T)' : 'Ver cada comando y herramienta del agente por separado (Ctrl+Alt+T)'}">${icon(app.showTools ? 'rectangle.compress.vertical' : 'rectangle.expand.vertical', { size: 17 })}</button>`
    + `<button class="tb-btn" data-cmd="traza" title="Estado del trabajo: plan, por dónde iba el agente, ficheros tocados y git (lo que recibiría otro agente)"${noItems ? ' disabled' : ''}>${icon('list.bullet.clipboard', { size: 17 })}</button>`
    + `<button class="tb-btn" data-cmd="threadUsage" title="Tokens y coste de este hilo"${noItems ? ' disabled' : ''}>${icon('chart.bar.xaxis', { size: 17 })}</button>`
    + (has(hostId, 'git') ? `<button class="tb-btn" data-cmd="gitMenu" title="${esc(wt ? `Worktree propio: ${wt.path}` : 'Git: cambios, commit, push y PR')}">${icon(wt ? 'square.stack.3d.down.right' : 'arrow.triangle.branch', { size: 17 })}${caret}</button>` : '')
    + (has(hostId, 'quickActions') ? `<button class="tb-btn" data-cmd="actionsMenu" title="Acciones del proyecto: compilar, tests… (Ctrl+1…Ctrl+9)">${icon(running.size ? 'gearshape.arrow.triangle.2.circlepath' : 'play.rectangle', { size: 17 })}${caret}</button>` : '')
    + `<button class="tb-btn" data-cmd="compare" title="La misma tarea a varios agentes, cada uno en su worktree, para quedarte con el mejor resultado">${icon('person.3.sequence', { size: 19 })}</button>`
    + `<button class="tb-btn" data-cmd="relayMenu" title="Pasa la conversación (con todo su contexto) a otra suscripción"${hasUser ? '' : ' disabled'}>${icon('arrow.triangle.swap', { size: 17 })}${caret}</button>`
    + (project ? `<button class="tb-btn" data-cmd="projectMenu" title="Acciones del proyecto">${icon('folder', { size: 17 })}${caret}</button>` : '');
  if (T.sig.toolbar !== html) { T.toolbar.innerHTML = html; T.sig.toolbar = html; }
}

function abbreviate(p) {
  return String(p ?? '').replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

// MARK: - Transcript (TranscriptView + ItemViews)

function rowsOf(items) {
  // A reply with no text, no usage and no changes yet is hidden.
  items = items.filter((it) => !(it.kind === 'assistant' && !it.text?.trim() && !it.usage));
  if (app.showTools) return items.map((item) => ({ key: item.id, item }));
  const rows = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (!run.some((i) => i.kind === 'tool')) rows.push(...run.map((item) => ({ key: item.id, item })));
    else {
      const key = `group:${run[0].id}`;
      rows.push({ key, group: run });
      if (app.expandedItems.has(key)) rows.push(...run.map((item) => ({ key: item.id, item })));
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

// MARK: - Teams

const ROLE = {
  orchestrator: { label: 'Orquestador', short: 'Orq.', icon: 'crown.fill' },
  executor: { label: 'Ejecutor', short: 'Ej.', icon: 'wrench.and.screwdriver' },
  researcher: { label: 'Investigador', short: 'Inv.', icon: 'globe' },
  relevo: { label: 'Relevo', short: 'Relevo', icon: 'info.circle' },
  team: { label: 'Equipo', short: 'Equipo', icon: 'person.3.sequence' },
};
const teamOf = (hostId, teamId) => snap(hostId)?.hostTeams?.find((x) => x.id === teamId) ?? null;

/** The team a thread belongs to: its members (each a click away, with what it's doing), pause and dissolve. */
function renderTeamBar() {
  const { hostId, summary } = current();
  const team = summary?.team && teamOf(hostId, summary.team.id);
  let html = '';
  if (team) {
    const threads = snap(hostId)?.threads ?? [];
    const chips = team.members.map((m) => {
      const t = threads.find((x) => x.id === m.threadId);
      const state = t?.isRunning ? '<span class="spinner"></span>' : t?.needsApproval ? `<span class="orange">${icon('questionmark.bubble.fill', { size: 11 })}</span>` : '';
      const tip = `${m.name}${t?.isRunning ? ' · trabajando' : t?.needsApproval ? ' · esperando respuesta' : ' · libre'}`;
      return `<button class="team-chip r-${m.role}${m.threadId === summary.id ? ' on' : ''}" data-team-go="${esc(m.threadId)}" title="${esc(tip)}">${icon(ROLE[m.role]?.icon ?? 'person.2', { size: 11 })}<span>${esc(m.name)}</span>${state}</button>`;
    }).join('');
    const status = team.status === 'paused' ? `<span class="team-status orange">En pausa${team.held ? ` · ${team.held} mensaje${team.held === 1 ? '' : 's'} esperando` : ''}</span>`
      : team.status === 'done' ? `<span class="team-status green">${icon('checkmark.circle.fill', { size: 11 })} Objetivo cumplido</span>` : '';
    html = `<span class="team-label" title="${esc(team.goal)}">${icon('person.3.sequence', { size: 13 })}Equipo</span>${chips}<span class="grow"></span>${status}`
      + (team.status === 'paused' ? `<button class="btn small" data-team-act="resume">${icon('play.rectangle', { size: 11 })} Reanudar</button>`
        : team.status === 'active' ? `<button class="btn small" data-team-act="pause" title="Los mensajes entre agentes esperan; tú puedes seguir escribiendo">${icon('pause.circle', { size: 11 })} Pausar</button>` : '')
      + `<button class="tb-btn" data-team-menu title="Más">${icon('chevron.down', { size: 10 })}</button>`;
  }
  if (T.sig.team !== html) { T.team.innerHTML = html; T.team.classList.toggle('hidden', !html); T.sig.team = html; }
}

function teamMenu(anchor) {
  const { hostId, summary } = current();
  const team = summary?.team && teamOf(hostId, summary.team.id);
  if (!team) return;
  showMenu(anchor, [
    { info: team.goal.length > 80 ? `${team.goal.slice(0, 78)}…` : team.goal },
    '-',
    { label: 'Ir al orquestador', action: () => { const m = team.members.find((x) => x.role === 'orchestrator'); if (m) select(hostId, m.threadId); } },
    { label: 'Disolver el equipo…', danger: true, action: async () => {
      const ok = await alertSheet({ title: '¿Disolver el equipo?', message: 'Los hilos se conservan como hilos normales; los agentes dejan de pasarse mensajes.', buttons: [{ label: 'Disolver', role: 'destructive' }, { label: 'Cancelar', role: 'cancel' }] });
      if (!ok) return;
      const r = await request(hostId, { teamAction: { teamId: team.id, action: 'dissolve' } });
      if (!r.ok) toast(r.error);
    } },
  ]);
}

function renderTranscript() {
  const { hostId, threadId, thread } = current();
  if (!thread) { T.rows.innerHTML = '<div class="center" style="padding:40px"><span class="spinner big"></span></div>'; T.sig.rows = 'loading'; T.cache = new Map(); return; }
  if (!thread.items.length) {
    const project = projectOf(hostId, summaryOf(hostId, threadId)?.projectId);
    const kinds = [...new Map((snap(hostId)?.accounts ?? []).map((a) => [a.kind.split(':')[0], a])).values()];
    const html = `<div class="hero" style="min-height:${T.scroll.clientHeight - 40}px"><span class="badges-stack">${kinds.map((a) => badge(a, 30)).join('')}</span>`
      + `<h1>¿Qué hacemos en ${esc(project?.name ?? 'este proyecto')}?</h1>${project ? `<div class="path">${esc(abbreviate(thread.worktree?.path ?? project.path))}</div>` : ''}`
      + '<div class="hint">Elige suscripción y modelo abajo. Si llegas a un límite, cambia de agente y Relevo le pasa todo el contexto.</div></div>';
    if (T.sig.rows !== html) { T.rows.innerHTML = html; T.sig.rows = html; T.cache = new Map(); }
    return;
  }
  if (T.sig.rows) { T.rows.innerHTML = ''; T.sig.rows = null; }
  const key = `${hostId}/${thread.id}`;
  const older = app.older.get(key) ?? [];
  const items = older.length ? [...older, ...thread.items] : thread.items;
  const hidden = Math.max(0, thread.totalItems - thread.items.length - older.length);
  // Author header: first assistant item after each user message or notice; turn footers on the turn's last item.
  const headers = new Set();
  let need = true;
  for (const it of items) {
    if (it.kind === 'user' || it.kind === 'notice') need = true;
    else if (it.kind === 'assistant' && need) { headers.add(it.id); need = false; }
  }
  const footers = turnFooters(items);
  const rows = rowsOf(items);
  const groupFooters = new Map();
  for (const row of rows) if (row.group && !app.expandedItems.has(row.key)) {
    const f = [...row.group].reverse().find((i) => footers.has(i.id));
    if (f) groupFooters.set(row.key, footers.get(f.id));
  }
  const next = new Map();
  const container = T.rows;
  let prev = null;
  const head = hidden ? { key: '__older', html: `<div class="older">${hidden} elementos anteriores${has(hostId, 'history') ? ' · <button class="btn link small" data-cmd="loadOlder">Cargar más</button>' : ''}</div>` } : null;
  const all = head ? [head, ...rows] : rows;
  for (const row of all) {
    const footer = row.item ? footers.get(row.item.id) : row.group ? groupFooters.get(row.key) : null;
    const version = row.html ?? JSON.stringify([row.item ?? row.group, app.expandedItems.has(row.key), headers.has(row.key), footer, app.showTurnUsage]);
    let entry = T.cache.get(row.key);
    if (!entry || entry.version !== version) {
      const el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = row.html ?? ((row.group ? groupHTML(row) : itemHTML(hostId, row.item, headers.has(row.key))) + (footer ? footerHTML(footer) : ''));
      if (entry) entry.el.replaceWith(el);
      entry = { el, version };
    }
    next.set(row.key, entry);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (want !== entry.el) container.insertBefore(entry.el, want);
    prev = entry.el;
  }
  for (const [k, e] of T.cache) if (!next.has(k)) e.el.remove();
  T.cache = next;
  // Working / waiting indicator after the rows.
  const rt = thread.runtime;
  let tail = container.querySelector(':scope > .tail');
  const tailHTML = rt?.isRunning ? `<div class="working"><span class="dots"><i></i><i></i><i></i></span>${esc(rt.statusLine ?? 'Trabajando…')}</div>`
    : rt?.backgroundTasks?.length ? `<div class="waiting">${icon('clock', { size: 13 })}<div><div class="w-title">${rt.backgroundTasks.length === 1 ? 'Esperando a una tarea en segundo plano' : `Esperando a ${rt.backgroundTasks.length} tareas en segundo plano`}</div>${rt.backgroundTasks.map((b) => `<div class="w-line">${esc(b.description)}</div>`).join('')}<div class="w-line tert">El agente no está trabajando: retomará solo cuando termine.</div></div></div>` : '';
  if (tailHTML) {
    if (!tail) { tail = document.createElement('div'); tail.className = 'tail'; }
    if (tail.innerHTML !== tailHTML) tail.innerHTML = tailHTML;
    container.appendChild(tail);
  } else tail?.remove();
  hydrateImages(hostId, thread.id);
}

/** Usage and changes of each turn, keyed by the turn's last item (the Mac's TurnFooter). */
function turnFooters(items) {
  const out = new Map();
  let user = null, last = null, usage = null;
  const close = () => {
    if (last && (usage || user?.turnChanges)) out.set(last.id, { usage, changes: user?.turnChanges ?? null, userId: user?.id });
  };
  for (const it of items) {
    if (it.kind === 'user') { close(); user = it; last = null; usage = null; continue; }
    if (it.kind === 'notice') continue;
    last = it;
    if (it.usage) usage = it.usage;
  }
  close();
  return out;
}

function footerHTML(f) {
  const parts = [];
  if (f.usage && app.showTurnUsage) {
    const u = f.usage;
    const bits = [];
    if (u.switchLabel && (u.overhead ?? 0) >= 1000) bits.push(`<span class="sw">${icon('arrow.triangle.swap', { size: 10 })}${esc(u.switchLabel)}: +${shortTokens(u.overhead)}${u.overheadCost ? ` · ${usd(u.overheadCost)}` : ''}</span>`);
    if (u.tokens) {
      bits.push(`<span>${shortTokens(u.tokens)} tokens</span>`);
      if (u.cacheShare) bits.push(`<span>${pct(u.cacheShare * 100)} caché</span>`);
      if (u.cost) bits.push(`<span>${u.costEstimated ? '≈ ' : ''}${usd(u.cost)}</span>`);
    } else if (u.context) bits.push(`<span>contexto ${shortTokens(u.context)}</span>`);
    parts.push(`<button data-turn-usage='${esc(JSON.stringify(u))}' title="Consumo de este turno">${bits.join('')}</button>`);
  }
  if (f.changes) parts.push(`<button class="changes" data-turn-changes="${esc(f.userId)}" title="Ver lo que cambió este turno, comentarlo o deshacerlo">${icon('doc.badge.ellipsis', { size: 11 })}${f.changes.files} ${f.changes.files === 1 ? 'fichero' : 'ficheros'} · +${f.changes.added} −${f.changes.removed}</button>`);
  return parts.length ? `<div class="turn-footer">${parts.join('')}</div>` : '';
}

function groupHTML(row) {
  const tools = row.group.filter((i) => i.kind === 'tool');
  const names = [];
  for (const t of tools) { const n = t.toolName ?? 'Herramienta'; if (!names.includes(n)) names.push(n); }
  const failed = tools.filter((t) => t.toolState === 'failed').length;
  const runningNow = tools.some((t) => t.toolState === 'running');
  const open = app.expandedItems.has(row.key);
  const summary = `${tools.length === 1 ? '1 acción' : `${tools.length} acciones`} · ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`;
  return `<button class="tool-group" data-toggle-item="${esc(row.key)}" title="${open ? 'Ocultar estas acciones' : 'Ver estas acciones'}">${runningNow ? '<span class="spinner"></span>' : icon('wrench.and.screwdriver', { size: 11 })}${esc(summary)}${failed ? `<span class="fails">${icon('xmark.circle.fill', { size: 10 })}${failed}</span>` : ''}${icon(open ? 'chevron.down' : 'chevron.right', { size: 9 })}</button>`;
}

function itemHTML(hostId, it, header) {
  const open = app.expandedItems.has(it.id);
  switch (it.kind) {
    case 'user':
      if (it.from) {
        const role = ROLE[it.from.role] ?? ROLE.team;
        return `<div class="from-row r-${esc(it.from.role)}"><div class="from-head">${icon(role.icon, { size: 11 })}<b>${esc(it.from.name)}</b>${it.from.label ? `<span>· ${esc(it.from.label)}</span>` : ''}${it.from.threadId ? `<button class="btn link small" data-team-go="${esc(it.from.threadId)}">Ver hilo</button>` : ''}</div><div class="md">${markdown(it.text)}</div></div>`;
      }
      return `<div class="user-row"><div class="bubble">${esc(it.text)}</div></div>${imagesHTML(hostId, it.text).replace('class="thumbs"', 'class="thumbs" style="justify-content:flex-end"')}`;
    case 'assistant': {
      const acct = accountOf(hostId, it.accountId);
      const author = header && acct ? `<div class="author">${badge(acct, 14)}<b>${esc(acct.name)}</b><span class="m">${esc(modelName(acct, it.model))}</span></div>` : '';
      return `${author}<div class="md">${markdown(it.text)}</div>${imagesHTML(hostId, it.text)}`;
    }
    case 'reasoning':
      return `<div><button class="toggle-row" data-toggle-item="${esc(it.id)}">${icon('brain', { size: 11 })}Razonamiento${icon(open ? 'chevron.down' : 'chevron.right', { size: 9 })}</button>${open ? `<div class="reasoning-body">${esc(it.text)}</div>` : ''}</div>`;
    case 'tool': {
      const detail = it.output && it.output.trim();
      const state = it.toolState === 'running' ? '<span class="spinner"></span>' : it.toolState === 'failed' ? `<span class="st-failed">${icon('xmark.circle.fill', { size: 13 })}</span>` : `<span class="st-done">${icon('checkmark', { size: 11 })}</span>`;
      const title = it.title ?? it.toolName ?? 'Herramienta';
      return `<div class="tool"><button class="tool-head" data-toggle-item="${esc(it.id)}"${detail ? '' : ' disabled'}>${icon(toolSymbol(it.toolName ?? it.title ?? ''), { size: 14, cls: 'sym' })}<span class="t" title="${esc(title)}">${esc(title)}</span>${state}${detail ? `<span class="chev">${icon(open ? 'chevron.down' : 'chevron.right', { size: 9 })}</span>` : ''}</button>`
        + (open && detail ? `<div class="tool-body">${it.text && it.text !== title ? `<div class="in">${esc(it.text)}</div>` : ''}<div>${esc(it.output)}</div></div>` : '') + '</div>';
    }
    case 'notice': {
      const acct = /^Relevo/.test(it.text) ? accountOf(hostId, it.accountId) : null;
      return `<div class="notice"><span class="c">${acct ? badge(acct, 13) : ''}<span>${inline(it.text)}</span>${it.redoTree ? `<button class="btn small" data-redo-tree="${esc(it.redoTree)}">Deshacer</button>` : ''}</span></div>`;
    }
    case 'error': return `<div class="error-row">${icon('exclamationmark.triangle.fill', { size: 14 })}<span class="selectable">${esc(it.text)}</span></div>`;
    case 'approval': return it.questions?.length ? questionHTML(it) : approvalHTML(it);
    default: return `<div class="notice"><span class="c">${esc(it.text)}</span></div>`;
  }
}

function approvalHTML(it) {
  const pending = !it.resolution;
  const options = it.options ?? [];
  const firstAllow = options.findIndex((o) => o.isAllow);
  return `<div class="approval${pending ? '' : ' resolved'}"><div class="approval-head">${icon('hand.raised.fill', { size: 13 })}${pending ? 'El agente pide permiso' : 'Permiso'}${pending ? '' : `<span class="res-pill">${esc(it.resolution)}</span>`}</div>`
    + `<div class="cmd selectable">${esc(it.title ?? it.text)}</div>${it.output ? `<div class="detail">${esc(it.output)}</div>` : ''}`
    + (pending ? `<div class="sheet-buttons">${options.map((o, i) => `<button class="btn${i === firstAllow ? ' primary' : ''}" data-approve="${esc(it.id)}" data-option="${esc(o.id)}"${i === firstAllow ? ' title="Ctrl+Intro"' : ''}>${esc(o.label)}</button>`).join('')}</div>` : '') + '</div>';
}

const qState = new Map(); // itemId → { picked: [Set], other: [] }
function questionHTML(it) {
  const pending = !it.resolution;
  const st = qState.get(it.id) ?? { picked: it.questions.map(() => new Set()), other: it.questions.map(() => '') };
  qState.set(it.id, st);
  const n = it.questions.length;
  let html = `<div class="question${pending ? '' : ' resolved'}"><div class="q-title">${icon('questionmark.bubble.fill', { size: 14 })}${n === 1 ? 'El agente te pregunta' : `El agente te hace ${n} preguntas`}</div>`;
  it.questions.forEach((q, qi) => {
    html += `<div class="q-one"><div class="q-head">${q.header ? `<span class="q-pill">${esc(q.header)}</span>` : ''}${q.multiSelect ? '<span class="caption">varias opciones</span>' : ''}</div><div class="q-text">${esc(q.question)}</div>`;
    const answer = it.answers?.[q.question];
    if (answer) html += `<div class="q-answer">${icon('checkmark.circle.fill', { size: 13 })}${esc(answer)}</div>`;
    else if (pending) {
      q.options.forEach((o, oi) => {
        const on = st.picked[qi].has(oi);
        const ic = q.multiSelect ? (on ? 'checkmark.square.fill' : 'square') : (on ? 'largecircle.fill.circle' : 'circle');
        html += `<button class="q-opt${on ? ' on' : ''}" data-q-opt="${esc(it.id)}" data-qi="${qi}" data-oi="${oi}">${icon(ic, { size: 14 })}<span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></button>`;
      });
      html += `<input type="text" class="field-input" data-q-other="${esc(it.id)}" data-qi="${qi}" placeholder="Otra respuesta…" value="${esc(st.other[qi])}">`;
    }
    html += '</div>';
  });
  if (pending) {
    const complete = it.questions.every((q, qi) => st.other[qi].trim() || st.picked[qi].size);
    html += `<div class="sheet-buttons"><button class="btn primary" data-q-send="${esc(it.id)}"${complete ? '' : ' disabled'}>Responder</button><button class="btn" data-q-skip="${esc(it.id)}" title="No responder: el agente seguirá por su cuenta">Omitir</button></div>`;
  } else if (!it.answers) html += `<div class="caption">${icon('xmark.circle', { size: 10 })} ${esc(it.resolution)}</div>`;
  return `${html}</div>`;
}

// Image strip (ImageStrip): thumbnails 150 tall of the images a message names.
const IMAGE_PATH = /(?:^|[\s(`'"*])((?:[A-Za-z]:[\\/]|~?\/|\.{1,2}[\\/])?[\w.\-\\/]*[\w-]\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))(?=$|[\s)\]`'".,;:*])/gim;
function imagesHTML(hostId, text) {
  const paths = [...new Set([...String(text ?? '').matchAll(IMAGE_PATH)].map((m) => m[1]))].slice(0, 12);
  if (!paths.length) return '';
  return `<div class="thumbs">${paths.map((p) => `<button class="thumb" data-image="${esc(p)}" title="${esc(p.split(/[\\/]/).pop())}"><span class="frame"><span class="spinner"></span></span><span class="fname">${esc(p.split(/[\\/]/).pop())}</span></button>`).join('')}</div>`;
}


function hydrateImages(hostId, threadId) {
  for (const b of T.rows.querySelectorAll('.thumb:not([data-ready])')) {
    b.dataset.ready = '1';
    imageData(hostId, threadId, b.dataset.image, 480).then((url) => {
      const frame = b.querySelector('.frame');
      if (url) { frame.innerHTML = `<img src="${url}" alt="">`; b.classList.add('loaded'); }
      else frame.innerHTML = icon('photo', { size: 22 });
    });
  }
}

// MARK: - Banners above the composer (LimitBanner, SuggestionBar, QueueBar)

function renderBanner() {
  const { hostId, thread } = current();
  const rt = thread?.runtime;
  let html = '';
  if (rt?.limit || rt?.pendingRelay || rt?.resumeAt) html = limitHTML(hostId, rt);
  else if (rt?.suggestion) html = suggestionHTML(hostId, rt.suggestion);
  if (T.sig.banner !== html) { T.banner.innerHTML = html; T.sig.banner = html; }
}

function limitHTML(hostId, rt) {
  const l = rt.limit ?? {};
  const acc = accountOf(hostId, l.accountId ?? rt.selectedAccountId);
  const name = acc?.name;
  const title = l.isNoPlan ? `Tu plan de ${name ?? 'esta suscripción'} no incluye este servicio ahora mismo`
    : l.isCapacity ? `${name ?? 'El proveedor'} no está disponible ahora mismo` : `Límite alcanzado en ${name ?? 'este proveedor'}`;
  const when = reset(l.resetsAt);
  const sub = l.isNoPlan ? 'La sesión sigue iniciada, pero la suscripción no da acceso (¿ha caducado?). Continúa con otro agente sin perder el contexto:'
    : l.isCapacity ? 'El modelo está saturado. Elige otro modelo abajo o continúa con otro agente sin perder el contexto:'
      : when ? `Se reinicia ${when}. Continúa ahora con otro agente sin perder el contexto:` : 'Continúa ahora con otro agente sin perder el contexto:';
  let html = `<div class="card limit-card"><div class="head">${icon('hourglass', { size: 13, cls: 'hg' })}<div class="grow"><div class="ttl">${esc(title)}</div><div class="sub">${esc(sub)}</div></div><button class="icon-plain" data-limit-dismiss>${icon('xmark', { size: 11 })}</button></div>`;
  if (rt.pendingRelay) {
    const to = accountOf(hostId, rt.pendingRelay.accountId);
    const secs = Math.max(0, Math.ceil(rt.pendingRelay.at - Date.now() / 1000));
    html += `<div class="line">${icon('arrow.triangle.2.circlepath', { size: 13, cls: 'muted' })}<span class="grow">Pasa a <b>${esc(to?.name ?? '?')} · ${esc(modelName(to, rt.pendingRelay.model))}</b> en ${secs} s, con todo el contexto</span><button class="btn primary small" data-limit-action="relayNow">Ahora</button><button class="btn small" data-limit-action="cancelRelay">No relevar</button></div>`;
  } else if (rt.resumeAt) {
    html += `<div class="line">${icon('clock', { size: 13, cls: 'muted' })}<span class="grow">Seguirá ${esc(reset(rt.resumeAt) ?? 'cuando se reinicie la cuota')} con el mismo agente, donde lo dejó</span><button class="btn small" data-limit-action="resumeNow">Retomar ahora</button><button class="btn small" data-limit-action="cancelResume">No esperar</button></div>`;
  }
  const cands = (rt.relayCandidates ?? []).map((c) => ({ c, a: accountOf(hostId, c.accountId) })).filter((x) => x.a).sort((x, y) => maxPercent(x.a) - maxPercent(y.a));
  html += cands.length
    ? `<div class="cands">${cands.map(({ c, a }) => `<button class="btn cand" data-relay="${esc(c.accountId)}" data-model="${esc(c.model)}">${badge(a, 14)}${esc(a.name)} · ${esc(modelName(a, c.model))}<span class="p">${Math.round(maxPercent(a))}%</span></button>`).join('')}</div>`
    : '<div class="caption">No hay otras suscripciones con cuota disponible ahora mismo.</div>';
  return `${html}</div>`;
}

function suggestionHTML(hostId, sg) {
  const a = accountOf(hostId, sg.accountId);
  const what = [a?.name, modelName(a, sg.model), sg.effort ? effortName(sg.effort) : null].filter(Boolean).join(' · ');
  return `<div class="card suggest-card" title="${sg.byAI ? 'Tarea clasificada por el modelo auxiliar' : 'Tarea clasificada sin IA (heurística local)'}">${icon('wand.and.stars', { size: 15, cls: 'w' })}`
    + `<div class="grow"><div class="l1"><span class="k">${sg.autoApplied ? 'Relevo ha elegido' : 'Sugerido'}</span>${badge(a, 14)}<b>${esc(what)}</b></div>${sg.reasons?.length ? `<div class="l2">${esc(sg.reasons.join(' · '))}</div>` : ''}</div>`
    + (sg.autoApplied ? '<button class="btn small" data-suggestion="undo">Deshacer</button>' : '<button class="btn primary small" data-suggestion="accept" title="Usar esta suscripción, modelo y razonamiento (Ctrl+Mayús+U)">Usar</button>')
    + `<button class="icon-plain" data-suggestion="dismiss" title="Ocultar hasta el próximo mensaje">${icon('xmark', { size: 11 })}</button></div>`;
}

function renderQueue() {
  const { thread } = current();
  const rt = thread?.runtime;
  const q = rt?.queued ?? [];
  let html = '';
  if (q.length) {
    html = `<div class="card queue-card"><div class="qh${rt.queuePaused ? ' paused' : ''}">${icon(rt.queuePaused ? 'pause.circle' : 'text.append', { size: 11 })}<span class="grow">${rt.queuePaused ? 'Cola en pausa' : 'En cola · se envían al terminar cada turno'}</span>${rt.queuePaused ? `<button class="btn small" data-cmd="resumeQueue"${rt.isRunning ? ' disabled' : ''} title="Enviar el siguiente mensaje de la cola">Reanudar</button>` : ''}</div>`
      + q.map((m, i) => `<div class="qr"><span class="n">${i + 1}</span><span class="tx">${esc(m.text)}</span><button class="icon-plain orange" data-queued-now="${esc(m.id)}" title="Enviar ya: interrumpe al agente y le manda este mensaje ahora">${icon('bolt.fill', { size: 12 })}</button><button class="icon-plain tert" data-dequeue="${esc(m.id)}" title="Quitar de la cola">${icon('xmark.circle.fill', { size: 13 })}</button></div>`).join('')
      + (rt.queuePaused ? '<div class="caption">El último turno no terminó bien (error, límite o detenido). Revisa y reanuda cuando quieras.</div>' : '') + '</div>';
  }
  if (T.sig.queue !== html) { T.queue.innerHTML = html; T.sig.queue = html; }
}

// MARK: - Composer controls (ModelPicker, EffortPicker, ModePicker, UsageHint, buttons)

function renderControls() {
  const { hostId, thread, h } = current();
  const rt = thread?.runtime;
  const acc = accountOf(hostId, rt?.selectedAccountId);
  const model = modelOf(acc, rt?.selectedModel);
  const lastAcc = [...(thread?.items ?? [])].reverse().find((i) => i.kind === 'assistant')?.accountId;
  const pickTip = acc && lastAcc && lastAcc !== acc.id ? `Al enviar, Relevo pasará el contexto del hilo a ${acc.name}` : 'Proveedor y modelo';
  const draft = T.draft.value.trim() || attachments.some((a) => a.path);
  const connected = h?.info.state === 'connected';
  const runningNow = rt?.isRunning;
  const efforts = model?.efforts ?? [];
  const effortLabel = rt?.selectedEffort ? effortName(rt.selectedEffort) : model?.defaultEffort ? effortName(model.defaultEffort) : 'Auto';
  const mode = MODES.find((m) => m[0] === rt?.mode) ?? MODES[0];
  const windows = (rt?.usage ?? acc?.status?.windows ?? []).slice(0, 2);
  const hint = windows.length ? `<span class="usage-hint" title="${esc(windows.map((w) => `${w.label}: ${Math.round(w.percent)}%${w.resetsAt ? ` · se reinicia ${reset(w.resetsAt)}` : ''}`).join('\n'))}">${windows.map((w) => `<span><i style="background:${usageColor(w.percent)}"></i>${esc(w.label)} ${Math.round(w.percent)}%</span>`).join('')}</span>` : '';
  let buttons;
  if (runningNow && draft) {
    buttons = `<button class="circle-btn orange" data-cmd="sendNow" title="Enviar ya: interrumpe al agente y le manda esto ahora, sin perder el contexto (Ctrl+Intro)">${icon('bolt.fill', { size: 12 })}</button>`
      + `<button class="circle-btn" data-cmd="send" title="Añadir a la cola: se enviará al terminar el turno (Intro)">${icon('text.append', { size: 12 })}</button>`
      + `<button class="circle-btn" data-cmd="stop" title="Detener (Ctrl+.)">${icon('stop.fill', { size: 11 })}</button>`;
  } else if (runningNow) {
    buttons = `<button class="circle-btn" data-cmd="stop" title="Detener (Ctrl+.)">${icon('stop.fill', { size: 11 })}</button>`;
  } else {
    buttons = `<button class="circle-btn" data-cmd="send" title="Enviar (Intro) · nueva línea con Mayús+Intro"${draft && connected ? '' : ' disabled'}>${icon('arrow.up', { size: 14 })}</button>`;
  }
  const html = `<button class="pick model" data-cmd="modelMenu" title="${esc(pickTip)}"${rt ? '' : ' disabled'}>${acc ? `${badge(acc, 15)}<span class="acc">${esc(acc.name)}</span><span class="mdl">${esc(modelName(acc, rt?.selectedModel))}</span>` : '<span>Elige una suscripción</span>'}${icon('chevron.up.chevron.down', { size: 9, cls: 'ud' })}</button>`
    + (efforts.length ? `<button class="pick${rt?.selectedEffort ? ' set' : ''}" data-cmd="effortMenu" title="Nivel de razonamiento: cuánto «piensa» el modelo antes de responder (más alto = mejor en tareas difíciles, más lento y gasta más cuota)">${icon('brain', { size: 13 })}${esc(effortLabel)}</button>` : '')
    + `<button class="pick${mode[0] === 'full' ? ' danger' : ''}" data-cmd="modeMenu" title="${esc(mode[3])}">${icon(mode[2], { size: 13 })}${esc(mode[1])}</button>`
    + `<span class="grow"></span>${hint}${buttons}`;
  if (T.sig.controls !== html) { T.controls.innerHTML = html; T.sig.controls = html; }
}

function sendDraft(now) {
  const { hostId, threadId, thread, h } = current();
  if (h?.info.state !== 'connected') { toast(`Sin conexión con ${nameOf(h)}`); return; }
  const files = attachments.filter((a) => a.path).map((a) => `[Imagen adjunta: ${a.path}]`);
  if (attachments.some((a) => !a.path && !a.error)) { toast('Espera a que se suban las imágenes'); return; }
  const text = [T.draft.value.trim(), ...files].filter(Boolean).join('\n\n');
  if (!text) return;
  const runningNow = thread?.runtime?.isRunning;
  sendTo(hostId, now && runningNow ? Client.sendNow(threadId, text) : Client.send(threadId, text));
  T.draft.value = '';
  app.drafts.delete(`${hostId}/${threadId}`);
  saveDrafts();
  attachments.length = 0;
  renderAttachments();
  autosize();
  T.stick = true;
  T.scroll.scrollTo({ top: T.scroll.scrollHeight, behavior: 'smooth' });
  renderControls();
}

// Attachments: images pasted or dropped (the message names their path on the host for the agent).
const attachments = [];
async function attach(files) {
  const { hostId, threadId } = current();
  if (!has(hostId, 'attachments')) { toast(`${nameOf(host(hostId))} no admite imágenes adjuntas`); return; }
  for (const file of files.slice(0, 6)) {
    if (file.size > 10 << 20) { toast(`${file.name || 'La imagen'} pasa de 10 MB`); continue; }
    const entry = { name: file.name || `captura-${Date.now()}.png`, preview: URL.createObjectURL(file) };
    attachments.push(entry);
    renderAttachments();
    const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(file); });
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const name = /\.\w+$/.test(entry.name) ? entry.name : `${entry.name}.${ext}`;
    const r = await request(hostId, { uploadImage: { threadId, name, data } });
    if (r.ok) entry.path = r.path; else { entry.error = r.error; toast(r.error); }
    renderAttachments();
  }
}
function renderAttachments() {
  if (!T) return;
  T.attachments.innerHTML = attachments.map((a, i) => `<span class="att${a.error ? ' bad' : ''}"><img src="${a.preview}" alt="">${esc(a.name)}${!a.path && !a.error ? ' <span class="spinner"></span>' : ''}<button class="icon-plain" data-remove-attachment="${i}" title="Quitar">${icon('xmark', { size: 10 })}</button></span>`).join('');
  renderControls();
}

// MARK: - Menus of the composer and toolbar

function modelMenu(anchor) {
  const { hostId, threadId, thread } = current();
  const rt = thread?.runtime;
  const items = [];
  for (const a of snap(hostId)?.accounts ?? []) {
    const s = a.status;
    const state = s?.noPlan ? ' · plan sin acceso' : s?.exhausted ? ' · agotada' : s?.windows?.length ? ` · ${Math.round(maxPercent(a))}% usado` : '';
    items.push({ section: `${a.name} · ${s?.email ?? a.agentName}${state}${s?.loggedIn === false ? ' · sin sesión' : ''}` });
    for (const m of visibleModels(a)) items.push({ label: m.name, checked: a.id === rt?.selectedAccountId && m.id === rt?.selectedModel, help: m.detail ?? '', action: () => sendTo(hostId, Client.select(threadId, a.id, m.id)) });
  }
  if (rt?.defaultLimitPlan) items.push('-', { label: `Si se acaba la cuota: ${planSummary(hostId, rt.limitPlan ?? rt.defaultLimitPlan)}`, submenu: limitPlanItems(hostId, threadId, rt) });
  items.push('-', { label: 'Gestionar suscripciones…', action: () => sheets.openSettings('accounts', hostId) });
  showMenu(anchor, items);
}

function planSummary(hostId, plan) {
  if (!plan) return 'avisarme';
  if (plan.mode !== 'chain') return PLAN_SUMMARY[plan.mode] ?? plan.mode;
  if (!plan.targets?.length) return 'lista vacía';
  return plan.targets.map((t) => { const a = accountOf(hostId, t.accountId); return `${a?.name ?? '?'} · ${modelName(a, t.model)}`; }).join(', luego ');
}

function limitPlanItems(hostId, threadId, rt) {
  const own = rt.limitPlan;
  const set = (plan) => sendTo(hostId, Client.setLimitPlan(threadId, plan));
  const single = own?.mode === 'chain' && own.targets.length === 1 ? own.targets[0] : null;
  return [
    { label: `Como en Ajustes (${planSummary(hostId, rt.defaultLimitPlan)})`, checked: !own, action: () => set(null) },
    '-',
    { label: 'Pasar a la suscripción con más cuota', checked: own?.mode === 'mostQuota', action: () => set({ mode: 'mostQuota', targets: [] }) },
    { label: 'Pasar a…', submenu: (snap(hostId)?.accounts ?? []).flatMap((a) => [{ section: a.name }, ...visibleModels(a).map((m) => ({ label: m.name, checked: single?.accountId === a.id && single?.model === m.id, action: () => set({ mode: 'chain', targets: [{ accountId: a.id, model: m.id }] }) }))]) },
    { label: 'Varias, en orden…', checked: own?.mode === 'chain' && own.targets.length > 1, action: () => sheets.openLimitPlanEditor(hostId, threadId) },
    { label: 'Esperar a que se reinicie y seguir', checked: own?.mode === 'wait', action: () => set({ mode: 'wait', targets: [] }) },
    { label: 'Avisarme y decidir yo', checked: own?.mode === 'ask', action: () => set({ mode: 'ask', targets: [] }) },
  ];
}

function effortMenu(anchor) {
  const { hostId, threadId, thread } = current();
  const rt = thread?.runtime;
  const model = modelOf(accountOf(hostId, rt?.selectedAccountId), rt?.selectedModel);
  showMenu(anchor, [
    { section: 'Nivel de razonamiento' },
    { label: `Predeterminado${model?.defaultEffort ? ` (${effortName(model.defaultEffort)})` : ''}`, checked: !rt?.selectedEffort, action: () => sendTo(hostId, Client.setEffort(threadId, null)) },
    ...(model?.efforts ?? []).map((e) => ({ label: effortName(e), checked: rt?.selectedEffort === e, action: () => sendTo(hostId, Client.setEffort(threadId, e)) })),
  ]);
}

function modeMenu(anchor) {
  const { hostId, threadId, thread } = current();
  const cur = thread?.runtime?.mode;
  showMenu(anchor, MODES.map(([id, label, ic, help]) => ({ label, icon: cur === id ? null : ic, checked: cur === id, help, action: () => sendTo(hostId, Client.setMode(threadId, id)) })));
}

function relayMenu(anchor) {
  const { hostId, threadId } = current();
  const items = [{ section: 'Continuar la última petición con…' }];
  for (const a of snap(hostId)?.accounts ?? []) {
    let label = a.name;
    if (a.status?.windows?.length) label += ` — ${Math.round(maxPercent(a))}% usado`;
    if (a.status?.exhausted) label += ' (agotada)';
    if (a.status?.noPlan) label += ' (sin plan)';
    items.push({ label, submenu: visibleModels(a).map((m) => ({ label: m.name, action: () => sendTo(hostId, Client.relay(threadId, a.id, m.id)) })) });
  }
  showMenu(anchor, items, { alignRight: true });
}

function projectMenuItems(hostId, projectId, workPath) {
  const p = projectOf(hostId, projectId);
  if (!p) return [];
  const folder = workPath ?? p.path;
  const items = [];
  if (host(hostId)?.info.local) items.push({ label: 'Abrir en VS Code', action: () => { location.href = `vscode://file/${encodeURI(folder.replaceAll('\\', '/')).replace(/^\/?/, '/').replace(/^\/([A-Za-z]:)/, '$1')}`; } });
  items.push({ label: 'Copiar ruta', action: () => copyText(folder, 'Ruta copiada') });
  if (has(hostId, 'projects')) items.push('-', { label: 'Configurar memoria compartida (AGENTS.md)', action: async () => {
    const r = await request(hostId, { setupSharedMemory: { projectId } });
    toast(r.ok ? 'Memoria compartida lista: AGENTS.md (+ CLAUDE.md y GEMINI.md la importan)' : r.error);
  } });
  return items;
}

function projectContextMenu(x, y, hostId, projectId) {
  const p = projectOf(hostId, projectId);
  if (!p) return;
  const items = [{ label: 'Nuevo hilo', action: () => newThread(hostId, projectId) }];
  if (has(hostId, 'worktrees')) items.push({ label: 'Nuevo hilo en un worktree', action: () => newThread(hostId, projectId, true) });
  if (has(hostId, 'teams')) items.push({ label: 'Nuevo equipo de agentes…', action: () => sheets.openNewTeam(hostId, projectId) });
  items.push(...projectMenuItems(hostId, projectId));
  if (has(hostId, 'projects')) items.push('-', { label: 'Quitar de Relevo…', danger: true, action: async () => {
    const ok = await alertSheet({ title: `¿Quitar «${p.name}» de Relevo?`, message: 'La carpeta del proyecto no se toca; solo se eliminan los hilos guardados en Relevo.', buttons: [{ label: 'Quitar y borrar sus hilos', role: 'destructive' }, { label: 'Cancelar', role: 'cancel' }] });
    if (!ok) return;
    const r = await request(hostId, { removeProject: { projectId, deleteThreads: true } });
    if (!r.ok) toast(r.error);
    if (app.sel?.host === hostId && summaryOf(hostId, app.sel.thread)?.projectId === projectId) select(null, null);
  } });
  showMenu({ x, y }, items);
}

function threadContextMenu(x, y, hostId, threadId) {
  const t = summaryOf(hostId, threadId);
  if (!t) return;
  const hasUser = !!t.preview;
  showMenu({ x, y }, [
    { label: 'Renombrar…', disabled: !has(hostId, 'threads'), action: async () => {
      const title = await promptSheet({ title: 'Renombrar hilo', placeholder: 'Título', value: t.title });
      if (title) { const r = await request(hostId, { renameThread: { threadId, title } }); if (!r.ok) toast(r.error); }
    } },
    { label: 'Regenerar título con IA', disabled: !has(hostId, 'titles') || !hasUser, action: async () => {
      const r = await request(hostId, { regenerateTitle: { threadId } });
      if (!r.ok) toast(r.error);
    } },
    '-',
    { label: 'Eliminar hilo', danger: true, disabled: !has(hostId, 'threads'), action: async () => {
      const r = await request(hostId, { deleteThread: { threadId } });
      if (!r.ok) { toast(r.error); return; }
      if (app.sel?.thread === threadId) select(null, null);
    } },
  ]);
}

// MARK: - Menu bar (Commands)

function menubarMenu(name, anchor) {
  const { hostId, threadId, summary } = current();
  const project = summary && projectOf(hostId, summary.projectId);
  const menus = {
    app: [
      { label: 'Acerca de Relevo', action: () => toast(`Relevo ${app.update?.current ?? ''}`) },
      '-',
      { label: 'Ajustes…', shortcut: 'Ctrl+,', action: () => sheets.openSettings() },
      { label: 'Buscar actualizaciones…', action: () => sheets.openSettings('updates') },
    ],
    file: [
      { label: 'Nuevo hilo', shortcut: 'Ctrl+N', action: () => newThread() },
      { label: 'Nuevo hilo en un worktree', shortcut: 'Ctrl+Alt+N', action: () => { const t = targetProject(); if (t) newThread(t.hostId, t.projectId, true); } },
      { label: 'Nuevo equipo de agentes…', shortcut: 'Ctrl+Alt+E', action: () => { const t = targetProject(); if (t) sheets.openNewTeam(t.hostId, t.projectId); else sheets.openNewProject(); } },
      { label: 'Añadir proyecto…', shortcut: 'Ctrl+O', action: () => sheets.openNewProject() },
    ],
    agents: [
      { label: 'Actualizar límites', shortcut: 'Ctrl+Mayús+R', action: refreshAll },
      { label: 'Consumo de tokens…', shortcut: 'Ctrl+Alt+U', action: () => sheets.openUsage() },
      { label: 'Mostrar consumo de cada mensaje', checked: app.showTurnUsage, action: () => { app.showTurnUsage = !app.showTurnUsage; save('showTurnUsage', app.showTurnUsage); renderThreadSafe(); } },
      '-',
      { label: 'Detener agente', shortcut: 'Ctrl+.', disabled: !current().thread?.runtime?.isRunning, action: () => sendTo(hostId, Client.stop(threadId)) },
    ],
    actions: project?.quickActions?.length
      ? project.quickActions.slice(0, 9).map((qa, i) => ({ label: qa.name, shortcut: `Ctrl+${i + 1}`, action: () => sheets.runQuickAction(hostId, threadId, qa) }))
      : [{ info: 'Este proyecto no tiene acciones' }],
    view: [
      { label: app.sidebarHidden ? 'Mostrar barra lateral' : 'Ocultar barra lateral', shortcut: 'Ctrl+Mayús+S', action: toggleSidebar },
      { label: app.showTools ? 'Agrupar acciones' : 'Ver cada acción', shortcut: 'Ctrl+Alt+T', action: toggleTools },
    ],
  };
  showMenu(anchor, menus[name]);
}

function refreshAll() { for (const id of app.hosts.keys()) sendTo(id, Client.refreshUsage()); }
function renderThreadSafe() { if (T) { T.cache = new Map(); T.rows.innerHTML = ''; renderThread(); } }
function toggleTools() {
  app.showTools = !app.showTools;
  save('showTools', app.showTools);
  toast(app.showTools ? 'Mostrando cada acción del agente' : 'Acciones del agente agrupadas');
  renderThreadSafe();
}
function toggleSidebar() { app.sidebarHidden = !app.sidebarHidden; save('sidebarHidden', app.sidebarHidden); renderSidebar(); }

// MARK: - Events

const commands = {
  applyUpdate: () => sheets.confirmUpdate(),
  restartNow: async () => {
    const busy = app.update?.pendingRestart?.busy ?? 0;
    const ok = await alertSheet({ title: '¿Reiniciar ahora?', message: busy ? `${busy === 1 ? 'El agente que está trabajando se interrumpe' : `Los ${busy} agentes que están trabajando se interrumpen`} (el hilo y su sesión se conservan: luego basta con decirle que siga).` : 'El servicio se reinicia con la versión nueva.', buttons: [{ label: 'Reiniciar ahora', role: 'destructive' }, { label: 'Esperar', role: 'cancel' }] });
    if (ok) post({ type: 'restartNow' });
  },
  newThread: () => newThread(),
  addProject: () => sheets.openNewProject(),
  pairWelcome: () => {
    const link = $('#welcome-link')?.value.trim();
    if (!/^relevocompanion:\/\/pair\?/.test(link ?? '')) { toast('Pega un enlace relevocompanion://pair?…'); return; }
    post({ type: 'pair', link });
    toast('Conectando…');
  },
  usage: () => sheets.openUsage(),
  refreshAll,
  settings: () => sheets.openSettings(),
  toggleSidebar,
  toggleTools,
  traza: () => { const { hostId, threadId } = current(); sheets.openTraza(hostId, threadId); },
  threadUsage: (el) => { const { hostId, threadId } = current(); sheets.threadUsagePopover(el, hostId, threadId); },
  gitMenu: (el) => { const { hostId, threadId } = current(); sheets.gitMenu(el, hostId, threadId); },
  actionsMenu: (el) => { const { hostId, threadId } = current(); sheets.actionsMenu(el, hostId, threadId); },
  compare: () => { const { hostId, threadId } = current(); sheets.openCompare(hostId, threadId, T?.draft.value ?? ''); },
  relayMenu: (el) => relayMenu(el),
  projectMenu: (el) => { const { hostId, summary, thread } = current(); showMenu(el, projectMenuItems(hostId, summary?.projectId, thread?.worktree?.path), { alignRight: true }); },
  modelMenu: (el) => modelMenu(el),
  effortMenu: (el) => effortMenu(el),
  modeMenu: (el) => modeMenu(el),
  send: () => sendDraft(false),
  sendNow: () => sendDraft(true),
  stop: () => { const { hostId, threadId } = current(); sendTo(hostId, Client.stop(threadId)); },
  resumeQueue: () => { const { hostId, threadId } = current(); sendTo(hostId, Client.resumeQueue(threadId)); },
  loadOlder: async () => {
    const { hostId, threadId, thread } = current();
    const key = `${hostId}/${threadId}`;
    const older = app.older.get(key) ?? [];
    const r = await request(hostId, { loadOlder: { threadId, have: older.length + (thread?.items.length ?? 0) } });
    if (!r.ok) { toast(r.error); return; }
    app.older.set(key, [...r.items, ...older]);
    T.stick = false;
    renderThread();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('button, [data-menu]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  const { hostId, threadId, thread } = current();
  if (d.menu) { menubarMenu(d.menu, el); return; }
  if (d.cmd && commands[d.cmd]) { commands[d.cmd](el); return; }
  if (d.thread) { select(d.host, d.thread); return; }
  if (d.toggleProject) {
    if (!app.collapsedProjects.delete(d.toggleProject)) app.collapsedProjects.add(d.toggleProject);
    save('collapsedProjects2', [...app.collapsedProjects]);
    renderSidebar();
    return;
  }
  if (d.newIn) { newThread(d.host, d.newIn); return; }
  if (d.accountPop) { accountPopover(el, d.host, d.accountPop); return; }
  if (d.toggleItem) {
    if (!app.expandedItems.delete(d.toggleItem)) app.expandedItems.add(d.toggleItem);
    T.stick = false;
    renderTranscript();
    return;
  }
  if (d.teamGo) { select(hostId, d.teamGo); return; }
  if (d.teamAct) {
    const teamId = summaryOf(hostId, threadId)?.team?.id;
    if (teamId) request(hostId, { teamAction: { teamId, action: d.teamAct } }).then((r) => { if (!r.ok) toast(r.error); });
    return;
  }
  if (d.teamMenu !== undefined) { teamMenu(el); return; }
  if (d.approve) { sendTo(hostId, Client.approve(threadId, d.approve, d.option)); return; }
  if (d.qOpt) {
    const it = thread?.items.find((i) => i.id === d.qOpt);
    const st = qState.get(d.qOpt);
    const qi = Number(d.qi), oi = Number(d.oi);
    if (!it || !st) return;
    if (it.questions[qi].multiSelect) { if (!st.picked[qi].delete(oi)) st.picked[qi].add(oi); } else st.picked[qi] = new Set([oi]);
    T.cache.get(d.qOpt)?.el.remove(); T.cache.delete(d.qOpt);
    renderTranscript();
    return;
  }
  if (d.qSend) {
    const it = thread?.items.find((i) => i.id === d.qSend);
    const st = qState.get(d.qSend);
    const answers = {};
    it.questions.forEach((q, qi) => {
      const a = st.other[qi].trim() || [...st.picked[qi]].sort().map((oi) => q.options[oi].label).join(', ');
      if (a) answers[q.question] = a;
    });
    sendTo(hostId, Client.answer(threadId, it.id, answers));
    return;
  }
  if (d.qSkip) { sendTo(hostId, Client.answer(threadId, d.qSkip, {})); return; }
  if (d.relay) { sendTo(hostId, Client.relay(threadId, d.relay, d.model)); return; }
  if (d.limitAction) { sendTo(hostId, Client.limitAction(threadId, d.limitAction)); return; }
  if (d.limitDismiss !== undefined) { sendTo(hostId, Client.limitAction(threadId, thread?.runtime?.resumeAt ? 'cancelResume' : 'cancelRelay')); return; }
  if (d.suggestion) { sendTo(hostId, Client.suggestion(threadId, d.suggestion)); return; }
  if (d.queuedNow) { sendTo(hostId, Client.sendQueuedNow(threadId, d.queuedNow)); return; }
  if (d.dequeue) { sendTo(hostId, Client.dequeue(threadId, d.dequeue)); return; }
  if (d.removeAttachment) { attachments.splice(Number(d.removeAttachment), 1); renderAttachments(); return; }
  if (d.turnUsage) { sheets.turnUsagePopover(el, JSON.parse(d.turnUsage)); return; }
  if (d.turnChanges) { sheets.openTurnDiff(hostId, threadId, d.turnChanges); return; }
  if (d.redoTree) { request(hostId, { restoreTree: { threadId, tree: d.redoTree } }).then((r) => { if (!r.ok) toast(r.error); }); return; }
  if (d.image) { sheets.imageViewer(hostId, threadId, d.image); return; }
  if (d.copyCode !== undefined) { copyText(el.closest('pre').querySelector('code').textContent, 'Copiado'); return; }
});

document.addEventListener('input', (e) => {
  const d = e.target.dataset;
  if (d.qOther) {
    const st = qState.get(d.qOther);
    if (st) st.other[Number(d.qi)] = e.target.value;
    const btn = e.target.closest('.question')?.querySelector('[data-q-send]');
    const { thread } = current();
    const it = thread?.items.find((i) => i.id === d.qOther);
    if (btn && it) btn.disabled = !it.questions.every((q, qi) => st.other[qi].trim() || st.picked[qi].size);
  }
});

document.addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('.thread-row');
  if (tr) { e.preventDefault(); threadContextMenu(e.clientX, e.clientY, tr.dataset.host, tr.dataset.thread); return; }
  const pr = e.target.closest('.proj-row');
  if (pr) { e.preventDefault(); projectContextMenu(e.clientX, e.clientY, pr.dataset.host, pr.dataset.project); return; }
  const th = e.target.closest('.thumb');
  if (th) {
    e.preventDefault();
    const { hostId, threadId } = current();
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'Abrir', action: () => sheets.imageViewer(hostId, threadId, th.dataset.image) },
      { label: 'Copiar imagen', action: async () => sheets.copyImage(await imageData(hostId, threadId, th.dataset.image, 2400)) },
      { label: 'Copiar ruta', action: () => copyText(th.dataset.image, 'Ruta copiada') },
    ]);
  }
});

// An image pasted anywhere in the window goes to the open thread's message.
document.addEventListener('paste', (e) => {
  if (!T || e.target === T.draft || e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  attach(files);
  T.draft.focus();
});

// Keyboard shortcuts (⌘ on the Mac → Ctrl here, ⌥ → Alt).
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const k = e.key.toLowerCase();
  const { hostId, threadId, thread, summary } = current();
  const run = (fn) => { e.preventDefault(); closeMenus(); fn(); };
  if (k === 'e' && e.altKey) return run(() => { const t = targetProject(); if (t) sheets.openNewTeam(t.hostId, t.projectId); });
  if (k === 'n' && e.altKey) return run(() => { const t = targetProject(); if (t) newThread(t.hostId, t.projectId, true); });
  if (k === 'n') return run(() => newThread());
  if (k === 'o') return run(() => sheets.openNewProject());
  if (k === 'r' && e.shiftKey) return run(refreshAll);
  if (k === 'u' && e.altKey) return run(() => sheets.openUsage());
  if (k === 'u' && e.shiftKey && thread?.runtime?.suggestion) return run(() => sendTo(hostId, Client.suggestion(threadId, 'accept')));
  if (k === 't' && e.altKey) return run(toggleTools);
  if (k === 's' && e.shiftKey) return run(toggleSidebar);
  if (k === ',') return run(() => sheets.openSettings());
  if (k === '.' && thread?.runtime?.isRunning) return run(() => sendTo(hostId, Client.stop(threadId)));
  if (k === 'enter' && document.activeElement !== T?.draft) {
    const pending = thread?.items.find((i) => i.kind === 'approval' && !i.resolution && !i.questions?.length);
    const allow = pending?.options?.find((o) => o.isAllow);
    if (allow) return run(() => sendTo(hostId, Client.approve(threadId, pending.id, allow.id)));
  }
  if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
    const qa = projectOf(hostId, summary?.projectId)?.quickActions?.[Number(e.key) - 1];
    if (qa) return run(() => sheets.runQuickAction(hostId, threadId, qa));
  }
});

// Sidebar resizing (min 240, max 380).
(() => {
  const handle = $('#resizer');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => { app.sidebarWidth = Math.max(240, Math.min(380, ev.clientX)); $('#sidebar').style.width = `${app.sidebarWidth}px`; };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); save('sidebarWidth', app.sidebarWidth); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
})();

// MARK: - Notifications (when the window isn't in front)

function notifyChanges(hostId) {
  for (const t of snap(hostId)?.threads ?? []) {
    const key = `${hostId}/${t.id}`;
    const prev = app.notified.get(key);
    app.notified.set(key, { running: t.isRunning, approval: t.needsApproval });
    if (!prev || (!document.hidden && document.hasFocus())) continue;
    if (!prev.approval && t.needsApproval) notify(hostId, t, `Aprobación pendiente · ${t.title}`, t.title);
    else if (prev.running && !t.isRunning && !t.needsApproval) notify(hostId, t, t.title, (t.preview ?? '').slice(0, 140));
  }
}
function notify(hostId, t, title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, icon: 'icon.png', tag: `${hostId}/${t.id}` });
  n.onclick = () => { window.focus(); select(hostId, t.id); n.close(); };
}
document.addEventListener('click', () => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }, { once: true });

// The relay countdown and relative times move on their own.
setInterval(() => { if (current().thread?.runtime?.pendingRelay) { T.sig.banner = null; renderBanner(); } }, 1000);
setInterval(() => renderSidebar(), 60_000);

connect();
render();
