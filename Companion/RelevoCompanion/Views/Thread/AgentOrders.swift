import SwiftUI
import RelevoMarkdown

/// An order inside an agent's reply: `<relevo:tarea para="Ejecutor 1">…</relevo:tarea>`.
/// The host acts on them; on the phone they fold into one line each, tap to read the whole order.
struct AgentOrder: Hashable {
    let type: String
    let to: String?
    let body: String

    var label: String {
        switch type {
        case "tarea": "Tarea"
        case "urgente": "Urgente"
        case "investigar": "Investigar"
        case "respuesta": "Respuesta"
        case "pregunta": "Pregunta"
        case "integrar": "Integrar"
        case "fin": "Fin"
        case "decision", "decisión": "Decisión"
        case "descartar": "Descartar"
        case "hito": "Hito"
        case "hecho": "Hecho"
        default: type.capitalized
        }
    }

    var symbol: String {
        switch type {
        case "tarea": "arrow.right.circle"
        case "urgente": "exclamationmark.circle"
        case "investigar": "globe"
        case "respuesta": "arrowshape.turn.up.left"
        case "pregunta": "questionmark.circle"
        case "integrar": "arrow.triangle.merge"
        case "fin": "flag.checkered"
        case "decision", "decisión": "checkmark.seal"
        case "descartar": "xmark.circle"
        case "hito": "flag"
        case "hecho": "checkmark.circle"
        default: "envelope"
        }
    }

    var tint: Color {
        switch type {
        case "urgente": .red
        case "investigar": .green
        case "pregunta": .purple
        case "decision", "decisión", "hito", "hecho": .teal
        default: .blue
        }
    }

    enum Segment: Hashable {
        case text(String)
        case order(AgentOrder)
    }

    private static let tag = try! NSRegularExpression(
        pattern: #"<relevo:(tarea|urgente|investigar|respuesta|pregunta|integrar|fin|decisi[oó]n|descartar|hito|hecho)\b([^>]*?)(?:/>|>([\s\S]*?)</relevo:\1\s*>)"#,
        options: [.caseInsensitive])
    private static let fenced = try! NSRegularExpression(pattern: "```[\\s\\S]*?(?:```|$)")
    private static let attr = try! NSRegularExpression(pattern: #"\b(?:para|de)\s*=\s*(?:["“']([^"”']+)["”']|([^\s"”'>/]+))"#, options: [.caseInsensitive])

    /// The reply cut into prose and orders, in order. Tags inside code blocks stay text (as the host reads them).
    static func segments(in text: String) -> [Segment] {
        guard text.contains("<relevo:") else { return [.text(text)] }
        let ns = text as NSString
        let whole = NSRange(location: 0, length: ns.length)
        let code = fenced.matches(in: text, range: whole).map(\.range)
        var out: [Segment] = []
        var cursor = 0
        func addText(_ upTo: Int) {
            guard upTo > cursor else { return }
            let chunk = ns.substring(with: NSRange(location: cursor, length: upTo - cursor)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !chunk.isEmpty { out.append(.text(chunk)) }
        }
        for m in tag.matches(in: text, range: whole) where !code.contains(where: { NSIntersectionRange($0, m.range).length > 0 }) {
            addText(m.range.location)
            let type = ns.substring(with: m.range(at: 1)).lowercased()
            let attrs = m.range(at: 2).location == NSNotFound ? "" : ns.substring(with: m.range(at: 2))
            let body = m.range(at: 3).location == NSNotFound ? "" : ns.substring(with: m.range(at: 3))
            var to: String?
            if let a = attr.firstMatch(in: attrs, range: NSRange(location: 0, length: (attrs as NSString).length)) {
                let r = a.range(at: 1).location != NSNotFound ? a.range(at: 1) : a.range(at: 2)
                if r.location != NSNotFound { to = (attrs as NSString).substring(with: r).trimmingCharacters(in: .whitespaces) }
            }
            out.append(.order(AgentOrder(type: type, to: to, body: body.trimmingCharacters(in: .whitespacesAndNewlines))))
            cursor = m.range.location + m.range.length
        }
        addText(ns.length)
        return out
    }

    /// First line of a message without the markdown marks, for a folded row.
    static func preview(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("```") && !$0.allSatisfy { "-|:".contains($0) } } ?? ""
        return line.replacingOccurrences(of: #"^(#+|[-*>]|\d+\.)\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
    }
}

/// An agent's reply with its orders folded: the prose as usual, each order one tappable line.
struct ReplyWithOrders: View {
    let text: String
    let itemId: String
    let expanded: Set<String>
    let toggle: (String) -> Void

    var body: some View {
        let segments = AgentOrder.segments(in: text)
        if segments.count == 1, case .text = segments[0] {
            MarkdownText(text: text)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                    switch segment {
                    case .text(let prose):
                        MarkdownText(text: prose)
                    case .order(let order):
                        let id = "\(itemId)#order\(index)"
                        OrderRow(order: order, isExpanded: expanded.contains(id)) { toggle(id) }
                    }
                }
            }
        }
    }
}

private struct OrderRow: View {
    let order: AgentOrder
    let isExpanded: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Image(systemName: order.symbol)
                        .foregroundStyle(order.tint)
                    Text(order.label + (order.to.map { " → \($0)" } ?? ""))
                        .fontWeight(.semibold)
                        .layoutPriority(1)
                    if !isExpanded, !order.body.isEmpty {
                        Text(AgentOrder.preview(order.body))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if !order.body.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .font(.footnote)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(order.body.isEmpty)
            .accessibilityLabel("\(order.label)\(order.to.map { " para \($0)" } ?? "")")
            .accessibilityValue(isExpanded ? "Desplegado" : "Plegado")

            if isExpanded {
                Divider()
                MarkdownText(text: order.body)
                    .padding(12)
            }
        }
        .background(order.tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(order.tint.opacity(0.18)))
    }
}

/// What the agent is doing right now. A long command folds to one line; tap to read it whole.
struct WorkingRow: View {
    let text: String?
    @State private var isExpanded = false

    private var isLong: Bool {
        guard let text else { return false }
        return text.count > 60 || text.contains("\n")
    }

    var body: some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { isExpanded.toggle() }
        } label: {
            HStack(alignment: isExpanded ? .top : .center, spacing: 8) {
                ProgressView()
                Text(text ?? "Trabajando…")
                    .font(isLong ? .system(.footnote, design: .monospaced) : .callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(isExpanded ? nil : 1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isLong {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .padding(.vertical, 4)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isLong)
        .accessibilityValue(isLong ? (isExpanded ? "Desplegado" : "Plegado") : "")
    }
}
