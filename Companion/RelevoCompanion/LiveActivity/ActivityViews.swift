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
    var subtitle: String { [accountName, model].compactMap { $0 }.joined(separator: " · ") }

    /// "2 trabajando · 1 te espera"
    var countsLine: String? {
        var parts: [String] = []
        if running > 0 { parts.append("\(running) trabajando") }
        if waiting > 0 { parts.append(waiting == 1 ? "1 te espera" : "\(waiting) te esperan") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
    let phase: RelevoActivityState.Phase
    /// No recent update reached the phone: don't claim the agent is still doing what it last did.
    var isStale = false

    var body: some View {
        let color = isStale ? Color.gray : phase.color
        Label(isStale ? "Sin actualizar" : phase.label, systemImage: isStale ? "clock.badge.questionmark" : phase.symbol)
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
                PhaseBadge(phase: state.phase, isStale: isStale)
            }

            if isStale, state.approval == nil {
                Text("Último estado conocido: \(state.phase.label.lowercased()). Abre Relevo para ver cómo va.")
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
