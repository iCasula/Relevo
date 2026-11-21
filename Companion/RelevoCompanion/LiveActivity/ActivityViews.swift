import AppIntents
import SwiftUI
import RelevoProtocol

extension RelevoActivityState.Phase {
    var label: String {
        switch self {
        case .needsYou: "Te necesita"
        case .limit: "Límite"
        case .working: "Trabajando"
        case .finished: "Terminado"
        case .idle: "En pausa"
        }
    }

    var symbol: String {
        switch self {
        case .needsYou: "hand.raised.fill"
        case .limit: "hourglass"
        case .working: "ellipsis.circle.fill"
        case .finished: "checkmark.circle.fill"
        case .idle: "moon.zzz.fill"
        }
    }

    var color: Color {
        switch self {
        case .needsYou, .limit: .orange
        case .working: .blue
        case .finished: .green
        case .idle: .gray
        }
    }
}

extension RelevoActivityState {
    var tintColor: Color { tint.map(Color.init(hex:)) ?? .blue }
    /// A team's milestones and goal; a thread's provider and model.
    var subtitle: String { detail ?? [accountName, model].compactMap { $0 }.joined(separator: " · ") }

    /// Done and talking to you (the orchestrator waiting for your answer) reads apart from a plain "finished".
    var isReady: Bool { phase == .finished && ready == true }
    var phaseLabel: String { isReady ? "Te espera" : phase.label }
    var phaseSymbol: String { isReady ? "bubble.left.and.text.bubble.right.fill" : phase.symbol }
    var phaseColor: Color { isReady ? .green : phase.color }

    /// "2 trabajando · 1 te espera · y 1 más"
    var countsLine: String? {
        var parts: [String] = []
        if running > 0, agents == nil { parts.append("\(running) trabajando") }
        if waiting > 0 { parts.append(waiting == 1 ? "1 te espera" : "\(waiting) te esperan") }
        if let others, others > 0 { parts.append(others == 1 ? "y 1 cosa más" : "y \(others) cosas más") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

extension RelevoActivityState.Agent {
    /// "Ejecutor 1" → "E1", "Orquestador" → "Orq", "Investigador" → "Inv".
    var short: String {
        let digits = name.filter(\.isNumber)
        if !digits.isEmpty, let first = name.first { return "\(first)\(digits)" }
        return String(name.prefix(3))
    }

    var roleSymbol: String {
        switch role {
        case "orchestrator": "crown.fill"
        case "researcher": "magnifyingglass"
        default: "wrench.and.screwdriver.fill"
        }
    }

    var stateLabel: String {
        switch state {
        case "needsYou": "te necesita"
        case "working": "trabajando"
        case "background": "en segundo plano"
        case "reviewing": "permiso al orquestador"
        case "limit": "sin cuota"
        default: "libre"
        }
    }

    var stateColor: Color {
        switch state {
        case "needsYou": .orange
        case "working": .blue
        case "background": .teal
        case "reviewing": .purple
        case "limit": .red
        default: .gray
        }
    }

    var isActive: Bool { ["needsYou", "working", "background", "reviewing"].contains(state) }
}

/// One chip per agent: who it is and, by colour, where it stands (busy ones filled, free ones outlined).
struct AgentsRow: View {
    let agents: [RelevoActivityState.Agent]
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 4 : 6) {
            ForEach(agents, id: \.self) { agent in
                HStack(spacing: 3) {
                    Image(systemName: agent.roleSymbol)
                        .font(.system(size: compact ? 8 : 9, weight: .bold))
                    Text(agent.short)
                        .font(.system(size: compact ? 10 : 11, weight: .semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(agent.isActive ? .white : agent.stateColor)
                .padding(.horizontal, compact ? 5 : 7)
                .padding(.vertical, 3)
                .background(agent.isActive ? agent.stateColor.opacity(0.9) : agent.stateColor.opacity(0.15), in: Capsule())
                .accessibilityLabel("\(agent.name), \(agent.stateLabel)")
            }
        }
    }
}

struct ActivityProviderBadge: View {
    let state: RelevoActivityState
    var size: CGFloat = 28

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(state.tintColor.gradient)
            Image(systemName: state.symbol ?? "arrow.triangle.2.circlepath")
                .font(.system(size: size * 0.52, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

struct PhaseBadge: View {
    let state: RelevoActivityState
    /// No recent update reached the phone: don't claim the agent is still doing what it last did.
    var isStale = false

    var body: some View {
        let color = isStale ? Color.gray : state.phaseColor
        Label(isStale ? "Sin actualizar" : state.phaseLabel, systemImage: isStale ? "clock.badge.questionmark" : state.phaseSymbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.18), in: Capsule())
    }
}

/// Permission buttons that answer from the Lock Screen / Dynamic Island without opening the app.
struct ApprovalButtons: View {
    let state: RelevoActivityState
    let approval: RelevoActivityState.Approval

    var body: some View {
        HStack(spacing: 8) {
            ForEach(approval.options) { option in
                if let threadId = state.threadId {
                    Button(intent: ApprovalIntent(threadId: threadId, itemId: approval.itemId, optionId: option.id)) {
                        Text(option.label)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(option.isAllow ? .green : .red.opacity(0.85))
                }
            }
        }
    }
}

/// Lock Screen (and banner) presentation.
struct ActivityLockScreenView: View {
    let state: RelevoActivityState
    let macName: String
    var isStale = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ActivityProviderBadge(state: state)
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.threadTitle.isEmpty ? "Relevo" : state.threadTitle)
                        .font(.headline)
                        .lineLimit(1)
                    if !state.subtitle.isEmpty {
                        Text(state.subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                PhaseBadge(state: state, isStale: isStale)
            }

            if isStale, state.approval == nil {
                Text("Último estado conocido: \(state.phaseLabel.lowercased()). Abre Relevo para ver cómo va.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else if let approval = state.approval {
                VStack(alignment: .leading, spacing: 4) {
                    Text(approval.title)
                        .font(.system(.subheadline, design: .monospaced).weight(.medium))
                        .lineLimit(2)
                    if let detail = approval.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                ApprovalButtons(state: state, approval: approval)
            } else if let status = state.statusLine, !status.isEmpty {
                Text(status)
                    .font(.subheadline)
                    .lineLimit(2)
            }

            if let agents = state.agents, !agents.isEmpty, !isStale {
                AgentsRow(agents: agents)
            }

            HStack {
                Text([state.countsLine, macName].compactMap { $0 }.joined(separator: " · "))
                Spacer()
                if state.updatedAt > 0 {
                    Text(Date(timeIntervalSince1970: state.updatedAt), style: .relative)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(16)
    }
}
