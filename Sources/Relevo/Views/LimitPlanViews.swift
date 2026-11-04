import SwiftUI

extension LimitPlan {
    /// Short description for menus and the limit banner.
    @MainActor
    func summary(_ store: AppStore) -> String {
        switch mode {
        case .ask: return "avisarme"
        case .mostQuota: return "la de más cuota"
        case .wait: return "esperar al reinicio"
        case .chain:
            let names = targets.compactMap { t in store.account(t.accountId).map { "\($0.name) · \(store.modelName($0, t.model))" } }
            return names.isEmpty ? "lista vacía" : names.joined(separator: ", luego ")
        }
    }
}

/// "Si se acaba la cuota" inside the thread's model menu: the default, one subscription·model, a list in order,
/// waiting for the reset, or asking.
struct LimitPlanMenu: View {
    @Environment(AppStore.self) private var store
    @Bindable var thread: ThreadModel
    @Binding var editing: Bool

    var body: some View {
        let current = thread.limitPlan
        Menu("Si se acaba la cuota: " + (current ?? store.settings.defaultLimitPlan).summary(store)) {
            pick("Como en Ajustes (\(store.settings.defaultLimitPlan.summary(store)))", selected: current == nil) { thread.limitPlan = nil }
            Divider()
            pick(LimitPlan.Mode.mostQuota.label, selected: current?.mode == .mostQuota) { thread.limitPlan = LimitPlan(mode: .mostQuota) }
            Menu("Pasar a…") {
                ForEach(store.enabledAccounts) { account in
                    Section(account.name) {
                        ForEach(store.modelsFor(account)) { model in
                            let target = FallbackTarget(accountId: account.id, model: model.id)
                            pick(model.name, selected: current?.mode == .chain && current?.targets.count == 1
                                 && current?.targets.first?.accountId == account.id && current?.targets.first?.model == model.id) {
                                thread.limitPlan = LimitPlan(mode: .chain, targets: [target])
                            }
                        }
                    }
                }
            }
            Button("Varias, en orden…") { editing = true }
            pick(LimitPlan.Mode.wait.label, selected: current?.mode == .wait) { thread.limitPlan = LimitPlan(mode: .wait) }
            pick(LimitPlan.Mode.ask.label, selected: current?.mode == .ask) { thread.limitPlan = .ask }
        }
    }

    private func pick(_ title: String, selected: Bool, _ action: @escaping () -> Void) -> some View {
        Button {
            action()
            store.save(thread)
        } label: {
            if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }
}

/// Edits a plan: what to do, and for a list, which subscriptions and models in which order.
struct LimitPlanEditor: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let title: String
    @State var plan: LimitPlan
    let onSave: (LimitPlan) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title2.weight(.semibold))
            Picker("Si se acaba la cuota", selection: $plan.mode) {
                ForEach(LimitPlan.Mode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.radioGroup)
            if plan.mode == .chain {
                Text("Se prueban en este orden; las que también estén sin cuota se saltan. Si no queda ninguna, el hilo espera a que se reinicie la cuota y sigue.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 6) {
                    ForEach(Array(plan.targets.enumerated()), id: \.element.id) { index, target in
                        HStack(spacing: 8) {
                            Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary).frame(width: 22, alignment: .trailing)
                            if let account = store.account(target.accountId) {
                                ProviderBadge(kind: account.kind, size: 16)
                                Text("\(account.name) · \(store.modelName(account, target.model))")
                            } else {
                                Text("Suscripción eliminada").foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button { move(index, by: -1) } label: { Image(systemName: "chevron.up") }
                                .disabled(index == 0)
                            Button { move(index, by: 1) } label: { Image(systemName: "chevron.down") }
                                .disabled(index == plan.targets.count - 1)
                            Button { plan.targets.remove(at: index) } label: { Image(systemName: "minus.circle") }
                        }
                        .buttonStyle(.borderless)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 8))
                    }
                }
                Menu("Añadir") {
                    ForEach(store.enabledAccounts) { account in
                        Section(account.name) {
                            ForEach(store.modelsFor(account)) { model in
                                Button(model.name) { plan.targets.append(FallbackTarget(accountId: account.id, model: model.id)) }
                            }
                        }
                    }
                }
                .fixedSize()
            } else if plan.mode == .wait {
                Text("A la hora del reinicio (o en cuanto vuelva a haber cuota, si el proveedor no la dice), Relevo le pide al mismo agente que siga donde lo dejó. Su sesión conserva todo el contexto. Hace falta que Relevo esté abierto; si el Mac estaba dormido, sigue al despertar.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancelar") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Guardar") {
                    onSave(plan)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(plan.mode == .chain && plan.targets.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func move(_ index: Int, by offset: Int) {
        let to = index + offset
        guard plan.targets.indices.contains(to) else { return }
        plan.targets.swapAt(index, to)
    }
}
