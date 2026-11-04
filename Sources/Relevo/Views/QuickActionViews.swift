import SwiftUI

/// Toolbar menu with the project's quick actions (⌃1…⌃9 from the Acciones menu), their output and the editor.
struct QuickActionsMenu: View {
    @Environment(AppStore.self) private var store
    let thread: ThreadModel
    @State private var editing = false
    @State private var showRuns = false

    var body: some View {
        let project = store.project(thread.projectId)
        let actions = project?.quickActions ?? []
        let running = store.actions.runs(for: thread.id).contains { $0.isRunning }
        Menu {
            ForEach(Array(actions.enumerated()), id: \.element.id) { i, action in
                Button(action.name, systemImage: action.symbol) { run(action) }
                    .help(action.command)
            }
            if !actions.isEmpty { Divider() }
            Button("Ver salida…", systemImage: "terminal") { showRuns = true }
                .disabled(store.actions.runs(for: thread.id).isEmpty)
            Button("Editar acciones…", systemImage: "slider.horizontal.3") { editing = true }
        } label: {
            Label("Acciones", systemImage: running ? "gearshape.arrow.triangle.2.circlepath" : "play.rectangle")
        }
        .help("Acciones del proyecto: compilar, tests… (⌃1…⌃9)")
        .sheet(isPresented: $editing) {
            if let project { QuickActionsEditor(project: project) }
        }
        .sheet(isPresented: $showRuns) { ActionRunsSheet(thread: thread) }
    }

    private func run(_ action: QuickAction) {
        store.actions.run(action, thread: thread, store: store)
        showRuns = true
    }
}

/// Output of the actions run in a thread, with "send to the agent" for errors worth fixing.
struct ActionRunsSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let thread: ThreadModel
    @State private var selected: UUID?

    var body: some View {
        let runs = store.actions.runs(for: thread.id)
        let run = runs.first { $0.id == selected } ?? runs.first
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Picker("Ejecución", selection: Binding(get: { run?.id }, set: { selected = $0 })) {
                    ForEach(runs) { r in
                        Text("\(r.action.name) · \(r.started.formatted(date: .omitted, time: .shortened))").tag(Optional(r.id))
                    }
                }
                .frame(maxWidth: 360)
                Spacer()
                if let run {
                    status(run)
                    if run.isRunning { Button("Detener") { store.actions.stop(run) } }
                    Button("Enviar al agente") {
                        store.runtime(for: thread).send(QuickActionRunner.message(for: run))
                        dismiss()
                    }
                    .disabled(run.isRunning)
                    .help("Manda el final de la salida al agente (útil con errores de compilación o tests)")
                }
                Button("Cerrar") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if let run {
                Text(run.action.command).font(.caption.monospaced()).foregroundStyle(.secondary)
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(run.output.isEmpty ? "…" : run.output)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                        Color.clear.frame(height: 1).id("end")
                    }
                    .background(Color(nsColor: .textBackgroundColor))
                    .onChange(of: run.output.count) { proxy.scrollTo("end", anchor: .bottom) }
                }
            } else {
                ContentUnavailableView("Sin ejecuciones", systemImage: "terminal")
            }
        }
        .padding(16)
        .frame(minWidth: 760, minHeight: 480)
    }

    @ViewBuilder private func status(_ run: ActionRun) -> some View {
        switch run.state {
        case .running: HStack(spacing: 6) { ProgressView().controlSize(.small); Text("En curso") }
        case .succeeded: Label("Terminó bien", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed(let code): Label("Falló (\(code))", systemImage: "xmark.octagon.fill").foregroundStyle(.red)
        }
    }
}

/// Edit a project's quick actions.
struct QuickActionsEditor: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var project: Project
    @State private var actions: [QuickAction] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Acciones de \(project.name)").font(.title2.weight(.semibold))
            Text("Comandos que lanzas desde la barra del hilo, en su carpeta (o su worktree), con tu shell. Las nueve primeras tienen atajo ⌃1…⌃9.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(spacing: 10) {
                    ForEach($actions) { $a in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                TextField("Nombre", text: $a.name).frame(width: 180)
                                TextField("Comando", text: $a.command).font(.body.monospaced())
                                Button { actions.removeAll { $0.id == a.id } } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless)
                            }
                            Toggle("Ejecutar al crear un worktree", isOn: $a.runOnWorktreeCreate).font(.caption)
                        }
                        .padding(10)
                        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 8))
                    }
                }
            }
            .frame(minHeight: 160, maxHeight: 360)
            HStack {
                Menu("Añadir") {
                    Button("Vacía") { actions.append(QuickAction(name: "Nueva acción", command: "")) }
                    Divider()
                    ForEach(Self.templates, id: \.name) { t in Button(t.name) { actions.append(t) } }
                }
                .fixedSize()
                Spacer()
                Button("Cancelar") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Guardar") {
                    project.actions = actions.filter { !$0.command.trimmingCharacters(in: .whitespaces).isEmpty }
                    store.updateProject(project)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 680)
        .onAppear { actions = project.quickActions }
    }

    static let templates: [QuickAction] = [
        QuickAction(name: "Compilar (Xcode)", command: "xcodebuild -scheme \"$(basename \"$PWD\")\" -destination 'generic/platform=iOS Simulator' build | tail -40", symbol: "hammer"),
        QuickAction(name: "Tests (Xcode)", command: "xcodebuild test -scheme \"$(basename \"$PWD\")\" -destination 'platform=iOS Simulator,name=iPhone 17' | tail -60", symbol: "checkmark.seal"),
        QuickAction(name: "XcodeGen", command: "xcodegen generate", symbol: "gearshape.2", runOnWorktreeCreate: true),
        QuickAction(name: "Swift build", command: "swift build 2>&1 | tail -40", symbol: "hammer"),
        QuickAction(name: "npm install", command: "npm install", symbol: "shippingbox", runOnWorktreeCreate: true),
        QuickAction(name: "npm test", command: "npm test", symbol: "checkmark.seal"),
    ]
}

/// "Acciones" menu in the menu bar: the selected thread's project actions with ⌃1…⌃9.
struct QuickActionCommands: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if let thread = store.selectedThread, let project = store.project(thread.projectId), !project.quickActions.isEmpty {
            ForEach(Array(project.quickActions.prefix(9).enumerated()), id: \.element.id) { i, action in
                Button(action.name) { store.actions.run(action, thread: thread, store: store) }
                    .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .control)
            }
        } else {
            Text("Este proyecto no tiene acciones")
        }
    }
}
