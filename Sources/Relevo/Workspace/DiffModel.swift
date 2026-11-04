import Foundation

/// A unified diff split into files, hunks and lines, for the diff viewer.
struct DiffFile: Identifiable, Hashable {
    enum Change: String { case added = "A", deleted = "D", modified = "M", renamed = "R" }

    struct Line: Identifiable, Hashable {
        enum Kind { case context, added, removed, hunk }
        var id: Int
        var kind: Kind
        var text: String
        /// Line number in the old and new file (nil where the line doesn't exist).
        var old: Int?
        var new: Int?
    }

    var path: String
    var oldPath: String?
    var change: Change
    var lines: [Line]
    var isBinary = false
    var id: String { path }

    var added: Int { lines.filter { $0.kind == .added }.count }
    var removed: Int { lines.filter { $0.kind == .removed }.count }
}

/// A review comment on one line of a diff, sent to the agent.
struct DiffComment: Identifiable, Hashable {
    var id = UUID()
    var file: String
    var line: Int
    var code: String
    var text: String
}

enum DiffParser {
    static func parse(_ text: String) -> [DiffFile] {
        var files: [DiffFile] = []
        var current: DiffFile?
        var oldLine = 0, newLine = 0, counter = 0

        func flush() { if let c = current { files.append(c) }; current = nil }

        for raw in text.components(separatedBy: "\n") {
            if raw.hasPrefix("diff --git ") {
                flush()
                // "diff --git a/x b/y": the b/ side is the current name.
                let parts = raw.dropFirst("diff --git ".count).components(separatedBy: " b/")
                let path = parts.count > 1 ? parts.last! : String(raw.dropFirst("diff --git a/".count))
                current = DiffFile(path: path, oldPath: nil, change: .modified, lines: [])
                continue
            }
            guard current != nil else { continue }
            if raw.hasPrefix("new file mode") { current?.change = .added; continue }
            if raw.hasPrefix("deleted file mode") { current?.change = .deleted; continue }
            if raw.hasPrefix("rename from ") { current?.oldPath = String(raw.dropFirst("rename from ".count)); current?.change = .renamed; continue }
            if raw.hasPrefix("Binary files") { current?.isBinary = true; continue }
            if raw.hasPrefix("index ") || raw.hasPrefix("--- ") || raw.hasPrefix("+++ ") || raw.hasPrefix("similarity index")
                || raw.hasPrefix("rename to ") || raw.hasPrefix("old mode") || raw.hasPrefix("new mode") { continue }
            counter += 1
            if raw.hasPrefix("@@") {
                // @@ -a,b +c,d @@ context
                let nums = raw.split(separator: " ").prefix(3)
                if nums.count == 3 {
                    oldLine = Int(nums[1].dropFirst().split(separator: ",").first ?? "") ?? 0
                    newLine = Int(nums[2].dropFirst().split(separator: ",").first ?? "") ?? 0
                }
                current?.lines.append(.init(id: counter, kind: .hunk, text: raw, old: nil, new: nil))
            } else if raw.hasPrefix("+") {
                current?.lines.append(.init(id: counter, kind: .added, text: String(raw.dropFirst()), old: nil, new: newLine))
                newLine += 1
            } else if raw.hasPrefix("-") {
                current?.lines.append(.init(id: counter, kind: .removed, text: String(raw.dropFirst()), old: oldLine, new: nil))
                oldLine += 1
            } else if raw.hasPrefix(" ") {
                current?.lines.append(.init(id: counter, kind: .context, text: String(raw.dropFirst()), old: oldLine, new: newLine))
                oldLine += 1
                newLine += 1
            }
        }
        flush()
        return files
    }
}
