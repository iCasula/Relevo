import SwiftUI
import QuickLook
import RelevoMarkdown
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
                let images = FileReference.imageReferences(in: item.text)
                if !images.isEmpty {
                    ImageStrip(paths: images, load: { path in await thumbnail(path) }, open: { runtime.openReference($0, nearText: item.text) })
                }
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
            if let questions = item.questions, !questions.isEmpty {
                QuestionCard(item: item, questions: questions, runtime: runtime)
            } else {
                ApprovalCard(item: item, runtime: runtime)
            }
        }
    }
}

extension ItemView {
    /// Thumbnail of an image the reply mentions, read from disk off the main thread.
    func thumbnail(_ path: String) async -> CGImage? {
        guard let url = FilePaths.resolve(path, thread: runtime.thread, projectPath: store.project(runtime.thread.projectId)?.path,
                                          nearText: item.text) else { return nil }
        return await Task.detached(priority: .utility) { ThumbnailMaker.image(url: url, maxPixel: 400) }.value
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

/// A folded run of tool calls: "4 acciones · Read, Edit, Bash". Click to show them.
struct ToolGroupRow: View {
    let items: [ChatItem]
    let isExpanded: Bool
    let toggle: () -> Void

    private var tools: [ChatItem] { items.filter { $0.kind == .tool } }

    private var summary: String {
        var names: [String] = []
        for tool in tools {
            let name = tool.toolName ?? tool.title?.split(separator: " ").first.map(String.init) ?? "Herramienta"
            if !names.contains(name) { names.append(name) }
        }
        let count = tools.count == 1 ? "1 acción" : "\(tools.count) acciones"
        let list = names.prefix(4).joined(separator: ", ") + (names.count > 4 ? "…" : "")
        return list.isEmpty ? count : "\(count) · \(list)"
    }

    var body: some View {
        let failed = tools.filter { $0.status == .failed }.count
        let running = tools.contains { $0.status == .running }
        Button(action: toggle) {
            HStack(spacing: 6) {
                if running {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "wrench.and.screwdriver")
                }
                Text(summary).lineLimit(1)
                if failed > 0 {
                    Label("\(failed)", systemImage: "xmark.circle.fill").foregroundStyle(.red)
                }
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right").font(.caption2)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.subtleFill, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Ocultar estas acciones" : "Ver estas acciones")
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

/// The agent asks you something (AskUserQuestion): pick options or write your own answer.
struct QuestionCard: View {
    let item: ChatItem
    let questions: [AgentQuestion]
    let runtime: ThreadRuntime
    @State private var selected: [Int: Set<String>] = [:]
    @State private var other: [Int: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(questions.count == 1 ? "El agente te pregunta" : "El agente te hace \(questions.count) preguntas", systemImage: "questionmark.bubble.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            ForEach(Array(questions.enumerated()), id: \.offset) { index, q in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        if let header = q.header, !header.isEmpty {
                            Text(header.uppercased())
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Theme.subtleFill, in: Capsule())
                        }
                        if q.multiSelect { Text("varias opciones").font(.caption2).foregroundStyle(.secondary) }
                    }
                    Text(q.question).font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                    if let answer = item.answers?[q.question] {
                        Label(answer, systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.green)
                    } else if item.resolution == nil {
                        ForEach(q.options, id: \.label) { option in
                            optionRow(index: index, question: q, option: option)
                        }
                        TextField("Otra respuesta…", text: Binding(get: { other[index] ?? "" }, set: { other[index] = $0 }))
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }
            if item.resolution == nil {
                HStack {
                    Button("Responder", action: submit)
                        .buttonStyle(.borderedProminent)
                        .disabled(!allAnswered)
                    Button("Omitir") {
                        if let skip = item.options?.first(where: { !$0.isAllow }) { runtime.resolveApproval(itemId: item.id, option: skip) }
                    }
                    .help("No responder: el agente seguirá por su cuenta")
                }
            } else if item.answers == nil {
                Label(item.resolution ?? "", systemImage: "xmark.circle").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(item.resolution == nil ? 0.07 : 0.03), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.accentColor.opacity(0.2)))
    }

    private func optionRow(index: Int, question: AgentQuestion, option: AgentQuestion.Option) -> some View {
        let isOn = selected[index]?.contains(option.label) ?? false
        return Button {
            var set = selected[index] ?? []
            if question.multiSelect {
                if set.remove(option.label) == nil { set.insert(option.label) }
            } else {
                set = isOn ? [] : [option.label]
            }
            selected[index] = set
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: question.multiSelect ? (isOn ? "checkmark.square.fill" : "square") : (isOn ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(isOn ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.callout)
                    if let d = option.description, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 5).padding(.horizontal, 8)
            .background(isOn ? Color.accentColor.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func answer(for index: Int) -> String? {
        let text = (other[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        let picked = questions[index].options.map(\.label).filter { selected[index]?.contains($0) ?? false }
        return picked.isEmpty ? nil : picked.joined(separator: ", ")
    }

    private var allAnswered: Bool { questions.indices.allSatisfy { answer(for: $0) != nil } }

    private func submit() {
        var answers: [String: String] = [:]
        for (i, q) in questions.enumerated() { if let a = answer(for: i) { answers[q.question] = a } }
        runtime.answerQuestions(itemId: item.id, answers: answers)
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
/// Agent replies and the trace: the shared renderer (same output as Relevo Companion on the iPhone).
struct MarkdownText: View {
    let text: String

    var body: some View {
        MarkdownView(text)
    }
}
