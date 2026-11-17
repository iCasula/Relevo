// Menus, dialogs and small widgets shared by the desktop app's views.

import { esc } from './markdown.mjs';

let openMenu = null;

/** A context menu at (x, y): items are { label, action, danger, disabled } or '-' for a separator. */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) => (it === '-' ? '<div class="menu-sep"></div>'
    : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}"${it.disabled ? ' disabled' : ''}>${esc(it.label)}</button>`)).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[Number(b.dataset.i)].action?.();
  });
  openMenu = menu;
  menu.querySelector('button:not([disabled])')?.focus();
}
export function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openMenu) { closeMenu(); return; }
  const top = [...document.querySelectorAll('.dialog-backdrop')].pop();
  if (top && !top.dataset.locked) top.remove();
});
addEventListener('blur', closeMenu);

/** A modal dialog; returns { el, close }. `wide` for diffs and lists. */
export function openDialog({ title, body = '', wide = false, onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  backdrop.innerHTML = `<div class="dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title ?? '')}">`
    + `<header class="dialog-head"><h2>${esc(title ?? '')}</h2><button class="icon-btn" data-close title="Cerrar">✕</button></header>`
    + `<div class="dialog-body">${body}</div></div>`;
  document.body.appendChild(backdrop);
  const close = () => { backdrop.remove(); onClose?.(); };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]').onclick = close;
  const observer = new MutationObserver(() => { if (!backdrop.isConnected) { observer.disconnect(); onClose?.(); } });
  observer.observe(document.body, { childList: true });
  setTimeout(() => backdrop.querySelector('input, textarea, select, button.primary')?.focus(), 0);
  return { el: backdrop.querySelector('.dialog-body'), close, backdrop };
}

/** Asks for confirmation; resolves true/false. */
export function confirmDialog({ title, text, confirm = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const d = openDialog({ title, body: `<p>${esc(text)}</p><div class="actions end"><button class="btn" data-no>Cancelar</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" data-yes>${esc(confirm)}</button></div>`,
      onClose: () => { if (!answered) resolve(false); } });
    d.el.querySelector('[data-no]').onclick = () => { answered = true; resolve(false); d.close(); };
    d.el.querySelector('[data-yes]').onclick = () => { answered = true; resolve(true); d.close(); };
  });
}

/** Asks for a line of text; resolves the text or null. */
export function promptDialog({ title, label = '', value = '', confirm = 'Guardar' }) {
  return new Promise((resolve) => {
    let answered = false;
    const d = openDialog({ title, body: `<label class="field"><span>${esc(label)}</span><input type="text" value="${esc(value)}"></label>`
      + `<div class="actions end"><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>${esc(confirm)}</button></div>`,
      onClose: () => { if (!answered) resolve(null); } });
    const input = d.el.querySelector('input');
    const done = () => { answered = true; resolve(input.value.trim() || null); d.close(); };
    d.el.querySelector('[data-no]').onclick = () => { answered = true; resolve(null); d.close(); };
    d.el.querySelector('[data-yes]').onclick = done;
    input.onkeydown = (e) => { if (e.key === 'Enter') done(); };
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/**
 * A folder browser over the host's disks (`listDirectory` requests). Resolves the chosen path or null.
 * `request(message)` sends to the host and resolves its reply.
 */
export function chooseFolder({ title = 'Elegir carpeta', start, confirm = 'Elegir esta carpeta', request }) {
  return new Promise((resolve) => {
    let answered = false, current = null;
    const d = openDialog({ title, wide: true, onClose: () => { if (!answered) resolve(null); }, body: `
      <div class="browser">
        <div class="browser-bar"><button class="btn" data-up title="Carpeta superior">↑</button><input type="text" class="path" spellcheck="false"><button class="btn" data-go>Ir</button></div>
        <div class="browser-roots"></div>
        <div class="browser-list" tabindex="-1"></div>
      </div>
      <div class="actions end"><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>${esc(confirm)}</button></div>` });
    const $ = (s) => d.el.querySelector(s);
    const load = async (p) => {
      $('.browser-list').innerHTML = '<div class="note pad">Cargando…</div>';
      const r = await request({ listDirectory: { path: p ?? null } });
      if (!r.ok) { $('.browser-list').innerHTML = `<div class="note bad pad">${esc(r.error)}</div>`; return; }
      const dir = r.directory;
      current = dir;
      $('.path').value = dir.path;
      $('[data-up]').disabled = !dir.parent;
      $('.browser-roots').innerHTML = dir.roots.map((root) => `<button class="chip" data-path="${esc(root)}">${esc(root)}</button>`).join('');
      $('.browser-list').innerHTML = dir.folders.length
        ? dir.folders.map((f) => `<button class="folder" data-path="${esc(f.path)}"><span class="ficon">📁</span>${esc(f.name)}${f.git ? '<span class="tag">git</span>' : ''}</button>`).join('')
        : '<div class="note pad">Sin subcarpetas</div>';
    };
    d.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-path]');
      if (b) load(b.dataset.path);
    });
    d.el.addEventListener('dblclick', (e) => { const b = e.target.closest('.folder'); if (b) load(b.dataset.path); });
    $('[data-up]').onclick = () => current?.parent && load(current.parent);
    $('[data-go]').onclick = () => load($('.path').value.trim());
    $('.path').onkeydown = (e) => { if (e.key === 'Enter') load($('.path').value.trim()); };
    $('[data-no]').onclick = () => { answered = true; resolve(null); d.close(); };
    $('[data-yes]').onclick = () => { if (!current) return; answered = true; resolve(current.path); d.close(); };
    load(start);
  });
}

/** A unified diff, coloured line by line. */
export function diffHTML(text) {
  if (!text?.trim()) return '<div class="note pad">No hay diferencias.</div>';
  const lines = text.split('\n').map((l) => {
    const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('new file') ? 'meta'
      : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return `<div class="dl ${cls}">${esc(l) || ' '}</div>`;
  });
  return `<div class="diff">${lines.join('')}</div>`;
}

/** Text with its URLs as links. */
export function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
