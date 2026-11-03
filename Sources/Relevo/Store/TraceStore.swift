import Foundation
import SQLite3

/// A step of the agent's own plan / todo list.
struct PlanStep: Codable, Hashable {
    var text: String
    /// pending | in_progress | completed
    var status: String
}

struct TraceEvent: Identifiable {
    var id: Int64
    var ts: Date
    var kind: String
    var provider: String?
    var account: String?
    var model: String?
    var title: String
    var detail: String?
    var status: String?
}

struct TraceCheckpoint {
    var ts: Date
    var reason: String
    var provider: String?
    var model: String?
    var detail: String?
}

struct TouchedFile {
    var path: String
    var action: String
    var count: Int
    var ts: Date
}

struct TraceContext {
    var provider: String
    var account: String
    var model: String
}

/// Continuous, token-free trace of what each agent did, kept in SQLite so a handoff knows
/// exactly where the work stopped even if the outgoing agent can no longer answer (e.g. out of quota).
final class TraceStore {
    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "relevo.trace")
    private(set) var hasFTS = false
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(url: URL) {
        queue.sync {
            guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
                db = nil
                return
            }
            exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
            exec("""
            CREATE TABLE IF NOT EXISTS events(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              thread_id TEXT NOT NULL, project TEXT NOT NULL, ref TEXT NOT NULL,
              ts REAL NOT NULL, kind TEXT NOT NULL,
              provider TEXT, account TEXT, model TEXT,
              title TEXT NOT NULL DEFAULT '', detail TEXT, status TEXT,
              UNIQUE(thread_id, ref));
            CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, id);
            CREATE TABLE IF NOT EXISTS files(
              thread_id TEXT NOT NULL, path TEXT NOT NULL, action TEXT NOT NULL,
              count INTEGER NOT NULL DEFAULT 1, ts REAL NOT NULL, PRIMARY KEY(thread_id, path));
            CREATE TABLE IF NOT EXISTS plans(
              thread_id TEXT PRIMARY KEY, ts REAL NOT NULL, provider TEXT, steps TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS checkpoints(
              id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, ts REAL NOT NULL,
              reason TEXT NOT NULL, provider TEXT, model TEXT, detail TEXT);
            CREATE INDEX IF NOT EXISTS checkpoints_thread ON checkpoints(thread_id, id);
            CREATE TABLE IF NOT EXISTS outcomes(
              id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, ts REAL NOT NULL,
              level TEXT NOT NULL, task TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, result TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS outcomes_key ON outcomes(provider, model, level);
            """)
            hasFTS = exec("""
            CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(title, detail, content='events', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
            CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
              INSERT INTO events_fts(rowid, title, detail) VALUES (new.id, new.title, new.detail); END;
            CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
              INSERT INTO events_fts(events_fts, rowid, title, detail) VALUES ('delete', old.id, old.title, old.detail); END;
            CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
              INSERT INTO events_fts(events_fts, rowid, title, detail) VALUES ('delete', old.id, old.title, old.detail);
              INSERT INTO events_fts(rowid, title, detail) VALUES (new.id, new.title, new.detail); END;
            """)
        }
    }

    deinit { if let db { sqlite3_close(db) } }

    var isAvailable: Bool { db != nil }

    // MARK: - Writes (async, ordered)

    /// Inserts an event, or updates the one with the same `ref` (tool start → tool result).
    func record(thread: UUID, project: String, ref: String, kind: String, context: TraceContext?, title: String, detail: String? = nil, status: String? = nil, appendDetail: Bool = false) {
        let now = Date().timeIntervalSince1970
        queue.async { [self] in
            let detailSQL = appendDetail
                ? "CASE WHEN excluded.detail IS NULL THEN events.detail WHEN events.detail IS NULL THEN excluded.detail ELSE events.detail || char(10) || '→ ' || excluded.detail END"
                : "COALESCE(excluded.detail, events.detail)"
            run("""
            INSERT INTO events(thread_id, project, ref, ts, kind, provider, account, model, title, detail, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(thread_id, ref) DO UPDATE SET
              title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE events.title END,
              detail = \(detailSQL),
              status = COALESCE(excluded.status, events.status)
            """, [thread.uuidString, project, ref, now, kind, context?.provider, context?.account, context?.model,
                  String(title.prefix(400)), detail.map { String($0.prefix(6000)) }, status])
        }
    }

    func touch(thread: UUID, path: String, action: String) {
        let now = Date().timeIntervalSince1970
        queue.async { [self] in
            run("""
            INSERT INTO files(thread_id, path, action, count, ts) VALUES (?,?,?,1,?)
            ON CONFLICT(thread_id, path) DO UPDATE SET action = excluded.action, count = files.count + 1, ts = excluded.ts
            """, [thread.uuidString, path, action, now])
        }
    }

    func setPlan(thread: UUID, provider: String, steps: [PlanStep]) {
        guard let data = try? JSONEncoder().encode(steps), let json = String(data: data, encoding: .utf8) else { return }
        let now = Date().timeIntervalSince1970
        queue.async { [self] in
            run("INSERT OR REPLACE INTO plans(thread_id, ts, provider, steps) VALUES (?,?,?,?)", [thread.uuidString, now, provider, json])
        }
    }

    func checkpoint(thread: UUID, reason: String, context: TraceContext?, detail: String? = nil) {
        let now = Date().timeIntervalSince1970
        queue.async { [self] in
            run("INSERT INTO checkpoints(thread_id, ts, reason, provider, model, detail) VALUES (?,?,?,?,?,?)",
                [thread.uuidString, now, reason, context?.provider, context?.model, detail.map { String($0.prefix(2000)) }])
        }
    }

    // MARK: - Outcomes («Relevo sugiere» learns which models finish each kind of task)

    /// result: ok | error | limit | stopped | switched (the user moved to another model right after).
    func recordOutcome(thread: UUID, level: String, task: String?, provider: String, model: String, result: String) {
        let now = Date().timeIntervalSince1970
        queue.async { [self] in
            run("INSERT INTO outcomes(thread_id, ts, level, task, provider, model, result) VALUES (?,?,?,?,?,?,?)",
                [thread.uuidString, now, level, task, provider, model, result])
        }
    }

    /// The user changed model right after a turn that looked fine: a sign that model fell short.
    func markLastOutcomeSwitched(thread: UUID) {
        queue.async { [self] in
            run("""
            UPDATE outcomes SET result = 'switched'
            WHERE id = (SELECT MAX(id) FROM outcomes WHERE thread_id = ?) AND result = 'ok'
            """, [thread.uuidString])
        }
    }

    static func outcomeKey(_ provider: String, _ model: String, _ level: String) -> String { "\(provider)|\(model)|\(level)" }

    /// Finished turns per provider|model|level (limits and user stops say nothing about quality, so they don't count).
    func outcomeStats() -> [String: (ok: Int, total: Int)] {
        queue.sync {
            var out: [String: (ok: Int, total: Int)] = [:]
            let rows = query("""
            SELECT provider, model, level, SUM(result = 'ok'), COUNT(*) FROM outcomes
            WHERE result IN ('ok', 'error', 'switched') GROUP BY provider, model, level
            """, []) { stmt in
                (Self.outcomeKey(Self.text(stmt, 0) ?? "", Self.text(stmt, 1) ?? "", Self.text(stmt, 2) ?? ""),
                 Int(sqlite3_column_int64(stmt, 3)), Int(sqlite3_column_int64(stmt, 4)))
            }
            for r in rows { out[r.0] = (r.1, r.2) }
            return out
        }
    }

    /// Outcomes are kept when a thread is deleted: they hold no content, only level/provider/model/result.
    func deleteThread(_ thread: UUID) {
        queue.async { [self] in
            for table in ["events", "files", "plans", "checkpoints"] {
                run("DELETE FROM \(table) WHERE thread_id = ?", [thread.uuidString])
            }
        }
    }

    // MARK: - Reads (sync, after pending writes)

    func recentEvents(thread: UUID, limit: Int, kinds: [String]? = nil) -> [TraceEvent] {
        queue.sync {
            var sql = "SELECT id, ts, kind, provider, account, model, title, detail, status FROM events WHERE thread_id = ?"
            var params: [Any?] = [thread.uuidString]
            if let kinds, !kinds.isEmpty {
                sql += " AND kind IN (" + kinds.map { _ in "?" }.joined(separator: ",") + ")"
                params += kinds
            }
            sql += " ORDER BY id DESC LIMIT ?"
            params.append(limit)
            return query(sql, params, Self.event).reversed()
        }
    }

    func events(thread: UUID, after id: Int64) -> [TraceEvent] {
        queue.sync {
            query("SELECT id, ts, kind, provider, account, model, title, detail, status FROM events WHERE thread_id = ? AND id > ? ORDER BY id",
                  [thread.uuidString, id], Self.event)
        }
    }

    func lastEvent(thread: UUID, kind: String) -> TraceEvent? {
        queue.sync {
            query("SELECT id, ts, kind, provider, account, model, title, detail, status FROM events WHERE thread_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
                  [thread.uuidString, kind], Self.event).first
        }
    }

    func eventCount(thread: UUID) -> Int {
        queue.sync { query("SELECT COUNT(*) FROM events WHERE thread_id = ?", [thread.uuidString]) { Int(sqlite3_column_int64($0, 0)) }.first ?? 0 }
    }

    func plan(thread: UUID) -> (steps: [PlanStep], provider: String?, ts: Date)? {
        queue.sync {
            query("SELECT steps, provider, ts FROM plans WHERE thread_id = ?", [thread.uuidString]) { stmt -> (steps: [PlanStep], provider: String?, ts: Date)? in
                guard let json = Self.text(stmt, 0), let data = json.data(using: .utf8),
                      let steps = try? JSONDecoder().decode([PlanStep].self, from: data) else { return nil }
                return (steps, Self.text(stmt, 1), Date(timeIntervalSince1970: sqlite3_column_double(stmt, 2)))
            }.compactMap { $0 }.first
        }
    }

    func files(thread: UUID) -> [TouchedFile] {
        queue.sync {
            query("SELECT path, action, count, ts FROM files WHERE thread_id = ? ORDER BY ts DESC", [thread.uuidString]) { stmt in
                TouchedFile(path: Self.text(stmt, 0) ?? "", action: Self.text(stmt, 1) ?? "", count: Int(sqlite3_column_int64(stmt, 2)),
                            ts: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 3)))
            }
        }
    }

    func checkpoints(thread: UUID, limit: Int = 20) -> [TraceCheckpoint] {
        queue.sync {
            query("SELECT ts, reason, provider, model, detail FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT ?", [thread.uuidString, limit]) { stmt in
                TraceCheckpoint(ts: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 0)), reason: Self.text(stmt, 1) ?? "",
                                provider: Self.text(stmt, 2), model: Self.text(stmt, 3), detail: Self.text(stmt, 4))
            }
        }
    }

    /// Full-text search over older events of the thread (excluding the newest `excludingNewest`).
    func search(thread: UUID, terms: [String], excludingNewest: Int, limit: Int) -> [TraceEvent] {
        guard !terms.isEmpty else { return [] }
        return queue.sync {
            let cutoff = query("SELECT id FROM events WHERE thread_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
                               [thread.uuidString, excludingNewest]) { sqlite3_column_int64($0, 0) }.first
            guard let cutoff else { return [] }
            if hasFTS {
                let match = terms.map { "\"\($0.replacingOccurrences(of: "\"", with: ""))\"" }.joined(separator: " OR ")
                let rows = query("""
                SELECT e.id, e.ts, e.kind, e.provider, e.account, e.model, e.title, e.detail, e.status
                FROM events_fts JOIN events e ON e.id = events_fts.rowid
                WHERE events_fts MATCH ? AND e.thread_id = ? AND e.id <= ?
                ORDER BY bm25(events_fts) LIMIT ?
                """, [match, thread.uuidString, cutoff, limit], Self.event)
                return rows.sorted { $0.id < $1.id }
            }
            let likes = terms.prefix(4).map { _ in "(title LIKE ? OR detail LIKE ?)" }.joined(separator: " OR ")
            var params: [Any?] = [thread.uuidString, cutoff]
            for t in terms.prefix(4) { params += ["%\(t)%", "%\(t)%"] }
            params.append(limit)
            return query("SELECT id, ts, kind, provider, account, model, title, detail, status FROM events WHERE thread_id = ? AND id <= ? AND (\(likes)) ORDER BY id LIMIT ?",
                         params, Self.event)
        }
    }

    // MARK: - SQLite plumbing (always on `queue`)

    @discardableResult
    private func exec(_ sql: String) -> Bool {
        guard let db else { return false }
        return sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
    }

    private func prepare(_ sql: String, _ params: [Any?]) -> OpaquePointer? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
        for (i, p) in params.enumerated() {
            let idx = Int32(i + 1)
            switch p {
            case nil: sqlite3_bind_null(stmt, idx)
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, Self.transient)
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Double: sqlite3_bind_double(stmt, idx, v)
            default: sqlite3_bind_text(stmt, idx, "\(p!)", -1, Self.transient)
            }
        }
        return stmt
    }

    private func run(_ sql: String, _ params: [Any?]) {
        guard let stmt = prepare(sql, params) else { return }
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    private func query<T>(_ sql: String, _ params: [Any?], _ row: (OpaquePointer) -> T) -> [T] {
        guard let stmt = prepare(sql, params) else { return [] }
        defer { sqlite3_finalize(stmt) }
        var out: [T] = []
        while sqlite3_step(stmt) == SQLITE_ROW { out.append(row(stmt)) }
        return out
    }

    private static func text(_ stmt: OpaquePointer, _ col: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, col) else { return nil }
        return String(cString: c)
    }

    private static func event(_ stmt: OpaquePointer) -> TraceEvent {
        TraceEvent(id: sqlite3_column_int64(stmt, 0), ts: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 1)),
                   kind: text(stmt, 2) ?? "", provider: text(stmt, 3), account: text(stmt, 4), model: text(stmt, 5),
                   title: text(stmt, 6) ?? "", detail: text(stmt, 7), status: text(stmt, 8))
    }
}
