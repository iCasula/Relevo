import SwiftUI
import RelevoProtocol

/// Provider icon: the provider's real logo (Claude, OpenAI, Antigravity, Gemini, DeepSeek), or an SF Symbol on
/// its colour for the others, like the Mac app.
struct ProviderBadge: View {
    let account: RemoteAccount?
    var size: CGFloat = 22

    var body: some View {
        Group {
            if let logo = Self.logo(account) {
                Image(logo.asset)
                    .resizable()
                    .renderingMode(logo.tinted ? .template : .original)
                    .scaledToFit()
                    .foregroundStyle(logo.tinted ? AnyShapeStyle(logo.tint ?? .primary) : AnyShapeStyle(.primary))
                    .padding(size * 0.04)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                        .fill((account?.tintColor ?? .gray).gradient)
                    Image(systemName: account?.symbol ?? "questionmark")
                        .font(.system(size: size * 0.55, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    struct Logo {
        let asset: String
        var tinted = false
        var tint: Color?
    }

    /// Which logo a subscription shows, by its provider (the host's account kind).
    static func logo(_ account: RemoteAccount?) -> Logo? {
        guard let kind = account?.kind else { return nil }
        switch kind {
        case "claude", "api:anthropic": return Logo(asset: "ProviderClaude")
        case "codex": return Logo(asset: "ProviderOpenAI", tinted: true)
        case "gemini": return Logo(asset: "ProviderAntigravity", tinted: true, tint: Color(red: 0.27, green: 0.52, blue: 0.96))
        case "acp:gemini": return Logo(asset: "ProviderGemini")
        default: return kind.contains("deepseek") || kind.contains("dsh") ? Logo(asset: "ProviderDeepSeek") : nil
        }
    }
}

/// Connection state shown at the top of the lists when the Mac isn't reachable.
struct ConnectionStatusRow: View {
    let state: CompanionClient.ConnectionState
    let macName: String
    let retry: () -> Void

    var body: some View {
        switch state {
        case .connected, .unpaired:
            EmptyView()
        case .connecting:
            Label {
                Text("Conectando con \(macName)…")
            } icon: {
                ProgressView()
            }
            .foregroundStyle(.secondary)
        case .offline(let reason):
            HStack {
                Label(reason, systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.orange)
                Spacer()
                Button("Reintentar", action: retry)
                    .buttonStyle(.glass)
                    .controlSize(.small)
            }
        }
    }
}

/// Usage bar of one quota window with its reset time.
struct UsageWindowView: View {
    let window: RemoteWindow
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(window.label)
                Spacer()
                Text("\(Int(window.percent.rounded())) %")
                    .monospacedDigit()
                    .foregroundStyle(window.percent >= 90 ? .red : .secondary)
            }
            .font(compact ? .caption : .subheadline)
            ProgressView(value: min(window.percent, 100), total: 100)
                .tint(window.tint)
            if !compact, let reset = ResetFormatter.string(window.resetsAt) {
                Text("Se reinicia \(reset)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
