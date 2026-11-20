import SwiftUI
import RelevoProtocol
import RelevoMarkdown

// Teams of agents (Relevo hosts): an orchestrator, executors and a researcher, each in its own thread.

extension RemoteTeamRole {
    var color: Color {
        switch self {
        case .orchestrator: .orange
        case .executor: .blue
        case .researcher: .green
        case .relevo, .team: .secondary
        }
    }
}

extension RemoteTeamMember.Task {
    /// "en curso · Arreglar el shader", "hecha", "bloqueado"…
    var line: String? {
        let parts = [state, text].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// "Orq." / "Ejecutor 1" with the role's icon and colour.
struct RoleChip: View {
    let role: RemoteTeamRole
    let name: String

    var body: some View {
        Label(name, systemImage: role.symbol)
            .labelStyle(.titleAndIcon)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(role.color)
            .background(role.color.opacity(0.14), in: Capsule())
    }
}

/// What a member is doing now, from its thread.
struct MemberState: View {
    let thread: RemoteThreadSummary?

    var body: some View {
        if thread?.needsApproval == true {
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
        } else if thread?.attention != nil {
            Image(systemName: "text.bubble.fill").foregroundStyle(.tint)
        } else if thread?.isRunning == true {
            ProgressView().controlSize(.mini)
        } else if thread?.isWaiting == true {
            Image(systemName: "clock").foregroundStyle(.secondary)
        }
    }
}

/// A message another agent of the team (or Relevo) sent to this thread: who, what kind, when.
struct AgentMessageRow: View {
    let item: RemoteItem
    let sender: RemoteSender
    let currentThread: UUID
    let expanded: Set<String>
    let toggle: (String) -> Void

    /// Short messages show whole; longer ones fold to a few lines (tap to read them).
    private var isLong: Bool { item.text.count > 220 || item.text.split(whereSeparator: \.isNewline).count > 3 }
    private var isExpanded: Bool { expanded.contains(item.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: sender.role.symbol)
                    .foregroundStyle(sender.role.color)
                Text(sender.name)
                    .fontWeight(.semibold)
                    .foregroundStyle(.primary)
                if let label = sender.label { Text("· \(label)") }
                Text(item.date, format: .dateTime.hour().minute())
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 4)
                if let id = sender.threadId, id != currentThread {
                    NavigationLink(value: id) {
                        Text("Ver hilo")
                    }
                    .font(.caption.weight(.medium))
                }
                if isLong {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if isLong && !isExpanded {
                Text(Self.folded(item.text))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ReplyWithOrders(text: item.text, itemId: item.id, expanded: expanded, toggle: toggle)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(sender.role.color.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14)
                .fill(sender.role.color.opacity(0.6))
                .frame(width: 3)
        }
        .contentShape(.rect)
        .onTapGesture {
            guard isLong else { return }
            withAnimation(.snappy(duration: 0.2)) { toggle(item.id) }
        }
        .accessibilityAction(named: isExpanded ? "Plegar" : "Desplegar") { if isLong { toggle(item.id) } }
    }

    /// The opening lines without tags or markdown marks.
    static func folded(_ text: String) -> String {
        let plain = AgentOrder.segments(in: text).map { segment -> String in
            switch segment {
            case .text(let t): t
            case .order(let o): o.label + (o.to.map { " → \($0)" } ?? "") + ": " + o.body
            }
        }.joined(separator: "\n")
        return plain.split(whereSeparator: \.isNewline)
            .map { AgentOrder.preview(String($0)) }
            .filter { !$0.isEmpty }
            .prefix(3)
            .joined(separator: " ")
    }
}

/// The team's members under the title of each of their threads: tap one to go to its thread.
struct TeamStrip: View {
    let team: RemoteTeam
    let currentThread: UUID
    let client: CompanionClient
    let showTeam: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button(action: showTeam) {
                    HStack(spacing: 5) {
                        Label(team.isPaused ? "En pausa" : "Equipo", systemImage: team.isPaused ? "pause.circle.fill" : "person.3.sequence")
                        if let held = team.heldList?.count, held > 0 {
                            Text("· \(held) retenidos")
                                .foregroundStyle(.orange)
                        }
                        if let count = team.milestones?.count, count > 0 {
                            Text("\(team.milestonesDone)/\(count)")
                                .monospacedDigit()
                                .foregroundStyle(.green)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(team.isPaused ? .orange : .secondary)
                }
                .buttonStyle(.plain)
                ForEach(team.members) { member in
                    let thread = client.snapshot?.threads.first { $0.id == member.threadId }
                    let chip = HStack(spacing: 4) {
                        Image(systemName: member.role.symbol)
                            .foregroundStyle(member.role.color)
                        Text(member.name)
                            .lineLimit(1)
                        ProviderBadge(account: client.account(member.accountId), size: 13)
                        MemberState(thread: thread)
                    }
                    .font(.caption)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    if member.threadId == currentThread {
                        chip
                            .fontWeight(.semibold)
                            .background(member.role.color.opacity(0.16), in: Capsule())
                    } else {
                        NavigationLink(value: member.threadId) { chip }
                            .buttonStyle(.plain)
                            .background(.fill.quaternary, in: Capsule())
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }
}

/// The whole team: goal, each member with its model and task, and pause / resume.
struct TeamSheet: View {
    let teamId: String
    let client: CompanionClient
    let open: (UUID) -> Void
    @Environment(\.dismiss) private var dismiss

    private var team: RemoteTeam? { client.snapshot?.hostTeams?.first { $0.id == teamId } }

    var body: some View {
        NavigationStack {
            List {
                if let team {
                    Section("Objetivo") {
                        Text(team.goal)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                    Section {
                        ForEach(team.members) { member in
                            Button {
                                dismiss()
                                open(member.threadId)
                            } label: {
                                MemberRow(member: member, account: client.account(member.accountId),
                                          thread: client.snapshot?.threads.first { $0.id == member.threadId })
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        HStack {
                            Text("Agentes")
                            Spacer()
                            if let total = TeamSpend.total(team) { Text("\(total) hoy").textCase(nil) }
                        }
                    } footer: {
                        Text("Cambia nombres, modelos o el plan si se acaba la cuota desde Relevo en el ordenador.")
                    }
                    if let held = team.heldList, !held.isEmpty {
                        HeldSection(team: team, held: held, client: client)
                    }
                    MilestonesSection(team: team, client: client)
                    DecisionsSection(team: team, client: client)
                    if let findings = team.findings, !findings.isEmpty {
                        FindingsSection(team: team, findings: findings, client: client)
                    }
                    Section {
                        if team.isPaused {
                            Button("Reanudar el equipo", systemImage: "play.fill") { client.send(.teamAction(teamId: team.id, action: "resume")) }
                            if let held = team.held, held > 0 {
                                Text(held == 1 ? "1 mensaje entre agentes espera" : "\(held) mensajes entre agentes esperan")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Button("Pausar el equipo", systemImage: "pause.fill") { client.send(.teamAction(teamId: team.id, action: "pause")) }
                        }
                    } footer: {
                        Text("En pausa, los mensajes entre agentes esperan; lo que cada uno está haciendo termina.")
                    }
                    .disabled(!client.isConnected)
                } else {
                    ContentUnavailableView("El equipo ya no existe", systemImage: "person.3")
                }
            }
            .navigationTitle("Equipo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Listo") { dismiss() } }
            }
        }
    }
}

enum TeamSpend {
    static func text(_ spend: RemoteSpend?) -> String? {
        guard let spend, spend.tokens > 0 else { return nil }
        let tokens = TurnUsageLine.short(spend.tokens) + " tokens"
        guard let cost = spend.cost, cost > 0 else { return tokens }
        return tokens + " · " + (spend.estimated == true ? "≈ " : "") + TurnUsageLine.usd(cost)
    }

    static func total(_ team: RemoteTeam) -> String? {
        let cost = team.members.compactMap { $0.today?.cost }.reduce(0, +)
        let tokens = team.members.compactMap { $0.today?.tokens }.reduce(0, +)
        if cost > 0 { return (team.members.contains { $0.today?.estimated == true } ? "≈ " : "") + TurnUsageLine.usd(cost) }
        return tokens > 0 ? TurnUsageLine.short(tokens) + " tokens" : nil
    }
}

/// The goal's milestones with the team's progress. Tap one to mark it done or pending.
private struct MilestonesSection: View {
    let team: RemoteTeam
    let client: CompanionClient
    @State private var draft = ""

    var body: some View {
        let list = team.milestones ?? []
        Section {
            if !list.isEmpty {
                ProgressView(value: Double(team.milestonesDone), total: Double(list.count))
                    .tint(.green)
            }
            ForEach(list) { milestone in
                Button {
                    client.send(.teamMemory(teamId: team.id, kind: "milestone", add: nil, remove: nil, toggle: String(milestone.id)))
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: milestone.done ? "checkmark.circle.fill" : milestone.id == team.currentMilestone?.id ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(milestone.done ? .green : .secondary)
                        Text(milestone.text)
                            .font(.callout)
                            .fontWeight(milestone.id == team.currentMilestone?.id ? .semibold : .regular)
                            .foregroundStyle(milestone.done ? .secondary : .primary)
                            .strikethrough(milestone.done, color: .secondary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!client.isConnected)
                .swipeActions {
                    Button("Quitar", systemImage: "trash", role: .destructive) {
                        client.send(.teamMemory(teamId: team.id, kind: "milestone", add: nil, remove: String(milestone.id), toggle: nil))
                    }
                }
            }
            HStack {
                TextField("Añadir un hito", text: $draft, axis: .vertical)
                    .lineLimit(1...3)
                    .submitLabel(.done)
                    .onSubmit(add)
                Button("Añadir", systemImage: "plus.circle.fill", action: add)
                    .labelStyle(.iconOnly)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !client.isConnected)
            }
        } header: {
            HStack {
                Text("Hitos")
                Spacer()
                if !list.isEmpty { Text("\(team.milestonesDone)/\(list.count)").textCase(nil) }
            }
        } footer: {
            Text("Los pasos hacia el objetivo. El orquestador los escribe y marca los conseguidos; toca uno para cambiarlo tú.")
        }
    }

    private func add() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        client.send(.teamMemory(teamId: team.id, kind: "milestone", add: text, remove: nil, toggle: nil))
        draft = ""
    }
}

/// Messages held while the team was paused: send or drop each one (many go stale).
private struct HeldSection: View {
    let team: RemoteTeam
    let held: [RemoteHeldMessage]
    let client: CompanionClient

    var body: some View {
        Section {
            ForEach(held) { message in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 4) {
                        Text("\(message.from) → \(message.to)").fontWeight(.semibold)
                        if let label = message.label { Text("· \(label)") }
                        Spacer()
                        if let at = message.at { Text(at, format: .dateTime.hour().minute()).monospacedDigit() }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text(message.text)
                        .font(.callout)
                        .lineLimit(6)
                    HStack {
                        Button("Enviar", systemImage: "paperplane") { client.send(.teamHeld(teamId: team.id, id: message.id, action: "send")) }
                            .buttonStyle(.borderedProminent)
                        Button("Descartar", systemImage: "trash", role: .destructive) { client.send(.teamHeld(teamId: team.id, id: message.id, action: "discard")) }
                            .buttonStyle(.bordered)
                    }
                    .controlSize(.small)
                    .disabled(!client.isConnected)
                }
                .padding(.vertical, 2)
            }
        } header: {
            Label("Retenidos (\(held.count))", systemImage: "pause.circle")
                .foregroundStyle(.orange)
        } footer: {
            Text("No se entregaron porque el equipo estaba en pausa. Si descartas una orden, el orquestador se entera.")
        }
    }
}

/// What the researcher found, kept so nobody searches for it again.
private struct FindingsSection: View {
    let team: RemoteTeam
    let findings: [RemoteTeamFinding]
    let client: CompanionClient

    var body: some View {
        Section("Investigado") {
            ForEach(findings.reversed()) { finding in
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(finding.summary)
                            .font(.caption)
                            .textSelection(.enabled)
                        ForEach(finding.links ?? [], id: \.self) { link in
                            if let url = URL(string: link) {
                                Link(link.replacingOccurrences(of: "https://", with: ""), destination: url)
                                    .font(.caption2)
                                    .lineLimit(1)
                            }
                        }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(finding.topic)
                            .font(.callout)
                            .lineLimit(2)
                        if let at = finding.at {
                            Text(at, format: .dateTime.day().month(.abbreviated).hour().minute())
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .swipeActions {
                    Button("Quitar", systemImage: "trash", role: .destructive) {
                        client.send(.teamMemory(teamId: team.id, kind: "finding", add: nil, remove: String(finding.id), toggle: nil))
                    }
                }
            }
        }
    }
}

/// What the team decided: Relevo reminds every agent. Swipe to withdraw one, or add your own.
private struct DecisionsSection: View {
    let team: RemoteTeam
    let client: CompanionClient
    @State private var draft = ""

    var body: some View {
        Section {
            ForEach(team.decisions ?? []) { decision in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("#\(decision.id)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(decision.text)
                            .font(.callout)
                            .textSelection(.enabled)
                        Text(decision.by == "usuario" ? "Tú" : decision.by ?? "")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .swipeActions {
                    Button("Retirar", systemImage: "trash", role: .destructive) {
                        client.send(.teamDecisions(teamId: team.id, add: nil, remove: String(decision.id)))
                    }
                    .disabled(!client.isConnected)
                }
            }
            HStack {
                TextField("Añadir una decisión", text: $draft, axis: .vertical)
                    .lineLimit(1...3)
                    .submitLabel(.done)
                    .onSubmit(add)
                Button("Añadir", systemImage: "plus.circle.fill", action: add)
                    .labelStyle(.iconOnly)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !client.isConnected)
            }
        } header: {
            Text("Decisiones")
        } footer: {
            Text("Lo que ya está decidido. Relevo se lo recuerda a cada agente, también cuando empieza una sesión nueva o cambia de proveedor.")
        }
    }

    private func add() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        client.send(.teamDecisions(teamId: team.id, add: text, remove: nil))
        draft = ""
    }
}

private struct MemberRow: View {
    let member: RemoteTeamMember
    let account: RemoteAccount?
    let thread: RemoteThreadSummary?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ProviderBadge(account: account, size: 26)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    RoleChip(role: member.role, name: member.name)
                    Text(account.map { "\($0.name) · \($0.modelName(member.model))" } ?? "")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    MemberState(thread: thread)
                        .font(.caption)
                }
                if let line = member.task?.line {
                    Text(line)
                        .font(.subheadline)
                        .lineLimit(2)
                } else if let preview = thread?.preview {
                    Text(MarkdownInline.plain(preview))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if let spend = TeamSpend.text(member.today) {
                    Text("Hoy: \(spend)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                if let attention = thread?.attention?.text {
                    Label(attention, systemImage: "text.bubble.fill")
                        .font(.caption)
                        .foregroundStyle(.tint)
                        .lineLimit(2)
                }
            }
        }
        .contentShape(Rectangle())
    }
}
