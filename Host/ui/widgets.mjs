// Small pieces shared by the main window and the sheets: usage bars, account status labels, thread images.

import { esc } from './markdown.mjs';
import { icon } from './icons.mjs';
import { app, request, has, reset, usageColor } from './core.mjs';

/** UsageBar: label · capsule bar (green / orange ≥70 / red ≥90) · percent. */
export function usageBar(w, regular = false) {
  const p = Math.max(0, Math.min(100, w.percent));
  const tip = `${w.label}: ${Math.round(w.percent)}% usado${w.resetsAt ? ` · se reinicia ${reset(w.resetsAt)}` : ''}${w.detail ? ` · ${w.detail}` : ''}`;
  return `<div class="ubar${regular ? ' regular' : ''}" title="${esc(tip)}"><span class="lbl">${esc(w.label)}</span><span class="track"><span class="fill" style="width:${Math.max(3, p)}%;background:${usageColor(w.percent)}"></span></span><span class="pct${w.percent >= 90 ? ' high' : ''}">${Math.round(w.percent)}%</span></div>`;
}

/** AccountStatusLabel. */
export function statusLabel(a) {
  const s = a.status;
  if (a.refreshing && !s) return '<span class="tert caption"><span class="spinner"></span></span>';
  if (s?.loggedIn === false) return `<span class="orange caption">${icon('person.crop.circle.badge.exclamationmark', { size: 11 })} Sin sesión</span>`;
  if (s?.loggedIn) return `<span class="green caption">${icon('checkmark.circle.fill', { size: 11 })} ${esc([s.plan, s.email].filter(Boolean).join(' · ') || 'Conectada')}</span>`;
  if (s?.error) return `<span class="caption">${esc(s.error)}</span>`;
  return '<span class="tert caption">Comprobando…</span>';
}

/** An image the thread mentions, as a data URL (cached per size). */
export async function imageData(hostId, threadId, path, maxPixel) {
  const key = `${hostId}/${threadId}/${maxPixel}/${path}`;
  if (app.images.has(key)) return app.images.get(key);
  const pending = request(hostId, { fetchImage: { threadId, path, maxPixel } }, 30_000).then((r) => {
    if (!r.data) return null;
    const ext = path.split('.').pop().toLowerCase();
    const mime = !has(hostId, 'images') ? 'image/jpeg' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${r.data}`;
  });
  app.images.set(key, pending);
  return pending;
}

/** Quick actions running now (the toolbar shows a spinning gear meanwhile). */
export const running = new Set();
