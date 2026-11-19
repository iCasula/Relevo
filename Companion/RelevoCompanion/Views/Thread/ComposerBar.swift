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
                ModelButton(viewModel: viewModel)
                // These menus only take values: an agent streaming output redraws the bar several times a second,
                // and a menu whose content is rebuilt closes under your finger.
                if !viewModel.efforts.isEmpty {
                    EffortMenu(viewModel: viewModel, efforts: viewModel.efforts, selected: viewModel.runtime?.selectedEffort,
                               defaultEffort: viewModel.selectedModel?.defaultEffort, title: viewModel.effortTitle)
                        .equatable()
                }
                ModeMenu(viewModel: viewModel, current: viewModel.runtime?.mode ?? .ask)
                    .equatable()
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
/// It opens a sheet (not a menu): it stays open while the agent works and the screen keeps updating.
private struct ModelButton: View {
    let viewModel: ThreadViewModel
    @State private var showing = false

    var body: some View {
        Button {
            showing = true
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
        .buttonStyle(.plain)
        .accessibilityLabel("Suscripción y modelo: \(viewModel.subtitle). \(caption)")
        .sheet(isPresented: $showing) {
            ModelPickerSheet(viewModel: viewModel)
                .presentationDetents([.medium, .large])
        }
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
}

/// Every subscription and its models, the quota left and what to do when it runs out.
private struct ModelPickerSheet: View {
    let viewModel: ThreadViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if !viewModel.usage.isEmpty {
                    Section(viewModel.selectedAccount.map { "Cuota de \($0.name)" } ?? "Cuota") {
                        ForEach(viewModel.usage) { w in
                            LabeledContent(w.label) {
                                Text("\(Int(max(0, 100 - w.percent).rounded())) % libre"
                                     + (ResetFormatter.string(w.resetsAt).map { " · se reinicia \($0)" } ?? ""))
                            }
                            .font(.footnote)
                        }
                    }
                } else if let note = viewModel.usageNote {
                    Section("Cuota") { Text(note).font(.footnote) }
                }
                if viewModel.runtime?.defaultLimitPlan != nil {   // older Macs don't support it
                    Section {
                        NavigationLink {
                            LimitPlanPage(viewModel: viewModel)
                        } label: {
                            LabeledContent("Si se acaba la cuota") {
                                Text((viewModel.runtime?.limitPlan ?? viewModel.runtime?.defaultLimitPlan)?.summary ?? "")
                                    .lineLimit(2)
                            }
                        }
                    }
                }
                ForEach(viewModel.accounts) { account in
                    Section {
                        ForEach(account.models.filter { $0.hidden != true }) { model in
                            Button {
                                viewModel.select(account, model: model)
                                dismiss()
                            } label: {
                                HStack {
                                    Text(model.name).foregroundStyle(.primary)
                                    Spacer()
                                    if account.id == viewModel.selectedAccount?.id && model.id == viewModel.selectedModel?.id {
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            ProviderBadge(account: account, size: 16)
                            Text(sectionTitle(account)).textCase(nil)
                        }
                    }
                }
            }
            .navigationTitle("Modelo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Listo") { dismiss() } } }
        }
    }

    private func sectionTitle(_ account: RemoteAccount) -> String {
        let who = account.status?.email ?? account.agentName
        return [account.name, who, account.availabilityNote].compactMap { $0 }.joined(separator: " · ")
    }
}

/// "Si se acaba la cuota": the host's default, the subscription with most quota, one subscription·model,
/// waiting here for the quota (or balance) to come back, or asking. Lists of several are edited on the computer.
private struct LimitPlanPage: View {
    let viewModel: ThreadViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let own = viewModel.runtime?.limitPlan
        List {
            Section {
                pick("Como en el host (\(viewModel.runtime?.defaultLimitPlan?.summary ?? ""))", own == nil) { viewModel.setLimitPlan(nil) }
                pick("Esperar aquí: seguir con este mismo modelo cuando vuelva a haber cuota o saldo", own?.mode == "wait") {
                    viewModel.setLimitPlan(RemoteLimitPlan(mode: "wait"))
                }
                if viewModel.runtime?.canWait == true {   // Relevo hosts
                    pick("Automático: el mejor modelo con cuota, y volver a este cuando la recupere", own?.mode == "smart") {
                        viewModel.setLimitPlan(RemoteLimitPlan(mode: "smart"))
                    }
                }
                pick("Pasar a la suscripción con más cuota", own?.mode == "mostQuota") { viewModel.setLimitPlan(RemoteLimitPlan(mode: "mostQuota")) }
                pick("Avisarme y decidir yo", own?.mode == "ask") { viewModel.setLimitPlan(RemoteLimitPlan(mode: "ask")) }
                if let own, own.mode == "chain", own.targets.count > 1 {
                    pick("En orden: \(own.summary ?? "")", true) {}
                }
            }
            ForEach(viewModel.accounts) { account in
                Section("Pasar a \(account.name)") {
                    ForEach(account.models.filter { $0.hidden != true }) { model in
                        let target = RemoteCandidate(accountId: account.id, model: model.id)
                        pick(model.name, own?.mode == "chain" && own?.targets == [target]) {
                            viewModel.setLimitPlan(RemoteLimitPlan(mode: "chain", targets: [target]))
                        }
                    }
                }
            }
        }
        .navigationTitle("Si se acaba la cuota")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func pick(_ title: String, _ selected: Bool, _ action: @escaping () -> Void) -> some View {
        Button {
            action()
            dismiss()
        } label: {
            HStack {
                Text(title).foregroundStyle(.primary)
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

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

/// Takes values, not the view model's live state: redrawn only when one of them changes (see ComposerBar).
private struct EffortMenu: View, Equatable {
    let viewModel: ThreadViewModel
    let efforts: [String]
    let selected: String?
    let defaultEffort: String?
    let title: String

    nonisolated static func == (a: EffortMenu, b: EffortMenu) -> Bool {
        a.efforts == b.efforts && a.selected == b.selected && a.defaultEffort == b.defaultEffort && a.title == b.title
    }

    var body: some View {
        Menu {
            Section("Nivel de razonamiento") {
                Button {
                    viewModel.setEffort(nil)
                } label: {
                    let text = "Predeterminado" + (defaultEffort.map { " (\(EffortLabel.name($0)))" } ?? "")
                    if selected == nil { Label(text, systemImage: "checkmark") } else { Text(text) }
                }
                ForEach(efforts, id: \.self) { effort in
                    Button {
                        viewModel.setEffort(effort)
                    } label: {
                        if selected == effort {
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
                .foregroundStyle(selected == nil ? .secondary : .primary)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel("Nivel de razonamiento: \(title)")
    }
}

private struct ModeMenu: View, Equatable {
    let viewModel: ThreadViewModel
    let current: RemoteMode

    nonisolated static func == (a: ModeMenu, b: ModeMenu) -> Bool { a.current == b.current }

    var body: some View {
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
