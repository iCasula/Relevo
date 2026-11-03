import Foundation

/// Block structure of the Markdown agents write: headings, paragraphs, (nested, numbered, task) lists,
/// quotes, fenced code, rules and GFM tables. Inline formatting is left to `AttributedString(markdown:)`.
public enum MarkdownBlock: Hashable, Sendable {
    public enum Alignment: Hashable, Sendable { case leading, center, trailing }
    public enum Marker: Hashable, Sendable {
        case bullet
        case number(String)
        case task(done: Bool)
    }

    case heading(level: Int, text: String)
    case paragraph(String)
    case listItem(indent: Int, marker: Marker, text: String)
    case quote(String)
    case code(language: String, code: String)
    case table(header: [String], alignments: [Alignment], rows: [[String]])
    case rule
}

public enum MarkdownParser {
    public static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var i = 0

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph.removeAll()
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code (``` or ~~~), possibly indented inside a list.
            if let fence = ["```", "~~~"].first(where: { trimmed.hasPrefix($0) }) {
                flushParagraph()
                let language = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                let indent = line.prefix { $0 == " " }.count
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(String(lines[i].dropFirst(min(indent, lines[i].prefix { $0 == " " }.count))))
                    i += 1
                }
                blocks.append(.code(language: language, code: code.joined(separator: "\n")))
                i += 1
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            // GFM table: a row with pipes followed by a |---|:---:| separator.
            if trimmed.contains("|"), i + 1 < lines.count, let alignments = separatorAlignments(lines[i + 1]) {
                flushParagraph()
                let header = cells(trimmed)
                var rows: [[String]] = []
                i += 2
                while i < lines.count {
                    let row = lines[i].trimmingCharacters(in: .whitespaces)
                    guard !row.isEmpty, row.contains("|") else { break }
                    rows.append(cells(row))
                    i += 1
                }
                let columns = max(header.count, alignments.count)
                blocks.append(.table(header: pad(header, to: columns),
                                     alignments: alignments + Array(repeating: .leading, count: max(0, columns - alignments.count)),
                                     rows: rows.map { pad($0, to: columns) }))
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                i += 1
                continue
            }

            if trimmed.hasPrefix("#") {
                let level = trimmed.prefix { $0 == "#" }.count
                if level <= 6, trimmed.dropFirst(level).hasPrefix(" ") {
                    flushParagraph()
                    let title = trimmed.dropFirst(level + 1).trimmingCharacters(in: CharacterSet(charactersIn: "# ").union(.whitespaces))
                    blocks.append(.heading(level: level, text: title))
                    i += 1
                    continue
                }
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quote: [String] = []
                while i < lines.count {
                    let q = lines[i].trimmingCharacters(in: .whitespaces)
                    guard q.hasPrefix(">") else { break }
                    quote.append(String(q.dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
                continue
            }

            if let item = listItem(line) {
                flushParagraph()
                var text = item.text
                i += 1
                // Indented lines that aren't a new item continue this one.
                while i < lines.count {
                    let next = lines[i]
                    let nextTrimmed = next.trimmingCharacters(in: .whitespaces)
                    guard !nextTrimmed.isEmpty, next.first == " " || next.first == "\t", listItem(next) == nil,
                          !["```", "~~~"].contains(where: { nextTrimmed.hasPrefix($0) }) else { break }
                    text += "\n" + nextTrimmed
                    i += 1
                }
                blocks.append(.listItem(indent: item.indent, marker: item.marker, text: text))
                continue
            }

            paragraph.append(trimmed)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    // MARK: - Helpers

    private static func isRule(_ s: String) -> Bool {
        let compact = s.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func listItem(_ line: String) -> (indent: Int, marker: MarkdownBlock.Marker, text: String)? {
        let spaces = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let indent = spaces / 2
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for bullet in ["- ", "* ", "+ "] where trimmed.hasPrefix(bullet) {
            var text = String(trimmed.dropFirst(2))
            if text.hasPrefix("[ ] ") { text.removeFirst(4); return (indent, .task(done: false), text) }
            if text.lowercased().hasPrefix("[x] ") { text.removeFirst(4); return (indent, .task(done: true), text) }
            return (indent, .bullet, text)
        }
        if let match = trimmed.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
            let number = String(trimmed[match].dropLast()).replacingOccurrences(of: ")", with: ".")
            return (indent, .number(number), String(trimmed[match.upperBound...]))
        }
        return nil
    }

    /// `| --- | :---: | ---: |` → alignments, or nil if the line isn't a table separator.
    private static func separatorAlignments(_ line: String) -> [MarkdownBlock.Alignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.allSatisfy({ "|:- \t".contains($0) }) else { return nil }
        let parts = cells(trimmed)
        guard !parts.isEmpty, parts.allSatisfy({ $0.contains("-") }) else { return nil }
        return parts.map { part in
            let left = part.hasPrefix(":"), right = part.hasSuffix(":")
            return left && right ? .center : right ? .trailing : .leading
        }
    }

    /// Splits a table row on unescaped pipes, without the outer ones.
    private static func cells(_ row: String) -> [String] {
        var s = row.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") && !s.hasSuffix("\\|") { s.removeLast() }
        var result: [String] = []
        var current = ""
        var previous: Character?
        var inCode = false
        for ch in s {
            if ch == "`" { inCode.toggle() }
            if ch == "|" && previous != "\\" && !inCode {
                result.append(current)
                current = ""
            } else {
                if ch == "|" && previous == "\\" { current.removeLast() }
                current.append(ch)
            }
            previous = ch
        }
        result.append(current)
        return result.map {
            $0.trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "<br>", with: "\n").replacingOccurrences(of: "<br/>", with: "\n")
        }
    }

    private static func pad(_ row: [String], to count: Int) -> [String] {
        row.count >= count ? Array(row.prefix(count)) : row + Array(repeating: "", count: count - row.count)
    }
}

public enum MarkdownInline {
    /// Bold, italics, `code`, links and ~~strikethrough~~, keeping line breaks.
    /// Paths in code spans and bare absolute paths become links (see `FileReference`).
    public static func attributed(_ s: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var result = (try? AttributedString(markdown: s, options: options)) ?? AttributedString(s)
        FileReference.linkify(&result)
        return result
    }

    /// Plain one-line text for previews ("**Hecho**: `ok`" → "Hecho: ok").
    public static func plain(_ s: String) -> String {
        String(attributed(s).characters).replacingOccurrences(of: "\n", with: " ")
    }
}
