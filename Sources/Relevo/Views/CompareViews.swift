import SwiftUI

/// Launch the same task on several agents at once, each in its own worktree, with what starting them costs.
struct CompareLaunchSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: ThreadModel?
    let projectId: UUID
    @State var prompt: String
    @State private var options: [ComparisonOption] = []
    @State private var launching = false
    @State private var error: String?

    var body: some View {
        let context = source.flatMap { store.existingRuntime($0.id)?.context } ?? 0
        VStack(alignment: .leading, spacing: 14) {
            Text("La misma tarea a varios agentes").font(.title2.weight(.semibold))
            Text("Cada agente trabaja en su propio worktree desde el mismo commit"
                 + (source?.items.isEmpty == false ? " y recibe la conversación de este hilo" : "")
                 + ". Cuando terminen, comparas los cambios y te quedas con uno.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Tarea").font(.headline)
            TextEditor(text: $prompt)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(minHeight: 90)
                .background(Color(nsColor: .textBackgroundColor), in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            HStack {
                Text("Agentes").font(.headline)
                Spacer()
                Text("\(options.count) de \(Comparisons.maxAgents)").foregroundStyle(.secondary).font(.caption)
            }
            ForEach($options) { $option in
                HStack {
                    Picker("", selection: $option.accountId) {
                        ForEach(store.enabledAccounts) { Text($0.name).tag($0.id) }
                    }
                    .labelsHidden()
                    .frame(width: 180)
                    .onChange(of: option.accountId) {
                        if let a = store.account(option.accountId) { option.model = store.defaultModel(for: a); option.effort = nil }
                    }
                    if let account = store.account(option.accountId) {
                        Picker("", selection: $option.model) {
                            ForEach(store.visibleModels(for: account)) { Text($0.name).tag($0.id) }
                        }
                        .labelsHidden()
                    }
                    Group {
                        if let cost = Comparisons.startCost(option, contextTokens: context, store: store) {
                            Text("≈ \(TokenFormat.usd(cost)) al empezar")
                        }
                    }
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    .frame(width: 112, alignment: .trailing)
                    Button { options.removeAll { $0.id == option.id } } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                        .disabled(options.count <= 2)
                }
            }
            Button("Añadir agente", systemImage: "plus") {
                if let a = store.enabledAccounts.first { options.append(ComparisonOption(accountId: a.id, model: store.defaultModel(for: a))) }
            }
            .disabled(options.count >= Comparisons.maxAgents)
            Text("Gastan cuota de cada suscripción a la vez" + (context > 20_000 ? "; cada uno lee de cero los \(TokenFormat.short(context)) tokens de contexto del hilo." : "."))
                .font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            HStack {
                Button("Cancelar") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    launch()
                } label: {
                    if launching { ProgressView().controlSize(.small) } else { Text("Lanzar \(options.count) agentes") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(launching || options.count < 2 || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 640)
        .onAppear { if options.isEmpty { options = Comparisons.defaultOptions(prompt: prompt, thread: source, store: store) } }
    }

    private func launch() {
        guard let project = store.project(projectId) else { return }
        launching = true
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                let c = try await Comparisons.start(prompt: text, options: options, source: source, project: project, store: store)
                if let source, source.draft == text { source.draft = "" }
                if let first = c.threadIds.first { store.select(first) }
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            launching = false
        }
    }
}

/// The agents of a comparison side by side: status, changes, consumption; keep the best one.
struct ComparisonSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let comparison: Comparison
    @State private var candidates: [Comparisons.Candidate] = []
    @State private var loading = true
    @State private var diffFor: ThreadModel?
    @State private var picking: ThreadModel?
    @State private var working = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Comparación").font(.title2.weight(.semibold))
                    Text(comparison.prompt).lineLimit(2).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Actualizar", systemImage: "arrow.clockwise") { Task { await load() } }
                Button("Cerrar") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if loading { ProgressView().frame(maxWidth: .infinity) }
            HStack(alignment: .top, spacing: 12) {
                ForEach(candidates) { c in card(c) }
            }
            if let message { Text(message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
        }
        .padding(20)
        .frame(minWidth: 820)
        .task { await load() }
        .sheet(item: $diffFor) { t in
            if let path = store.workPath(t) {
                DiffSheet(title: "Cambios de \(t.title)", path: path, from: comparison.baseCommit, to: nil, runtime: store.runtime(for: t))
            }
        }
        .confirmationDialog("¿Quedarte con este resultado?", isPresented: Binding(get: { picking != nil }, set: { if !$0 { picking = nil } }), presenting: picking) { t in
            Button("Fusionar y borrar los demás worktrees") { pick(t, removeOthers: true) }
            Button("Fusionar y conservar los demás") { pick(t, removeOthers: false) }
        } message: { _ in
            Text("Se hace commit de sus cambios en su rama y se fusiona " + (comparison.sourceThreadId != nil ? "en el worktree del hilo original." : "en la rama actual del proyecto."))
        }
    }

    private func card(_ c: Comparisons.Candidate) -> some View {
        let t = c.thread
        let rt = store.existingRuntime(t.id)
        let account = store.account(t.selectedAccountId)
        let winner = comparison.winnerId == t.id
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let account { ProviderBadge(kind: account.kind, size: 22) }
                VStack(alignment: .leading, spacing: 0) {
                    Text(t.selectedModel.map { ModelNames.display($0, account: account, store: store) } ?? t.title)
                        .font(.headline).lineLimit(1)
                    if let account { Text(account.name).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if winner { Image(systemName: "crown.fill").foregroundStyle(.yellow).help("El elegido") }
            }
            Group {
                if rt?.isRunning == true { Label("Trabajando…", systemImage: "hourglass") }
                else if rt?.limit != nil { Label("Sin cuota", systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                else if t.items.last?.kind == .error { Label("Terminó con error", systemImage: "xmark.octagon").foregroundStyle(.red) }
                else { Label("Terminado", systemImage: "checkmark.circle").foregroundStyle(.green) }
            }
            .font(.callout)
            if let stat = c.stat {
                Text("\(stat.files) \(stat.files == 1 ? "fichero" : "ficheros") · +\(stat.added) −\(stat.removed)").font(.callout.monospacedDigit())
            }
            if c.tokens > 0 {
                Text("\(TokenFormat.short(c.tokens)) tokens" + (c.cost.map { " · ≈ \(TokenFormat.usd($0))" } ?? ""))
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if let last = t.items.last(where: { $0.kind == .assistant }) {
                Text(MarkdownInlinePlain.text(last.text)).font(.caption).lineLimit(6).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            HStack {
                Button("Ver hilo") { store.select(t.id); dismiss() }
                Button("Cambios") { diffFor = t }.disabled(t.worktree == nil)
            }
            .controlSize(.small)
            Button("Quedarme con este") { picking = t }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(working || rt?.isRunning == true || comparison.winnerId != nil || t.worktree == nil)
        }
        .padding(12)
        .frame(minWidth: 220, maxWidth: .infinity, minHeight: 260, alignment: .topLeading)
        .background(.quaternary.opacity(winner ? 0.6 : 0.35), in: .rect(cornerRadius: 10))
    }

    private func load() async {
        loading = true
        candidates = await Comparisons.candidates(comparison, store: store)
        loading = false
    }

    private func pick(_ t: ThreadModel, removeOthers: Bool) {
        working = true
        Task {
            do {
                let out = try await Comparisons.pick(t, in: comparison, removeOthers: removeOthers, store: store)
                message = "Fusionado. " + out
            } catch { message = error.localizedDescription }
            working = false
            await load()
        }
    }
}

enum MarkdownInlinePlain {
    static func text(_ s: String) -> String {
        s.replacingOccurrences(of: #"[*_`#>]"#, with: "", options: .regularExpression)
    }
}
