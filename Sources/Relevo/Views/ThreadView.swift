import SwiftUI
import QuickLook
import RelevoMarkdown
import AppKit

struct ThreadView: View {
    @Environment(AppStore.self) private var store
    @Bindable var thread: ThreadModel
    let runtime: ThreadRuntime
    @State private var showTrace = false
    /// Show every tool call, or fold each run of them into one summary row.
    @AppStorage("showTools") private var showTools = true

    var body: some View {
        let project = store.project(thread.projectId)
        VStack(spacing: 0) {
            if thread.items.isEmpty {
                EmptyThreadHero(project: project)
            } else {
                TranscriptView(thread: thread, runtime: runtime, showTools: showTools)
            }
            VStack(spacing: 10) {
                if let limit = runtime.limit {
                    LimitBanner(limit: limit, runtime: runtime)
                } else if let suggestion = runtime.suggester.suggestion {
                    SuggestionBar(suggestion: suggestion, suggester: runtime.suggester)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if !runtime.queue.isEmpty {
                    QueueBar(runtime: runtime)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                ComposerView(thread: thread, runtime: runtime)
            }
            .frame(maxWidth: Theme.contentWidth)
            .padding(.horizontal, 24)
            .padding(.bottom, 18)
            .padding(.top, 6)
            .animation(.easeOut(duration: 0.18), value: runtime.suggester.suggestion)
            .animation(.easeOut(duration: 0.18), value: runtime.queue)
        }
        .quickLookPreview(Binding(get: { runtime.previewURL }, set: { runtime.previewURL = $0 }))
        .sheet(isPresented: $showTrace) {
            if let project {
                WorkStateSheet(thread: thread, project: project)
                    .environment(store)
            }
        }
        .onChange(of: store.debugRequest) {
            if store.debugRequest == "trace" {
                showTrace = true
                store.debugRequest = nil
            }
        }
        .navigationTitle(thread.title)
        .navigationSubtitle(project.map { abbreviateHome($0.path) } ?? "")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { showTools.toggle() }
                } label: {
                    Label(showTools ? "Ocultar herramientas" : "Mostrar herramientas",
                          systemImage: showTools ? "wrench.and.screwdriver.fill" : "wrench.and.screwdriver")
                }
                .keyboardShortcut("t", modifiers: [.command, .option])
                .help(showTools ? "Ocultar los comandos y herramientas del agente (⌥⌘T)" : "Mostrar los comandos y herramientas del agente (⌥⌘T)")
                Button {
                    showTrace = true
                } label: {
                    Label("Traza", systemImage: "list.bullet.clipboard")
                }
                .help("Estado del trabajo: plan, por dónde iba el agente, ficheros tocados y git (lo que recibiría otro agente)")
                .disabled(thread.items.isEmpty)
                RelayMenu(thread: thread, runtime: runtime)
                if let project {
                    Menu {
                        Button("Mostrar en Finder") {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.path)])
                        }
                        Button("Abrir en Terminal") { ProjectActions.openTerminal(project.path) }
                        Button("Abrir en VS Code") {
                            if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") {
                                NSWorkspace.shared.open([URL(fileURLWithPath: project.path)], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
                            }
                        }
                        Divider()
                        Button("Configurar memoria compartida (AGENTS.md)") { store.setupSharedMemory(project) }
                    } label: {
                        Label("Proyecto", systemImage: "folder")
                    }
                    .help("Acciones del proyecto")
                }
            }
        }
    }
}

/// Toolbar menu: hand the current conversation to another subscription right now.
struct RelayMenu: View {
    @Environment(AppStore.self) private var store
    let thread: ThreadModel
    let runtime: ThreadRuntime

    var body: some View {
        Menu {
            Section("Continuar la última petición con…") {
                ForEach(store.enabledAccounts) { account in
                    Menu {
                        ForEach(store.modelsFor(account)) { model in
                            Button(model.name) { runtime.relay(to: account, model: model.id) }
                        }
                    } label: {
                        Text(accountLabel(account))
                    }
                }
            }
        } label: {
            Label("Relevo", systemImage: "arrow.triangle.swap")
        }
        .help("Pasa la conversación (con todo su contexto) a otra suscripción")
        .disabled(!thread.items.contains { $0.kind == .user })
    }

    private func accountLabel(_ account: Account) -> String {
        var label = account.name
        if let s = store.status[account.id], !s.windows.isEmpty {
            label += " — \(Int(s.maxPercent.rounded()))% usado"
        }
        if store.status[account.id]?.isExhausted == true { label += " (agotada)" }
        if store.status[account.id]?.noPlan == true { label += " (sin plan)" }
        return label
    }
}

struct EmptyThreadHero: View {
    @Environment(AppStore.self) private var store
    let project: Project?

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            HStack(spacing: -5) {
                ForEach(store.enabledAccounts.map(\.kind).uniqued(), id: \.self) { ProviderBadge(kind: $0, size: 30) }
            }
            Text("¿Qué hacemos en \(project?.name ?? "este proyecto")?")
                .font(.system(size: 26, weight: .semibold, design: .rounded))
            if let project {
                Text(abbreviateHome(project.path))
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text("Elige suscripción y modelo abajo. Si llegas a un límite, cambia de agente y Relevo le pasa todo el contexto.")
                .font(.callout)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding()
    }
}

extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

struct TranscriptView: View {
    @Environment(AppStore.self) private var store
    let thread: ThreadModel
    let runtime: ThreadRuntime
    var showTools = true

    private enum Row: Identifiable {
        case item(ChatItem)
        case group(id: String, items: [ChatItem])

        var id: String {
            switch self {
            case .item(let item): item.id
            case .group(let id, _): id
            }
        }
    }

    /// With tools hidden, each run of tool calls (and reasoning) becomes one expandable summary row.
    private var rows: [Row] {
        guard !showTools else { return thread.items.map(Row.item) }
        var rows: [Row] = []
        var run: [ChatItem] = []
        func flush() {
            defer { run = [] }
            guard !run.isEmpty else { return }
            guard run.contains(where: { $0.kind == .tool }) else { rows += run.map(Row.item); return }
            let id = "group:" + run[0].id
            rows.append(.group(id: id, items: run))
            if runtime.expandedItems.contains(id) { rows += run.map(Row.item) }
        }
        for item in thread.items {
            if item.kind == .tool || item.kind == .reasoning { run.append(item) } else { flush(); rows.append(.item(item)) }
        }
        flush()
        return rows
    }

    var body: some View {
        let headers = authorHeaders()
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(rows) { row in
                        switch row {
                        case .item(let item):
                            ItemView(item: item, runtime: runtime, showsAuthor: headers.contains(item.id))
                                .id(item.id)
                        case .group(let id, let items):
                            ToolGroupRow(items: items, isExpanded: runtime.expandedItems.contains(id)) {
                                withAnimation(.easeOut(duration: 0.15)) { runtime.toggleExpanded(id) }
                            }
                            .id(id)
                        }
                    }
                    if runtime.isRunning {
                        WorkingIndicator(text: runtime.statusLine)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: Theme.contentWidth, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.top, 22)
                .padding(.bottom, 8)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            // Paths and images in replies open in Quick Look (folders in Finder) instead of the browser.
            .environment(\.openURL, OpenURLAction { url in
                guard let path = FileReference.path(from: url) else { return .systemAction }
                runtime.openReference(path)
                return .handled
            })
            .onChange(of: thread.items.count) {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: thread.items.last?.text.count ?? 0) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    /// First assistant item of each turn (or after an agent switch) shows who answered.
    private func authorHeaders() -> Set<String> {
        var result = Set<String>()
        var needs = true
        for item in thread.items {
            switch item.kind {
            case .user, .notice: needs = true
            case .assistant:
                if needs { result.insert(item.id); needs = false }
            default: break
            }
        }
        return result
    }
}

struct WorkingIndicator: View {
    let text: String?
    @State private var phase = false

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle()
                        .fill(Color.secondary)
                        .frame(width: 5, height: 5)
                        .opacity(phase ? 1 : 0.25)
                        .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: phase)
                }
            }
            Text(text ?? "Trabajando…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .onAppear { phase = true }
        .padding(.vertical, 4)
    }
}

/// Messages waiting for the current turn to finish.
struct QueueBar: View {
    let runtime: ThreadRuntime

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(runtime.queuePaused ? "Cola en pausa" : "En cola · se envían al terminar cada turno",
                      systemImage: runtime.queuePaused ? "pause.circle" : "text.append")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(runtime.queuePaused ? Color.orange : Color.secondary)
                Spacer()
                if runtime.queuePaused {
                    Button("Reanudar") { runtime.resumeQueue() }
                        .controlSize(.small)
                        .disabled(runtime.isRunning)
                        .help("Enviar el siguiente mensaje de la cola")
                }
            }
            ForEach(Array(runtime.queue.enumerated()), id: \.element.id) { index, message in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(index + 1)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    Text(message.text)
                        .font(.callout)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        runtime.sendQueuedNow(message.id)
                    } label: {
                        Image(systemName: "bolt.fill").foregroundStyle(.orange)
                    }
                    .buttonStyle(.borderless)
                    .help("Enviar ya: interrumpe al agente y le manda este mensaje ahora")
                    Button {
                        runtime.removeQueued(message.id)
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.borderless)
                    .help("Quitar de la cola")
                }
            }
            if runtime.queuePaused {
                Text("El último turno no terminó bien (error, límite o detenido). Revisa y reanuda cuando quieras.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Theme.subtleFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.hairline))
    }
}

/// «Relevo sugiere»: the subscription, model and reasoning level that fit the request being written.
struct SuggestionBar: View {
    @Environment(AppStore.self) private var store
    let suggestion: Suggestion
    let suggester: Suggester

    var body: some View {
        if let account = store.account(suggestion.accountId) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "wand.and.stars")
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(suggester.autoApplied ? "Relevo ha elegido" : "Sugerido")
                            .foregroundStyle(.secondary)
                        ProviderBadge(kind: account.kind, size: 14)
                        Text(headline(account))
                            .fontWeight(.medium)
                    }
                    .font(.callout)
                    Text(suggestion.reasons.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 6)
                if suggester.autoApplied {
                    Button("Deshacer") { suggester.undo() }
                        .controlSize(.small)
                } else {
                    Button("Usar") { suggester.accept() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .keyboardShortcut("u", modifiers: [.command, .shift])
                        .help("Usar esta suscripción, modelo y razonamiento (⇧⌘U)")
                }
                Button {
                    suggester.dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Ocultar hasta el próximo mensaje")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.accentColor.opacity(0.22)))
            .help(suggestion.profile.byAI ? "Tarea clasificada por el modelo auxiliar" : "Tarea clasificada sin IA (heurística local)")
        }
    }

    private func headline(_ account: Account) -> String {
        var parts = [account.name, store.modelName(account, suggestion.model)]
        if let e = suggestion.effort { parts.append(EffortLabel.name(e)) }
        return parts.joined(separator: " · ")
    }
}

struct LimitBanner: View {
    @Environment(AppStore.self) private var store
    let limit: LimitNotice
    let runtime: ThreadRuntime

    var body: some View {
        let account = store.account(limit.accountId)
        let candidates = store.relayCandidates(excluding: [limit.accountId])
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "hourglass")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text(limit.isNoPlan ? "Tu plan de \(account?.name ?? "este proveedor") no incluye este servicio ahora mismo"
                         : limit.isCapacity ? "\(account?.name ?? "El proveedor") no está disponible ahora mismo" : "Límite alcanzado en \(account?.name ?? "esta suscripción")")
                        .font(.callout.weight(.semibold))
                    if limit.isNoPlan {
                        Text("La sesión sigue iniciada, pero la suscripción no da acceso (¿ha caducado?). Continúa con otro agente sin perder el contexto:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if limit.isCapacity {
                        Text("El modelo está saturado. Elige otro modelo abajo o continúa con otro agente sin perder el contexto:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if let reset = Formatters.reset(limit.resetsAt) {
                        Text("Se reinicia \(reset). Continúa ahora con otro agente sin perder el contexto:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Continúa ahora con otro agente sin perder el contexto:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button {
                    runtime.limit = nil
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
            }
            if let progress = WorkState.whereLeftOff(thread: runtime.thread, store: store) {
                Label("Iba por: \(progress)", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if candidates.isEmpty {
                Text("No hay otras suscripciones con cuota disponible ahora mismo.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(candidates, id: \.account.id) { candidate in
                            Button {
                                runtime.relay(to: candidate.account, model: candidate.model)
                            } label: {
                                HStack(spacing: 6) {
                                    ProviderBadge(kind: candidate.account.kind, size: 14)
                                    Text("\(candidate.account.name) · \(store.modelName(candidate.account, candidate.model))")
                                    if let s = store.status[candidate.account.id], !s.windows.isEmpty {
                                        Text("\(Int(s.maxPercent.rounded()))%")
                                            .foregroundStyle(.secondary)
                                            .font(.caption.monospacedDigit())
                                    }
                                }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.orange.opacity(0.25)))
    }
}
