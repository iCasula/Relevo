import Foundation
import ImageIO
import UniformTypeIdentifiers
import RelevoMarkdown

/// Turns a path an agent mentioned into a file on this Mac. Agents write absolute paths, `~/…`, paths
/// relative to where they work, or just a file name next to a folder they mentioned earlier.
enum FilePaths {
    private static let absolute = try! NSRegularExpression(pattern: #"(?:file://)?(?:~|/Users|/Volumes|/private|/tmp|/opt|/Applications)/[^\s`'"()\[\]<>]+"#)

    static func resolve(_ reference: String, thread: ThreadModel, projectPath: String?, nearText: String? = nil) -> URL? {
        var p = reference.trimmingCharacters(in: .whitespaces)
        if p.hasPrefix("file://"), let url = URL(string: p) { p = url.path(percentEncoded: false) }
        p = (p as NSString).expandingTildeInPath
        let fm = FileManager.default
        if p.hasPrefix("/") { return fm.fileExists(atPath: p) ? URL(fileURLWithPath: p) : nil }
        for root in roots(thread: thread, projectPath: projectPath, nearText: nearText) {
            let candidate = (root as NSString).appendingPathComponent(p)
            if fm.fileExists(atPath: candidate) { return URL(fileURLWithPath: candidate) }
        }
        return nil
    }

    /// Where a relative path may live: the project, then folders mentioned in the message and in recent activity.
    private static func roots(thread: ThreadModel, projectPath: String?, nearText: String?) -> [String] {
        var roots: [String] = projectPath.map { [$0] } ?? []
        var texts: [String] = nearText.map { [$0] } ?? []
        for item in thread.items.suffix(80).reversed() { texts.append(item.text); if let t = item.title { texts.append(t) } }
        for text in texts {
            let ns = text as NSString
            for m in absolute.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                var path = ns.substring(with: m.range)
                if path.hasPrefix("file://"), let url = URL(string: path) { path = url.path(percentEncoded: false) }
                path = (path as NSString).expandingTildeInPath
                var isDir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { continue }
                var dir = isDir.boolValue ? path : (path as NSString).deletingLastPathComponent
                for _ in 0..<4 where dir.count > 1 {
                    if !roots.contains(dir) { roots.append(dir) }
                    dir = (dir as NSString).deletingLastPathComponent
                }
            }
            if roots.count > 40 { break }
        }
        return roots
    }

    /// True if the thread names this path (the iPhone may only ask for files the conversation mentions).
    static func isMentioned(_ path: String, in thread: ThreadModel) -> Bool {
        thread.items.contains { $0.text.contains(path) || ($0.output ?? "").contains(path) || ($0.title ?? "").contains(path) }
    }

    static func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    /// Downscaled JPEG of an image file, for the iPhone.
    static func jpeg(_ url: URL, maxPixel: Int) -> Data? {
        guard let image = ThumbnailMaker.image(url: url, maxPixel: maxPixel) else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
