// Shared by the desktop page (browser) and its gateway in the host (Node): pairing links, protocol messages
// and how a host's state follows them. No Node or DOM APIs here.
//
// Messages follow Swift's synthesized Codable (RelevoProtocol): `{ "case": { "label": value } }`, unlabeled
// values under `_0`, cases without values as `{}`, dates in Unix seconds, UUIDs as uppercase strings.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47820;

/** `relevocompanion://pair?v=1&id=…&name=…&key=…&port=…&addrs=…` → pairing info, or null. */
export function parsePairingLink(link) {
  let url;
  try { url = new URL(String(link).trim()); } catch { return null; }
  if (url.protocol !== 'relevocompanion:') return null;
  // `relevocompanion://pair?…`: browsers put "pair" in host or at the start of the path.
  if (url.host !== 'pair' && !/^\/*pair$/.test(url.pathname)) return null;
  const q = url.searchParams;
  const id = q.get('id'), key = q.get('key');
  if (!id || !key || base64urlLength(key) < 16) return null;
  const port = Number(q.get('port'));
  return {
    serverId: id,
    name: q.get('name') || 'Host',
    key,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    host: q.get('host') || null,
    addresses: (q.get('addrs') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function base64urlLength(s) {
  const clean = s.replace(/=+$/, '');
  return /^[A-Za-z0-9_-]+$/.test(clean) ? Math.floor((clean.length * 3) / 4) : 0;
}

/** A fresh state for one host: what the host shares (snapshot), the transcripts seen and the live activity. */
export function emptyHostData() {
  return { snapshot: null, threads: new Map(), activity: null };
}

/** Applies a server message to a host's state; returns the message's case name. */
export function applyServerMessage(data, msg) {
  const [name] = Object.keys(msg ?? {});
  const a = msg?.[name] ?? {};
  switch (name) {
    case 'snapshot': data.snapshot = a._0; break;
    case 'thread': data.threads.set(a._0.id, a._0); break;
    case 'threadPatch': {
      const t = data.threads.get(a._0.id);
      if (t) data.threads.set(t.id, applyPatch(t, a._0)); // the full transcript always arrives first
      break;
    }
    case 'activity': data.activity = a._0; break;
    default: break;
  }
  return name;
}

/** New or changed items replace theirs by id, in transcript order; title, count and live state follow. */
export function applyPatch(thread, patch) {
  const items = thread.items.slice();
  const index = new Map(items.map((item, i) => [item.id, i]));
  for (const item of patch.upserts) {
    const i = index.get(item.id);
    if (i === undefined) { index.set(item.id, items.length); items.push(item); } else items[i] = item;
  }
  return { ...thread, items, title: patch.title, totalItems: patch.totalItems, runtime: patch.runtime };
}

/** Client messages (desktop → host), shaped as the host decodes them. */
export const Client = {
  hello: (device) => ({ hello: { device, version: PROTOCOL_VERSION } }),
  subscribe: (threadId) => ({ subscribe: threadId ? { threadId } : {} }),
  send: (threadId, text) => ({ send: { threadId, text } }),
  sendNow: (threadId, text) => ({ sendNow: { threadId, text } }),
  dequeue: (threadId, messageId) => ({ dequeue: { threadId, messageId } }),
  sendQueuedNow: (threadId, messageId) => ({ sendQueuedNow: { threadId, messageId } }),
  resumeQueue: (threadId) => ({ resumeQueue: { threadId } }),
  stop: (threadId) => ({ stop: { threadId } }),
  approve: (threadId, itemId, optionId) => ({ approve: { threadId, itemId, optionId } }),
  answer: (threadId, itemId, answers) => ({ answer: { threadId, itemId, answers } }),
  select: (threadId, accountId, model) => ({ select: { threadId, accountId, model } }),
  relay: (threadId, accountId, model) => ({ relay: { threadId, accountId, model } }),
  setEffort: (threadId, effort) => ({ setEffort: effort ? { threadId, effort } : { threadId } }),
  setMode: (threadId, mode) => ({ setMode: { threadId, mode } }),
  setDraft: (threadId, text) => ({ setDraft: { threadId, text } }),
  suggestion: (threadId, action) => ({ suggestion: { threadId, action } }),
  setLimitPlan: (threadId, plan) => ({ setLimitPlan: plan ? { threadId, plan } : { threadId } }),
  limitAction: (threadId, action) => ({ limitAction: { threadId, action } }),
  newThread: (projectId, requestId) => ({ newThread: { projectId, requestId } }),
  refreshUsage: () => ({ refreshUsage: {} }),
};

export const uuid = () => (globalThis.crypto?.randomUUID?.() ?? fallbackUUID()).toUpperCase();
function fallbackUUID() {
  const h = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
