import SwiftUI
import AppKit

struct ItemView: View {
    @Environment(AppStore.self) private var store
    let item: ChatItem
    let runtime: ThreadRuntime
    let showsAuthor: Bool

    var body: some View {
        switch item.kind {
        case .user:
            UserBubble(text: item.text)
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                if showsAuthor { AuthorLine(item: item) }
                MarkdownText(text: item.text)
            }
        case .reasoning:
            ReasoningView(item: item, runtime: runtime)
        case .tool:
            ToolRow(item: item, runtime: runtime)
        case .notice:
            NoticeRow(item: item)
        case .error:
            ErrorRow(text: item.text)
        case .approval:
            ApprovalCard(item: item, runtime: runtime)
        }
    }
}

struct AuthorLine: View {
    @Environment(AppStore.self) private var store
    let item: ChatItem

    var body: some View {
        if let account = store.account(item.accountId) {
            HStack(spacing: 6) {
                ProviderBadge(kind: account.kind, size: 14)
                Text(account.name)
                    .font(.caption.weight(.semibold))
                Text(store.modelName(account, item.model ?? ""))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 80)
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }
}

struct ReasoningView: View {
    let item: ChatItem
    let runtime: ThreadRuntime

    var body: some View {
        let open = runtime.expandedItems.contains(item.id)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { runtime.toggleExpanded(item.id) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "brain")
                    Text("Razonamiento")
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if open {
                Text(item.text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 2) }
            }
        }
    }
}

struct ToolRow: View {
    let item: ChatItem
    let runtime: ThreadRuntime

    var body: some View {
        let open = runtime.expandedItems.contains(item.id)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { runtime.toggleExpanded(item.id) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: ToolSummary.symbol(for: item.toolName ?? item.title))
                        .frame(width: 16)
                        .foregroundStyle(.secondary)
                    Text(item.title ?? item.toolName ?? "Herramienta")
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 6)
                    switch item.status {
                    case .running?: ProgressView().controlSize(.mini)
                    case .failed?: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                    default: Image(systemName: "checkmark").font(.caption).foregroundStyle(.tertiary)
                    }
                    if hasDetail {
                        Image(systemName: open ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open && hasDetail {
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if !item.text.isEmpty, item.text != item.title {
                            Text(item.text)
                                .foregroundStyle(.secondary)
                        }
                        if let output = item.output, !output.isEmpty {
                            Text(output)
                        }
                    }
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
                .frame(maxHeight: 260)
            }
        }
        .background(Theme.subtleFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.hairline))
    }

    private var hasDetail: Bool {
        !(item.output ?? "").isEmpty || (!item.text.isEmpty && item.text != item.title)
    }
}

struct NoticeRow: View {
    @Environment(AppStore.self) private var store
    let item: ChatItem

    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.hairline).frame(height: 1)
            HStack(spacing: 6) {
                if let account = store.account(item.accountId), item.text.hasPrefix("Relevo") {
                    ProviderBadge(kind: account.kind, size: 13)
                }
                Text(item.text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let path = item.output, FileManager.default.fileExists(atPath: path) {
                    Button("Ver traspaso") { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
                        .buttonStyle(.link)
                        .font(.caption)
                        .help("Abre el paquete exacto que recibió el agente: estado de trabajo + transcripción")
                }
            }
            .layoutPriority(1)
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
        .padding(.vertical, 4)
    }
}

struct ErrorRow: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(text)
                .font(.callout)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct ApprovalCard: View {
    let item: ChatItem
    let runtime: ThreadRuntime

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text(item.resolution == nil ? "El agente pide permiso" : "Permiso")
                    .font(.callout.weight(.semibold))
                Spacer()
                if let r = item.resolution {
                    Text(r)
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Theme.subtleFill, in: Capsule())
                }
            }
            Text(item.title ?? "")
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(6)
            if !item.text.isEmpty {
                Text(item.text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(8)
            }
            if item.resolution == nil, let options = item.options {
                HStack(spacing: 8) {
                    ForEach(options) { option in
                        if option.isAllow && option.id == options.first(where: \.isAllow)?.id {
                            Button(option.label) { runtime.resolveApproval(itemId: item.id, option: option) }
                                .buttonStyle(.borderedProminent)
                                .keyboardShortcut(.return, modifiers: .command)
                        } else {
                            Button(option.label) { runtime.resolveApproval(itemId: item.id, option: option) }
                                .buttonStyle(.bordered)
                        }
                    }
                }
                .controlSize(.regular)
            }
        }
        .padding(12)
        .background(Color.orange.opacity(item.resolution == nil ? 0.07 : 0.03), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.orange.opacity(item.resolution == nil ? 0.3 : 0.12)))
    }
}

// MARK: - Markdown

/// Lightweight block-level Markdown renderer (headings, lists, code fences, quotes) with inline styling.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let content):
            inline(content)
                .font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, 4)
        case .paragraph(let content):
            inline(content)
                .lineSpacing(2)
        case .bullet(let indent, let marker, let content):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 14, alignment: .trailing)
                inline(content)
                    .lineSpacing(2)
            }
            .padding(.leading, CGFloat(indent) * 14)
        case .quote(let content):
            inline(content)
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 3) }
        case .code(let language, let code):
            CodeBlock(language: language, code: code)
        case .rule:
            Divider()
        }
    }

    private func inline(_ s: String) -> Text {
        if let attributed = try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(attributed)
        }
        return Text(s)
    }
}

struct CodeBlock: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "código" : language)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }
                .buttonStyle(.borderless)
                .help("Copiar")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            Divider()
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .padding(10)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .background(Theme.subtleFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.hairline))
    }
}

enum MarkdownBlock {
    case heading(Int, String)
    case paragraph(String)
    case bullet(indent: Int, marker: String, content: String)
    case quote(String)
    case code(language: String, code: String)
    case rule

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var inCode = false
        var codeLang = ""
        var codeLines: [String] = []

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }

        for rawLine in text.components(separatedBy: "\n") {
            let line = rawLine
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCode {
                    blocks.append(.code(language: codeLang, code: codeLines.joined(separator: "\n")))
                    codeLines.removeAll()
                    inCode = false
                } else {
                    flushParagraph()
                    inCode = true
                    codeLang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                }
                continue
            }
            if inCode {
                codeLines.append(line)
                continue
            }
            if trimmed.isEmpty {
                flushParagraph()
                continue
            }
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.rule)
                continue
            }
            if trimmed.hasPrefix("#") {
                let level = trimmed.prefix(while: { $0 == "#" }).count
                if level <= 6, trimmed.dropFirst(level).hasPrefix(" ") {
                    flushParagraph()
                    blocks.append(.heading(level, String(trimmed.dropFirst(level + 1))))
                    continue
                }
            }
            if trimmed.hasPrefix("> ") {
                flushParagraph()
                blocks.append(.quote(String(trimmed.dropFirst(2))))
                continue
            }
            let indent = (line.prefix(while: { $0 == " " }).count) / 2
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
                flushParagraph()
                var content = String(trimmed.dropFirst(2))
                var marker = "•"
                if content.hasPrefix("[ ] ") { marker = "☐"; content = String(content.dropFirst(4)) }
                else if content.lowercased().hasPrefix("[x] ") { marker = "☑︎"; content = String(content.dropFirst(4)) }
                blocks.append(.bullet(indent: indent, marker: marker, content: content))
                continue
            }
            if let match = trimmed.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
                flushParagraph()
                let marker = String(trimmed[match].dropLast())
                blocks.append(.bullet(indent: indent, marker: marker, content: String(trimmed[match.upperBound...])))
                continue
            }
            paragraph.append(line)
        }
        if inCode {
            blocks.append(.code(language: codeLang, code: codeLines.joined(separator: "\n")))
        }
        flushParagraph()
        return blocks
    }
}
