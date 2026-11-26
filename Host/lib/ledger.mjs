// The teams' ledger: each team's board of tasks and its log (what was done and checked, reports, decisions that
// left the active list, audits). It lives in SQLite (node:sqlite, with full-text search) so the orchestrator
// doesn't have to carry the history in its context: Relevo shows it the open tasks and finds the rest when asked.
// On a Node without SQLite, the same in a JSON file (search by words, without the index).

import fs from 'node:fs';
import path from 'node:path';

/** A task's states: open ones need something from someone; closed ones are history. */
export const OPEN_STATES = ['pendiente', 'en curso', 'bloqueada', 'hecha', 'pausada'];
export const CLOSED_STATES = ['verificada', 'descartada'];

const words = (q) => String(q ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[\p{L}\p{N}_.#-]{2,}/gu) ?? [];

async function loadSQLite() {
  // node:sqlite says it's experimental on every start: once is enough, in the log.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => { if (!/SQLite/i.test(String(w?.message ?? w))) emit.call(process, w, ...rest); };
  try { return (await import('node:sqlite')).DatabaseSync; } catch { return null; } finally { process.emitWarning = emit; }
}

const DatabaseSync = await loadSQLite();

/** The ledger in `dir` (ledger.db, or ledger.json without SQLite). `memory`: nothing on disk (tests); `json`: without SQLite. */
export function openLedger(dir, { memory = false, json = false } = {}) {
  if (DatabaseSync && !json) {
    try { return new SQLiteLedger(memory ? ':memory:' : path.join(dir, 'ledger.db')); } catch {}
  }
  return new JSONLedger(memory ? null : path.join(dir, 'ledger.json'));
}

class SQLiteLedger {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.kind = 'sqlite';
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks(
        team TEXT NOT NULL, id INTEGER NOT NULL, owner TEXT NOT NULL, milestone INTEGER, kind TEXT NOT NULL DEFAULT 'tarea',
        text TEXT NOT NULL, state TEXT NOT NULL, by TEXT, created REAL NOT NULL, updated REAL NOT NULL, result TEXT,
        PRIMARY KEY(team, id));
      CREATE TABLE IF NOT EXISTS log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, ts REAL NOT NULL, kind TEXT NOT NULL,
        by TEXT, ref TEXT, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS log_team ON log(team, id);
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(text, content='log', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER IF NOT EXISTS log_ai AFTER INSERT ON log BEGIN INSERT INTO log_fts(rowid, text) VALUES (new.id, new.text); END;
        CREATE TRIGGER IF NOT EXISTS log_ad AFTER DELETE ON log BEGIN INSERT INTO log_fts(log_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      `);
      this.fts = true;
    } catch { this.fts = false; }
  }

  addTask(team0, { owner, milestone = null, kind = 'tarea', text, state = 'en curso', by = null }) {
    const team = String(team0 ?? '');
    const now = Date.now() / 1000;
    const id = (this.db.prepare('SELECT MAX(id) AS n FROM tasks WHERE team = ?').get(team)?.n ?? 0) + 1;
    this.db.prepare('INSERT INTO tasks(team, id, owner, milestone, kind, text, state, by, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(team, id, owner, milestone, kind, text, state, by, now, now);
    return this.task(team, id);
  }

  task(team0, id) {
    const team = String(team0 ?? '');
    return row(this.db.prepare('SELECT * FROM tasks WHERE team = ? AND id = ?').get(team, Number(id)));
  }

  updateTask(team0, id, patch) {
    const team = String(team0 ?? '');
    const cur = this.task(team, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updated: Date.now() / 1000 };
    this.db.prepare('UPDATE tasks SET owner = ?, milestone = ?, text = ?, state = ?, result = ?, updated = ? WHERE team = ? AND id = ?')
      .run(next.owner, next.milestone ?? null, next.text, next.state, next.result ?? null, next.updated, team, Number(id));
    return next;
  }

  /** Open tasks (oldest first), or the latest closed ones (newest first). */
  tasks(team0, { open = true, limit = 200 } = {}) {
    const team = String(team0 ?? '');
    const states = open ? OPEN_STATES : CLOSED_STATES;
    const order = open ? 'id ASC' : 'updated DESC';
    return this.db.prepare(`SELECT * FROM tasks WHERE team = ? AND state IN (${states.map(() => '?').join(',')}) ORDER BY ${order} LIMIT ?`)
      .all(team, ...states, limit).map(row);
  }

  log(team0, { kind, by = null, ref = null, text, ts = Date.now() / 1000 }) {
    const team = String(team0 ?? '');
    const r = this.db.prepare('INSERT INTO log(team, ts, kind, by, ref, text) VALUES (?,?,?,?,?,?)').run(team, ts, kind, by, ref == null ? null : String(ref), String(text));
    return { id: Number(r.lastInsertRowid), team, ts, kind, by, ref: ref == null ? null : String(ref), text: String(text) };
  }

  /** The latest entry of a kind with that reference (a decision by its number). */
  entry(team0, kind, ref) {
    const team = String(team0 ?? '');
    return row(this.db.prepare('SELECT * FROM log WHERE team = ? AND kind = ? AND ref = ? ORDER BY id DESC LIMIT 1').get(team, kind, String(ref)));
  }

  recent(team0, { kinds = null, limit = 20 } = {}) {
    const team = String(team0 ?? '');
    const where = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT * FROM log WHERE team = ?${where} ORDER BY id DESC LIMIT ?`).all(team, ...(kinds ?? []), limit).map(row);
  }

  /** The log entries (and tasks) that match the words, best first. */
  search(team0, q, { limit = 12, kinds = null } = {}) {
    const team = String(team0 ?? '');
    const ws = words(q);
    if (!ws.length) return [];
    const kindWhere = kinds?.length ? ` AND l.kind IN (${kinds.map(() => '?').join(',')})` : '';
    let hits = [];
    if (this.fts) {
      try {
        const match = ws.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
        hits = this.db.prepare(`SELECT l.* FROM log_fts f JOIN log l ON l.id = f.rowid WHERE log_fts MATCH ? AND l.team = ?${kindWhere} ORDER BY bm25(log_fts) LIMIT ?`)
          .all(match, team, ...(kinds ?? []), limit).map(row);
      } catch { hits = []; }
    }
    if (!hits.length) {
      const like = ws.map(() => 'LOWER(l.text) LIKE ?').join(' AND ');
      hits = this.db.prepare(`SELECT l.* FROM log l WHERE l.team = ? AND ${like}${kindWhere} ORDER BY l.id DESC LIMIT ?`)
        .all(team, ...ws.map((w) => `%${w}%`), ...(kinds ?? []), limit).map(row);
    }
    if (kinds?.length) return hits;
    const tlike = ws.map(() => 'LOWER(text || \' \' || IFNULL(result, \'\')) LIKE ?').join(' AND ');
    const tasks = this.db.prepare(`SELECT * FROM tasks WHERE team = ? AND ${tlike} ORDER BY updated DESC LIMIT 5`).all(team, ...ws.map((w) => `%${w}%`)).map(row);
    return [...tasks.map((t) => ({ task: t })), ...hits].slice(0, limit + tasks.length);
  }

  close() { try { this.db.close(); } catch {} }
}

/** node:sqlite rows have a null prototype: plain objects, like JSON ones. */
const row = (r) => (r ? { ...r } : null);

class JSONLedger {
  constructor(file) {
    this.file = file;
    this.kind = 'json';
    this.data = { tasks: [], log: [], nextLog: 0 };
    try { if (file && fs.existsSync(file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  addTask(team0, { owner, milestone = null, kind = 'tarea', text, state = 'en curso', by = null }) {
    const team = String(team0 ?? '');
    const now = Date.now() / 1000;
    const id = Math.max(0, ...this.data.tasks.filter((t) => t.team === team).map((t) => t.id)) + 1;
    const t = { team, id, owner, milestone, kind, text, state, by, created: now, updated: now, result: null };
    this.data.tasks.push(t);
    this._save();
    return { ...t };
  }

  task(team0, id) { const team = String(team0 ?? ""); const t = this.data.tasks.find((x) => x.team === team && x.id === Number(id)); return t ? { ...t } : null; }

  updateTask(team0, id, patch) {
    const team = String(team0 ?? '');
    const t = this.data.tasks.find((x) => x.team === team && x.id === Number(id));
    if (!t) return null;
    Object.assign(t, patch, { updated: Date.now() / 1000 });
    this._save();
    return { ...t };
  }

  tasks(team0, { open = true, limit = 200 } = {}) {
    const team = String(team0 ?? '');
    const states = open ? OPEN_STATES : CLOSED_STATES;
    const list = this.data.tasks.filter((t) => t.team === team && states.includes(t.state));
    return (open ? list.sort((a, b) => a.id - b.id) : list.sort((a, b) => b.updated - a.updated)).slice(0, limit).map((t) => ({ ...t }));
  }

  log(team0, { kind, by = null, ref = null, text, ts = Date.now() / 1000 }) {
    const team = String(team0 ?? '');
    const e = { id: ++this.data.nextLog, team, ts, kind, by, ref: ref == null ? null : String(ref), text: String(text) };
    this.data.log.push(e);
    this._save();
    return { ...e };
  }

  entry(team0, kind, ref) {
    const team = String(team0 ?? '');
    const e = [...this.data.log].reverse().find((x) => x.team === team && x.kind === kind && x.ref === String(ref));
    return e ? { ...e } : null;
  }

  recent(team0, { kinds = null, limit = 20 } = {}) {
    const team = String(team0 ?? '');
    return this.data.log.filter((e) => e.team === team && (!kinds?.length || kinds.includes(e.kind))).slice(-limit).reverse().map((e) => ({ ...e }));
  }

  search(team0, q, { limit = 12, kinds = null } = {}) {
    const team = String(team0 ?? '');
    const ws = words(q);
    if (!ws.length) return [];
    const has = (s) => { const n = String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); return ws.every((w) => n.includes(w)); };
    const hits = this.data.log.filter((e) => e.team === team && (!kinds?.length || kinds.includes(e.kind)) && has(e.text)).slice(-limit).reverse();
    if (kinds?.length) return hits.map((e) => ({ ...e }));
    const tasks = this.data.tasks.filter((t) => t.team === team && has(`${t.text} ${t.result ?? ''}`)).sort((a, b) => b.updated - a.updated).slice(0, 5);
    return [...tasks.map((t) => ({ task: { ...t } })), ...hits.map((e) => ({ ...e }))];
  }

  close() {}
}
