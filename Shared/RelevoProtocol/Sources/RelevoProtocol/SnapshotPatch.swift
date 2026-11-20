import Foundation

/// A Relevo host sends the whole snapshot once and then, to clients that say they take them, only what
/// changed: `{"snapshotPatch":{"_0":{"set":{…},"unset":[…],"lists":{"threads":{"ids":[…],"upsert":[…]}}}}}`.
/// Top-level values in `set` replace theirs; the lists (threads, accounts, projects, teams) go by id: `ids`
/// is the new order and each upsert carries only the fields that changed (`$unset` names the ones it lost).
/// Mirrors `applySnapshotPatch` in the host's ui/state.mjs.
public enum SnapshotPatch {
    public static let feature = "snapshotPatch"

    public static func apply(_ patch: [String: Any], to snapshot: [String: Any]) -> [String: Any] {
        var next = snapshot
        for (key, value) in patch["set"] as? [String: Any] ?? [:] { next[key] = value }
        for key in patch["unset"] as? [String] ?? [] { next.removeValue(forKey: key) }
        for (key, change) in patch["lists"] as? [String: Any] ?? [:] {
            guard let change = change as? [String: Any], let ids = change["ids"] as? [Any] else { continue }
            var byId: [String: [String: Any]] = [:]
            for item in snapshot[key] as? [[String: Any]] ?? [] { if let id = item["id"] { byId["\(id)"] = item } }
            for update in change["upsert"] as? [[String: Any]] ?? [] {
                guard let id = update["id"] else { continue }
                var item = byId["\(id)"] ?? [:]
                for (field, value) in update where field != "$unset" { item[field] = value }
                for field in update["$unset"] as? [String] ?? [] { item.removeValue(forKey: field) }
                byId["\(id)"] = item
            }
            next[key] = ids.compactMap { byId["\($0)"] }
        }
        return next
    }

    /// Keeps the last snapshot of one connection and turns each patch into a whole snapshot message, so the
    /// rest of the client only ever sees `snapshot`. Other messages pass through untouched.
    public struct Tracker {
        private var last: [String: Any]?

        public init() {}

        /// A new connection: the host starts again with a whole snapshot.
        public mutating func reset() { last = nil }

        /// The message to decode, or nil to drop it (a patch with no snapshot to apply it to).
        public mutating func resolve(_ data: Data) -> Data? {
            // Only snapshots are parsed here; transcripts (the big messages) go straight on.
            guard data.starts(with: Data(#"{"snapshot"#.utf8)),
                  let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return data }
            if let whole = (message["snapshot"] as? [String: Any])?["_0"] as? [String: Any] {
                last = whole
                return data
            }
            guard let patch = (message["snapshotPatch"] as? [String: Any])?["_0"] as? [String: Any] else { return data }
            guard let last else { return nil }
            let next = SnapshotPatch.apply(patch, to: last)
            self.last = next
            return try? JSONSerialization.data(withJSONObject: ["snapshot": ["_0": next]])
        }
    }
}
