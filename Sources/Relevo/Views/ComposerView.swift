import SwiftUI

struct ComposerView: View {
    @Environment(AppStore.self) private var store
    @Bindable var thread: ThreadModel
    let runtime: ThreadRuntime
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                // Invisible mirror text sizes the editor to its content.
                Text(thread.draft.isEmpty ? " " : thread.draft + " ")
                    .font(.body)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .opacity(0)
                    .accessibilityHidden(true)
                if thread.draft.isEmpty {
                    Text(placeholder)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 5)
                        .padding(.top, 0)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $thread.draft)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .scrollIndicators(.never)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) || press.modifiers.contains(.option) { return .ignored }
                        submit()
                        return .handled
                    }
            }
            .frame(minHeight: 38, maxHeight: 220)
            .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                ModelPicker(thread: thread)
                EffortPicker(thread: thread, runtime: runtime)
                ModePicker(thread: thread, runtime: runtime)
                Spacer(minLength: 4)
                UsageHint(accountId: thread.selectedAccountId)
                if runtime.isRunning {
                    Button {
                        runtime.stop()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 11, weight: .bold))
                            .frame(width: 28, height: 28)
                            .background(Color.primary, in: Circle())
                            .foregroundStyle(Theme.canvas)
                    }
                    .buttonStyle(.plain)
                    .help("Detener (⌘.)")
                } else {
                    Button(action: submit) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .bold))
                            .frame(width: 28, height: 28)
                            .background(canSend ? Color.primary : Color.primary.opacity(0.15), in: Circle())
                            .foregroundStyle(Theme.canvas)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .help("Enviar (↩︎) · nueva línea con ⇧↩︎")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(focused ? Color.primary.opacity(0.18) : Theme.hairline))
        .shadow(color: .black.opacity(0.06), radius: 14, y: 4)
        .onAppear { focused = true }
        .onChange(of: thread.draft) { runtime.suggester.draftChanged() }
        .onChange(of: selection) { runtime.suggester.selectionChanged() }
    }

    private var selection: [String] {
        [thread.selectedAccountId?.uuidString ?? "", thread.selectedModel ?? "", thread.selectedEffort ?? ""]
    }

    private var placeholder: String {
        thread.items.isEmpty ? "Pide un cambio, haz una pregunta o arranca un proyecto…" : "Responde o pide algo más…"
    }

    private var canSend: Bool {
        !thread.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        guard canSend, !runtime.isRunning else { return }
        let text = thread.draft
        thread.draft = ""
        runtime.send(text)
    }
}

struct ModelPicker: View {
    @Environment(AppStore.self) private var store
    @Bindable var thread: ThreadModel

    var body: some View {
        let account = store.account(thread.selectedAccountId) ?? store.preferredAccount()
        Menu {
            ForEach(store.enabledAccounts) { acc in
                Section(sectionTitle(acc)) {
                    ForEach(store.modelsFor(acc)) { model in
                        Button {
                            thread.selectedAccountId = acc.id
                            thread.selectedModel = model.id
                            if let e = thread.selectedEffort, !(store.efforts(for: acc, model: model.id)?.contains(e) ?? false) {
                                thread.selectedEffort = nil
                            }
                            store.updateAccount(acc.id) { $0.lastModel = model.id }
                            store.save(thread)
                        } label: {
                            if acc.id == account?.id && model.id == currentModel(account) {
                                Label(model.name, systemImage: "checkmark")
                            } else {
                                Text(model.name)
                            }
                        }
                    }
                }
            }
            Divider()
            SettingsLink { Text("Gestionar suscripciones…") }
        } label: {
            HStack(spacing: 6) {
                if let account {
                    ProviderBadge(kind: account.kind, size: 15)
                    Text(account.name)
                        .fontWeight(.medium)
                    Text(store.modelName(account, currentModel(account)))
                        .foregroundStyle(.secondary)
                } else {
                    Text("Elige una suscripción")
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.callout)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Theme.subtleFill, in: Capsule())
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(switchHelp(account))
    }

    private func currentModel(_ account: Account?) -> String {
        guard let account else { return "" }
        return thread.selectedModel ?? store.defaultModel(for: account)
    }

    private func sectionTitle(_ acc: Account) -> String {
        var title = acc.name
        if let email = store.status[acc.id]?.email { title += " · \(email)" } else { title += " · \(acc.kind.agentName)" }
        if let s = store.status[acc.id] {
            if s.noPlan == true { title += " · plan sin acceso" }
            else if s.isExhausted { title += " · agotada" }
            else if !s.windows.isEmpty { title += " · \(Int(s.maxPercent.rounded()))% usado" }
            if s.loggedIn == false { title += " · sin sesión" }
        }
        return title
    }

    private func switchHelp(_ account: Account?) -> String {
        guard let current = thread.segments.last, let account, current.accountId != account.id else {
            return "Proveedor y modelo"
        }
        return "Al enviar, Relevo pasará el contexto del hilo a \(account.name)"
    }
}

struct EffortPicker: View {
    @Environment(AppStore.self) private var store
    @Bindable var thread: ThreadModel
    let runtime: ThreadRuntime

    var body: some View {
        if let account = store.account(thread.selectedAccountId) ?? store.preferredAccount() {
            let model = thread.selectedModel ?? store.defaultModel(for: account)
            if let efforts = store.efforts(for: account, model: model), !efforts.isEmpty {
                let fallback = store.modelOption(account, model)?.defaultEffort
                Menu {
                    Section("Nivel de razonamiento") {
                        Button {
                            runtime.setEffort(nil)
                        } label: {
                            let text = "Predeterminado" + (fallback.map { " (\(EffortLabel.name($0)))" } ?? "")
                            if thread.selectedEffort == nil { Label(text, systemImage: "checkmark") } else { Text(text) }
                        }
                        ForEach(efforts, id: \.self) { effort in
                            Button {
                                runtime.setEffort(effort)
                            } label: {
                                if thread.selectedEffort == effort { Label(EffortLabel.name(effort), systemImage: "checkmark") } else { Text(EffortLabel.name(effort)) }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "brain")
                        Text(thread.selectedEffort.map(EffortLabel.name) ?? fallback.map(EffortLabel.name) ?? "Auto")
                    }
                    .font(.callout)
                    .foregroundStyle(thread.selectedEffort == nil ? Color.secondary : Color.primary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .contentShape(Capsule())
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Nivel de razonamiento: cuánto «piensa» el modelo antes de responder (más alto = mejor en tareas difíciles, más lento y gasta más cuota)")
            }
        }
    }
}

struct ModePicker: View {
    @Bindable var thread: ThreadModel
    let runtime: ThreadRuntime

    var body: some View {
        Menu {
            ForEach(PermissionMode.allCases) { mode in
                Button {
                    runtime.setMode(mode)
                } label: {
                    if mode == thread.mode {
                        Label(mode.label, systemImage: "checkmark")
                    } else {
                        Label(mode.label, systemImage: mode.symbol)
                    }
                }
                .help(mode.help)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: thread.mode.symbol)
                Text(thread.mode.label)
            }
            .font(.callout)
            .foregroundStyle(thread.mode == .full ? Color.orange : Color.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(thread.mode.help)
    }
}

struct UsageHint: View {
    @Environment(AppStore.self) private var store
    let accountId: UUID?

    var body: some View {
        if let id = accountId, let s = store.status[id], !s.windows.isEmpty {
            HStack(spacing: 8) {
                ForEach(s.windows.prefix(2)) { w in
                    HStack(spacing: 3) {
                        Circle().fill(Theme.usageColor(w.percent)).frame(width: 5, height: 5)
                        Text("\(w.label) \(Int(w.percent.rounded()))%")
                    }
                }
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .help(s.windows.map { w in
                "\(w.label): \(Int(w.percent.rounded()))%" + (Formatters.reset(w.resetsAt).map { " · se reinicia \($0)" } ?? "")
            }.joined(separator: "\n"))
        }
    }
}
