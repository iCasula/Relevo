import SwiftUI
import RelevoProtocol

/// One card: the message field and, under it, a row with subscription/model (its quota as a ring around the
/// badge), reasoning, permissions, stop and send — every control a 44-pt target.
struct ComposerBar: View {
    @Bindable var viewModel: ThreadViewModel
    @FocusState private var focused: Bool
    @State private var confirmStop = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A tall field, and its margins focus it too: easy to hit with a thumb.
            TextField(placeholder, text: $viewModel.draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .submitLabel(.send)
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .topLeading)
                .background { Color.clear.contentShape(.rect).onTapGesture { focused = true } }
            HStack(spacing: 0) {
                ModelMenu(viewModel: viewModel)
                if !viewModel.efforts.isEmpty { EffortMenu(viewModel: viewModel) }
                ModeMenu(viewModel: viewModel)
                // The free space between the controls also focuses the field.
                Color.clear
                    .frame(minWidth: 4, maxWidth: .infinity)
                    .frame(height: 44)
                    .contentShape(.rect)
                    .onTapGesture { focused = true }
                    .layoutPriority(-1)
                if viewModel.isRunning { stopButton }
                sendButton
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 4)
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
    }

    private var placeholder: String {
        if viewModel.isRunning { return "Siguiente mensaje (se envía al terminar)" }
        return viewModel.items.isEmpty ? "Pide un cambio o haz una pregunta" : "Responde o pide algo más"
    }

    // Stop has its own place: the send button never turns into it, so a second tap after sending
    // can't interrupt the agent by accident. Stopping also asks first.
    private var stopButton: some View {
        Button("Detener", systemImage: "stop.fill") { confirmStop = true }
            .labelStyle(.iconOnly)
            .buttonStyle(RoundIconButtonStyle(fill: Color.red.opacity(0.15), foreground: .red, iconSize: 13))
            .disabled(!viewModel.isConnected)
            .confirmationDialog("¿Detener al agente?", isPresented: $confirmStop, titleVisibility: .visible) {
                Button("Detener", role: .destructive, action: viewModel.stop)
            } message: {
                Text("Interrumpe lo que esté haciendo ahora mismo. Los mensajes en cola se quedan en pausa.")
            }
    }

    @ViewBuilder
    private var sendButton: some View {
        if viewModel.isRunning {
            // Tap: queue it. Hold: send it now, interrupting the agent to redirect it.
            Menu {
                Button("Enviar ya (interrumpe al agente)", systemImage: "bolt.fill", action: viewModel.sendNow)
                Button("Añadir a la cola", systemImage: "text.append", action: viewModel.send)
            } label: {
                Label("Añadir a la cola", systemImage: "text.append").labelStyle(.iconOnly)
            } primaryAction: {
                viewModel.send()
            }
            .menuStyle(.button)
            .buttonStyle(RoundIconButtonStyle(fill: .accentColor))
            .disabled(!viewModel.canSend)
            .accessibilityHint("Se enviará al terminar el turno. Mantén pulsado para enviarlo ya.")
        } else {
            Button("Enviar", systemImage: "arrow.up", action: viewModel.send)
                .labelStyle(.iconOnly)
                .buttonStyle(RoundIconButtonStyle(fill: .accentColor))
                .disabled(!viewModel.canSend)
        }
    }
}

/// A filled 34-pt circle inside a 44-pt target; greyed out (but still a circle) when disabled.
private struct RoundIconButtonStyle: ButtonStyle {
    var fill: Color
    var foreground: Color = .white
    var iconSize: CGFloat = 15
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: iconSize, weight: .bold))
            .foregroundStyle(isEnabled ? foreground : Color.secondary)
            .frame(width: 34, height: 34)
            .background(isEnabled ? fill : Color.secondary.opacity(0.16), in: .circle)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .frame(width: 44, height: 44)
            .contentShape(.circle)
            .animation(.snappy, value: isEnabled)
    }
}

/// Subscription and model, with what's left of its quota: one control instead of a picker plus a ring.
/// The menu lists every quota window (and when it resets) above the subscriptions and their models.
private struct ModelMenu: View {
    let viewModel: ThreadViewModel

    var body: some View {
        Menu {
            if !viewModel.usage.isEmpty {
                Section(viewModel.selectedAccount.map { "Cuota de \($0.name)" } ?? "Cuota") {
                    ForEach(viewModel.usage) { w in
                        Text("\(w.label): \(Int(max(0, 100 - w.percent).rounded())) % libre"
                             + (ResetFormatter.string(w.resetsAt).map { " · se reinicia \($0)" } ?? ""))
                    }
                }
            } else if let note = viewModel.usageNote {
                Section("Cuota") { Text(note) }
            }
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
            HStack(spacing: 8) {
                QuotaBadge(account: viewModel.selectedAccount, window: viewModel.tightestWindow)
                VStack(alignment: .leading, spacing: 0) {
                    Text(viewModel.selectedAccount?.shortModelName(viewModel.runtime?.selectedModel) ?? "Elige un modelo")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(caption)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(captionColor)
                }
                .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.leading, 4)
            .padding(.trailing, 6)
            .frame(height: 44)
            .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel("Suscripción y modelo: \(viewModel.subtitle). \(caption)")
    }

    /// "66 % · Semana": what's left of the window that runs out first.
    private var caption: String {
        if let w = viewModel.tightestWindow { return "\(Int(max(0, 100 - w.percent).rounded())) % · \(w.label)" }
        return viewModel.usageNote ?? viewModel.selectedAccount?.name ?? ""
    }

    private var captionColor: Color {
        guard let w = viewModel.tightestWindow, w.percent >= 70 else { return .secondary }
        return w.tint
    }

    private func sectionTitle(_ account: RemoteAccount) -> String {
        let who = account.status?.email ?? account.agentName
        return [account.name, who, account.availabilityNote].compactMap { $0 }.joined(separator: " · ")
    }
}

/// The subscription's badge with its remaining quota as a ring around it.
private struct QuotaBadge: View {
    let account: RemoteAccount?
    let window: RemoteWindow?

    var body: some View {
        let remaining = window.map { max(0, 100 - $0.percent) / 100 }
        ZStack {
            Circle().stroke(.quaternary, lineWidth: 3)
            if let remaining, let window {
                Circle()
                    .trim(from: 0, to: max(0.02, min(1, remaining)))
                    .stroke(window.tint, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            ProviderBadge(account: account, size: 20)
        }
        .frame(width: 32, height: 32)
        .animation(.snappy, value: remaining)
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
            Image(systemName: "brain")
                .font(.system(size: 17))
                .foregroundStyle(viewModel.runtime?.selectedEffort == nil ? .secondary : .primary)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
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
            Image(systemName: current.symbol)
                .font(.system(size: 17))
                .foregroundStyle(current == .full ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel("Permisos: \(current.label)")
    }
}
