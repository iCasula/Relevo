// macOS-style building blocks for the desktop app: menus (sections, submenus, checkmarks, icons, shortcuts),
// popovers anchored to a control, sheets, alerts, the toast capsule, and the folder browser.

import { esc } from './markdown.mjs';
import { icon } from './icons.mjs';

// MARK: - Menus

let menus = [];

/**
 * A menu at an anchor (an element, or {x, y}). Items: '-' (divider), { section: 'Título' }, or
 * { label, icon, checked, disabled, danger, shortcut, help, action, submenu: [...] }.
 */
export function showMenu(anchor, items, { level = 0, alignRight = false } = {}) {
  if (level === 0) closeMenus();
  else closeMenus(level);
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  const anyChecks = items.some((it) => it && it.checked !== undefined);
  const anyIcons = items.some((it) => it && it.icon);
  menu.innerHTML = items.map((it, i) => {
    if (it === '-') return '<div class="menu-sep"></div>';
    if (it.section !== undefined) return `<div class="menu-section">${esc(it.section)}</div>`;
    if (it.info !== undefined) return `<div class="menu-info">${esc(it.info)}</div>`;
    const check = anyChecks ? `<span class="menu-check">${it.checked ? icon('checkmark', { size: 12 }) : ''}</span>` : '';
    const ic = anyIcons ? `<span class="menu-icon">${it.icon ? icon(it.icon, { size: 14 }) : ''}</span>` : '';
    const right = it.submenu ? `<span class="menu-sub">${icon('chevron.right', { size: 11 })}</span>` : it.shortcut ? `<span class="menu-shortcut">${esc(it.shortcut)}</span>` : '';
    return `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}${it.submenu ? ' has-sub' : ''}"${it.disabled ? ' disabled' : ''}${it.help ? ` title="${esc(it.help)}"` : ''}>${check}${ic}<span class="menu-label">${esc(it.label)}</span>${right}</button>`;
  }).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  let x, y;
  if (anchor instanceof Element) {
    const a = anchor.getBoundingClientRect();
    if (level > 0) { x = a.right + 2; y = a.top - 5; if (x + r.width > innerWidth - 6) x = a.left - r.width - 2; }
    else { x = alignRight ? a.right - r.width : a.left; y = a.bottom + 4; if (y + r.height > innerHeight - 6) y = a.top - r.height - 4; }
  } else { x = anchor.x; y = anchor.y; }
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 6))}px`;
  menu.dataset.level = level;
  menus.push(menu);
  menu.addEventListener('mouseover', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b || b.disabled) return;
    const it = items[Number(b.dataset.i)];
    if (it.submenu) { if (menus[level + 1]?.dataset.parent !== b.dataset.i) { showMenu(b, it.submenu, { level: level + 1 }); menus.at(-1).dataset.parent = b.dataset.i; } }
    else closeMenus(level + 1);
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b || b.disabled) return;
    const it = items[Number(b.dataset.i)];
    if (it.submenu) return;
    closeMenus();
    it.action?.();
  });
  return menu;
}

export function closeMenus(fromLevel = 0) {
  while (menus.length > fromLevel) menus.pop().remove();
}

document.addEventListener('mousedown', (e) => {
  if (menus.length && !menus.some((m) => m.contains(e.target))) closeMenus();
  if (popover && !popover.el.contains(e.target) && !popover.anchor.contains(e.target)) closePopover();
});
addEventListener('blur', () => closeMenus());
addEventListener('resize', () => { closeMenus(); closePopover(); });

// MARK: - Popovers

let popover = null;

/** A popover under (or beside) a control, with the little arrow, like SwiftUI's .popover. */
export function openPopover(anchor, html, { width = 300, edge = 'bottom' } = {}) {
  if (popover?.anchor === anchor) { closePopover(); return null; }
  closePopover();
  const el = document.createElement('div');
  el.className = `popover edge-${edge}`;
  el.style.width = `${width}px`;
  el.innerHTML = html;
  document.body.appendChild(el);
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let x, y;
  if (edge === 'right') { x = a.right + 10; y = a.top + a.height / 2 - 30; }
  else if (edge === 'top') { x = a.left + a.width / 2 - r.width / 2; y = a.top - r.height - 10; }
  else { x = a.left + a.width / 2 - r.width / 2; y = a.bottom + 10; }
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  popover = { el, anchor };
  return { el, close: closePopover };
}

export function closePopover() { popover?.el.remove(); popover = null; }

// MARK: - Sheets and alerts

/** A modal sheet (centered, dimmed backdrop). Returns { el, close }. Esc closes it unless `locked`. */
export function openSheet({ width = 520, minHeight, body = '', onClose, className = '', focus = true } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet ${className}" role="dialog" aria-modal="true" style="width:min(${typeof width === 'number' ? `${width}px` : width}, calc(100vw - 32px))${minHeight ? `;min-height:min(${minHeight}px, calc(100vh - 48px))` : ''}">${body}</div>`;
  document.body.appendChild(backdrop);
  let closed = false;
  const close = () => { if (closed) return; closed = true; backdrop.remove(); onClose?.(); };
  backdrop.close = close;
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  if (focus) setTimeout(() => backdrop.querySelector('[autofocus], textarea, input:not([type=checkbox]):not([type=radio]), .btn.primary')?.focus(), 0);
  return { el: backdrop.querySelector('.sheet'), close, backdrop };
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (menus.length) { closeMenus(); e.preventDefault(); return; }
  if (popover) { closePopover(); e.preventDefault(); return; }
  const top = [...document.querySelectorAll('.sheet-backdrop')].pop();
  if (top) { top.close?.(); e.preventDefault(); }
});

/**
 * A macOS alert: title, message and buttons ({ label, role: 'default'|'cancel'|'destructive' }).
 * Resolves the chosen label (or null when cancelled).
 */
export function alertSheet({ title, message = '', buttons = [{ label: 'OK', role: 'default' }] }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = openSheet({ width: 300, className: 'alert', onClose: () => { if (!answered) resolve(null); }, body: `
      <div class="alert-icon">${icon('exclamationmark.triangle', { size: 34 })}</div>
      <div class="alert-title">${esc(title)}</div>${message ? `<div class="alert-msg">${esc(message)}</div>` : ''}
      <div class="alert-buttons">${buttons.map((b, i) => `<button class="btn ${b.role === 'default' ? 'primary' : ''} ${b.role === 'destructive' ? 'destructive' : ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</div>` });
    s.el.querySelector('.alert-icon').hidden = !buttons.some((b) => b.role === 'destructive');
    s.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      answered = true;
      const chosen = buttons[Number(b.dataset.b)];
      resolve(chosen.role === 'cancel' ? null : chosen.label);
      s.close();
    });
  });
}

/** An alert with a text field ("Renombrar hilo"): resolves the text or null. */
export function promptSheet({ title, placeholder = '', value = '', confirm = 'Guardar' }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = openSheet({ width: 300, className: 'alert', onClose: () => { if (!answered) resolve(null); }, body: `
      <div class="alert-title">${esc(title)}</div>
      <input type="text" class="field-input" placeholder="${esc(placeholder)}" value="${esc(value)}" autofocus>
      <div class="alert-buttons"><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>${esc(confirm)}</button></div>` });
    const input = s.el.querySelector('input');
    const done = (v) => { answered = true; resolve(v); s.close(); };
    s.el.querySelector('[data-no]').onclick = () => done(null);
    s.el.querySelector('[data-yes]').onclick = () => done(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); };
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// MARK: - Toast

let toastTimer = 0;
/** The capsule at the bottom of the window (5 s; a new one replaces it; click dismisses). */
export function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.onclick = () => el.classList.remove('show');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

// MARK: - Folder browser

/** Picks a folder on the host (listDirectory requests). Resolves the path or null. */
export function chooseFolder({ title = 'Elegir carpeta', start, confirm = 'Elegir', request }) {
  return new Promise((resolve) => {
    let answered = false, current = null;
    const s = openSheet({ width: 620, onClose: () => { if (!answered) resolve(null); }, body: `
      <div class="sheet-title">${esc(title)}</div>
      <div class="browser">
        <div class="browser-bar"><button class="btn" data-up title="Carpeta superior">${icon('arrow.up', { size: 13 })}</button><input type="text" class="field-input path" spellcheck="false"><button class="btn" data-go>Ir</button></div>
        <div class="browser-roots"></div>
        <div class="browser-list"></div>
      </div>
      <div class="sheet-buttons"><span class="grow"></span><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>${esc(confirm)}</button></div>` });
    const $ = (q) => s.el.querySelector(q);
    const load = async (p) => {
      $('.browser-list').innerHTML = '<div class="muted pad">Cargando…</div>';
      const r = await request({ listDirectory: { path: p ?? null } });
      if (!r.ok) { $('.browser-list').innerHTML = `<div class="red pad">${esc(r.error)}</div>`; return; }
      const dir = r.directory;
      current = dir;
      $('.path').value = dir.path;
      $('[data-up]').disabled = !dir.parent;
      $('.browser-roots').innerHTML = dir.roots.map((root) => `<button class="chip" data-path="${esc(root)}">${esc(root)}</button>`).join('');
      $('.browser-list').innerHTML = dir.folders.length
        ? dir.folders.map((f) => `<button class="folder-row" data-path="${esc(f.path)}">${icon('folder', { size: 15 })}<span>${esc(f.name)}</span>${f.git ? '<span class="pill">git</span>' : ''}</button>`).join('')
        : '<div class="muted pad">Sin subcarpetas</div>';
    };
    s.el.addEventListener('click', (e) => { const b = e.target.closest('[data-path]'); if (b) load(b.dataset.path); });
    $('[data-up]').onclick = () => current?.parent && load(current.parent);
    $('[data-go]').onclick = () => load($('.path').value.trim());
    $('.path').onkeydown = (e) => { if (e.key === 'Enter') load($('.path').value.trim()); };
    $('[data-no]').onclick = () => { answered = true; resolve(null); s.close(); };
    $('[data-yes]').onclick = () => { if (!current) return; answered = true; resolve(current.path); s.close(); };
    load(start);
  });
}

/** Text with its URLs as links. */
export function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
