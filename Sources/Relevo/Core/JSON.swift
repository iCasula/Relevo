import Foundation

typealias JSONObject = [String: Any]

extension Dictionary where Key == String, Value == Any {
    func str(_ key: String) -> String? {
        if let s = self[key] as? String { return s }
        if let n = self[key] as? NSNumber, !(self[key] is Bool) { return n.stringValue }
        return nil
    }
    func obj(_ key: String) -> JSONObject? { self[key] as? JSONObject }
    func objs(_ key: String) -> [JSONObject] { (self[key] as? [Any])?.compactMap { $0 as? JSONObject } ?? [] }
    func strs(_ key: String) -> [String] { (self[key] as? [Any])?.compactMap { $0 as? String } ?? [] }
    func num(_ key: String) -> Double? {
        if let n = self[key] as? NSNumber { return n.doubleValue }
        if let s = self[key] as? String { return Double(s) }
        return nil
    }
    func int(_ key: String) -> Int? {
        if let n = self[key] as? NSNumber { return n.intValue }
        if let s = self[key] as? String { return Int(s) }
        return nil
    }
    func bool(_ key: String) -> Bool? {
        if let b = self[key] as? Bool { return b }
        if let n = self[key] as? NSNumber { return n.boolValue }
        return nil
    }
    func has(_ key: String) -> Bool {
        guard let v = self[key] else { return false }
        return !(v is NSNull)
    }
}

enum JSONUtil {
    static func parse(_ line: String) -> JSONObject? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? JSONObject
    }

    static func parseAny(_ data: Data) -> Any? {
        try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func encode(_ value: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        return try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])
    }

    /// Compact, human readable rendering of an arbitrary JSON value (used for tool inputs/outputs).
    static func text(_ value: Any?, pretty: Bool = true) -> String {
        guard let value, !(value is NSNull) else { return "" }
        if let s = value as? String { return s }
        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return "\(value)"
    }

    /// Flattens content blocks ([{type:text,text:..}] / string) into plain text.
    static func flattenContent(_ value: Any?) -> String {
        if let s = value as? String { return s }
        if let arr = value as? [Any] {
            return arr.compactMap { el -> String? in
                if let o = el as? JSONObject {
                    if let t = o.str("text") { return t }
                    if let c = o["content"] { return flattenContent(c) }
                    if o.str("type") == "image" { return "[imagen]" }
                    return nil
                }
                return el as? String
            }.joined(separator: "\n")
        }
        if let o = value as? JSONObject {
            if let t = o.str("text") { return t }
            if let c = o["content"] { return flattenContent(c) }
            return text(o)
        }
        return text(value)
    }
}

enum DateParse {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Parses ISO-8601 strings with any fractional precision, or unix timestamps (s or ms).
    static func any(_ value: Any?) -> Date? {
        if let n = value as? NSNumber, !(value is Bool) {
            let d = n.doubleValue
            if d <= 0 { return nil }
            return Date(timeIntervalSince1970: d > 1e12 ? d / 1000 : d)
        }
        guard let s = value as? String, !s.isEmpty else { return nil }
        if let d = Double(s) { return any(NSNumber(value: d)) }
        // strip fractional seconds: 2026-11-03T15:00:00.434942+00:00 -> 2026-11-03T15:00:00+00:00
        let cleaned = s.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return iso.date(from: cleaned)
    }
}

func shellQuote(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

func expandTilde(_ path: String) -> String {
    (path as NSString).expandingTildeInPath
}

func abbreviateHome(_ path: String) -> String {
    let home = NSHomeDirectory()
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}
