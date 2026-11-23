// The Mac app's other windows and sheets: Ajustes (Suscripciones, General, iPhone, Integraciones), Consumo,
// DiffSheet, CommitSheet and the Git menu, quick actions, «Varios agentes», Traza, Añadir proyecto, the
// out-of-quota plan editor, sign-in, and the image viewer.

import { esc, markdown } from './markdown.mjs';
import { icon, badge } from './icons.mjs';
import { showMenu, openPopover, closePopover, openSheet, alertSheet, toast, chooseFolder, linkify } from './kit.mjs';
import {
  app, hooks, post, sendTo, request, requester, createThread, Client, uuid, host, snap, nameOf, has, accountOf, modelOf, modelName, visibleModels,
  maxPercent, threadOf, summaryOf, projectOf, shortTokens, usd, pct, grouped, reset, relative, effortName, MODES, chartColor, providerOf, copyText,
} from './core.mjs';
import { usageBar, statusLabel, imageData, running } from './widgets.mjs';

let main = { select() {}, render() {} };
export function bind(fns) { main = fns; }

const hostsWith = (feature) => [...app.hosts.entries()].filter(([id]) => has(id, feature));
const hostSelect = (list, current, attr) => (list.length > 1
  ? `<select class="field" ${attr}>${list.map(([id, h]) => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(nameOf(h))}</option>`).join('')}</select>` : '');

// MARK: - Añadir proyecto (NewProjectSheet)

export function openNewProject() {
  const hosts = hostsWith('projects');
  if (!hosts.length) { toast('Ningún host conectado permite añadir proyectos desde aquí'); return; }
  let hostId = main.currentHost?.() ?? hosts[0][0];
  if (!hosts.some(([id]) => id === hostId)) hostId = hosts[0][0];
  let mode = 0;
  const s = openSheet({ width: 520, body: '' });
  const draw = () => {
    const root = snap(hostId)?.hostSettings?.projectsRoot ?? '';
    s.el.innerHTML = `<div class="sheet-title">Añadir proyecto</div>
      ${hosts.length > 1 ? `<div class="form-row" style="padding:0">En ${hostSelect(hosts, hostId, 'data-host-sel')}</div>` : ''}
      <div class="seg"><button class="${mode === 0 ? 'on' : ''}" data-mode="0">Abrir carpeta existente</button><button class="${mode === 1 ? 'on' : ''}" data-mode="1">Crear proyecto nuevo</button></div>
      ${mode === 0 ? `<div class="sheet-sub">Elige la carpeta del proyecto. Los agentes trabajarán dentro de ella.</div>
        <label class="form-row" style="padding:0"><input type="checkbox" class="check" data-agents checked> Configurar memoria compartida (AGENTS.md) si no existe</label>`
      : `<div class="form-group">
          <div class="form-row"><span style="width:80px">Nombre</span><input class="field-input grow" data-name placeholder="mi-proyecto"></div>
          <div class="form-row"><span style="width:80px">Ubicación</span><input class="field-input grow mono" data-loc value="${esc(root)}"><button class="btn" data-pick-loc>Elegir…</button></div>
          <div class="form-row"><label><input type="checkbox" class="check" data-git checked> Inicializar repositorio git</label></div>
          <div class="form-row"><label><input type="checkbox" class="check" data-agents checked> Memoria compartida para todos los agentes (AGENTS.md)</label></div></div>`}
      <div class="caption red" data-err></div>
      <div class="sheet-buttons"><span class="grow"></span><button class="btn" data-no>Cancelar</button>
        <button class="btn primary" data-yes>${mode === 0 ? 'Elegir carpeta…' : 'Crear'}</button></div>`;
    const $ = (q) => s.el.querySelector(q);
    s.el.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { mode = Number(b.dataset.mode); draw(); }; });
    $('[data-host-sel]')?.addEventListener('change', (e) => { hostId = e.target.value; draw(); });
    $('[data-no]').onclick = s.close;
    $('[data-pick-loc]')?.addEventListener('click', async () => {
      const p = await chooseFolder({ title: 'Ubicación', start: $('[data-loc]').value, request: requester(hostId) });
      if (p) $('[data-loc]').value = p;
    });
    $('[data-yes]').onclick = async () => {
      let r;
      if (mode === 0) {
        const path = await chooseFolder({ title: 'Elegir la carpeta del proyecto', request: requester(hostId), confirm: 'Elegir' });
        if (!path) return;
        r = await request(hostId, { addProject: { path } });
      } else {
        const name = $('[data-name]').value.trim();
        if (!name) { $('[data-err]').textContent = 'Ponle un nombre'; return; }
        r = await request(hostId, { createProject: { name, git: $('[data-git]').checked, location: $('[data-loc]').value.trim() } });
      }
      if (!r.ok) { $('[data-err]').textContent = r.error; return; }
      if ($('[data-agents]')?.checked) await request(hostId, { setupSharedMemory: { projectId: r.projectId } });
      s.close();
      const id = await createThread(hostId, r.projectId);
      if (id) main.select(hostId, id);
    };
  };
  draw();
}

// MARK: - Ajustes

const TABS = [['accounts', 'Suscripciones', 'person.2.crop.square.stack'], ['general', 'General', 'gearshape'], ['iphone', 'iPhone', 'iphone.gen3'], ['integrations', 'Integraciones', 'puzzlepiece.extension']];
let settingsOpen = null;
// The update check answers when GitHub does (seconds, on a slow line): the panel shows it as it arrives.
hooks.onUpdate = () => { if (settingsOpen?.tab?.() === 'integrations') settingsOpen.redraw(); };

export function openSettings(tab = 'accounts', hostId) {
  if (tab === 'updates') tab = 'integrations';
  settingsOpen?.close();
  const hosts = hostsWith('settings');
  const state = { tab, hostId: hostId ?? main.currentHost?.() ?? hosts[0]?.[0], account: null };
  if (!hosts.some(([id]) => id === state.hostId)) state.hostId = hosts[0]?.[0];
  const s = openSheet({ className: 'settings-win', width: 680, focus: false, onClose: () => { settingsOpen = null; } });
  settingsOpen = s;
  s.tab = () => state.tab;
  const draw = () => {
    // The refresh keeps where you were scrolled in the subscription's details.
    const scrolled = s.el.querySelector('.acct-detail')?.scrollTop ?? 0;
    const wasAccount = state.account;
    const title = TABS.find((t) => t[0] === state.tab)[1];
    s.el.innerHTML = `<div class="settings-tabs"><button class="close" data-close title="Cerrar"></button><div class="wt">${esc(title)}</div>${TABS.map(([id, label, ic]) => `<button class="tab${id === state.tab ? ' on' : ''}" data-tab="${id}">${icon(ic, { size: 26 })}<span>${label}</span></button>`).join('')}</div><div class="settings-body" data-body></div>`;
    s.el.querySelector('[data-close]').onclick = s.close;
    s.el.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { state.tab = b.dataset.tab; draw(); }; });
    const body = s.el.querySelector('[data-body]');
    if (state.tab === 'accounts') {
      drawAccounts(body, state, draw);
      const detail = body.querySelector('.acct-detail');
      if (detail && state.account === wasAccount) detail.scrollTop = scrolled;
    } else if (state.tab === 'general') drawGeneral(body, state, draw);
    else if (state.tab === 'iphone') drawIPhone(body);
    else drawIntegrations(body);
  };
  s.redraw = draw;
  draw();
  // Live updates (statuses, new accounts) while open, without losing what's being typed.
  const tick = setInterval(() => {
    if (!settingsOpen) { clearInterval(tick); return; }
    const focused = s.el.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!focused && state.tab === 'accounts') draw();
  }, 3000);
}

function hostPickerHTML(state) {
  const hosts = hostsWith('settings');
  return hosts.length > 1 ? `<div class="form-row" style="padding:0 0 12px">Host ${hostSelect(hosts, state.hostId, 'data-settings-host')}</div>` : '';
}
function bindHostPicker(root, state, redraw) {
  root.querySelector('[data-settings-host]')?.addEventListener('change', (e) => { state.hostId = e.target.value; state.account = null; redraw(); });
}

const HELP = {
  claude: 'Abre el enlace de <code>claude auth login</code> (OAuth de tu suscripción Claude Pro/Max/Team) y pega el código que te muestra.',
  codex: 'Abre el login de ChatGPT (plan Plus/Pro/Team) a través de Codex, con un código de dispositivo.',
  gemini: 'Inicia sesión en Antigravity CLI (<code>agy</code>) con tu cuenta de Google: abre el enlace que muestra.',
};

function drawAccounts(body, state, redraw) {
  const hostId = state.hostId;
  if (!hostId) { body.innerHTML = '<div class="center">Ningún host conectado se puede configurar desde aquí.</div>'; return; }
  const sn = snap(hostId);
  const accounts = sn?.accounts ?? [];
  const defs = sn?.hostSettings?.accounts ?? [];
  if (!state.account || !accounts.some((a) => a.id === state.account)) state.account = accounts[0]?.id ?? null;
  body.className = 'settings-body split';
  const statusIc = (a) => (a.status?.loggedIn === false ? `<span class="st warn">${icon('exclamationmark.circle.fill', { size: 15 })}</span>` : a.status?.loggedIn ? `<span class="st ok">${icon('checkmark.circle.fill', { size: 15 })}</span>` : `<span class="st off">${icon('pause.circle', { size: 15 })}</span>`);
  body.innerHTML = `<div class="acct-list">${hostPickerHTML(state) ? `<div style="padding:10px 10px 0">${hostPickerHTML(state)}</div>` : ''}<div class="items">${accounts.map((a) => `<button class="acct-item${a.id === state.account ? ' on' : ''}" data-acc="${esc(a.id)}">${badge(a, 18)}<div class="grow"><div class="nm">${esc(a.name)}</div><div class="em">${esc(a.status?.email ?? a.agentName)}</div></div>${statusIc(a)}</button>`).join('')}</div>
    <div class="bottom"><button class="tb-btn" data-add-acc title="Añadir proveedor">${icon('plus', { size: 13 })}</button><button class="tb-btn" data-del-acc${state.account ? '' : ' disabled'}>${icon('minus', { size: 13 })}</button><span class="grow"></span><button class="btn link small" data-detect>Detectar CLIs</button></div></div>
    <div class="acct-detail" data-detail></div>`;
  bindHostPicker(body, state, redraw);
  body.querySelectorAll('[data-acc]').forEach((b) => { b.onclick = () => { state.account = b.dataset.acc; redraw(); }; });
  body.querySelector('[data-detect]').onclick = () => { sendTo(hostId, Client.refreshUsage()); toast('Comprobando las suscripciones…'); };
  body.querySelector('[data-add-acc]').onclick = (e) => addAccountMenu(e.currentTarget, hostId, state, redraw);
  body.querySelector('[data-del-acc]').onclick = async () => {
    const a = accountOf(hostId, state.account);
    if (!a) return;
    const ok = await alertSheet({ title: `¿Quitar ${a.name}?`, message: 'Deja de usarse en este host; los hilos que la usaban pasan a otra. Su carpeta de sesión se conserva.', buttons: [{ label: 'Quitar', role: 'destructive' }, { label: 'Cancelar', role: 'cancel' }] });
    if (!ok) return;
    const r = await request(hostId, { removeAccount: { accountId: a.id } });
    if (!r.ok) toast(r.error);
    state.account = null;
    setTimeout(redraw, 400);
  };
  const detail = body.querySelector('[data-detail]');
  const a = accountOf(hostId, state.account);
  if (!a) {
    detail.innerHTML = '<div class="center"><div>Elige una suscripción</div><div class="caption" style="max-width:300px;text-align:center">Relevo usa el login oficial de cada CLI: Claude Code, Codex y Antigravity. También APIs de pago por uso como DeepSeek.</div></div>';
    return;
  }
  const def = defs.find((d) => d.id === a.id) ?? {};
  const s = a.status ?? {};
  const isAPI = !!a.usesAPIKey;
  const kind = a.kind.split(':')[0];
  const cliKey = { claude: 'claude', api: 'claude', codex: 'codex', antigravity: 'antigravity' }[def.type] ?? null;
  const cliName = { claude: 'claude', codex: 'codex', antigravity: 'agy' }[cliKey];
  const custom = sn.hostSettings?.cliPaths?.[cliKey] ?? '';
  const found = cliKey ? sn.hostCLIs?.[cliKey] ?? null : null;
  const canLogin = has(hostId, 'login') && !isAPI && (def.type !== 'acp' || sn.hostProviders?.acp.find((p) => p.id === def.preset)?.login);
  detail.innerHTML = `
    <div class="form-group"><div class="form-row">${badge(a, 30)}<div class="l"><div style="font-weight:700">${esc(a.agentName)}</div>${statusLabel(a)}</div></div></div>
    ${isAPI ? `<div class="form-section">API key</div><div class="form-group"><div class="form-row"><input type="password" class="field-input grow" data-key placeholder="${def.hasKey ? 'Guardada en el host (pega otra para cambiarla)' : 'sk-…'}" autocomplete="off"><button class="btn" data-save-key>Guardar</button></div>
      <div class="form-row"><div class="caption">La clave solo se guarda en el host y solo se envía a la API oficial de ${esc(a.name)}.</div></div></div>` : ''}
    <div class="form-section">${isAPI ? 'Cuenta' : 'Sesión'}</div>
    <div class="form-group"><div class="form-row">${canLogin ? `<button class="btn" data-login>${icon('person.badge.key', { size: 13 })} ${s.loggedIn === false ? 'Iniciar sesión' : 'Volver a iniciar sesión'}</button>` : ''}<button class="btn" data-check>${icon('arrow.clockwise', { size: 12 })} Comprobar</button></div>
      ${HELP[kind] ? `<div class="form-row"><div class="caption">${HELP[kind]}</div></div>` : ''}
      ${(s.windows ?? []).map((w) => `<div class="form-row">${usageBar(w, true)}</div>`).join('')}
      ${s.note ? `<div class="form-row"><div class="caption">${esc(s.note)}</div></div>` : ''}${s.error ? `<div class="form-row"><div class="caption orange">${esc(s.error)}</div></div>` : ''}</div>
    <div class="form-section">Modelos</div>
    <div class="form-group">${a.models.filter((m) => m.id !== 'default').length ? a.models.map((m) => `<div class="form-row"><label style="display:flex;gap:8px;align-items:center;min-width:0"><input type="checkbox" class="check" data-model="${esc(m.id)}"${m.hidden ? '' : ' checked'}${m.id === 'default' ? ' disabled' : ''}> <span>${esc(m.name)}</span>${m.detail ? `<span class="caption" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.detail)}</span>` : ''}</label></div>`).join('') : '<div class="form-row caption">Esta suscripción aún no ha dado su lista de modelos.</div>'}
      <div class="form-row"><span class="caption grow">${s.updatedAt ? `Lista del proveedor comprobada ${esc(relative(s.updatedAt))}` : 'Aún no se ha comprobado en esta sesión'}</span><button class="btn small" data-check>Actualizar lista</button></div></div>
    <div class="caption" style="margin:6px 12px 0">Los que desmarques no salen en el menú del modelo del hilo, ni en relevos, comparaciones o sugerencias. Los hilos que ya usan uno lo conservan.</div>
    <div class="form-section">Configuración</div>
    <div class="form-group"><div class="form-row"><span style="width:120px">Nombre</span><input class="field-input grow" data-f="name" value="${esc(a.name)}"></div>
      ${def.type === 'api' && def.preset === 'custom' ? `<div class="form-row"><span style="width:120px">URL de la API</span><input class="field-input grow mono" data-f="baseURL" value="${esc(def.baseURL ?? '')}"></div><div class="form-row"><span style="width:120px">Modelos</span><input class="field-input grow mono" data-f="models" value="${esc((def.models ?? []).join(', '))}"></div>` : ''}
      ${def.type === 'acp' && def.preset === 'custom' ? `<div class="form-row"><span style="width:120px">Ruta del ejecutable</span><input class="field-input grow mono" data-f="command" value="${esc(def.command ?? '')}"></div><div class="form-row"><span style="width:120px">Argumentos ACP</span><input class="field-input grow mono" data-f="args" value="${esc((def.args ?? []).join(' '))}"></div>` : ''}
      <div class="form-row"><span class="grow"></span><button class="btn" data-save-cfg>Guardar cambios</button></div></div>
    ${cliKey ? `<div class="form-section">Programa</div>
    <div class="form-group"><div class="form-row"><input class="field-input grow mono" data-cli placeholder="${found ? esc(found) : `Ruta a ${cliName}${sn.hostPlatform === 'win32' ? '.exe' : ''}`}" value="${esc(custom)}"><button class="btn" data-save-cli>Guardar</button></div>
      <div class="form-row"><div class="caption${found ? '' : ' orange'}">${found ? `${custom ? 'Ruta indicada' : 'Encontrado'}: ${esc(found)}. Déjalo vacío para buscarlo solo.` : `No encuentro «${cliName}» en ${esc(sn.macName ?? 'el host')}. ${sn.hostPlatform === 'win32' ? `En PowerShell, <span class="mono">(Get-Command ${cliName}).Source</span> te dice dónde está: pega aquí esa ruta.` : `En una terminal, <span class="mono">which ${cliName}</span> te dice dónde está: pega aquí esa ruta.`}`}</div></div></div>` : ''}`;
  const $ = (q) => detail.querySelector(q);
  $('[data-save-cli]')?.addEventListener('click', async () => {
    const r = await request(hostId, { setSettings: { settings: { cliPaths: { [cliKey]: $('[data-cli]').value } } } });
    toast(r.ok ? 'Guardado: comprobando la suscripción…' : r.error);
    if (r.ok) setTimeout(redraw, 1500);
  });
  detail.querySelectorAll('[data-check]').forEach((b) => { b.onclick = () => { sendTo(hostId, Client.refreshUsage()); toast('Comprobando…'); }; });
  $('[data-login]')?.addEventListener('click', () => openLogin(hostId, a.id));
  $('[data-save-key]')?.addEventListener('click', async () => {
    const key = $('[data-key]').value.trim();
    if (!key) return;
    const r = await request(hostId, { updateAccount: { accountId: a.id, account: { apiKey: key } } });
    toast(r.ok ? 'API key guardada' : r.error);
  });
  detail.querySelectorAll('[data-model]').forEach((c) => {
    c.onchange = async () => {
      const hiddenModels = [...detail.querySelectorAll('[data-model]')].filter((x) => !x.checked).map((x) => x.dataset.model);
      if (hiddenModels.length >= a.models.length - 1 && !c.checked) { c.checked = true; toast('Deja al menos un modelo visible'); return; }
      const r = await request(hostId, { updateAccount: { accountId: a.id, account: { hiddenModels } } });
      if (!r.ok) toast(r.error);
    };
  });
  $('[data-save-cfg]').onclick = async () => {
    const account = {};
    detail.querySelectorAll('[data-f]').forEach((i) => { account[i.dataset.f] = i.value; });
    const r = await request(hostId, { updateAccount: { accountId: a.id, account } });
    toast(r.ok ? 'Cambios guardados' : r.error);
  };
}

function addAccountMenu(anchor, hostId, state, redraw) {
  const prov = snap(hostId)?.hostProviders ?? { api: [], acp: [] };
  const add = async (account) => {
    let apiKey;
    if (account.type === 'api' && account.preset !== 'custom') {
      apiKey = await new Promise((resolve) => {
        const s = openSheet({ width: 420, body: `<div class="sheet-title">${esc(prov.api.find((p) => p.id === account.preset)?.name ?? 'API')}</div>
          <div class="sheet-sub">Pega tu API key. Se guarda en el host y solo se envía a la API oficial del proveedor.${prov.api.find((p) => p.id === account.preset)?.keyURL ? ` <a href="${esc(prov.api.find((p) => p.id === account.preset).keyURL)}" target="_blank" rel="noopener">Crear una API key</a>` : ''}</div>
          <input type="password" class="field-input" data-key placeholder="sk-…" autofocus>
          <div class="sheet-buttons"><span class="grow"></span><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>Añadir</button></div>`, onClose: () => resolve(null) });
        s.el.querySelector('[data-no]').onclick = () => s.close();
        s.el.querySelector('[data-yes]').onclick = () => { const v = s.el.querySelector('[data-key]').value.trim(); resolve(v || null); s.close(); };
      });
      if (!apiKey) return;
    }
    if (account.preset === 'custom') {
      const ok = await new Promise((resolve) => {
        const api = account.type === 'api';
        const s = openSheet({ width: 480, body: `<div class="sheet-title">${api ? 'API compatible con Anthropic' : 'Agente ACP'}</div>
          <div class="form-group">${api ? '<div class="form-row"><span style="width:110px">URL</span><input class="field-input grow mono" data-baseurl placeholder="https://…/anthropic"></div><div class="form-row"><span style="width:110px">API key</span><input type="password" class="field-input grow" data-key></div><div class="form-row"><span style="width:110px">Modelos</span><input class="field-input grow mono" data-models placeholder="modelo-1, modelo-2"></div>'
            : '<div class="form-row"><span style="width:110px">Comando</span><input class="field-input grow mono" data-cmd placeholder="ruta al ejecutable"></div><div class="form-row"><span style="width:110px">Argumentos</span><input class="field-input grow mono" data-args placeholder="--acp"></div>'}</div>
          <div class="sheet-buttons"><span class="grow"></span><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>Añadir</button></div>`, onClose: () => resolve(false) });
        const $ = (q) => s.el.querySelector(q);
        $('[data-no]').onclick = () => s.close();
        $('[data-yes]').onclick = () => {
          if (api) Object.assign(account, { baseURL: $('[data-baseurl]').value, apiKey: $('[data-key]').value, models: $('[data-models]').value });
          else Object.assign(account, { command: $('[data-cmd]').value, args: $('[data-args]').value });
          resolve(true); s.close();
        };
      });
      if (!ok) return;
    }
    const r = await request(hostId, { addAccount: { account: { ...account, ...(apiKey ? { apiKey } : {}) } } });
    if (!r.ok) { toast(r.error); return; }
    state.account = r.accountId;
    setTimeout(redraw, 500);
  };
  showMenu(anchor, [
    { label: 'Claude', action: () => add({ type: 'claude' }) },
    { label: 'ChatGPT · Codex', action: () => add({ type: 'codex' }) },
    { label: 'Gemini (Antigravity)', action: () => add({ type: 'antigravity' }) },
    '-',
    ...prov.api.map((p) => ({ label: p.id === 'custom' ? 'Otra API compatible con Anthropic…' : `${p.name} (API)`, action: () => add({ type: 'api', preset: p.id }) })),
    '-',
    ...prov.acp.map((p) => ({ label: p.id === 'custom' ? 'Otro agente ACP…' : p.name, action: () => add({ type: 'acp', preset: p.id }) })),
  ]);
}

function drawGeneral(body, state, redraw) {
  const hostId = state.hostId;
  const sn = snap(hostId);
  if (!sn) { body.innerHTML = '<div class="center">Sin conexión con el host.</div>'; return; }
  const st = sn.hostSettings ?? {};
  const accounts = sn.accounts ?? [];
  const planMode = st.limitPlan?.mode ?? 'ask';
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
  body.innerHTML = `${hostPickerHTML(state)}
    <div class="form-section">Relevo entre agentes</div>
    <div class="form-group">
      <div class="form-row"><div class="l">Si se acaba la cuota<span class="cap">Lo que hace un hilo cuando su agente se queda sin cuota, salvo que el hilo tenga lo suyo (en su menú de modelo). Al relevar, pasa la petición con todo el contexto; al esperar, el mismo agente sigue donde lo dejó cuando se reinicia.</span></div>
        <select class="field" data-set="limitPlan">${opt('ask', 'Avisarme y decidir yo', planMode)}${opt('mostQuota', 'Pasar a la suscripción con más cuota', planMode)}${opt('chain', 'Pasar a las que elija, en orden', planMode)}${opt('wait', 'Esperar a que se reinicie y seguir', planMode)}</select></div>
      ${planMode === 'chain' ? `<div class="form-row"><span class="caption grow">${esc(st.limitPlanSummary ?? '')}</span><button class="btn small" data-edit-chain>Editar orden…</button></div>` : ''}
      <div class="form-row"><div class="l">Suscripción por defecto</div><select class="field" data-set="defaultAccountId">${opt('', 'La que tenga más cuota libre', st.defaultAccountId ?? '')}${accounts.map((a) => opt(a.id, a.name, st.defaultAccountId)).join('')}</select></div>
      <div class="form-row"><div class="l">Segundos antes de relevar</div><input type="number" class="field-input" style="width:70px" min="0" max="300" data-set="relayDelay" value="${st.relayDelay ?? 10}"></div>
    </div>
    <div class="form-section">Relevo sugiere</div>
    <div class="form-group"><div class="form-row"><div class="l">Elegir modelo según la tarea<span class="cap">Mientras escribes, propone la suscripción, el modelo y el razonamiento justos para la tarea, gastando antes la cuota que se iba a perder. A mitad de un hilo solo propone cambiar si compensa el traspaso.</span></div>
      <select class="field" data-set="suggestMode">${opt('off', 'Desactivado', st.suggestMode)}${opt('suggest', 'Sugerir (se acepta con un clic)', st.suggestMode)}${opt('auto', 'Aplicar automáticamente', st.suggestMode)}</select></div></div>
    <div class="form-section">Títulos de conversación</div>
    <div class="form-group"><div class="form-row"><div class="l">Poner el tema como título con IA<span class="cap">Un modelo barato y sin razonamiento resume de qué va el hilo. Si el primer mensaje no aclara nada, espera al siguiente.</span></div><input type="checkbox" class="switch" data-set="aiTitles"${st.aiTitles !== false ? ' checked' : ''}></div></div>
    <div class="form-section">Agentes</div>
    <div class="form-group">
      <div class="form-row"><div class="l">Permisos por defecto</div><select class="field" data-set="defaultMode">${MODES.map(([id, label]) => opt(id, label, st.defaultMode)).join('')}</select></div>
      <div class="form-row"><div class="l">Actualizar límites cada</div><select class="field" data-set="probeMinutes">${[5, 10, 15, 30, 60].map((m) => opt(m, `${m} min`, st.probeMinutes ?? 10)).join('')}</select></div>
      ${has(state.hostId, 'renewSessions') ? `<div class="form-row"><div class="l">Renovar la sesión al llegar a<span class="cap">Cada turno relee todo el contexto de la sesión, y eso es casi todo lo que gasta una suscripción. Al pasar de aquí, el agente escribe una nota de traspaso y sigue en una sesión nueva con la nota, un resumen y la traza entera en un fichero. Nunca a mitad de un turno ni con algo en segundo plano.</span></div><select class="field" data-set="renewAt">${[[0, 'Solo cuando esté casi llena'], [100000, '100 k tokens'], [150000, '150 k tokens'], [250000, '250 k tokens'], [400000, '400 k tokens']].map(([v, l]) => opt(v, l, st.renewAt ?? 150000)).join('')}</select></div>` : ''}
      <div class="form-row"><div class="l">Agentes trabajando a la vez</div><input type="number" class="field-input" style="width:70px" min="1" max="8" data-set="maxAgents" value="${st.maxAgents ?? 2}"></div>
    </div>
    <div class="form-section">Proyectos</div>
    <div class="form-group"><div class="form-row"><div class="l">Carpeta de proyectos<span class="cap">Sus subcarpetas aparecen como proyectos; puedes añadir carpetas de cualquier sitio con «Añadir proyecto».</span></div></div>
      <div class="form-row"><input class="field-input grow mono" data-root value="${esc(st.projectsRoot ?? '')}"><button class="btn" data-choose-root>Elegir…</button><button class="btn" data-save-root>Guardar</button></div></div>`;
  bindHostPicker(body, state, redraw);
  const save = async (settings) => { const r = await request(hostId, { setSettings: { settings } }); if (!r.ok) toast(r.error); setTimeout(redraw, 300); };
  body.querySelectorAll('[data-set]').forEach((el) => {
    el.onchange = () => {
      const k = el.dataset.set;
      if (k === 'limitPlan') {
        if (el.value === 'chain') { openLimitPlanEditor(hostId, null); return; }
        save({ limitPlan: { mode: el.value, targets: [] } });
      } else if (k === 'aiTitles') save({ aiTitles: el.checked });
      else if (k === 'defaultAccountId') save({ defaultAccountId: el.value || null });
      else save({ [k]: el.type === 'number' || k === 'probeMinutes' || k === 'renewAt' ? Number(el.value) : el.value });
    };
  });
  body.querySelector('[data-edit-chain]')?.addEventListener('click', () => openLimitPlanEditor(hostId, null));
  body.querySelector('[data-choose-root]').onclick = async () => {
    const p = await chooseFolder({ title: 'Carpeta de proyectos', start: body.querySelector('[data-root]').value, request: requester(hostId) });
    if (p) { body.querySelector('[data-root]').value = p; save({ projectsRoot: p }); }
  };
  body.querySelector('[data-save-root]').onclick = () => save({ projectsRoot: body.querySelector('[data-root]').value.trim() });
}

/** Where each kind of host gives its pairing link. */
export const PAIR_HELP = 'En Windows o Linux con la app: Relevo › Ajustes › iPhone › Copiar enlace. En la app nativa del Mac: Ajustes › iPhone › Copiar enlace. En un host sin pantalla: <code>relevo-host pair</code>.';

function drawIPhone(body) {
  // Only a machine that is itself a host has a link to give (the desktop app alone doesn't).
  body.innerHTML = `${app.pairingLink ? `<div class="form-section">Emparejar un iPhone u otro equipo</div>
    <div class="form-group"><div class="form-row"><div class="l">1. Copia el enlace de este equipo.<br>2. En Relevo Companion: Ajustes › Hosts › Añadir otro host › Pegar. En la app de escritorio de otro equipo: Ajustes › iPhone › Añadir un host.<span class="cap">El enlace lleva la clave del equipo: no lo compartas.</span></div><button class="btn" data-copy-pair>Copiar enlace</button></div></div>` : ''}
    <div class="form-section">Hosts</div>
    <div class="form-group">${[...app.hosts.entries()].map(([id, h]) => `<div class="form-row"><span class="dot" style="background:${h.info.state === 'connected' ? 'var(--green)' : h.info.state === 'connecting' ? 'var(--orange)' : 'var(--red)'}"></span><div class="l">${esc(nameOf(h))}${h.info.local ? ' · este equipo' : ''}<span class="cap">${esc(h.info.state === 'connected' ? `Conectado${h.info.via ? ` · ${h.info.via}` : ''}` : h.info.state === 'connecting' ? 'Conectando…' : h.info.reason ?? 'Sin conectar')}</span></div><button class="btn small" data-reconnect="${esc(id)}">Reconectar</button>${h.info.local ? '' : `<button class="btn small destructive" data-remove-host="${esc(id)}">Quitar</button>`}</div>`).join('')}</div>
    <div class="form-section">Añadir un host</div>
    <div class="form-group"><div class="form-row"><input class="field-input grow mono" data-link placeholder="relevocompanion://pair?…"><button class="btn" data-add-host>Añadir</button></div>
      <div class="form-row"><div class="caption">${PAIR_HELP}</div></div></div>`;
  body.querySelector('[data-copy-pair]')?.addEventListener('click', () => copyText(app.pairingLink, 'Enlace de emparejamiento copiado'));
  body.querySelectorAll('[data-reconnect]').forEach((b) => { b.onclick = () => post({ type: 'reconnect', host: b.dataset.reconnect }); });
  body.querySelectorAll('[data-remove-host]').forEach((b) => {
    b.onclick = async () => {
      const ok = await alertSheet({ title: `¿Quitar ${nameOf(host(b.dataset.removeHost))}?`, message: 'Para volver a añadirlo necesitarás su enlace de emparejamiento.', buttons: [{ label: 'Quitar', role: 'destructive' }, { label: 'Cancelar', role: 'cancel' }] });
      if (ok) { post({ type: 'remove', host: b.dataset.removeHost }); setTimeout(() => settingsOpen?.redraw(), 400); }
    };
  });
  body.querySelector('[data-add-host]').onclick = () => {
    const link = body.querySelector('[data-link]').value.trim();
    if (link) { post({ type: 'pair', link }); setTimeout(() => settingsOpen?.redraw(), 800); }
  };
  drawPush(body);
}

/**
 * Push notifications on the iPhone, per host: with your APNs key (.p8) the host itself tells your iPhone when an
 * agent asks you something, needs a permission or the guard holds a command, even with the app closed.
 */
function drawPush(body) {
  const hosts = [...app.hosts.keys()].filter((id) => has(id, 'push'));
  if (!hosts.length) return;
  const section = document.createElement('div');
  section.innerHTML = `<div class="form-section">Notificaciones en el iPhone</div>
    <div class="form-group"><div class="form-row"><div class="caption">Con tu clave de APNs, cada host avisa a tu iPhone cuando el orquestador te pide algo, un agente te pregunta o necesita tu permiso, o el guardarraíl detiene un comando, aunque la app esté cerrada o el móvil bloqueado. La clave se crea en developer.apple.com › Certificates, IDs &amp; Profiles › Keys › «+» con «Apple Push Notifications service (APNs)». Se descarga una sola vez (un fichero .p8). El iPhone se registra solo al abrir la app conectada al host.</div></div></div>
    ${hosts.map((id) => {
      const p = snap(id)?.hostPush ?? {};
      return `<div class="form-group" data-push-host="${esc(id)}">
        <div class="form-row"><div class="l"><b>${esc(nameOf(host(id)))}</b><span class="cap">${p.configured ? `Clave configurada · Team ID ${esc(p.teamId)} · Key ID ${esc(p.keyId)}` : 'Sin clave de APNs'}</span></div>${p.configured ? '<button class="btn small" data-push-test>Enviar prueba</button><button class="btn small destructive" data-push-clear>Quitar clave</button>' : ''}</div>
        ${(p.devices ?? []).map((d) => `<div class="form-row"><span class="dot" style="background:var(--green)"></span><div class="l">${esc(d.name)}<span class="cap">${d.environment === 'production' ? 'App Store / TestFlight' : 'Instalada desde Xcode'} · registrado ${esc(relative(d.at))}</span></div><button class="btn small" data-push-forget="${esc(d.id)}">Olvidar</button></div>`).join('') || '<div class="form-row"><div class="caption">Ningún iPhone registrado todavía: abre la app en el iPhone, conectada a este host, y acepta las notificaciones.</div></div>'}
        <div class="form-row"><input class="field-input mono" data-push-team placeholder="Team ID" maxlength="10" style="width:120px" value="${esc(p.teamId ?? '')}"><input class="field-input mono" data-push-key-id placeholder="Key ID" maxlength="10" style="width:120px" value="${esc(p.keyId ?? '')}"><label class="btn small">${p.configured ? 'Cambiar .p8…' : 'Elegir .p8…'}<input type="file" accept=".p8" data-push-file hidden></label><span class="caption grow" data-push-file-name></span><button class="btn primary small" data-push-save>Guardar</button></div>
      </div>`;
    }).join('')}`;
  body.appendChild(section);
  section.querySelectorAll('[data-push-host]').forEach((g) => {
    const id = g.dataset.pushHost;
    let key = null;
    g.querySelector('[data-push-file]').onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      key = await f.text();
      g.querySelector('[data-push-file-name]').textContent = /BEGIN PRIVATE KEY/.test(key) ? f.name : 'Ese fichero no parece una clave .p8';
    };
    g.querySelector('[data-push-save]').onclick = async () => {
      const r = await request(id, { setPushKey: { teamId: g.querySelector('[data-push-team]').value, keyId: g.querySelector('[data-push-key-id]').value, key } });
      key = null;
      if (!r.ok) { toast(r.error); return; }
      toast('Clave de APNs guardada en el host');
      setTimeout(() => settingsOpen?.redraw(), 400);
    };
    g.querySelector('[data-push-test]')?.addEventListener('click', async () => {
      const r = await request(id, { testPush: {} });
      toast(r.ok ? r.results.join(' · ') : r.error);
    });
    g.querySelector('[data-push-clear]')?.addEventListener('click', async () => {
      const r = await request(id, { setPushKey: { clear: true } });
      if (!r.ok) toast(r.error); else setTimeout(() => settingsOpen?.redraw(), 400);
    });
    g.querySelectorAll('[data-push-forget]').forEach((b) => { b.onclick = async () => { await request(id, { forgetPushDevice: { deviceId: b.dataset.pushForget } }); setTimeout(() => settingsOpen?.redraw(), 400); }; });
  });
}

/** Installs the new version now; the service restarts once no agent is working. */
export async function confirmUpdate() {
  const u = app.update;
  if (!u?.latest) return;
  const ok = await alertSheet({ title: `¿Actualizar Relevo a ${u.latest}?`, message: 'Se instala ahora, y el servicio se reinicia en cuanto ningún agente esté trabajando, así que no se corta ningún turno. Los mensajes que envíes mientras tanto esperan en cola y salen solos después.', buttons: [{ label: 'Actualizar', role: 'default' }, { label: 'Cancelar', role: 'cancel' }] });
  if (ok) post({ type: 'applyUpdate' });
}

function drawIntegrations(body) {
  const u = app.update;
  const notif = 'Notification' in window ? Notification.permission : 'denied';
  body.innerHTML = `<div class="form-section">Actualizaciones</div>
    <div class="form-group"><div class="form-row"><div class="l">Versión instalada: <b>${esc(u?.current ?? '—')}</b><span class="cap">${u?.pendingRestart ? `${esc(u.pendingRestart.version)} instalada: se reinicia cuando ${u.pendingRestart.busy ? `terminen ${u.pendingRestart.busy === 1 ? 'el agente' : `los ${u.pendingRestart.busy} agentes`} que están trabajando` : 'pueda'}` : u?.applying ? 'Instalando…' : u?.available ? `Hay una versión nueva: ${esc(u.latest)}` : u?.latest ? `Al día (última publicada: ${esc(u.latest)})` : 'Sin comprobar todavía'}${u?.checkedAt ? ` · comprobado ${esc(relative(u.checkedAt))}` : ''}</span>${u?.error ? `<span class="cap orange">${esc(u.error)}</span>` : ''}</div>
      <button class="btn" data-check-update${u?.applying ? ' disabled' : ''}>Buscar actualizaciones</button>${u?.available ? `<button class="btn primary" data-apply-update${u.applying ? ' disabled' : ''}>Actualizar a ${esc(u.latest)}</button>` : ''}</div>
      <div class="form-row"><div class="caption">Solo se instalan versiones firmadas. La versión nueva se instala enseguida, pero el servicio no se reinicia hasta que ningún agente esté trabajando: no se corta ningún turno. Mientras tanto, los mensajes nuevos esperan en cola y salen solos tras el reinicio.</div></div></div>
    <div class="form-section">Avisos</div>
    <div class="form-group"><div class="form-row"><div class="l">Avisos del sistema<span class="cap">Cuando un hilo termina o pide permiso y la ventana no está delante.</span></div>
      <button class="btn" data-notif${notif === 'default' ? '' : ' disabled'}>${notif === 'granted' ? 'Activados' : notif === 'denied' ? 'Bloqueados en el navegador' : 'Activar avisos'}</button></div></div>`;
  body.querySelector('[data-check-update]').onclick = () => { post({ type: 'checkUpdate' }); toast('Buscando actualizaciones…'); setTimeout(() => settingsOpen?.redraw(), 2500); };
  body.querySelector('[data-apply-update]')?.addEventListener('click', () => confirmUpdate());
  body.querySelector('[data-notif]').onclick = async () => { await Notification.requestPermission(); settingsOpen?.redraw(); };
}

// MARK: - Sign-in

export function openLogin(hostId, accountId) {
  const account = accountOf(hostId, accountId);
  const requestId = uuid();
  let finished = false;
  const s = openSheet({ width: 620, onClose: () => { app.logins.delete(requestId); app.requests.delete(requestId); if (!finished) sendTo(hostId, { loginCancel: { requestId } }); }, body: `
    <div class="sheet-title">Iniciar sesión en ${esc(account?.name ?? 'la suscripción')}</div>
    <div class="sheet-sub" data-intro>Abre el enlace, entra con tu cuenta y, si te muestra un código, pégalo abajo. La sesión queda guardada en ${esc(nameOf(host(hostId)))}.</div>
    <div class="sheet-buttons" data-link-row><button class="btn primary" data-open disabled>Abrir el enlace</button><button class="btn" data-copy disabled>Copiar enlace</button></div>
    <div class="sheet-buttons" data-state-row><span class="caption grow" data-state>Arrancando…</span></div>
    <pre class="out-log" data-out style="min-height:120px;max-height:240px;white-space:pre-wrap"></pre>
    <div class="sheet-buttons" data-code-row><input class="field-input grow mono" data-code placeholder="Código (si te lo pide)" autocomplete="off"><button class="btn" data-send>Enviar</button></div>
    <div class="sheet-buttons"><span class="grow"></span><button class="btn" data-close>Cerrar</button></div>` });
  const $ = (q) => s.el.querySelector(q);
  let output = '', link = null;
  app.logins.set(requestId, (m) => {
    if (m.terminal) {
      // agy only signs in from a real terminal: the command to run on that machine, and this sheet waits.
      $('[data-intro]').innerHTML = `${esc(account?.agentName ?? 'Este agente')} solo inicia sesión desde una terminal. En <b>${esc(nameOf(host(hostId)))}</b>, abre ${host(hostId)?.data.snapshot?.hostPlatform === 'win32' ? 'PowerShell' : 'una terminal'} y ejecuta:`;
      $('[data-link-row]').innerHTML = `<code class="term-cmd grow">${esc(m.terminal)}</code><button class="btn primary" data-copy-cmd>Copiar</button>`;
      $('[data-copy-cmd]').onclick = () => copyText(m.terminal, 'Comando copiado');
      $('[data-out]').textContent = 'Abre el enlace que te muestre, entra con tu cuenta de Google y, si te da un código, pégalo en esa terminal. Cuando la sesión quede guardada se cierra sola y esta ventana también.';
      $('[data-code-row]').remove();
      $('[data-state-row]').innerHTML = '<span class="spinner" data-spin></span><span class="caption grow" data-state>Esperando a que inicies sesión en la terminal…</span>';
      return;
    }
    if (m.text) {
      output += m.text;
      $('[data-out]').innerHTML = linkify(output);
      $('[data-out]').scrollTop = $('[data-out]').scrollHeight;
      const found = output.match(/https?:\/\/[^\s<>"']+/g);
      if (found && !link) {
        link = found.find((u) => /oauth|auth|login|device|activate/i.test(u)) ?? found[0];
        $('[data-open]').disabled = false; $('[data-copy]').disabled = false;
        $('[data-state]').textContent = 'Esperando a que inicies sesión…';
      }
    }
    if (m.done) {
      finished = true;
      $('[data-spin]')?.remove();
      $('[data-state]').textContent = m.ok ? 'Sesión iniciada ✓' : `No se ha completado: ${m.error ?? ''}`;
      $('[data-state]').className = `caption grow ${m.ok ? 'green' : 'red'}`;
      if (m.ok) setTimeout(s.close, 1500);
    }
  });
  app.requests.set(requestId, (r) => { if (r.ok === false) { finished = true; $('[data-state]').textContent = r.error; } });
  $('[data-open]').onclick = () => window.open(link, '_blank', 'noopener');
  $('[data-copy]').onclick = () => copyText(link, 'Enlace copiado');
  $('[data-close]').onclick = s.close;
  const sendCode = () => { const v = $('[data-code]').value.trim(); if (!v) return; sendTo(hostId, { loginInput: { requestId, text: v } }); $('[data-code]').value = ''; $('[data-state]').textContent = 'Código enviado…'; };
  $('[data-send]').onclick = sendCode;
  $('[data-code]').onkeydown = (e) => { if (e.key === 'Enter') sendCode(); };
  sendTo(hostId, { login: { requestId, accountId } });
}

// MARK: - Consumo window (UsageView)

export async function openUsage() {
  const hosts = hostsWith('usage');
  const st = { hostId: main.currentHost?.() ?? hosts[0]?.[0], days: Number(localStorage.getItem('usagePeriod') ?? 7), metric: localStorage.getItem('usageMetric') ?? 'tokens', report: null };
  if (!hosts.some(([id]) => id === st.hostId)) st.hostId = hosts[0]?.[0];
  const s = openSheet({ className: 'usage-win', width: 980, focus: false });
  const load = async () => {
    st.report = null; draw();
    if (!st.hostId) return;
    const r = await request(st.hostId, { usageReport: { days: st.days } });
    st.report = r.ok ? r.usage : { error: r.error };
    draw();
  };
  const draw = () => {
    const r = st.report;
    const periods = [[1, 'Hoy'], [7, '7 días'], [30, '30 días'], [0, 'Todo']];
    let html = `<div class="usage-head"><div class="grow"><h1>Consumo</h1><div class="muted">Tokens y coste por mensaje, modelo y proveedor</div></div>${hostSelect(hosts, st.hostId, 'data-u-host')}
      <div class="seg">${periods.map(([d, l]) => `<button class="${st.days === d ? 'on' : ''}" data-days="${d}">${l}</button>`).join('')}</div>
      <div class="seg"><button class="${st.metric === 'tokens' ? 'on' : ''}" data-metric="tokens">Tokens</button><button class="${st.metric === 'cost' ? 'on' : ''}" data-metric="cost">Coste</button></div>
      <button class="btn" data-close>Cerrar</button></div>`;
    if (!st.hostId) html += '<div class="center" style="min-height:320px">Ningún host conectado da estadísticas de consumo.</div>';
    else if (!r) html += '<div class="center" style="min-height:320px"><span class="spinner big"></span></div>';
    else if (r.error) html += `<div class="center red" style="min-height:320px">${esc(r.error)}</div>`;
    else if (!r.total.turns) html += `<div class="center" style="min-height:320px">${icon('chart.bar.xaxis', { size: 40, cls: 'big-ic' })}<div style="font-size:17px;font-weight:600;color:var(--text)">Aún no hay datos de consumo</div><div style="max-width:420px;text-align:center">Relevo apunta los tokens de cada turno. Vuelve cuando hayas trabajado un poco.</div></div>`;
    else html += usageBody(r, st.metric);
    s.el.innerHTML = html;
    s.el.querySelector('[data-close]').onclick = s.close;
    s.el.querySelectorAll('[data-days]').forEach((b) => { b.onclick = () => { st.days = Number(b.dataset.days); localStorage.setItem('usagePeriod', st.days); load(); }; });
    s.el.querySelectorAll('[data-metric]').forEach((b) => { b.onclick = () => { st.metric = b.dataset.metric; localStorage.setItem('usageMetric', st.metric); draw(); }; });
    s.el.querySelector('[data-u-host]')?.addEventListener('change', (e) => { st.hostId = e.target.value; load(); });
    s.el.querySelectorAll('[data-open-thread]').forEach((b) => { b.onclick = () => { s.close(); main.select(st.hostId, b.dataset.openThread); }; });
  };
  load();
}

function usageBody(r, metric) {
  const t = r.total;
  const cachePct = t.tokens ? (t.cacheTokens ?? 0) / t.tokens * 100 : 0;
  const tiles = `<div class="tiles">
    <div class="tile"><div class="tt">Tokens</div><div class="tv">${shortTokens(t.tokens)}</div><div class="td">${t.turns} turnos</div></div>
    <div class="tile"><div class="tt">Coste equivalente en API</div><div class="tv">≈ ${usd(t.cost)}</div><div class="td">tus suscripciones no cobran así; sirve para comparar</div></div>
    <div class="tile"><div class="tt">Leído de caché</div><div class="tv">${t.cacheTokens ? pct(cachePct) : '—'}</div><div class="td">${shortTokens(t.tokens - (t.cacheTokens ?? 0))} tokens sin caché</div></div>
    <div class="tile"><div class="tt">Hilos</div><div class="tv">${r.byThread.length}</div><div class="td">con consumo en el periodo</div></div></div>`;
  // Per day, stacked by provider.
  const providers = [...new Set(r.byDay.flatMap((d) => Object.keys(metric === 'cost' ? d.costByProvider ?? {} : d.byProvider ?? {})))];
  const val = (d, p) => (metric === 'cost' ? d.costByProvider?.[p] ?? 0 : d.byProvider?.[p] ?? 0);
  const totalOf = (d) => providers.reduce((n, p) => n + val(d, p), 0);
  const max = Math.max(1e-9, ...r.byDay.map(totalOf));
  const fmt = (v) => (metric === 'cost' ? usd(v) : shortTokens(v));
  const every = Math.max(1, Math.ceil(r.byDay.length / 10));
  const grid = [0.25, 0.5, 0.75, 1].map((f) => `<div class="grid" style="bottom:${20 + f * 210}px"><span>${fmt(max * f)}</span></div>`).join('');
  const day = `<div class="u-section"><h2>Por día</h2><div class="sub">${metric === 'cost' ? 'Coste equivalente en API por proveedor' : 'Tokens por proveedor'}</div>
    <div class="legend">${providers.map((p) => `<span><i style="background:${chartColor(p)}"></i>${esc(p[0].toUpperCase() + p.slice(1))}</span>`).join('')}</div>
    <div class="chart">${grid}${r.byDay.map((d, i) => `<div class="col" title="${esc(`${new Date(`${d.day}T12:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' })}\n${providers.map((p) => `${p}: ${fmt(val(d, p))}`).join('\n')}`)}">${providers.map((p) => `<i style="height:${(val(d, p) / max) * 210}px;background:${chartColor(p)}"></i>`).join('')}${i % every === 0 ? `<span class="xl">${new Date(`${d.day}T12:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</span>` : ''}</div>`).join('')}</div></div>`;
  // Weekday × hour heatmap.
  const heatMax = Math.max(1, ...r.heat.flat().map((c) => (metric === 'cost' ? c.cost : c.tokens)));
  const days = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
  const cell = (c) => { const v = (metric === 'cost' ? c.cost : c.tokens) / heatMax; return v ? `color-mix(in srgb, #184f95 ${Math.round(15 + v * 85)}%, #cde2fb)` : 'rgba(var(--primary-base), .04)'; };
  const heat = `<div class="u-section"><h2>Por hora</h2><div class="sub">Cuándo trabajan tus agentes (día de la semana × hora)</div>
    <div class="heat">${r.heat.map((row, di) => `<span>${days[di]}</span>${row.map((c, h) => `<div class="c" style="background:${cell(c)}" title="${esc(`${days[di]} · ${h}:00–${h + 1}:00\n${shortTokens(c.tokens)} tokens · ${c.turns} turnos · ${usd(c.cost)}`)}"></div>`).join('')}`).join('')}
    <span></span>${Array.from({ length: 24 }, (_, h) => `<span style="text-align:center">${h % 3 === 0 ? `${h} h` : ''}</span>`).join('')}</div></div>`;
  const models = `<div class="u-section"><h2>Por modelo</h2><div class="sub">Turnos, tokens y coste</div><div class="grid-card"><table><thead><tr><th>Modelo</th><th>Turnos</th><th>Tokens</th><th>Coste</th><th>Por turno</th></tr></thead><tbody>
    ${r.byModel.map((m) => `<tr><td><span class="dot" style="background:${chartColor(providerOf(m.kind ?? ''))}"></span><b style="font-weight:500">${esc(m.model === 'default' ? 'Predeterminado' : m.model)}</b> <span class="muted">${esc(m.accountName)}</span></td><td>${m.turns}</td><td>${shortTokens(m.tokens)}</td><td>${usd(m.cost)}</td><td>${shortTokens(m.tokens / m.turns)}</td></tr>`).join('')}</tbody></table></div></div>`;
  const threads = `<div class="u-section"><h2>Hilos que más gastan</h2><div class="grid-card"><table><thead><tr><th>Hilo</th><th>Turnos</th><th>Tokens</th><th>Coste</th></tr></thead><tbody>
    ${r.byThread.map((x) => `<tr><td><button class="btn link" data-open-thread="${esc(x.threadId)}">${esc(x.title)}</button></td><td>${x.turns}</td><td>${shortTokens(x.tokens)}</td><td>${usd(x.cost)}</td></tr>`).join('')}</tbody></table></div></div>`;
  return `${tiles}${day}${heat}${models}${threads}<div class="caption" style="border-top:1px solid var(--separator);padding-top:10px">Costes con precios de lista (Claude: los que calcula Claude Code). Para una suscripción es un equivalente para comparar modelos, no lo que pagas.</div>`;
}

// MARK: - Popovers: thread usage and turn usage

export function threadUsagePopover(anchor, hostId, threadId) {
  const thread = threadOf(hostId, threadId);
  const items = [...(app.older.get(`${hostId}/${threadId}`) ?? []), ...(thread?.items ?? [])].filter((i) => i.usage);
  const byModel = new Map();
  let tokens = 0, cost = 0, cache = 0;
  for (const it of items) {
    const a = accountOf(hostId, it.accountId);
    const k = `${a?.id}|${it.model}`;
    const e = byModel.get(k) ?? { a, model: it.model, turns: 0, cost: 0 };
    e.turns++; e.cost += it.usage.cost ?? 0;
    byModel.set(k, e);
    tokens += it.usage.tokens ?? 0; cost += it.usage.cost ?? 0; cache += (it.usage.tokens ?? 0) * (it.usage.cacheShare ?? 0);
  }
  const last = items.at(-1)?.usage;
  const p = openPopover(anchor, `<div class="pop-title">Consumo del hilo</div>
    ${last?.context && last?.contextWindow ? `<div>Contexto: ${shortTokens(last.context)} de ${shortTokens(last.contextWindow)}<div class="progress" style="margin-top:4px"><i style="width:${Math.min(100, last.context / last.contextWindow * 100)}%"></i></div></div>` : ''}
    ${items.length ? `<div class="pop-grid"><span class="k">Turnos</span><span class="v">${items.length}</span><span class="k">Tokens</span><span class="v">${shortTokens(tokens)}</span><span class="k">Leído de caché</span><span class="v">${shortTokens(cache)}</span><span class="k">Coste (equiv. API)</span><span class="v">≈ ${usd(cost)}</span></div>
      <div style="display:flex;flex-direction:column;gap:4px">${[...byModel.values()].map((e) => `<div class="pop-foot" style="color:var(--text)"><span class="dot" style="width:7px;height:7px;background:${esc(e.a?.tint ?? 'gray')}"></span><span class="grow">${esc(e.a?.name ?? '?')} · ${esc(modelName(e.a, e.model))}</span><span class="muted">${e.turns} · ${usd(e.cost)}</span></div>`).join('')}</div>`
    : '<div class="muted">Aún no hay turnos con datos de tokens en este hilo.</div>'}
    <div><button class="btn small" data-open-usage>Abrir estadísticas de consumo</button></div>`, { width: 300 });
  p?.el.querySelector('[data-open-usage]')?.addEventListener('click', () => { closePopover(); openUsage(); });
}

export function turnUsagePopover(anchor, u) {
  const cache = (u.tokens ?? 0) * (u.cacheShare ?? 0);
  openPopover(anchor, `<div class="pop-title">Consumo del turno</div>
    ${u.switchLabel ? `<div><div class="orange" style="font-weight:600">${icon('arrow.triangle.swap', { size: 11 })} ${esc(u.switchLabel)}</div>${u.switchDetail ? `<div class="caption">${esc(u.switchDetail)}</div>` : ''}${u.overhead ? `<div class="caption">Re-procesó ≈ ${grouped(u.overhead)} tokens que, sin el cambio, se habrían leído de caché${u.overheadCost ? ` (≈ ${usd(u.overheadCost)})` : ''}.</div>` : ''}</div><div class="pop-sep"></div>` : ''}
    <div class="pop-grid"><span class="k">Entrada sin caché</span><span class="v">${grouped((u.tokens ?? 0) - cache)}</span><span class="k">Leída de caché</span><span class="v">${grouped(cache)}</span><span class="total">Total</span><span class="v total">${grouped(u.tokens)}</span></div>
    ${u.cost ? `<div style="font-weight:500">${u.paid ? 'Gasto: ' : 'Coste equivalente en API: '}${u.costEstimated ? '≈ ' : ''}${usd(u.cost)}</div><div class="caption">${u.paid ? 'Pago por uso: estimado con los precios de lista.' : u.costEstimated ? 'Estimado con los precios de lista; tu suscripción no cobra por token.' : 'Calculado por el propio CLI a precios de lista; tu suscripción no cobra por token.'}</div>` : ''}
    ${u.context ? `<div class="caption">Contexto al terminar: ${shortTokens(u.context)}${u.contextWindow ? ` de ${shortTokens(u.contextWindow)}` : ''}</div>` : ''}`, { width: 300, edge: 'top' });
}

// MARK: - Diffs (DiffSheet)

function parseDiff(text) {
  const files = [];
  let f = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { f = { path: m[2], old: m[1], kind: 'M', added: 0, removed: 0, lines: [], binary: false }; files.push(f); continue; }
    if (!f) continue;
    if (/^new file/.test(line)) { f.kind = 'A'; continue; }
    if (/^deleted file/.test(line)) { f.kind = 'D'; continue; }
    if (/^rename from/.test(line)) { f.kind = 'R'; continue; }
    if (/^(index |--- |\+\+\+ |similarity|rename to|old mode|new mode)/.test(line)) continue;
    if (/^(Binary files|Fichero binario)/.test(line)) { f.binary = true; continue; }
    f.lines.push(line);
    if (line.startsWith('+')) f.added++; else if (line.startsWith('-')) f.removed++;
  }
  return files;
}

function diffLinesHTML(f, comments) {
  if (f.binary) return '<div class="pad muted">Fichero binario</div>';
  let o = 0, n = 0;
  const out = [];
  f.lines.forEach((line, i) => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (h) { o = Number(h[1]); n = Number(h[2]); out.push(`<div class="dl hunk"><span class="no"></span><span class="no"></span><span class="mk"></span>${esc(line)}</div>`); return; }
    if (line === '' && i === f.lines.length - 1) return;
    let cls = '', on = '', nn = '', mk = '';
    if (line.startsWith('+')) { cls = 'add'; nn = n++; mk = '+'; }
    else if (line.startsWith('-')) { cls = 'del'; on = o++; mk = '−'; }
    else { on = o++; nn = n++; }
    out.push(`<div class="dl ${cls}" data-line="${i}"><span class="no">${on}</span><span class="no">${nn}</span><span class="mk">${mk}</span>${esc(line.slice(1))}</div>`);
    const c = comments.get(`${f.path}:${i}`);
    if (c) out.push(`<div class="dl-note">${icon('text.bubble.fill', { size: 11 })}${esc(c)}</div>`);
  });
  return out.join('');
}

/** The diff sheet: files, lines with numbers, comments for the agent, and (for a turn) restore. */
export async function openDiff({ hostId, threadId, title, load, restoreItemId }) {
  const s = openSheet({ className: 'diff-sheet', width: 1100, focus: false, body: `<div class="diff-head"><div class="grow"><div class="t">${esc(title)}</div><div class="s" data-sum>…</div></div>
    ${restoreItemId ? `<button class="btn" data-restore title="Devuelve los ficheros a como estaban antes de este turno">${icon('arrow.uturn.backward', { size: 12 })} Restaurar a antes de este turno…</button>` : ''}<button class="btn" data-close>Cerrar</button></div>
    <div class="diff-split"><div class="center"><span class="spinner big"></span></div></div>` });
  s.el.querySelector('[data-close]').onclick = s.close;
  s.el.querySelector('[data-restore]')?.addEventListener('click', async () => {
    const ok = await alertSheet({ title: '¿Restaurar los ficheros a como estaban antes de este turno?', message: 'Se deshacen los cambios de este turno y de los siguientes en la carpeta del hilo (los ignorados por git no se tocan). Lo de ahora se guarda antes y lo puedes recuperar con «Deshacer». Al agente se le avisa con tu próximo mensaje.', buttons: [{ label: 'Restaurar', role: 'destructive' }, { label: 'Cancelar', role: 'cancel' }] });
    if (!ok) return;
    const r = await request(hostId, { restoreTurn: { threadId, itemId: restoreItemId } });
    if (!r.ok) { await alertSheet({ title: 'No se pudo restaurar', message: r.error }); return; }
    s.close();
  });
  const text = await load();
  const files = parseDiff(text);
  const total = files.reduce((n, f) => [n[0] + f.added, n[1] + f.removed], [0, 0]);
  s.el.querySelector('[data-sum]').textContent = `${files.length} ${files.length === 1 ? 'fichero' : 'ficheros'} · +${total[0]} −${total[1]}`;
  const split = s.el.querySelector('.diff-split');
  if (!files.length) { split.innerHTML = `<div class="center">${icon('checkmark.circle', { size: 36, cls: 'big-ic' })}<div style="font-weight:600;color:var(--text)">Sin cambios</div><div>No hay diferencias en los ficheros.</div></div>`; return; }
  const comments = new Map();
  let current = files[0];
  const draw = () => {
    split.innerHTML = `<div class="diff-files">${files.map((f, i) => `<button class="diff-file${f === current ? ' on' : ''}" data-f="${i}" title="${esc(f.path)}"><span class="k ${f.kind}">${f.kind}</span><span class="fn">${esc(f.path.split('/').pop())}</span><span class="nums">+${f.added} −${f.removed}</span></button>`).join('')}</div>
      <div class="diff-pane"><div class="diff-path">${esc(current.kind === 'R' ? `${current.old} → ${current.path}` : current.path)}</div>${diffLinesHTML(current, comments)}</div>`;
    split.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { current = files[Number(b.dataset.f)]; draw(); }; });
    split.querySelectorAll('.dl[data-line]').forEach((l) => {
      l.onclick = () => {
        if (window.getSelection()?.toString()) return;
        split.querySelector('.dl-comment')?.remove();
        const box = document.createElement('div');
        box.className = 'dl-comment';
        box.innerHTML = '<textarea class="field grow" rows="2" placeholder="Comentario para el agente sobre esta línea"></textarea><button class="btn" data-add>Añadir</button><button class="btn" data-cancel>Cancelar</button>';
        l.after(box);
        box.querySelector('textarea').focus();
        box.querySelector('[data-cancel]').onclick = () => box.remove();
        box.querySelector('[data-add]').onclick = () => {
          const v = box.querySelector('textarea').value.trim();
          if (!v) return;
          comments.set(`${current.path}:${l.dataset.line}`, v);
          drawBar();
          draw();
        };
      };
    });
  };
  const drawBar = () => {
    s.el.querySelector('.comment-bar')?.remove();
    if (!comments.size) return;
    const bar = document.createElement('div');
    bar.className = 'comment-bar';
    const runningNow = threadOf(hostId, threadId)?.runtime?.isRunning;
    bar.innerHTML = `${icon('text.bubble', { size: 13 })}<span class="grow">${comments.size} ${comments.size === 1 ? 'comentario' : 'comentarios'}</span><button class="btn" data-discard>Descartar</button><button class="btn primary" data-send>${runningNow ? 'Poner en cola para el agente' : 'Enviar al agente'}</button>`;
    s.el.appendChild(bar);
    bar.querySelector('[data-discard]').onclick = () => { comments.clear(); drawBar(); draw(); };
    bar.querySelector('[data-send]').onclick = () => {
      const lines = [...comments].map(([k, v]) => {
        const [path, idx] = [k.slice(0, k.lastIndexOf(':')), Number(k.slice(k.lastIndexOf(':') + 1))];
        const f = files.find((x) => x.path === path);
        return `- \`${path}\` · \`${(f?.lines[idx] ?? '').slice(0, 160)}\`\n  ${v}`;
      });
      sendTo(hostId, Client.send(threadId, `Comentarios sobre los cambios:\n\n${lines.join('\n')}`));
      s.close();
    };
  };
  draw();
}

export function openTurnDiff(hostId, threadId, userItemId) {
  openDiff({ hostId, threadId, title: 'Cambios de este turno', restoreItemId: userItemId, load: async () => {
    const r = await request(hostId, { turnChanges: { threadId, itemId: userItemId } });
    if (!r.ok) { toast(r.error); return ''; }
    return r.changes.diff;
  } });
}

// MARK: - Git menu and CommitSheet

export async function gitMenu(anchor, hostId, threadId) {
  const thread = threadOf(hostId, threadId);
  const wt = thread?.worktree;
  const [st, pr] = await Promise.all([request(hostId, { gitStatus: { threadId } }, 15_000), has(hostId, 'pullRequests') ? request(hostId, { pullRequest: { threadId } }, 15_000) : Promise.resolve(null)]);
  const g = st.ok ? st.git : null;
  const items = [{ info: wt ? `Worktree · ${wt.branch} (desde ${wt.base ?? 'HEAD'})` : g?.repo ? `Rama ${g.branch} · carpeta del proyecto` : 'La carpeta no es un repositorio git' }];
  if (g?.repo) {
    items.push({ label: 'Cambios del hilo…', icon: 'doc.badge.ellipsis', action: () => openDiff({ hostId, threadId, title: 'Cambios del hilo', load: async () => { const r = await request(hostId, { gitDiff: { threadId } }); return r.ok ? r.diff : ''; } }) },
      { label: 'Commit…', icon: 'checkmark.circle', action: () => openCommit(hostId, threadId) });
  }
  const p = pr?.ok ? pr.pr : null;
  if (p) items.push('-', { label: `Abrir PR #${p.number} (${{ OPEN: 'abierto', MERGED: 'fusionado', CLOSED: 'cerrado' }[p.state] ?? p.state})`, icon: 'arrow.up.right.square', action: () => window.open(p.url, '_blank', 'noopener') });
  if (wt) {
    items.push('-', { label: `Fusionar en ${wt.base ?? 'la rama base'}`, icon: 'arrow.triangle.merge', action: async () => {
      const r = await request(hostId, { mergeWorktree: { threadId, message: `Cambios de ${wt.branch}`, remove: false } }, 180_000);
      if (!r.ok) await alertSheet({ title: 'Git', message: r.error });
    } }, '-', { label: 'Eliminar worktree…', danger: true, action: async () => {
      const choice = await alertSheet({ title: '¿Eliminar el worktree de este hilo?', message: 'Lo que no esté en un commit se pierde. Si borras también la rama, sus commits sin fusionar se pierden.', buttons: [{ label: 'Eliminar carpeta y rama', role: 'destructive' }, { label: 'Eliminar solo la carpeta', role: 'default' }, { label: 'Cancelar', role: 'cancel' }] });
      if (!choice) return;
      const r = await request(hostId, { removeWorktree: { threadId, deleteBranch: choice === 'Eliminar carpeta y rama' } });
      if (!r.ok) await alertSheet({ title: 'Git', message: r.error });
    } });
  }
  showMenu(anchor, items, { alignRight: true });
}

export async function openCommit(hostId, threadId) {
  const s = openSheet({ width: 640, body: '<div class="center"><span class="spinner big"></span></div>' });
  const st = await request(hostId, { gitStatus: { threadId } });
  const g = st.ok ? st.git : { files: [] };
  const remote = !!g.upstream || true;
  s.el.innerHTML = `<div><div class="sheet-title">Commit</div><div class="mono muted" style="font-size:12px">${esc(g.branch ?? '')}</div></div>
    <div class="out-log" style="max-height:${Math.min(220, g.files.length * 26 + 14)}px;white-space:normal;padding:6px 10px">${g.files.length ? g.files.map((f) => `<div style="display:flex;gap:8px;align-items:center;height:26px"><b class="mono" style="width:18px;color:${f.kind === 'new' || f.kind === 'added' ? 'var(--green)' : f.kind === 'deleted' ? 'var(--red)' : 'var(--orange)'}">${{ new: 'A', added: 'A', deleted: 'D', renamed: 'R' }[f.kind] ?? 'M'}</b><span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.path)}</span><span class="mono muted" style="font-size:10px">+${f.added} −${f.removed}</span></div>`).join('') : '<span class="muted">No hay cambios sin commit.</span>'}</div>
    <div class="sheet-buttons"><h3 class="grow">Mensaje</h3><button class="btn" data-ai title="Un modelo barato lo escribe a partir del diff">${icon('sparkles', { size: 12 })} Escribir con IA</button></div>
    <textarea class="field" data-msg style="min-height:120px"></textarea>
    <div class="caption" data-progress></div>
    <div class="sheet-buttons"><button class="btn" data-no>Cancelar</button><span class="grow"></span><button class="btn" data-commit>Commit</button><button class="btn" data-push${remote ? '' : ' disabled'}>Commit y push</button><button class="btn primary" data-pr${has(hostId, 'pullRequests') ? '' : ' disabled'}>Commit, push y crear PR</button></div>`;
  const $ = (q) => s.el.querySelector(q);
  $('[data-no]').onclick = s.close;
  $('[data-ai]').onclick = async (e) => {
    e.currentTarget.disabled = true;
    const r = await request(hostId, { gitMessage: { threadId } });
    e.currentTarget.disabled = false;
    if (r.ok) $('[data-msg]').value = r.message; else $('[data-progress]').innerHTML = `<span class="red">No se pudo escribir el mensaje (¿hay un modelo de utilidad disponible?). ${esc(r.error)}</span>`;
  };
  const go = async (push, pr) => {
    const message = $('[data-msg]').value.trim();
    if (!message) { $('[data-progress]').innerHTML = '<span class="red">Escribe el mensaje del commit</span>'; return; }
    s.el.querySelectorAll('.sheet-buttons .btn').forEach((b) => { b.disabled = true; });
    $('[data-progress]').innerHTML = `<span class="spinner"></span> ${push ? `Subiendo ${esc(g.branch ?? '')}…` : 'Haciendo commit…'}`;
    const r = await request(hostId, { gitCommit: { threadId, message, push } }, 180_000);
    if (!r.ok) { $('[data-progress]').innerHTML = `<span class="red">${esc(r.error)}</span>`; s.el.querySelectorAll('.sheet-buttons .btn').forEach((b) => { b.disabled = false; }); return; }
    if (pr) {
      $('[data-progress]').innerHTML = '<span class="spinner"></span> Creando el PR…';
      const p = await request(hostId, { createPullRequest: { threadId } }, 180_000);
      if (!p.ok) { $('[data-progress]').innerHTML = `<span class="red">${esc(p.error)}</span>`; return; }
    }
    s.close();
  };
  $('[data-commit]').onclick = () => go(false, false);
  $('[data-push]').onclick = () => go(true, false);
  $('[data-pr]').onclick = () => go(true, true);
}

// MARK: - Quick actions

const runs = []; // { name, command, at, code, output, running }

export function actionsMenu(anchor, hostId, threadId) {
  const project = projectOf(hostId, summaryOf(hostId, threadId)?.projectId);
  const items = (project?.quickActions ?? []).map((qa, i) => ({ label: qa.name, icon: 'play.rectangle', shortcut: i < 9 ? `Ctrl+${i + 1}` : '', help: qa.command, action: () => runQuickAction(hostId, threadId, qa) }));
  if (items.length) items.push('-');
  items.push({ label: 'Ver salida…', icon: 'terminal', disabled: !runs.length, action: () => openRuns(hostId, threadId) },
    { label: 'Editar acciones…', icon: 'slider.horizontal.3', action: () => project && openActionsEditor(hostId, project.id) });
  showMenu(anchor, items, { alignRight: true });
}

export async function runQuickAction(hostId, threadId, qa) {
  const run = { name: qa.name, command: qa.command, at: Date.now(), running: true, output: '', code: null };
  runs.unshift(run);
  running.add(run);
  main.render();
  openRuns(hostId, threadId, run);
  const r = await request(hostId, { runQuickAction: { threadId, actionId: qa.id } }, 11 * 60_000);
  run.running = false;
  running.delete(run);
  run.code = r.ok ? r.code : -1;
  run.output = r.ok ? r.output : r.error;
  toast(`«${qa.name}» ${run.code === 0 ? 'terminó bien' : 'falló'}`);
  main.render();
  runsSheet?.redraw?.();
}

let runsSheet = null;
function openRuns(hostId, threadId, selected = runs[0]) {
  runsSheet?.close();
  if (!runs.length) return;
  let cur = selected;
  const s = openSheet({ width: 760, minHeight: 480, onClose: () => { runsSheet = null; } });
  runsSheet = s;
  const draw = () => {
    const st = cur.running ? '<span class="spinner"></span> En curso' : cur.code === 0 ? `<span class="green">${icon('checkmark.circle.fill', { size: 13 })} Terminó bien</span>` : `<span class="red">${icon('xmark.octagon', { size: 13 })} Falló (${cur.code})</span>`;
    s.el.innerHTML = `<div class="sheet-buttons"><select class="field" data-run style="max-width:360px">${runs.map((r, i) => `<option value="${i}"${r === cur ? ' selected' : ''}>${esc(r.name)} · ${new Date(r.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</option>`).join('')}</select><span class="grow"></span>${st}
      <button class="btn" data-send${cur.running ? ' disabled' : ''} title="Manda el final de la salida al agente (útil con errores de compilación o tests)">Enviar al agente</button><button class="btn" data-close>Cerrar</button></div>
      <div class="caption mono">${esc(cur.command)}</div><div class="out-log" style="flex:1;min-height:340px">${esc(cur.output || '…')}</div>`;
    s.el.querySelector('[data-close]').onclick = s.close;
    s.el.querySelector('[data-run]').onchange = (e) => { cur = runs[Number(e.target.value)]; draw(); };
    s.el.querySelector('[data-send]').onclick = () => {
      const tail = cur.output.length > 12_000 ? `…\n${cur.output.slice(-12_000)}` : cur.output;
      sendTo(hostId, Client.send(threadId, `Salida de «${cur.name}» (\`${cur.command}\`, ${cur.code === 0 ? 'terminó bien' : `código ${cur.code}`}):\n\n\`\`\`\n${tail}\n\`\`\``));
      toast('Enviado al agente');
      s.close();
    };
    const log = s.el.querySelector('.out-log');
    log.scrollTop = log.scrollHeight;
  };
  s.redraw = draw;
  draw();
}

const TEMPLATES = [['Compilar (Xcode)', 'xcodebuild -scheme App build'], ['Tests (Xcode)', 'xcodebuild -scheme App test'], ['Swift build', 'swift build'], ['npm install', 'npm install'], ['npm test', 'npm test'], ['dotnet build', 'dotnet build']];

function openActionsEditor(hostId, projectId) {
  const project = projectOf(hostId, projectId);
  const list = (project.quickActions ?? []).map((x) => ({ ...x }));
  const s = openSheet({ width: 680 });
  const draw = () => {
    s.el.innerHTML = `<div class="sheet-title">Acciones de ${esc(project.name)}</div>
      <div class="sheet-sub">Comandos que lanzas desde la barra del hilo, en su carpeta (o su worktree), con tu shell. Las nueve primeras tienen atajo Ctrl+1…Ctrl+9.</div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:360px;min-height:160px;overflow:auto">${list.map((qa, i) => `<div class="form-group"><div class="form-row"><input class="field-input" style="width:180px" data-n="${i}" placeholder="Nombre" value="${esc(qa.name)}"><input class="field-input grow mono" data-c="${i}" placeholder="Comando" value="${esc(qa.command)}"><button class="tb-btn" data-del="${i}">${icon('trash', { size: 13 })}</button></div></div>`).join('') || '<div class="muted pad">Sin acciones todavía.</div>'}</div>
      <div class="sheet-buttons"><button class="btn" data-add>Añadir ${icon('chevron.down', { size: 9 })}</button><span class="grow"></span><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>Guardar</button></div>`;
    s.el.querySelectorAll('[data-n]').forEach((i) => { i.oninput = () => { list[Number(i.dataset.n)].name = i.value; }; });
    s.el.querySelectorAll('[data-c]').forEach((i) => { i.oninput = () => { list[Number(i.dataset.c)].command = i.value; }; });
    s.el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { list.splice(Number(b.dataset.del), 1); draw(); }; });
    s.el.querySelector('[data-add]').onclick = (e) => showMenu(e.currentTarget, [{ label: 'Vacía', action: () => { list.push({ name: 'Nueva acción', command: '' }); draw(); } }, '-', ...TEMPLATES.map(([n, c]) => ({ label: n, action: () => { list.push({ name: n, command: c }); draw(); } }))]);
    s.el.querySelector('[data-no]').onclick = s.close;
    s.el.querySelector('[data-yes]').onclick = async () => {
      const r = await request(hostId, { setQuickActions: { projectId, actions: list.filter((x) => x.command.trim()) } });
      if (r.ok) s.close(); else toast(r.error);
    };
  };
  draw();
}

// MARK: - «Varios agentes» (CompareLaunchSheet)

export function openCompare(hostId, threadId, draft = '') {
  const accounts = (snap(hostId)?.accounts ?? []).filter((a) => a.status?.loggedIn !== false);
  const rows = accounts.slice(0, 2).map((a) => ({ accountId: a.id, model: visibleModels(a)[0]?.id ?? 'default' }));
  while (rows.length < 2 && accounts[0]) rows.push({ accountId: accounts[0].id, model: visibleModels(accounts[0])[1]?.id ?? 'default' });
  const project = projectOf(hostId, summaryOf(hostId, threadId)?.projectId);
  const s = openSheet({ width: 640 });
  const draw = () => {
    s.el.innerHTML = `<div class="sheet-title">La misma tarea a varios agentes</div>
      <div class="sheet-sub">Cada agente trabaja en su propio worktree desde el mismo commit. Cuando terminen, comparas los cambios y te quedas con uno.</div>
      <h3>Tarea</h3><textarea class="field" data-prompt style="min-height:90px;font-family:var(--font);font-size:13px">${esc(draft)}</textarea>
      <div class="sheet-buttons"><h3 class="grow">Agentes</h3><span class="caption">${rows.length} de 5</span></div>
      ${rows.map((r, i) => { const a = accountOf(hostId, r.accountId); return `<div class="sheet-buttons"><select class="field" style="width:180px" data-acc="${i}">${accounts.map((x) => `<option value="${esc(x.id)}"${x.id === r.accountId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <select class="field grow" data-model="${i}">${visibleModels(a).map((m) => `<option value="${esc(m.id)}"${m.id === r.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        <button class="tb-btn" data-rm="${i}"${rows.length <= 2 ? ' disabled' : ''}>${icon('minus.circle', { size: 15 })}</button></div>`; }).join('')}
      <div><button class="btn" data-add${rows.length >= 5 ? ' disabled' : ''}>${icon('plus', { size: 11 })} Añadir agente</button></div>
      <div class="caption">Gastan cuota de cada suscripción a la vez.</div>
      <div class="sheet-buttons"><button class="btn" data-no>Cancelar</button><span class="grow"></span><button class="btn primary" data-go>Lanzar ${rows.length} agentes</button></div>`;
    const $ = (q) => s.el.querySelector(q);
    s.el.querySelectorAll('[data-acc]').forEach((el) => { el.onchange = () => { const r = rows[Number(el.dataset.acc)]; r.accountId = el.value; r.model = visibleModels(accountOf(hostId, el.value))[0]?.id ?? 'default'; draft = $('[data-prompt]').value; draw(); }; });
    s.el.querySelectorAll('[data-model]').forEach((el) => { el.onchange = () => { rows[Number(el.dataset.model)].model = el.value; }; });
    s.el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { rows.splice(Number(b.dataset.rm), 1); draft = $('[data-prompt]').value; draw(); }; });
    $('[data-add]').onclick = () => { rows.push({ ...rows[rows.length - 1] }); draft = $('[data-prompt]').value; draw(); };
    $('[data-no]').onclick = s.close;
    $('[data-go]').onclick = async () => {
      const prompt = $('[data-prompt]').value.trim();
      if (!prompt || !project) return;
      $('[data-go]').disabled = true;
      $('[data-go]').innerHTML = '<span class="spinner"></span> Lanzando…';
      const ids = [];
      for (const r of rows) {
        let id = null;
        if (has(hostId, 'worktrees')) { const w = await request(hostId, { newWorktreeThread: { projectId: project.id } }); id = w.ok ? w.threadId : null; }
        if (!id) id = await createThread(hostId, project.id);
        if (!id) continue;
        sendTo(hostId, Client.select(id, r.accountId, r.model));
        sendTo(hostId, Client.send(id, prompt));
        ids.push(id);
      }
      s.close();
      if (ids[0]) main.select(hostId, ids[0]);
    };
  };
  draw();
}

// MARK: - New team (orchestrator + executors + researcher)

/** «Sin cuota →»: what a member does when its subscription runs out (its thread's out-of-quota plan). */
function fallbackSelect(hostId, attrs, value) {
  const accounts = (snap(hostId)?.accounts ?? []).filter((a) => a.status?.loggedIn !== false);
  const opt = (v, label) => `<option value="${esc(v)}"${String(value ?? '') === v ? ' selected' : ''}>${esc(label)}</option>`;
  return `<select class="field team-fb" ${attrs} title="Qué hace este agente cuando se le acaba la cuota. Automático: el mejor modelo con cuota para su papel (el más potente para un ejecutor, uno ligero para el orquestador y el investigador). Con «→ otro modelo» va al que tú elijas. En los dos casos vuelve solo a su modelo en cuanto recupera la cuota">${has(hostId, 'smartFallback') ? opt('auto', 'Sin cuota: automático') : ''}${opt('', 'Sin cuota: como en Ajustes')}${opt('wait', 'Sin cuota: esperar y seguir aquí')}`
    + accounts.map((a) => `<optgroup label="Sin cuota → ${esc(a.name)}">${visibleModels(a).map((m) => opt(`${a.id}|${m.id}`, `→ ${a.name} · ${m.name} (y vuelve)`)).join('')}</optgroup>`).join('') + '</select>';
}

/** One picker that sets what every agent of the team does when its quota runs out. */
function allFallbackRow(hostId, shared) {
  const select = fallbackSelect(hostId, 'data-fb-all', shared ?? '*').replace('<option value=""', `${shared === null ? '<option value="*" selected>Cada uno el suyo</option>' : ''}<option value=""`);
  return `<div class="team-line team-all"><span class="team-role">${icon('arrow.triangle.2.circlepath', { size: 12 })} Para todos</span><span class="caption grow">Qué hace cada agente si se le acaba la cuota (lo puedes cambiar en cada uno)</span>${select}<span class="tb-spacer"></span></div>`;
}

/**
 * A team of agents. With `threadId`, the team joins that thread instead: it becomes the first executor (same
 * agent, same session) and the orchestrator gets a brief of what it has done.
 */
export function openNewTeam(hostId, projectId, goal = '', { threadId = null } = {}) {
  if (!has(hostId, 'teams')) { toast('Actualiza el host para usar equipos de agentes'); return; }
  const joining = threadId ? summaryOf(hostId, threadId) : null;
  if (joining?.team) { toast('Este hilo ya está en un equipo'); return; }
  if (joining) projectId = joining.projectId;
  const project = projectOf(hostId, projectId);
  const accounts = (snap(hostId)?.accounts ?? []).filter((a) => a.status?.loggedIn !== false);
  if (!project || !accounts.length) { toast(project ? 'No hay ninguna suscripción con sesión iniciada' : 'Elige un proyecto'); return; }
  if (joining && !goal) goal = threadOf(hostId, threadId)?.items.find((i) => i.kind === 'user')?.text ?? joining.title ?? '';
  // Out of quota, each agent goes by default to the best model with quota for its role (if the host can).
  const auto = has(hostId, 'smartFallback') ? 'auto' : '';
  const pick = (a, prefer) => ({ accountId: a.id, model: (visibleModels(a).find((m) => prefer.test(m.id)) ?? visibleModels(a)[0])?.id ?? 'default', notes: '', fallback: auto });
  const kindOf = (a) => a.kind.split(':')[0];
  const claude = accounts.find((a) => a.kind === 'claude') ?? accounts[0];
  const gemini = accounts.find((a) => kindOf(a) === 'gemini');
  const other = accounts.find((a) => kindOf(a) !== kindOf(claude));
  const st = {
    // Joining a thread: a light orchestrator (Gemini Flash if there is one), the thread does the heavy work.
    lead: joining && gemini ? pick(gemini, /flash.*low|flash/i) : pick(claude, /opus/i),
    executors: joining ? [] : [pick(claude, /sonnet/i)],
    researcher: other ? pick(other, /.^/) : pick(claude, /sonnet|haiku/i),
    threadNotes: '',
    threadFallback: auto,
    withResearcher: true,
    worktrees: true,
    mode: 'autoEdit',
  };
  // What you entered stays if you close the sheet or creating fails: reopening it brings it back.
  const draftKey = `relevo.teamDraft.${hostId}.${threadId ?? projectId}`;
  try {
    const d = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
    if (d) {
      const ok = (r) => r && accountOf(hostId, r.accountId);
      if (d.goal) goal = d.goal;
      if (ok(d.lead)) st.lead = d.lead;
      if (Array.isArray(d.executors)) st.executors = d.executors.filter(ok);
      if (ok(d.researcher)) st.researcher = d.researcher;
      for (const k of ['threadNotes', 'threadFallback', 'withResearcher', 'worktrees', 'mode']) if (d[k] !== undefined) st[k] = d[k];
    }
  } catch {}
  const persist = () => {
    try {
      const { focused, ...rest } = st;
      localStorage.setItem(draftKey, JSON.stringify({ ...rest, goal }));
    } catch {}
  };
  const joinedAcct = joining && accountOf(hostId, joining.accountId);
  const s = openSheet({ width: 680 });
  const row = (key, r, i = null) => {
    const a = accountOf(hostId, r.accountId) ?? accounts[0];
    const idx = i === null ? '' : ` data-i="${i}"`;
    return `<select class="field" style="width:190px" data-acc="${key}"${idx}>${accounts.map((x) => `<option value="${esc(x.id)}"${x.id === r.accountId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select class="field grow" data-model="${key}"${idx}>${visibleModels(a).map((m) => `<option value="${esc(m.id)}"${m.id === r.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;
  };
  const notes = (key, value, i = null) => {
    const idx = i === null ? '' : ` data-i="${i}"`;
    const fb = key === 'thread' ? st.threadFallback : key === 'lead' ? st.lead.fallback : key === 'res' ? st.researcher.fallback : st.executors[i]?.fallback;
    return `<div class="team-line"><span class="team-role"></span><input class="field-input grow team-notes" data-notes="${key}"${idx} placeholder="Indicaciones para este agente (opcional)" value="${esc(value ?? '')}">${fallbackSelect(hostId, `data-fb="${key}"${idx}`, fb)}<span class="tb-spacer"></span></div>`;
  };
  // Every agent's "out of quota" choice, to set them all at once.
  const fallbacks = () => [st.lead.fallback, ...(joining ? [st.threadFallback] : []), ...st.executors.map((e) => e.fallback), ...(st.withResearcher ? [st.researcher.fallback] : [])].map((x) => x ?? '');
  const sharedFallback = () => { const v = fallbacks(); return v.every((x) => x === v[0]) ? v[0] : null; };
  const setAllFallbacks = (v) => { st.lead.fallback = v; if (joining) st.threadFallback = v; for (const e of st.executors) e.fallback = v; st.researcher.fallback = v; };
  const draw = () => {
    const n = st.executors.length + (joining ? 1 : 0);
    const execLabel = (i) => (n > 1 ? `Ejecutor ${i + 1}` : 'Ejecutor');
    s.el.innerHTML = `<div class="sheet-title">${icon('person.3.sequence', { size: 16 })} ${joining ? `Añadir coordinador a «${esc(joining.title)}»` : `Equipo de agentes en ${esc(project.name)}`}</div>
      <div class="sheet-sub">${joining ? 'Este hilo pasa a ser el ejecutor: sigue con su agente, su sesión y lo que ya sabe. Un orquestador recibe un resumen de lo hecho, le da las siguientes tareas, responde a sus dudas y, si se atasca, pide al investigador que busque librerías, proyectos open source o documentación.' : 'Un orquestador reparte el trabajo entre los ejecutores, responde a sus dudas y los desbloquea; el investigador busca librerías, proyectos open source y documentación para no reinventar nada. Puedes escribir a cualquiera en su hilo.'}</div>
      <h3>Objetivo</h3><textarea class="field" data-goal style="min-height:84px;font-family:var(--font);font-size:13px" placeholder="Qué quieres conseguir, con el detalle que tengas">${esc(goal)}</textarea>
      <div class="team-form">
        <div class="team-line"><span class="team-role r-orchestrator">${icon('crown.fill', { size: 12 })} Orquestador</span>${row('lead', st.lead)}<span class="tb-spacer"></span></div>
        ${notes('lead', st.lead.notes)}
        ${joining ? `<div class="team-line"><span class="team-role r-executor">${icon('wrench.and.screwdriver', { size: 12 })} ${execLabel(0)}</span><span class="grow team-fixed">${joinedAcct ? badge(joinedAcct, 14) : ''} Este hilo${joinedAcct ? ` · ${esc(joinedAcct.name)}` : ''} <span class="caption">(cambia de modelo o se releva como siempre)</span></span><span class="tb-spacer"></span></div>${notes('thread', st.threadNotes)}` : ''}
        ${st.executors.map((r, i) => `<div class="team-line"><span class="team-role r-executor">${icon('wrench.and.screwdriver', { size: 12 })} ${execLabel(i + (joining ? 1 : 0))}</span>${row('exec', r, i)}<button class="tb-btn" data-rm="${i}"${n <= 1 ? ' disabled' : ''} title="Quitar">${icon('minus.circle', { size: 15 })}</button></div>${notes('exec', r.notes, i)}`).join('')}
        <div class="team-line"><span class="team-role"></span><button class="btn small" data-add${n >= 4 ? ' disabled' : ''}>${icon('plus', { size: 10 })} Añadir ejecutor</button></div>
        <div class="team-line"><label class="team-role r-researcher"><input type="checkbox" class="check" data-res${st.withResearcher ? ' checked' : ''}> ${icon('globe', { size: 12 })} Investigador</label>${st.withResearcher ? row('res', st.researcher) : '<span class="caption grow">Sin investigador: el orquestador buscará alternativas por su cuenta</span>'}<span class="tb-spacer"></span></div>
        ${st.withResearcher ? notes('res', st.researcher.notes) : ''}
        ${allFallbackRow(hostId, sharedFallback())}
      </div>
      <div class="form-group" style="margin-top:12px${st.executors.length ? '' : ';display:none'}">
        ${st.executors.length ? `<div class="form-row"><span class="grow">Los ejecutores nuevos</span><select class="field" data-mode>${[['ask', 'Piden permiso'], ['autoEdit', 'Editan sin pedir permiso'], ['full', 'Acceso total']].map(([v, l]) => `<option value="${v}"${v === st.mode ? ' selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
        ${n > 1 && has(hostId, 'worktrees') && st.executors.length ? `<div class="form-row"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" data-wt${st.worktrees ? ' checked' : ''}> Cada ejecutor nuevo en su propio worktree (su rama; no se pisan)</label></div>` : ''}
      </div>
      <div class="caption" style="margin-top:8px">El orquestador y el investigador leen y buscan sin pedir permiso (el investigador con Codex, en solo lectura); el orquestador no debería editar, pero si le das acceso total podría. Si los agentes se pasan muchos mensajes seguidos sin ti, el equipo se pone en pausa.</div>
      <div class="sheet-buttons"><button class="btn" data-no>Cancelar</button><span class="grow"></span><button class="btn primary" data-go>${joining ? 'Añadir coordinador' : 'Crear equipo'} (${1 + n + (st.withResearcher ? 1 : 0)} agentes)</button></div>`;
    const $ = (q) => s.el.querySelector(q);
    const keep = () => { goal = $('[data-goal]').value; persist(); };
    const target = (el) => { const k = el.dataset.acc ?? el.dataset.model ?? el.dataset.notes; return k === 'lead' ? st.lead : k === 'res' ? st.researcher : st.executors[Number(el.dataset.i)]; };
    $('[data-goal]').oninput = keep;
    s.el.querySelectorAll('[data-acc]').forEach((el) => { el.onchange = () => { const r = target(el); r.accountId = el.value; r.model = visibleModels(accountOf(hostId, el.value))[0]?.id ?? 'default'; keep(); draw(); }; });
    s.el.querySelectorAll('[data-model]').forEach((el) => { el.onchange = () => { target(el).model = el.value; persist(); }; });
    s.el.querySelectorAll('[data-notes]').forEach((el) => { el.oninput = () => { if (el.dataset.notes === 'thread') st.threadNotes = el.value; else target(el).notes = el.value; persist(); }; });
    s.el.querySelectorAll('[data-fb]').forEach((el) => { el.onchange = () => { if (el.dataset.fb === 'thread') st.threadFallback = el.value; else { const k = el.dataset.fb; (k === 'lead' ? st.lead : k === 'res' ? st.researcher : st.executors[Number(el.dataset.i)]).fallback = el.value; } keep(); draw(); }; });
    $('[data-fb-all]').onchange = (e) => { if (e.target.value === '*') return; setAllFallbacks(e.target.value); keep(); draw(); };
    s.el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { st.executors.splice(Number(b.dataset.rm), 1); keep(); draw(); }; });
    $('[data-add]').onclick = () => { st.executors.push(st.executors.length ? { ...st.executors[st.executors.length - 1], notes: '' } : pick(claude, /sonnet/i)); keep(); draw(); };
    $('[data-res]').onchange = (e) => { st.withResearcher = e.target.checked; keep(); draw(); };
    $('[data-mode]')?.addEventListener('change', (e) => { st.mode = e.target.value; persist(); });
    $('[data-wt]')?.addEventListener('change', (e) => { st.worktrees = e.target.checked; persist(); });
    $('[data-no]').onclick = s.close;
    $('[data-go]').onclick = async () => {
      keep();
      if (!goal.trim()) { $('[data-goal]').focus(); toast('Escribe el objetivo del equipo'); return; }
      $('[data-go]').disabled = true;
      $('[data-go]').innerHTML = '<span class="spinner"></span> Creando…';
      const r = await request(hostId, { createTeam: { team: {
        projectId, threadId: joining ? threadId : undefined, threadNotes: st.threadNotes, threadFallback: st.threadFallback, goal: goal.trim(),
        orchestrator: st.lead, executors: st.executors, researcher: st.withResearcher ? st.researcher : null,
        worktrees: st.worktrees && n > 1, mode: st.mode,
      } } });
      if (!r.ok) { toast(r.error); $('[data-go]').disabled = false; $('[data-go]').textContent = joining ? 'Añadir coordinador' : 'Crear equipo'; return; }
      try { localStorage.removeItem(draftKey); } catch {}
      s.close();
      main.select(hostId, r.threadId);
    };
    if (!st.focused) { st.focused = true; setTimeout(() => $('[data-goal]')?.focus(), 0); }
  };
  draw();
}

/** Edits a team as it is: goal, each member's subscription, model and instructions; add or remove members. */
export function openTeamEditor(hostId, teamId) {
  const team = snap(hostId)?.hostTeams?.find((x) => x.id === teamId);
  if (!team) { toast('Equipo desconocido'); return; }
  const accounts = snap(hostId)?.accounts ?? [];
  const usable = accounts.filter((a) => a.status?.loggedIn !== false);
  const ROLE_UI = { orchestrator: ['crown.fill', 'r-orchestrator'], executor: ['wrench.and.screwdriver', 'r-executor'], researcher: ['globe', 'r-researcher'] };
  const st = {
    goal: team.goal,
    members: team.members.map((m) => ({ ...m, accountId: m.accountId ?? usable[0]?.id, model: m.model ?? 'default', notes: m.notes ?? '', fallback: m.fallback ?? '', remove: false })),
    allFallback: null, // the "for everyone" picker, until a member's own differs
    adds: [], // { role, accountId, model, notes }
    budget: { usd: team.budget?.usd ?? '', action: team.budget?.action ?? 'pause' },
    guard: team.guard !== false,
    leadApproves: team.leadApproves !== false,
    worktrees: true,
  };
  const original = JSON.stringify(st.members.map(({ threadId, accountId, model, notes, fallback, name }) => ({ threadId, accountId, model, notes, fallback, name })));
  const canRename = has(hostId, 'teamRename');
  const nameField = (key, m) => (canRename ? `<input class="team-name" data-name="${key}" value="${esc(m.name)}" maxlength="32" spellcheck="false" title="Nombre del agente: el orquestador lo usa para darle órdenes">` : esc(m.name));
  const everyone = () => [...st.members.filter((m) => !m.remove), ...st.adds];
  // The "for everyone" picker shows the shared value when all have the same one.
  const sharedFallback = () => { const v = everyone().map((m) => m.fallback ?? ''); return v.every((x) => x === v[0]) ? v[0] : null; };
  const hasResearcher = () => st.members.some((m) => m.role === 'researcher' && !m.remove) || st.adds.some((a) => a.role === 'researcher');
  const s = openSheet({ width: 700 });
  const selects = (key, r) => {
    const a = accountOf(hostId, r.accountId) ?? usable[0];
    const list = accounts.some((x) => x.id === r.accountId) ? usable.concat(usable.some((x) => x.id === r.accountId) ? [] : [accountOf(hostId, r.accountId)]) : usable;
    return `<select class="field" style="width:190px" data-acc="${key}">${list.map((x) => `<option value="${esc(x.id)}"${x.id === r.accountId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select class="field grow" data-model="${key}">${visibleModels(a).map((m) => `<option value="${esc(m.id)}"${m.id === r.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}${visibleModels(a).some((m) => m.id === r.model) ? '' : `<option value="${esc(r.model)}" selected>${esc(r.model)}</option>`}</select>`;
  };
  const notesRow = (key, value) => `<div class="team-line"><span class="team-role"></span><input class="field-input grow team-notes" data-notes="${key}" placeholder="Indicaciones para este agente (opcional)" value="${esc(value ?? '')}">${fallbackSelect(hostId, `data-fb="${key}"`, (key[0] === 'm' ? st.members[Number(key.slice(1))] : st.adds[Number(key.slice(1))])?.fallback)}<span class="tb-spacer"></span></div>`;
  const draw = () => {
    const live = st.members.filter((m) => !m.remove);
    const executors = live.filter((m) => m.role === 'executor').length + st.adds.filter((a) => a.role === 'executor').length;
    s.el.innerHTML = `<div class="sheet-title">${icon('person.3.sequence', { size: 16 })} Editar el equipo</div>
      <div class="sheet-sub">Los cambios se aplican sin perder nada: cada hilo conserva su historial y su sesión (cambiar de proveedor le pasa el contexto, como un relevo), y el orquestador recibe un aviso con lo que ha cambiado.</div>
      <h3>Objetivo</h3><textarea class="field" data-goal style="min-height:70px;font-family:var(--font);font-size:13px">${esc(st.goal)}</textarea>
      <div class="team-form">
        ${st.members.map((m, i) => { const [ic, cls] = ROLE_UI[m.role] ?? ROLE_UI.executor; return m.remove
          ? `<div class="team-line removed"><span class="team-role ${cls}">${icon(ic, { size: 12 })} ${esc(m.name)}</span><span class="caption grow">Sale del equipo (su hilo se conserva como uno normal)</span><button class="btn small" data-undo="${i}">Deshacer</button></div>`
          : `<div class="team-line"><span class="team-role ${cls}">${icon(ic, { size: 12 })} ${nameField(`m${i}`, m)}</span>${selects(`m${i}`, m)}${m.role === 'orchestrator' ? '<span class="tb-spacer"></span>' : `<button class="tb-btn" data-rm="${i}" title="Sacar del equipo"${m.role === 'executor' && executors <= 1 ? ' disabled' : ''}>${icon('minus.circle', { size: 15 })}</button>`}</div>${notesRow(`m${i}`, m.notes)}`; }).join('')}
        ${st.adds.map((a, i) => { const [ic, cls] = ROLE_UI[a.role]; return `<div class="team-line"><span class="team-role ${cls}">${icon(ic, { size: 12 })} ${a.role === 'executor' ? 'Ejecutor nuevo' : 'Investigador'}</span>${selects(`a${i}`, a)}<button class="tb-btn" data-rm-add="${i}" title="Quitar">${icon('minus.circle', { size: 15 })}</button></div>${notesRow(`a${i}`, a.notes)}`; }).join('')}
        <div class="team-line"><span class="team-role"></span><button class="btn small" data-add-exec${executors >= 4 ? ' disabled' : ''}>${icon('plus', { size: 10 })} Añadir ejecutor</button>${hasResearcher() ? '' : `<button class="btn small" data-add-res>${icon('plus', { size: 10 })} Añadir investigador</button>`}</div>
        ${allFallbackRow(hostId, sharedFallback())}
      </div>
      ${has(hostId, 'guard') ? `<div class="form-group" style="margin-top:12px"><div class="form-row"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" data-guard${st.guard ? ' checked' : ''}> Guardarraíl: Relevo detiene y te pregunta antes de borrados recursivos, descartes de git o escrituras fuera de la carpeta del proyecto (recomendado, también con acceso total)</label></div></div>` : ''}
      ${has(hostId, 'leadApproves') ? `<div class="form-group" style="margin-top:12px"><div class="form-row"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" data-lead-approves${st.leadApproves ? ' checked' : ''}> El orquestador decide los permisos de los demás agentes: permite lo que encaja con su tarea y te pasa lo delicado. Los borrados también: permite los que sobran claramente y, si no lo ve claro, el agente busca otra forma o lo anota en .relevo/borrados-pendientes.md. Formatear discos, tocar la raíz de un disco o un push forzado te llegan siempre a ti</label></div></div>` : ''}
      ${has(hostId, 'teamBudget') ? `<div class="form-group" style="margin-top:12px"><div class="form-row"><span class="grow">Presupuesto diario <span class="caption">(${team.members.some((m) => m.today?.cost) ? `hoy van ${usd(team.members.reduce((n, m) => n + (m.today?.cost ?? 0), 0))}` : 'coste equivalente a la API'})</span></span><input class="field-input" data-budget type="number" min="0" step="1" placeholder="sin límite" style="width:110px" value="${st.budget.usd || ''}"> USD <select class="field" data-budget-action>${[['pause', 'y entonces pausar'], ['light', 'y entonces abaratar']].map(([v, l]) => `<option value="${v}"${st.budget.action === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div><div class="caption" style="padding:0 10px 8px">Abaratar: el orquestador y el investigador pasan a modelos ligeros; los ejecutores siguen igual.</div></div>` : ''}
      ${st.adds.some((a) => a.role === 'executor') && has(hostId, 'worktrees') ? `<div class="form-group" style="margin-top:12px"><div class="form-row"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" data-wt${st.worktrees ? ' checked' : ''}> Los ejecutores nuevos, cada uno en su worktree (si el proyecto es un repositorio git)</label></div></div>` : ''}
      <div class="sheet-buttons"><button class="btn" data-no>Cancelar</button><span class="grow"></span><button class="btn primary" data-go>Guardar cambios</button></div>`;
    const $ = (q) => s.el.querySelector(q);
    const target = (key) => (key[0] === 'm' ? st.members[Number(key.slice(1))] : st.adds[Number(key.slice(1))]);
    const keep = () => { st.goal = $('[data-goal]').value; const g = $('[data-guard]'); if (g) st.guard = g.checked; const la = $('[data-lead-approves]'); if (la) st.leadApproves = la.checked; const b = $('[data-budget]'); if (b) { st.budget.usd = b.value; st.budget.action = $('[data-budget-action]').value; } };
    s.el.querySelectorAll('[data-acc]').forEach((el) => { el.onchange = () => { const r = target(el.dataset.acc); r.accountId = el.value; r.model = visibleModels(accountOf(hostId, el.value))[0]?.id ?? 'default'; keep(); draw(); }; });
    s.el.querySelectorAll('[data-model]').forEach((el) => { el.onchange = () => { target(el.dataset.model).model = el.value; }; });
    s.el.querySelectorAll('[data-notes]').forEach((el) => { el.oninput = () => { target(el.dataset.notes).notes = el.value; }; });
    s.el.querySelectorAll('[data-fb]').forEach((el) => { el.onchange = () => { target(el.dataset.fb).fallback = el.value; keep(); draw(); }; });
    $('[data-fb-all]').onchange = (e) => { if (e.target.value === '*') return; for (const m of everyone()) m.fallback = e.target.value; keep(); draw(); };
    s.el.querySelectorAll('[data-name]').forEach((el) => { el.oninput = () => { target(el.dataset.name).name = el.value; }; });
    s.el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { st.members[Number(b.dataset.rm)].remove = true; keep(); draw(); }; });
    s.el.querySelectorAll('[data-undo]').forEach((b) => { b.onclick = () => { st.members[Number(b.dataset.undo)].remove = false; keep(); draw(); }; });
    s.el.querySelectorAll('[data-rm-add]').forEach((b) => { b.onclick = () => { st.adds.splice(Number(b.dataset.rmAdd), 1); keep(); draw(); }; });
    const fresh = (role) => { const a = usable[0]; return { role, accountId: a?.id, model: visibleModels(a)[0]?.id ?? 'default', notes: '', fallback: has(hostId, 'smartFallback') ? 'auto' : '' }; };
    $('[data-add-exec]').onclick = () => { st.adds.push(fresh('executor')); keep(); draw(); };
    $('[data-add-res]')?.addEventListener('click', () => { st.adds.push(fresh('researcher')); keep(); draw(); });
    $('[data-wt]')?.addEventListener('change', (e) => { st.worktrees = e.target.checked; });
    $('[data-no]').onclick = s.close;
    $('[data-go]').onclick = async () => {
      keep();
      const before = JSON.parse(original);
      for (const m of st.members) m.name = String(m.name ?? '').replace(/\s+/g, ' ').trim();
      const names = st.members.filter((m) => !m.remove).map((m) => m.name.toLowerCase());
      if (names.some((n) => !n)) { toast('Cada agente necesita un nombre'); return; }
      if (new Set(names).size !== names.length) { toast('Dos agentes no pueden llamarse igual'); return; }
      const changes = {
        goal: st.goal.trim() !== team.goal ? st.goal.trim() : undefined,
        members: st.members.filter((m, i) => !m.remove && JSON.stringify({ threadId: m.threadId, accountId: m.accountId, model: m.model, notes: m.notes, fallback: m.fallback, name: m.name }) !== JSON.stringify(before[i])).map(({ threadId, accountId, model, notes, fallback, name }) => ({ threadId, accountId, model, notes, fallback, name: canRename ? name : undefined })),
        remove: st.members.filter((m) => m.remove).map((m) => m.threadId),
        add: { executors: st.adds.filter((a) => a.role === 'executor'), researcher: st.adds.find((a) => a.role === 'researcher') ?? null },
        worktrees: st.worktrees,
        budget: has(hostId, 'teamBudget') && (String(st.budget.usd ?? '') !== String(team.budget?.usd ?? '') || st.budget.action !== (team.budget?.action ?? 'pause')) ? { usd: Number(st.budget.usd) || 0, action: st.budget.action } : undefined,
      };
      $('[data-go]').disabled = true;
      const making = st.adds.some((x) => x.role === 'executor') && st.worktrees !== false;
      $('[data-go]').innerHTML = `<span class="spinner"></span> ${making ? 'Creando su worktree… (en un repositorio grande tarda unos minutos)' : 'Guardando…'}`;
      if (has(hostId, 'guard') && st.guard !== (team.guard !== false)) { const g = await request(hostId, { setGuard: { teamId, on: st.guard } }); if (!g.ok) toast(g.error); }
      if (has(hostId, 'leadApproves') && st.leadApproves !== (team.leadApproves !== false)) { const g = await request(hostId, { setLeadApproves: { teamId, on: st.leadApproves } }); if (!g.ok) toast(g.error); }
      const r = await request(hostId, { updateTeam: { teamId, changes } }, making ? 25 * 60_000 : undefined);
      if (!r.ok) { toast(r.error); $('[data-go]').disabled = false; $('[data-go]').textContent = 'Guardar cambios'; return; }
      s.close();
      toast('Equipo actualizado');
    };
  };
  draw();
}

// MARK: - Held messages

/** What the team held while paused: send or drop each message (much of it goes stale), or all at once. */
export function openHeldMessages(hostId, teamId) {
  const s = openSheet({ width: 680 });
  let busy = false;
  const draw = () => {
    const team = snap(hostId)?.hostTeams?.find((x) => x.id === teamId);
    if (!team) { s.close(); return; }
    const list = team.heldList ?? [];
    const when = (at) => (at ? new Date(at * 1000).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    s.el.innerHTML = `<div class="sheet-title">${icon('pause.circle', { size: 16 })} Mensajes retenidos</div>
      <div class="sheet-sub">Mensajes entre agentes que no se entregaron porque el equipo estaba en pausa. Revísalos: muchos pueden estar ya desactualizados. Si descartas una orden, el orquestador se entera y no la da por hecha.</div>
      <div class="decisions">${list.length ? list.map((m) => `<div class="decision"><div class="grow"><div class="caption"><b>${esc(m.from)}${m.label ? ` · ${esc(m.label)}` : ''}</b> → <b>${esc(m.to)}</b> · ${esc(when(m.at))}</div><div class="f-sum selectable" style="color:var(--text);max-height:160px">${esc(m.text)}</div></div><div style="display:flex;flex-direction:column;gap:4px"><button class="btn small primary" data-send="${esc(m.id)}">Enviar</button><button class="btn small" data-drop="${esc(m.id)}">Descartar</button></div></div>`).join('')
        : '<div class="caption" style="padding:10px 2px">No queda ningún mensaje retenido.</div>'}</div>
      <div class="sheet-buttons">${list.length > 1 ? '<button class="btn" data-drop-all>Descartar todos</button>' : ''}<span class="grow"></span><button class="btn" data-close>Listo</button></div>`;
    const send = async (id, action) => {
      if (busy) return;
      busy = true;
      const r = await request(hostId, { teamHeld: { teamId, id, action } });
      busy = false;
      if (!r.ok) { toast(r.error); return; }
      setTimeout(draw, 200); setTimeout(draw, 800);
    };
    s.el.querySelectorAll('[data-send]').forEach((b) => { b.onclick = () => send(b.dataset.send, 'send'); });
    s.el.querySelectorAll('[data-drop]').forEach((b) => { b.onclick = () => send(b.dataset.drop, 'discard'); });
    s.el.querySelector('[data-drop-all]')?.addEventListener('click', () => send('*', 'discard'));
    s.el.querySelector('[data-close]').onclick = s.close;
  };
  draw();
}

// MARK: - Team memory (milestones, decisions, research)

/** Tokens and cost, short: "120k tokens · $0,40". */
export function spendText(sp) {
  if (!sp?.tokens) return '';
  return `${shortTokens(sp.tokens)} tokens${sp.cost ? ` · ${sp.estimated ? '≈ ' : ''}${usd(sp.cost)}` : ''}`;
}

/**
 * What the team keeps across sessions and relays: the goal's milestones, the decisions taken and what the
 * researcher found. Relevo reminds the agents of it; here you see it and change it.
 */
export function openTeamMemory(hostId, teamId, tab = 'milestones') {
  const s = openSheet({ width: 660 });
  let busy = false;
  const full = has(hostId, 'teamMemory');
  const draw = () => {
    const team = snap(hostId)?.hostTeams?.find((x) => x.id === teamId);
    if (!team) { s.close(); return; }
    const when = (at) => (at ? new Date(at * 1000).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    const ms = team.milestones ?? [], ds = team.decisions ?? [], fs = team.findings ?? [];
    const tabs = [['milestones', 'Hitos', ms.length ? `${ms.filter((m) => m.done).length}/${ms.length}` : ''], ['decisions', 'Decisiones', ds.length || ''], ['findings', 'Investigado', fs.length || '']].filter(([k]) => full || k === 'decisions');
    if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
    let body = '';
    if (tab === 'milestones') {
      const current = ms.find((m) => !m.done);
      body = `<div class="caption" style="margin-bottom:6px">Los pasos hacia el objetivo. El orquestador los escribe con <code>&lt;relevo:hito&gt;</code> y marca los conseguidos con <code>&lt;relevo:hecho&gt;</code>; los tiene presentes en cada sesión.</div>`
        + (ms.length ? `<div class="m-progress"><i style="width:${Math.round((ms.filter((m) => m.done).length / ms.length) * 100)}%"></i></div>` : '')
        + `<div class="decisions">${ms.length ? ms.map((m) => `<div class="decision${m.done ? ' done' : ''}${m === current ? ' current' : ''}"><button class="tb-btn" data-toggle="${m.id}" title="${m.done ? 'Marcar como pendiente' : 'Marcar como conseguido'}">${icon(m.done ? 'checkmark.circle.fill' : m === current ? 'largecircle.fill.circle' : 'circle', { size: 15 })}</button><div class="grow"><div class="d-text selectable">${esc(m.text)}</div><div class="caption">#${m.id}${m.done ? ` · conseguido ${esc(when(m.doneAt))}` : m === current ? ' · en curso' : ''}</div></div><button class="tb-btn" data-drop="${m.id}" title="Quitar este hito">${icon('trash', { size: 12 })}</button></div>`).join('')
          : '<div class="caption" style="padding:10px 2px">Aún no hay hitos. El orquestador los escribirá al planificar, o añádelos tú.</div>'}</div>
        <div class="team-line" style="margin-top:10px"><input class="field-input grow" data-new placeholder="Un hito comprobable (p. ej. «el menú principal se ve»)" maxlength="240"><button class="btn primary" data-add>Añadir</button></div>`;
    } else if (tab === 'decisions') {
      body = `<div class="caption" style="margin-bottom:6px">Lo ya decidido, que no debe reabrirse. El orquestador las guarda con <code>&lt;relevo:decision&gt;</code>; Relevo se las da a cada agente nuevo, en cada sesión renovada y en cada relevo de proveedor.</div>
        <div class="decisions">${ds.length ? ds.map((d) => `<div class="decision"><span class="d-id">#${d.id}</span><div class="grow"><div class="d-text selectable">${esc(d.text)}</div><div class="caption">${d.by === 'usuario' ? 'Tú' : esc(d.by ?? '')} · ${esc(when(d.at))}</div></div><button class="tb-btn" data-drop="${d.id}" title="Retirar esta decisión (se avisa al orquestador)">${icon('trash', { size: 12 })}</button></div>`).join('')
          : '<div class="caption" style="padding:10px 2px">Aún no hay ninguna. Añade las que ya estén claras (por ejemplo, qué proyecto usáis de base).</div>'}</div>
        <div class="team-line" style="margin-top:10px"><input class="field-input grow" data-new placeholder="Una decisión, en una línea: qué y por qué" maxlength="400"><button class="btn primary" data-add>Añadir</button></div>`;
    } else {
      body = `<div class="caption" style="margin-bottom:6px">Cada informe del investigador, guardado. Antes de investigar algo nuevo, Relevo le recuerda al equipo lo que ya se sabe para no repetir búsquedas.</div>
        <div class="decisions">${fs.length ? [...fs].reverse().map((f) => `<div class="decision"><span class="d-id">#${f.id}</span><div class="grow"><div class="d-text selectable"><b>${esc(f.topic)}</b></div><div class="f-sum selectable">${esc(f.summary)}</div>${f.links?.length ? `<div class="f-links">${f.links.map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener">${esc(l.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</a>`).join('')}</div>` : ''}<div class="caption">${esc(f.by ?? '')} · ${esc(when(f.at))}</div></div><button class="tb-btn" data-drop="${f.id}" title="Quitar de la biblioteca">${icon('trash', { size: 12 })}</button></div>`).join('')
          : '<div class="caption" style="padding:10px 2px">Aún no hay informes. Cuando el investigador termine uno, aparecerá aquí.</div>'}</div>`;
    }
    s.el.innerHTML = `<div class="sheet-title">${icon('checklist', { size: 16 })} Memoria del equipo</div>
      <div class="seg mem-tabs">${tabs.map(([k, l, n]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}${n !== '' ? ` <span class="n">${n}</span>` : ''}</button>`).join('')}</div>
      ${body}
      <div class="sheet-buttons"><span class="grow"></span><button class="btn" data-close>Listo</button></div>`;
    const $ = (q) => s.el.querySelector(q);
    const kind = { milestones: 'milestone', decisions: 'decision', findings: 'finding' }[tab];
    const send = async (op) => {
      if (busy) return;
      busy = true;
      const r = full ? await request(hostId, { teamMemory: { teamId, kind, ...op } }) : await request(hostId, { teamDecisions: { teamId, ...op } });
      busy = false;
      if (!r.ok) { toast(r.error); return; }
      setTimeout(draw, 200); setTimeout(draw, 800); // the snapshot with the change is on its way
    };
    s.el.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; draw(); }; });
    $('[data-add]')?.addEventListener('click', () => { const v = $('[data-new]').value.trim(); if (v) send({ add: v }); else $('[data-new]').focus(); });
    $('[data-new]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-add]').click(); } });
    s.el.querySelectorAll('[data-drop]').forEach((b) => { b.onclick = () => send({ remove: b.dataset.drop }); });
    s.el.querySelectorAll('[data-toggle]').forEach((b) => { b.onclick = () => send({ toggle: b.dataset.toggle }); });
    $('[data-close]').onclick = s.close;
    setTimeout(() => $('[data-new]')?.focus(), 0);
  };
  draw();
}

// MARK: - Traza (WorkStateSheet)

export async function openTraza(hostId, threadId) {
  const s = openSheet({ width: 720, minHeight: 620, body: `<div class="sheet-buttons"><div class="grow"><div style="font-size:15px;font-weight:600">Estado del trabajo</div><div class="caption">Lo que recibiría otro agente si relevas ahora: petición, dónde se quedó, ficheros tocados y git</div></div><button class="btn" data-copy>${icon('doc.on.doc', { size: 12 })} Copiar</button><button class="btn" data-close>Cerrar</button></div><div data-body class="center"><span class="spinner big"></span><div>Leyendo traza y git…</div></div>` });
  s.el.querySelector('[data-close]').onclick = s.close;
  const r = await request(hostId, { workState: { threadId } });
  const md = r.ok ? r.markdown : '';
  const body = s.el.querySelector('[data-body]');
  body.className = 'md';
  body.style.padding = '0 4px';
  body.innerHTML = md ? markdown(md) : `<div class="muted">${esc(r.ok ? 'Todavía no hay traza para este hilo.' : r.error)}</div>`;
  s.el.querySelector('[data-copy]').onclick = () => copyText(md);
}

// MARK: - Out-of-quota plan editor (LimitPlanEditor)

export function openLimitPlanEditor(hostId, threadId) {
  const thread = threadId ? threadOf(hostId, threadId) : null;
  const base = threadId ? (thread?.runtime?.limitPlan ?? thread?.runtime?.defaultLimitPlan) : snap(hostId)?.hostSettings?.limitPlan;
  const plan = { mode: base?.mode ?? 'ask', targets: [...(base?.targets ?? [])], tier: base?.tier ?? 'heavy' };
  const s = openSheet({ width: 520 });
  const draw = () => {
    const modes = [['ask', 'Avisarme y decidir yo'], ...(has(hostId, 'smartFallback') ? [['smart', 'Automático: el mejor modelo con cuota (y volver cuando haya)']] : []), ['mostQuota', 'Pasar a la suscripción con más cuota'], ['chain', 'Pasar a las que elija, en orden'], ['wait', 'Esperar a que vuelva a haber cuota o saldo y seguir con el mismo modelo']];
    s.el.innerHTML = `<div class="sheet-title">${threadId ? 'Si se acaba la cuota en este hilo' : 'Si se acaba la cuota (por defecto)'}</div>
      <div style="display:flex;flex-direction:column;gap:6px">${modes.map(([m, l]) => `<label><input type="radio" name="pm" value="${m}"${plan.mode === m ? ' checked' : ''}> ${l}</label>`).join('')}</div>
      ${plan.mode === 'chain' ? `<div class="caption">Se prueban en este orden; las que también estén sin cuota se saltan. Si no queda ninguna, el hilo espera a que se reinicie la cuota y sigue. Tras un relevo automático, el hilo vuelve solo a su modelo de antes en cuanto recupera la cuota (lo comprueba antes de cada turno).</div>
        <div style="display:flex;flex-direction:column;gap:6px">${plan.targets.map((t, i) => { const a = accountOf(hostId, t.accountId); return `<div class="form-group"><div class="form-row" style="padding:6px 10px"><span class="mono muted" style="width:22px;text-align:right">${i + 1}.</span>${badge(a, 16)}<span class="grow">${a ? `${esc(a.name)} · ${esc(modelName(a, t.model))}` : 'Suscripción eliminada'}</span><button class="tb-btn" data-up="${i}"${i ? '' : ' disabled'}>${icon('chevron.up', { size: 11 })}</button><button class="tb-btn" data-down="${i}"${i < plan.targets.length - 1 ? '' : ' disabled'}>${icon('chevron.down', { size: 11 })}</button><button class="tb-btn" data-rm="${i}">${icon('minus.circle', { size: 13 })}</button></div></div>`; }).join('')}</div>
        <div><button class="btn" data-add>Añadir ${icon('chevron.down', { size: 9 })}</button></div>`
      : plan.mode === 'smart' ? `<div class="caption">Cuando se acaba, Relevo elige entre todas las suscripciones el mejor modelo que tenga cuota (saltando las que estén casi agotadas). Si la cuota del modelo de antes vuelve, regresa a él antes del siguiente turno; si no queda ninguno, espera al reinicio.</div>
        <div style="display:flex;gap:14px"><label><input type="radio" name="tier" value="heavy"${plan.tier !== 'light' ? ' checked' : ''}> El más potente</label><label><input type="radio" name="tier" value="light"${plan.tier === 'light' ? ' checked' : ''}> Uno ligero y barato</label></div>`
      : plan.mode === 'wait' ? '<div class="caption">A la hora del reinicio (o en cuanto vuelva a haber cuota, si el proveedor no la dice), Relevo le pide al mismo agente que siga donde lo dejó. Su sesión conserva todo el contexto. Hace falta que el host esté encendido.</div>' : ''}
      <div class="sheet-buttons"><span class="grow"></span><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes${plan.mode === 'chain' && !plan.targets.length ? ' disabled' : ''}>Guardar</button></div>`;
    s.el.querySelectorAll('input[name=pm]').forEach((r) => { r.onchange = () => { plan.mode = r.value; draw(); }; });
    s.el.querySelectorAll('input[name=tier]').forEach((r) => { r.onchange = () => { plan.tier = r.value; }; });
    s.el.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => { const i = Number(b.dataset.up); [plan.targets[i - 1], plan.targets[i]] = [plan.targets[i], plan.targets[i - 1]]; draw(); }; });
    s.el.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => { const i = Number(b.dataset.down); [plan.targets[i + 1], plan.targets[i]] = [plan.targets[i], plan.targets[i + 1]]; draw(); }; });
    s.el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { plan.targets.splice(Number(b.dataset.rm), 1); draw(); }; });
    s.el.querySelector('[data-add]')?.addEventListener('click', (e) => showMenu(e.currentTarget, (snap(hostId)?.accounts ?? []).flatMap((a) => [{ section: a.name }, ...visibleModels(a).map((m) => ({ label: m.name, action: () => { plan.targets.push({ accountId: a.id, model: m.id }); draw(); } }))])));
    s.el.querySelector('[data-no]').onclick = s.close;
    s.el.querySelector('[data-yes]').onclick = async () => {
      const p = { mode: plan.mode, targets: plan.mode === 'chain' ? plan.targets : [], ...(plan.mode === 'smart' ? { tier: plan.tier } : {}) };
      if (threadId) sendTo(hostId, Client.setLimitPlan(threadId, p));
      else { const r = await request(hostId, { setSettings: { settings: { limitPlan: p } } }); if (!r.ok) toast(r.error); }
      s.close();
      settingsOpen?.redraw();
    };
  };
  draw();
}

// MARK: - Images

export async function imageViewer(hostId, threadId, path) {
  const s = openSheet({ width: 900, body: `<div class="sheet-buttons"><div class="grow" style="font-weight:600">${esc(path.split(/[\\/]/).pop())}</div><button class="btn" data-copy-img disabled>Copiar imagen</button><button class="btn" data-copy-path>Copiar ruta</button><button class="btn" data-close>Cerrar</button></div><div class="viewer"><span class="spinner big"></span></div>` });
  s.el.querySelector('[data-close]').onclick = s.close;
  s.el.querySelector('[data-copy-path]').onclick = () => copyText(path, 'Ruta copiada');
  const url = await imageData(hostId, threadId, path, 2400);
  s.el.querySelector('.viewer').innerHTML = url ? `<img src="${url}" alt="">` : '<div class="muted">No se ha podido cargar la imagen.</div>';
  const b = s.el.querySelector('[data-copy-img]');
  b.disabled = !url;
  b.onclick = () => copyImage(url);
}

/** Puts an image on the clipboard as PNG (which every app accepts). */
export async function copyImage(url) {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Imagen copiada');
  } catch (e) {
    toast(`No he podido copiar la imagen: ${e.message}`);
  }
}
