import SwiftUI
import RelevoProtocol
import RelevoMarkdown

struct TranscriptItemView: View {
    let item: RemoteItem
    let viewModel: ThreadViewModel
    let showsAuthor: Bool
    @AppStorage("showTurnUsage") private var showTurnUsage = true

    var body: some View {
        switch item.kind {
        case .user:
            UserBubble(text: item.text)
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                if showsAuthor { AuthorLine(account: viewModel.account(item.accountId), model: item.model) }
                MarkdownText(text: item.text)
                let images = FileReference.imageReferences(in: item.text)
                if !images.isEmpty {
                    ImageStrip(paths: images, load: { await viewModel.thumbnail($0) }, open: { viewModel.open(path: $0) })
                }
                if showTurnUsage, let usage = item.usage { TurnUsageLine(usage: usage) }
            }
        case .reasoning:
            ReasoningRow(item: item, isExpanded: viewModel.expanded.contains(item.id)) { viewModel.toggle(item) }
        case .tool:
            ToolRow(item: item, isExpanded: viewModel.expanded.contains(item.id)) { viewModel.toggle(item) }
        case .notice:
            NoticeRow(text: item.text)
        case .error:
            ErrorRow(text: item.text)
        case .approval:
            if let questions = item.questions, !questions.isEmpty {
                QuestionCard(item: item, questions: questions, isConnected: viewModel.isConnected,
                             answer: { viewModel.answer(item, answers: $0) },
                             skip: { if let skip = item.options?.first(where: { !$0.isAllow }) { viewModel.approve(item, option: skip) } })
            } else {
                ApprovalCard(item: item, isConnected: viewModel.isConnected) { option in viewModel.approve(item, option: option) }
            }
        }
    }
}

/// A folded run of tool calls: "4 acciones · Read, Edit, Bash". Tap to show them.
/// One line under a reply: tokens, cache and cost of the turn, and what a model or provider switch cost.
struct TurnUsageLine: View {
    let usage: RemoteTurnUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let label = usage.switchLabel, let overhead = usage.overhead, overhead >= 1000 {
                Label("\(label): +\(Self.short(overhead)) tokens" + (usage.overheadCost.map { " · \(Self.usd($0))" } ?? ""),
                      systemImage: "arrow.triangle.swap")
                    .foregroundStyle(.orange)
            }
            HStack(spacing: 8) {
                Text("\(Self.short(usage.tokens)) tokens")
                if let share = usage.cacheShare { Text("\(Int((share * 100).rounded()))\u{00A0}% caché") }
                if let cost = usage.cost { Text((usage.costEstimated ? "≈ " : "") + Self.usd(cost)) }
            }
            .foregroundStyle(.tertiary)
        }
        .font(.caption2.monospacedDigit())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = ["\(usage.tokens) tokens"]
        if let cost = usage.cost { parts.append("coste aproximado \(Self.usd(cost))") }
        if let label = usage.switchLabel, let overhead = usage.overhead { parts.append("\(label), \(overhead) tokens re-procesados") }
        return parts.joined(separator: ", ")
    }

    static func short(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        let v = Double(n)
        if n < 1_000_000 { return (v / 1000).formatted(.number.precision(.fractionLength(v < 10_000 ? 1 : 0))) + "k" }
        return (v / 1_000_000).formatted(.number.precision(.fractionLength(1))) + "M"
    }

    static func usd(_ v: Double) -> String {
        "$" + v.formatted(.number.precision(.fractionLength(v < 0.1 ? 3 : v < 100 ? 2 : 0)))
    }
}

struct ActivityGroupRow: View {
    let group: ThreadViewModel.ActivityGroup
    let isExpanded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 7) {
                if group.isRunning {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "wrench.and.screwdriver")
                }
                Text(group.summary)
                    .lineLimit(1)
                if group.failed > 0 {
                    Label("\(group.failed)", systemImage: "xmark.circle.fill")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(.red)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.fill.quaternary, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.summary + (group.failed > 0 ? ", \(group.failed) con error" : ""))
        .accessibilityValue(isExpanded ? "Desplegado" : "Plegado")
    }
}

/// The agent asks you something: options (one or several) or your own answer.
private struct QuestionCard: View {
    let item: RemoteItem
    let questions: [RemoteQuestion]
    let isConnected: Bool
    let answer: ([String: String]) -> Void
    let skip: () -> Void
    @State private var selected: [Int: Set<String>] = [:]
    @State private var other: [Int: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(questions.count == 1 ? "El agente te pregunta" : "El agente te hace \(questions.count) preguntas",
                  systemImage: "questionmark.bubble.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.tint)
            ForEach(Array(questions.enumerated()), id: \.offset) { index, q in
                VStack(alignment: .leading, spacing: 8) {
                    if let header = q.header, !header.isEmpty {
                        Text(header.uppercased() + (q.multiSelect ? " · varias opciones" : ""))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                    Text(q.question).font(.body.weight(.medium))
                    if let chosen = item.answers?[q.question] {
                        Label(chosen, systemImage: "checkmark.circle.fill").font(.subheadline).foregroundStyle(.green)
                    } else if item.resolution == nil {
                        ForEach(q.options, id: \.label) { option in optionRow(index: index, question: q, option: option) }
                        TextField("Otra respuesta…", text: Binding(get: { other[index] ?? "" }, set: { other[index] = $0 }), axis: .vertical)
                            .padding(10)
                            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }
            if item.resolution == nil {
                HStack {
                    Button("Responder", action: submit)
                        .buttonStyle(.glassProminent)
                        .disabled(!allAnswered || !isConnected)
                    Button("Omitir", action: skip)
                        .buttonStyle(.glass)
                        .disabled(!isConnected)
                }
            } else if item.answers == nil, let resolution = item.resolution {
                Label(resolution, systemImage: "xmark.circle").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(item.resolution == nil ? 0.08 : 0.03), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func optionRow(index: Int, question: RemoteQuestion, option: RemoteQuestion.Option) -> some View {
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
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: question.multiSelect ? (isOn ? "checkmark.square.fill" : "square") : (isOn ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(isOn ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.subheadline.weight(.medium))
                    if let d = option.description, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(isOn ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
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
        answer(answers)
    }
}

private struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .foregroundStyle(.white)
                .background(Color.accentColor.gradient, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
}

private struct AuthorLine: View {
    let account: RemoteAccount?
    let model: String?

    var body: some View {
        HStack(spacing: 6) {
            ProviderBadge(account: account, size: 16)
            Text(account?.name ?? "Agente")
                .font(.caption.weight(.semibold))
            Text(account?.modelName(model) ?? model ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct ReasoningRow: View {
    let item: RemoteItem
    let isExpanded: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: toggle) {
                HStack(spacing: 5) {
                    Image(systemName: "brain")
                    Text("Razonamiento")
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded ? "Desplegado" : "Plegado")
            if isExpanded {
                Text(item.text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Capsule().fill(.quaternary).frame(width: 2) }
            }
        }
    }
}

private struct ToolRow: View {
    let item: RemoteItem
    let isExpanded: Bool
    let toggle: () -> Void

    private var hasDetail: Bool {
        !(item.output ?? "").isEmpty || (!item.text.isEmpty && item.text != item.title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 10) {
                    Image(systemName: Self.symbol(for: item.toolName ?? item.title ?? ""))
                        .frame(width: 18)
                        .foregroundStyle(.secondary)
                    Text(item.title ?? item.toolName ?? "Herramienta")
                        .font(.system(.footnote, design: .monospaced))
                        .lineLimit(isExpanded ? 4 : 1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    switch item.toolState {
                    case .running?: ProgressView().controlSize(.small)
                    case .failed?: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                    default: Image(systemName: "checkmark").font(.caption).foregroundStyle(.tertiary)
                    }
                    if hasDetail {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!hasDetail)
            .accessibilityValue(isExpanded ? "Desplegado" : "Plegado")

            if isExpanded && hasDetail {
                Divider()
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 8) {
                        if !item.text.isEmpty, item.text != item.title {
                            Text(item.text).foregroundStyle(.secondary)
                        }
                        if let output = item.output, !output.isEmpty {
                            Text(output)
                        }
                    }
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                }
                .frame(maxHeight: 280)
            }
        }
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    static func symbol(for name: String) -> String {
        let n = name.lowercased()
        if n.contains("bash") || n.contains("shell") || n.contains("command") || n.contains("exec") { return "terminal" }
        if n.contains("edit") || n.contains("write") || n.contains("patch") || n.contains("edición") { return "pencil" }
        if n.contains("read") || n.contains("view") { return "doc.text" }
        if n.contains("grep") || n.contains("search") || n.contains("glob") || n.contains("find") { return "magnifyingglass" }
        if n.contains("web") || n.contains("fetch") { return "globe" }
        if n.contains("task") || n.contains("todo") { return "checklist" }
        return "wrench.and.screwdriver"
    }
}

private struct NoticeRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
    }
}

private struct ErrorRow: View {
    let text: String

    var body: some View {
        Label {
            Text(text).textSelection(.enabled)
        } icon: {
            Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(.red)
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// Permission request from the agent: big, clear buttons, since this is often why you opened the app.
private struct ApprovalCard: View {
    let item: RemoteItem
    let isConnected: Bool
    let respond: (RemoteOption) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(item.title ?? "Permiso")
                    .font(.subheadline.weight(.semibold))
            } icon: {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            }
            if !item.text.isEmpty {
                Text(item.text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(8)
                    .textSelection(.enabled)
            }
            if let resolution = item.resolution {
                Label(resolution, systemImage: resolution.hasPrefix("Permitir") ? "checkmark.circle.fill" : "xmark.circle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(resolution.hasPrefix("Permitir") ? .green : .secondary)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack { buttons }
                    VStack(alignment: .leading) { buttons }
                }
                .disabled(!isConnected)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(item.resolution == nil ? 0.10 : 0.04), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder
    private var buttons: some View {
        ForEach(item.options ?? []) { option in
            if option.isAllow {
                Button(option.label) { respond(option) }
                    .buttonStyle(.glassProminent)
            } else {
                Button(option.label, role: .destructive) { respond(option) }
                    .buttonStyle(.glass)
            }
        }
    }
}
