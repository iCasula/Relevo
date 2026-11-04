import SwiftUI
import AppKit

struct SidebarView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let selection = Binding<UUID?>(
            get: { store.selectedThreadId },
            set: { store.select($0) }
        )
        VStack(spacing: 0) {
            List(selection: selection) {
                Section {
                    SidebarActionRow(title: "Nuevo hilo", symbol: "square.and.pencil", shortcut: "⌘N") {
                        store.newThread()
                    }
                    SidebarActionRow(title: "Añadir proyecto", symbol: "folder.badge.plus", shortcut: "⌘O") {
                        store.showNewProject = true
                    }
                }
                Section("Proyectos") {
                    ForEach(store.projects) { project in
                        ProjectGroup(project: project)
                    }
                    if store.projects.isEmpty {
                        Text("Aún no hay proyectos")
                            .foregroundStyle(.tertiary)
                            .font(.callout)
                    }
                }
            }
            .listStyle(.sidebar)
            UsageFooter()
        }
    }
}

struct SidebarActionRow: View {
    let title: String
    let symbol: String
    var shortcut: String? = nil
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: symbol)
                Spacer()
                if let shortcut, hover {
                    Text(shortcut).font(.caption).foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

struct ProjectGroup: View {
    @Environment(AppStore.self) private var store
    let project: Project
    @State private var hover = false
    @State private var confirmRemove = false

    var body: some View {
        let expanded = Binding<Bool>(
            get: { store.expandedProjects.contains(project.id) },
            set: { open in
                if open { store.expandedProjects.insert(project.id) } else { store.expandedProjects.remove(project.id) }
                store.saveState()
            }
        )
        DisclosureGroup(isExpanded: expanded) {
            let threads = store.threads(in: project.id)
            ForEach(threads) { thread in
                ThreadRow(thread: thread)
                    .tag(thread.id)
            }
            if threads.isEmpty {
                Button {
                    store.newThread(in: project)
                } label: {
                    Text("Empieza un hilo").foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                Text(project.name)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Button {
                    store.newThread(in: project)
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .opacity(hover ? 1 : 0)
                .help("Nuevo hilo en \(project.name)")
            }
            .onHover { hover = $0 }
            .help(abbreviateHome(project.path))
            .contextMenu {
                Button("Nuevo hilo") { store.newThread(in: project) }
                Button("Nuevo hilo en un worktree") { store.newWorktreeThread(in: project) }
                Button("Mostrar en Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.path)])
                }
                Button("Abrir en Terminal") { ProjectActions.openTerminal(project.path) }
                Divider()
                Button("Configurar memoria compartida (AGENTS.md)") { store.setupSharedMemory(project) }
                Divider()
                Button("Quitar de Relevo…", role: .destructive) { confirmRemove = true }
            }
            .confirmationDialog("¿Quitar «\(project.name)» de Relevo?", isPresented: $confirmRemove) {
                Button("Quitar y borrar sus hilos", role: .destructive) { store.removeProject(project) }
            } message: {
                Text("La carpeta del proyecto no se toca; solo se eliminan los hilos guardados en Relevo.")
            }
        }
    }
}

struct ThreadRow: View {
    @Environment(AppStore.self) private var store
    let thread: ThreadModel
    @State private var renaming = false
    @State private var newTitle = ""

    var body: some View {
        row
            .contextMenu {
                Button("Renombrar…") { newTitle = thread.title; renaming = true }
                Button("Regenerar título con IA") { TopicNamer.regenerate(thread, store: store) }
                    .disabled(store.topicProvider() == nil || !thread.items.contains { $0.kind == .user })
                Divider()
                Button("Eliminar hilo", role: .destructive) { store.deleteThread(thread) }
            }
            .alert("Renombrar hilo", isPresented: $renaming) {
                TextField("Título", text: $newTitle)
                Button("Guardar") {
                    let t = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    thread.title = t
                    thread.titleSource = .manual
                    store.save(thread)
                }
                Button("Cancelar", role: .cancel) {}
            }
    }

    private var row: some View {
        HStack(spacing: 8) {
            if let kind = thread.lastKind {
                Circle().fill(kind.tint).frame(width: 6, height: 6)
            } else {
                Circle().strokeBorder(.tertiary).frame(width: 6, height: 6)
            }
            if thread.comparisonId != nil {
                Image(systemName: "person.3.sequence").font(.caption2).foregroundStyle(.secondary)
                    .help("Uno de varios agentes haciendo la misma tarea")
            } else if let w = thread.worktree {
                Image(systemName: "square.stack.3d.down.right").font(.caption2).foregroundStyle(.secondary)
                    .help("Worktree propio · \(w.branch)")
            }
            Text(thread.title)
                .lineLimit(1)
                .help(thread.titleSource == .ai ? "Tema puesto por IA · clic derecho para renombrar" : thread.title)
            if let pr = thread.pullRequest {
                Image(systemName: pr.state == "MERGED" ? "arrow.triangle.merge" : "arrow.triangle.pull")
                    .font(.caption2)
                    .foregroundStyle(pr.state == "MERGED" ? Color.purple : pr.state == "OPEN" ? Color.green : Color.secondary)
                    .help("PR #\(pr.number) \(GitMenu.stateName(pr.state))" + (pr.watching ? " · vigilado" : ""))
            }
            Spacer(minLength: 4)
            if store.existingRuntime(thread.id)?.isRunning == true {
                ProgressView().controlSize(.mini)
            } else if store.existingRuntime(thread.id)?.limit != nil {
                Image(systemName: "hourglass").font(.caption2).foregroundStyle(.orange)
            } else if let tasks = store.existingRuntime(thread.id)?.backgroundTasks, !tasks.isEmpty {
                Image(systemName: "clock").font(.caption2).foregroundStyle(.secondary)
                    .help("Esperando a \(tasks.count == 1 ? "una tarea" : "\(tasks.count) tareas") en segundo plano: " + tasks.map(\.description).joined(separator: ", "))
            } else {
                Text(Formatters.relative(thread.updatedAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

enum ProjectActions {
    static func openTerminal(_ path: String) {
        let url = URL(fileURLWithPath: path)
        let terminal = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        NSWorkspace.shared.open([url], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration())
    }
}

// MARK: - Usage footer

struct UsageFooter: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Límites")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    openWindow(id: "usage")
                } label: {
                    Image(systemName: "chart.bar.xaxis")
                }
                .buttonStyle(.borderless)
                .help("Consumo de tokens (⌥⌘U)")
                Button {
                    store.refreshAllUsage()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Actualizar límites (⇧⌘R)")
                SettingsLink {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .help("Suscripciones y ajustes")
            }
            ForEach(store.enabledAccounts) { account in
                AccountUsageRow(account: account)
            }
            if store.enabledAccounts.isEmpty {
                Text("Añade una suscripción en Ajustes")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

struct AccountUsageRow: View {
    @Environment(AppStore.self) private var store
    let account: Account
    @State private var showDetail = false

    var body: some View {
        let s = store.status[account.id]
        Button {
            showDetail.toggle()
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    ProviderBadge(kind: account.kind, size: 14)
                    Text(account.name)
                        .font(.caption.weight(.medium))
                        .layoutPriority(1)
                    if let email = s?.email {
                        Text(email)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 2)
                    if let plan = s?.plan {
                        Text(plan)
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Theme.subtleFill, in: Capsule())
                            .layoutPriority(1)
                    }
                    if store.refreshing.contains(account.id) {
                        ProgressView().controlSize(.mini)
                    } else if s?.noPlan == true {
                        Image(systemName: "creditcard.trianglebadge.exclamationmark").font(.caption2).foregroundStyle(.orange)
                    } else if s?.isExhausted == true {
                        Image(systemName: "hourglass").font(.caption2).foregroundStyle(.red)
                    } else if s?.loggedIn == false {
                        Image(systemName: "person.crop.circle.badge.exclamationmark").font(.caption2).foregroundStyle(.orange)
                    }
                }
                if let windows = s?.windows, !windows.isEmpty {
                    ForEach(windows.prefix(2)) { w in
                        UsageBar(window: w, compact: true)
                    }
                } else if s?.loggedIn == false {
                    Text("Sin sesión · pulsa para iniciar")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                } else if s?.noPlan == true {
                    Text(s?.error ?? "El plan no incluye este servicio")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                } else if let err = s?.error {
                    Text(err).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                } else if let note = s?.note {
                    Text(note).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showDetail, arrowEdge: .trailing) {
            AccountDetailPopover(account: account)
                .environment(store)
        }
    }
}

struct UsageBar: View {
    let window: UsageWindow
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            Text(window.label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: compact ? 62 : 120, alignment: .leading)
                .lineLimit(1)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule()
                        .fill(Theme.usageColor(window.percent))
                        .frame(width: max(3, geo.size.width * min(1, window.percent / 100)))
                }
            }
            .frame(height: compact ? 4 : 6)
            Text("\(Int(window.percent.rounded()))%")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(window.percent >= 90 ? .red : .secondary)
                .frame(width: 32, alignment: .trailing)
        }
        .help(helpText)
    }

    private var helpText: String {
        var parts = ["\(window.label): \(Int(window.percent.rounded()))% usado"]
        if let r = Formatters.reset(window.resetsAt) { parts.append("se reinicia \(r)") }
        if let d = window.detail { parts.append(d) }
        return parts.joined(separator: " · ")
    }
}

struct AccountDetailPopover: View {
    @Environment(AppStore.self) private var store
    let account: Account

    var body: some View {
        let s = store.status[account.id]
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                ProviderBadge(kind: account.kind, size: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(account.name).font(.headline)
                    Text([account.kind.agentName, s?.plan, s?.email].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            if let windows = s?.windows, !windows.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(windows) { w in
                        VStack(alignment: .leading, spacing: 3) {
                            UsageBar(window: w)
                            if let r = Formatters.reset(w.resetsAt) {
                                Text("Se reinicia \(r)" + (w.detail.map { " · \($0)" } ?? ""))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .padding(.leading, 116)
                            }
                        }
                    }
                }
            } else {
                Text(s?.error ?? "Sin datos de uso todavía")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let note = s?.note {
                Label(note, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            }
            if let until = s?.exhaustedUntil, until > Date() {
                Label("Límite alcanzado · disponible \(Formatters.reset(until) ?? "")", systemImage: "hourglass")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            Divider()
            HStack {
                if let at = s?.updatedAt {
                    Text("Actualizado \(Formatters.relative(at))").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                Button("Iniciar sesión") { store.login(account) }
                Button {
                    store.refreshUsage(account.id)
                } label: {
                    Label("Actualizar", systemImage: "arrow.clockwise")
                }
                .disabled(store.refreshing.contains(account.id))
            }
            .controlSize(.small)
        }
        .padding(16)
        .frame(width: 340)
    }
}
