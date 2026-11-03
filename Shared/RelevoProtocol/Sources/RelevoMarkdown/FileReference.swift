import Foundation

/// File paths and image names in agent replies: detected in links (`file://…`), code spans
/// (`ProClubs/App.swift`, `duo-inicio.png`) and bare absolute paths, and turned into tappable links.
public enum FileReference {
    /// Links Relevo adds for paths that aren't URLs: `relevo-path://open?p=<path>`.
    public static let scheme = "relevo-path"

    public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "tiff", "tif", "bmp"]
    static let fileExtensions: Set<String> = Set([
        "swift", "m", "mm", "h", "c", "cc", "cpp", "kt", "java", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "php", "cs",
        "json", "yml", "yaml", "toml", "plist", "xcstrings", "strings", "stringsdict", "md", "markdown", "txt", "rtf", "sh", "zsh",
        "html", "css", "scss", "svg", "pdf", "csv", "sql", "log", "xml", "lock", "gradle", "entitlements", "xcconfig",
        "storyboard", "xib", "xcodeproj", "xcworkspace", "xcassets", "env", "ini", "conf", "p8", "pem",
    ]).union(imageExtensions)

    public static func url(for path: String) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "p", value: path)]
        return c.url
    }

    /// The path a link points to (`file://` or `relevo-path:`), or nil for web links.
    public static func path(from url: URL) -> String? {
        if url.isFileURL { return url.path(percentEncoded: false) }
        guard url.scheme == scheme else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "p" }?.value
    }

    public static func pathExtension(_ path: String) -> String {
        (path as NSString).pathExtension.lowercased()
    }

    public static func isImage(_ path: String) -> Bool { imageExtensions.contains(pathExtension(path)) }

    /// `ProClubs/App.swift`, `preview/duo/`, `~/x`, `/Users/…`, `AGENTS.md` — but not `os.Logger`, `a b`, URLs or flags.
    public static func looksLikePath(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count >= 3, t.count <= 400, !t.contains("\n"), !t.hasPrefix("-"), !t.contains("://") || t.hasPrefix("file://") else { return false }
        if t.hasPrefix("/") || t.hasPrefix("~/") || t.hasPrefix("./") || t.hasPrefix("../") || t.hasPrefix("file://") {
            return !t.contains(" ") || t.hasPrefix("file://")
        }
        guard !t.contains(" ") else { return false }
        if t.contains("/") {
            // Relative paths: at least one segment that looks like a file or folder name, no code punctuation.
            return t.range(of: #"^[\w.@+\-]+(/[\w.@+\-*]+)*/?$"#, options: .regularExpression) != nil
        }
        return fileExtensions.contains(pathExtension(t)) && t.range(of: #"^[\w.@+\-]+$"#, options: .regularExpression) != nil
    }

    private static let barePath = try! NSRegularExpression(pattern: #"(?<![\w/`])(?:~|/Users|/Volumes|/private|/tmp|/opt|/Applications)/[^\s`'"()\[\]<>]+"#)

    /// Image paths a reply mentions, in order and without repeats (for the thumbnail strip).
    public static func imageReferences(in text: String) -> [String] {
        var found: [String] = []
        func add(_ raw: String) {
            var p = raw.trimmingCharacters(in: .whitespaces)
            p = p.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:"))
            if p.hasPrefix("file://"), let url = URL(string: p) { p = url.path(percentEncoded: false) }
            guard isImage(p), !found.contains(p) else { return }
            found.append(p)
        }
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        // Link targets: [x](file:///…/a.png), ![x](a.png)
        if let links = try? NSRegularExpression(pattern: #"\]\(([^)\s]+)\)"#) {
            for m in links.matches(in: text, range: full) { add(ns.substring(with: m.range(at: 1))) }
        }
        // Code spans: `preview/duo/a.png`
        if let code = try? NSRegularExpression(pattern: #"`([^`\n]+)`"#) {
            for m in code.matches(in: text, range: full) { add(ns.substring(with: m.range(at: 1))) }
        }
        for m in barePath.matches(in: text, range: full) { add(ns.substring(with: m.range)) }
        return found
    }

    /// Adds links to code spans that look like paths and to bare absolute paths.
    static func linkify(_ attributed: inout AttributedString) {
        var edits: [(Range<AttributedString.Index>, URL)] = []
        for run in attributed.runs where run.link == nil {
            let text = String(attributed[run.range].characters)
            if run.inlinePresentationIntent?.contains(.code) == true {
                if looksLikePath(text), let url = url(for: text) { edits.append((run.range, url)) }
                continue
            }
            let ns = text as NSString
            for m in barePath.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                let path = ns.substring(with: m.range).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:"))
                guard let url = url(for: path) else { continue }
                let start = attributed.characters.index(run.range.lowerBound, offsetBy: m.range.location)
                let end = attributed.characters.index(start, offsetBy: path.count)
                edits.append((start..<end, url))
            }
        }
        for (range, url) in edits { attributed[range].link = url }
    }
}
