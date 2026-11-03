import SwiftUI
import RelevoProtocol

/// Message field plus subscription/model, reasoning and permission pickers — same controls as the Mac composer.
struct ComposerBar: View {
    @Bindable var viewModel: ThreadViewModel
    @FocusState private var focused: Bool
    @State private var confirmStop = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(viewModel.isRunning ? "Siguiente mensaje (se envía al terminar)"
                          : viewModel.items.isEmpty ? "Pide un cambio o haz una pregunta" : "Responde o pide algo más",
                          text: $viewModel.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
                    .submitLabel(.send)

                // Stop has its own place: the send button never turns into it, so a second tap
                // after sending can't interrupt the agent by accident. Stopping also asks first.
                if viewModel.isRunning {
                    Button("Detener", systemImage: "stop.fill") { confirmStop = true }
                        .labelStyle(.iconOnly)
                        .font(.footnote.weight(.bold))
                        .frame(width: 30, height: 30)
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .tint(.red)
                        .disabled(!viewModel.isConnected)
                        .confirmationDialog("¿Detener al agente?", isPresented: $confirmStop, titleVisibility: .visible) {
                            Button("Detener", role: .destructive, action: viewModel.stop)
                        } message: {
                            Text("Interrumpe lo que esté haciendo ahora mismo. Los mensajes en cola se quedan en pausa.")
                        }
                }
                if viewModel.isRunning {
                    // Tap: queue it. Hold: send it now, interrupting the agent to redirect it.
                    Menu {
                        Button("Enviar ya (interrumpe al agente)", systemImage: "bolt.fill", action: viewModel.sendNow)
                        Button("Añadir a la cola", systemImage: "text.append", action: viewModel.send)
                    } label: {
                        Label("Añadir a la cola", systemImage: "text.append")
                            .labelStyle(.iconOnly)
                            .font(.body.weight(.bold))
                            .frame(width: 30, height: 30)
                    } primaryAction: {
                        viewModel.send()
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .disabled(!viewModel.canSend)
                    .accessibilityHint("Se enviará al terminar el turno. Mantén pulsado para enviarlo ya.")
                } else {
                    Button("Enviar", systemImage: "arrow.up", action: viewModel.send)
                        .labelStyle(.iconOnly)
                        .font(.body.weight(.bold))
                        .frame(width: 30, height: 30)
                        .buttonStyle(.glassProminent)
                        .buttonBorderShape(.circle)
                        .disabled(!viewModel.canSend)
                }
            }

            HStack(spacing: 8) {
                ModelMenu(viewModel: viewModel)
                if !viewModel.efforts.isEmpty { EffortMenu(viewModel: viewModel).fixedSize() }
                ModeMenu(viewModel: viewModel).fixedSize()
                Spacer(minLength: 0)
                QuotaRing(viewModel: viewModel)
            }
        }
    }
}

private struct ModelMenu: View {
    let viewModel: ThreadViewModel

    var body: some View {
        Menu {
            ForEach(viewModel.accounts) { account in
                Section(sectionTitle(account)) {
                    ForEach(account.models) { model in
                        Button {
                            viewModel.select(account, model: model)
                        } label: {
                            if account.id == viewModel.selectedAccount?.id && model.id == viewModel.selectedModel?.id {
                                Label(model.name, systemImage: "checkmark")
                            } else {
                                Text(model.name)
                            }
                        }
                    }
                }
            }
        } label: {
            // The badge says which subscription; the full "account · email" is in the menu sections.
            HStack(spacing: 6) {
                ProviderBadge(account: viewModel.selectedAccount, size: 16)
                Text(viewModel.selectedAccount?.modelName(viewModel.runtime?.selectedModel) ?? "Elige un modelo")
                    .fontWeight(.medium)
                    .lineLimit(1)
            }
            .font(.footnote)
        }
        .buttonStyle(.glass)
        .controlSize(.small)
        .accessibilityLabel("Suscripción y modelo: \(viewModel.subtitle)")
    }

    private func sectionTitle(_ account: RemoteAccount) -> String {
        let who = account.status?.email ?? account.agentName
        return [account.name, who, account.availabilityNote].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Remaining quota of the selected model as a small ring; tap for every window and when it resets.
private struct QuotaRing: View {
    let viewModel: ThreadViewModel

    var body: some View {
        if let window = viewModel.tightestWindow {
            let remaining = max(0, 100 - window.percent)
            Menu {
                Section(viewModel.selectedAccount.map { "\($0.name) · \($0.modelName(viewModel.runtime?.selectedModel))" } ?? "Cuota") {
                    ForEach(viewModel.usage) { w in
                        Text("\(w.label): \(Int(max(0, 100 - w.percent).rounded())) % libre"
                             + (ResetFormatter.string(w.resetsAt).map { " · se reinicia \($0)" } ?? ""))
                    }
                }
            } label: {
                RingView(fraction: remaining / 100, color: window.tint, text: "\(Int(remaining.rounded()))")
            }
            .accessibilityLabel("Cuota restante: \(Int(remaining.rounded())) por ciento de \(window.label)")
        } else if let note = viewModel.usageNote {
            Menu {
                Text(note)
            } label: {
                Image(systemName: "creditcard")
                    .font(.footnote.weight(.semibold))
                    .frame(width: 30, height: 30)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .accessibilityLabel(note)
        }
    }
}

private struct RingView: View {
    let fraction: Double
    let color: Color
    let text: String

    var body: some View {
        ZStack {
            Circle().stroke(.quaternary, lineWidth: 3.5)
            Circle()
                .trim(from: 0, to: max(0.02, min(1, fraction)))
                .stroke(color, style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(text)
                .font(.system(size: 10, weight: .bold).monospacedDigit())
                .foregroundStyle(.primary)
                .minimumScaleFactor(0.6)
        }
        .frame(width: 30, height: 30)
        .padding(3)
        .glassEffect(.regular.interactive(), in: .circle)
        .animation(.snappy, value: fraction)
    }
}

private struct EffortMenu: View {
    let viewModel: ThreadViewModel

    var body: some View {
        Menu {
            Section("Nivel de razonamiento") {
                Button {
                    viewModel.setEffort(nil)
                } label: {
                    let text = "Predeterminado" + (viewModel.selectedModel?.defaultEffort.map { " (\(EffortLabel.name($0)))" } ?? "")
                    if viewModel.runtime?.selectedEffort == nil { Label(text, systemImage: "checkmark") } else { Text(text) }
                }
                ForEach(viewModel.efforts, id: \.self) { effort in
                    Button {
                        viewModel.setEffort(effort)
                    } label: {
                        if viewModel.runtime?.selectedEffort == effort {
                            Label(EffortLabel.name(effort), systemImage: "checkmark")
                        } else {
                            Text(EffortLabel.name(effort))
                        }
                    }
                }
            }
        } label: {
            Label(viewModel.effortTitle, systemImage: "brain")
                .font(.footnote)
        }
        .buttonStyle(.glass)
        .controlSize(.small)
        .accessibilityLabel("Nivel de razonamiento: \(viewModel.effortTitle)")
    }
}

private struct ModeMenu: View {
    let viewModel: ThreadViewModel

    var body: some View {
        let current = viewModel.runtime?.mode ?? .ask
        Menu {
            ForEach(RemoteMode.allCases) { mode in
                Button {
                    viewModel.setMode(mode)
                } label: {
                    Label {
                        Text(mode.label)
                        Text(mode.help)
                    } icon: {
                        Image(systemName: mode == current ? "checkmark" : mode.symbol)
                    }
                }
            }
        } label: {
            Label(current.label, systemImage: current.symbol)
                .labelStyle(.iconOnly)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(current == .full ? .orange : .primary)
        }
        .buttonStyle(.glass)
        .controlSize(.small)
        .accessibilityLabel("Permisos: \(current.label)")
    }
}
