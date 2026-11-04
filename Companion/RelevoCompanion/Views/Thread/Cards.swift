import SwiftUI
import RelevoProtocol

/// The agent hit a limit (or its plan has no access): continue with another subscription in one tap.
/// In the limit card: the relay about to happen (with a countdown to stop it) or the wait for the reset.
private struct LimitPlanStatus: View {
    let viewModel: ThreadViewModel

    var body: some View {
        if let pending = viewModel.runtime?.pendingRelay, let target = viewModel.account(pending.accountId) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let seconds = max(0, Int(pending.at.timeIntervalSince(context.date).rounded(.up)))
                VStack(alignment: .leading, spacing: 8) {
                    Label("Pasa a \(target.name) · \(target.shortModelName(pending.model)) en \(seconds) s, con todo el contexto",
                          systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote)
                    HStack {
                        Button("Ahora") { viewModel.limitAction(.relayNow) }
                            .buttonStyle(.glassProminent)
                        Button("No relevar") { viewModel.limitAction(.cancelRelay) }
                            .buttonStyle(.glass)
                    }
                    .font(.footnote)
                }
            }
        } else if let at = viewModel.runtime?.resumeAt {
            VStack(alignment: .leading, spacing: 8) {
                Label("Seguirá " + (ResetFormatter.string(at) ?? "cuando se reinicie la cuota") + " con el mismo agente, donde lo dejó",
                      systemImage: "clock")
                    .font(.footnote)
                HStack {
                    Button("Retomar ahora") { viewModel.limitAction(.resumeNow) }
                        .buttonStyle(.glass)
                    Button("No esperar") { viewModel.limitAction(.cancelResume) }
                        .buttonStyle(.glass)
                }
                .font(.footnote)
            }
        }
    }
}

struct LimitCard: View {
    let limit: RemoteLimit
    let viewModel: ThreadViewModel

    var body: some View {
        let account = viewModel.account(limit.accountId)
        let candidates = viewModel.runtime?.relayCandidates ?? []
        VStack(alignment: .leading, spacing: 10) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(account?.name))
                        .font(.subheadline.weight(.semibold))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: limit.isNoPlan ? "creditcard.trianglebadge.exclamationmark" : "hourglass")
                    .foregroundStyle(.orange)
            }
            LimitPlanStatus(viewModel: viewModel)
            if candidates.isEmpty {
                Text("No hay otras suscripciones con cuota disponible ahora mismo.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(candidates, id: \.self) { candidate in
                            if let target = viewModel.account(candidate.accountId) {
                                Button {
                                    viewModel.relay(to: candidate)
                                } label: {
                                    HStack(spacing: 6) {
                                        ProviderBadge(account: target, size: 16)
                                        Text("\(target.name) · \(target.modelName(candidate.model))")
                                    }
                                    .font(.footnote)
                                }
                                .buttonStyle(.glass)
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 22))
    }

    private func title(_ name: String?) -> String {
        if limit.isNoPlan { return "Tu plan de \(name ?? "este proveedor") no incluye este servicio" }
        if limit.isCapacity { return "\(name ?? "El proveedor") no está disponible ahora mismo" }
        return "Límite alcanzado en \(name ?? "esta suscripción")"
    }

    private var detail: String {
        if let reset = ResetFormatter.string(limit.resetsAt), !limit.isNoPlan, !limit.isCapacity {
            return "Se reinicia \(reset). Continúa con otro agente sin perder el contexto:"
        }
        return "Continúa con otro agente sin perder el contexto:"
    }
}

/// Messages waiting for the agent to finish its turn (queued on the Mac).
struct QueueCard: View {
    let viewModel: ThreadViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(viewModel.queuePaused ? "Cola en pausa" : "En cola", systemImage: viewModel.queuePaused ? "pause.circle.fill" : "text.append")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(viewModel.queuePaused ? .orange : .secondary)
                Spacer()
                if viewModel.queuePaused {
                    Button("Reanudar", action: viewModel.resumeQueue)
                        .buttonStyle(.glassProminent)
                        .controlSize(.small)
                        .disabled(viewModel.isRunning)
                }
            }
            ForEach(Array(viewModel.queued.enumerated()), id: \.element.id) { index, message in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(index + 1)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    Text(message.text)
                        .font(.subheadline)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Enviar ya", systemImage: "bolt.fill") { viewModel.sendQueuedNow(message) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                        .foregroundStyle(.orange)
                        .accessibilityHint("Interrumpe al agente y le manda este mensaje ahora")
                    Button("Quitar de la cola", systemImage: "xmark.circle.fill") { viewModel.dequeue(message) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                        .foregroundStyle(.tertiary)
                }
            }
            if viewModel.queuePaused {
                Text("El último turno no terminó bien (error, límite o detenido). Reanuda cuando quieras.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Se envían uno a uno al terminar cada turno. ⚡ envía uno ya, interrumpiendo al agente.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}

/// «Relevo suggests»: subscription, model and reasoning level for what you're writing.
struct SuggestionCard: View {
    let suggestion: RemoteSuggestion
    let viewModel: ThreadViewModel

    var body: some View {
        let account = viewModel.account(suggestion.accountId)
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "wand.and.stars")
                        .foregroundStyle(.tint)
                    Text(suggestion.autoApplied ? "Relevo ha elegido" : "Sugerido")
                        .foregroundStyle(.secondary)
                    ProviderBadge(account: account, size: 16)
                    Text(headline(account))
                        .fontWeight(.semibold)
                        .lineLimit(1)
                }
                .font(.footnote)
                Text(suggestion.reasons.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            Spacer(minLength: 0)
            VStack(spacing: 6) {
                if suggestion.autoApplied {
                    Button("Deshacer") { viewModel.suggestion(.undo) }
                        .buttonStyle(.glass)
                } else {
                    Button("Usar") { viewModel.suggestion(.accept) }
                        .buttonStyle(.glassProminent)
                }
                Button("Ocultar", systemImage: "xmark") { viewModel.suggestion(.dismiss) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
            .controlSize(.small)
        }
        .padding(14)
        .glassEffect(.regular.tint(.accentColor.opacity(0.12)), in: .rect(cornerRadius: 22))
        .accessibilityElement(children: .contain)
    }

    private func headline(_ account: RemoteAccount?) -> String {
        var parts = [account?.name ?? "", account?.modelName(suggestion.model) ?? suggestion.model]
        if let effort = suggestion.effort { parts.append(EffortLabel.name(effort)) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
