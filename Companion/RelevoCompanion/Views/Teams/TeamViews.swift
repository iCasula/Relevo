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
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            MarkdownText(text: item.text)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(sender.role.color.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14)
                .fill(sender.role.color.opacity(0.6))
                .frame(width: 3)
        }
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
                    Label(team.isPaused ? "En pausa" : "Equipo", systemImage: team.isPaused ? "pause.circle.fill" : "person.3.sequence")
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
                        Text("Agentes")
                    } footer: {
                        Text("Cambia nombres, modelos o el plan si se acaba la cuota desde Relevo en el ordenador.")
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
