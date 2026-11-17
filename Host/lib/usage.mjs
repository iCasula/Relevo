// Token and cost statistics from the turns stored in the threads (each closing item carries its `usage`):
// per model and subscription, per day and per thread, over a period. The Mac's «Consumo» window in small.

const DAY = 86_400;

const dayKey = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function usageReport(threads, accountsById, { days = 30 } = {}) {
  const since = days > 0 ? Date.now() / 1000 - days * DAY : 0;
  const byModel = new Map(), byDay = new Map(), byThread = new Map();
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ tokens: 0, turns: 0, cost: 0 })));
  const total = { turns: 0, tokens: 0, cost: 0 };
  for (const t of threads) {
    for (const item of t.items) {
      const u = item.usage;
      if (!u || (item.date ?? 0) < since) continue;
      const account = accountsById.get(item.accountId ?? t.accountId);
      const key = `${account?.id ?? '?'}|${item.model ?? 'default'}`;
      const cost = u.cost ?? 0;
      const add = (map, k, init) => {
        const e = map.get(k) ?? { ...init, turns: 0, tokens: 0, cost: 0 };
        e.turns++; e.tokens += u.tokens ?? 0; e.cost += cost;
        map.set(k, e);
      };
      add(byModel, key, { accountId: account?.id ?? null, accountName: account?.name ?? 'Suscripción eliminada', model: item.model ?? 'default', kind: account?.kind ?? null });
      add(byDay, dayKey(item.date), { day: dayKey(item.date), byProvider: {} });
      const day = byDay.get(dayKey(item.date));
      const kind = account?.kind ?? 'other';
      const provider = kind.startsWith('api:') ? kind.slice(4) : kind.split(':')[0]; // claude, codex, gemini, deepseek…
      day.byProvider[provider] = (day.byProvider[provider] ?? 0) + (u.tokens ?? 0);
      day.costByProvider = day.costByProvider ?? {};
      day.costByProvider[provider] = (day.costByProvider[provider] ?? 0) + cost;
      const d = new Date(item.date * 1000);
      const cell = heat[(d.getDay() + 6) % 7][d.getHours()]; // Monday first
      cell.tokens += u.tokens ?? 0; cell.turns++; cell.cost += cost;
      total.cacheTokens = (total.cacheTokens ?? 0) + (u.cacheShare ? (u.tokens ?? 0) * u.cacheShare : 0);
      add(byThread, t.id, { threadId: t.id, title: t.title });
      total.turns++; total.tokens += u.tokens ?? 0; total.cost += cost;
    }
  }
  return {
    days, total, heat,
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byThread: [...byThread.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
  };
}
