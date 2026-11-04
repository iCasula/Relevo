import SwiftUI
import AppKit

struct SettingsView: View {
    var body: some View {
        TabView {
            AccountsSettings()
                .tabItem { Label("Suscripciones", systemImage: "person.2.crop.square.stack") }
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
            CompanionSettings()
                .tabItem { Label("iPhone", systemImage: "iphone.gen3") }
            IntegrationsSettings()
                .tabItem { Label("Integraciones", systemImage: "puzzlepiece.extension") }
        }
        .frame(width: 680, height: 500)
    }
}

struct AccountsSettings: View {
    @Environment(AppStore.self) private var store
    @State private var selection: UUID?

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                List(selection: $selection) {
                    ForEach(store.accounts) { account in
                        HStack(spacing: 8) {
                            ProviderBadge(kind: account.kind, size: 18)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(account.name)
                                Text(store.status[account.id]?.email ?? account.kind.displayName)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer()
                            if !account.enabled {
                                Image(systemName: "pause.circle").foregroundStyle(.tertiary)
                            } else if store.status[account.id]?.loggedIn == true {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            } else if store.status[account.id]?.loggedIn == false {
                                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                            }
                        }
                        .tag(account.id)
                    }
                }
                Divider()
                HStack(spacing: 4) {
                    let missing = ProviderKind.allCases.filter { kind in !store.accounts.contains { $0.kind == kind } }
                    Menu {
                        ForEach(missing) { kind in
                            Button(kind.displayName) { store.addAccount(kind); selection = store.accounts.last?.id }
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .disabled(missing.isEmpty)
                    .help(missing.isEmpty ? "Ya tienes una suscripción de cada proveedor (una por proveedor)" : "Añadir proveedor")
                    Button {
                        if let id = selection { store.removeAccount(id); selection = store.accounts.first?.id }
                    } label: {
                        Image(systemName: "minus")
                    }
                    .buttonStyle(.borderless)
                    .disabled(selection == nil)
                    Spacer()
                    Button("Detectar CLIs") { store.detectAccountsMerge() }
                        .buttonStyle(.borderless)
                        .font(.caption)
                }
                .padding(8)
            }
            .frame(minWidth: 210, maxWidth: 240)

            Group {
                if let id = selection, let account = store.account(id) {
                    AccountEditor(account: account)
                        .id(account.id)
                } else {
                    VStack(spacing: 8) {
                        Text("Elige una suscripción")
                            .foregroundStyle(.secondary)
                        Text("Relevo usa el login oficial (OAuth) de cada CLI: Claude Code, Codex, Antigravity y ZCode. Una suscripción por proveedor; no necesitas API keys.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 300)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { if selection == nil { selection = store.accounts.first?.id } }
    }
}

struct AccountEditor: View {
    @Environment(AppStore.self) private var store
    let account: Account
    @State private var name = ""
    @State private var configDir = ""
    @State private var binaryPath = ""
    @State private var apiKey = ""
    @State private var hasKey = false

    var body: some View {
        let s = store.status[account.id]
        let launch = Binaries.launch(for: account)
        Form {
            Section {
                HStack(spacing: 10) {
                    ProviderBadge(kind: account.kind, size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.kind.displayName).font(.headline)
                        AccountStatusLabel(account: account)
                    }
                    Spacer()
                    Toggle("Activa", isOn: Binding(get: { account.enabled }, set: { v in store.updateAccount(account.id) { $0.enabled = v } }))
                        .toggleStyle(.switch)
                        .labelsHidden()
                }
            }
            if account.kind.usesAPIKey {
                Section("API key") {
                    HStack {
                        SecureField(hasKey ? "Guardada en el Llavero (pega otra para cambiarla)" : "sk-…", text: $apiKey)
                        Button("Guardar") {
                            Keychain.set(apiKey.trimmingCharacters(in: .whitespacesAndNewlines), for: Keychain.apiKeyName(account.id))
                            apiKey = ""
                            hasKey = true
                            store.refreshUsage(account.id)
                        }
                        .disabled(apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
                        if hasKey {
                            Button("Borrar", role: .destructive) {
                                Keychain.delete(Keychain.apiKeyName(account.id))
                                hasKey = false
                                store.refreshUsage(account.id)
                            }
                        }
                    }
                    Text("La clave solo se guarda en tu Llavero y solo se envía a la API oficial de \(account.kind.shortName).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Section(account.kind.usesAPIKey ? "Cuenta" : "Sesión") {
                HStack {
                    Button {
                        store.login(account)
                    } label: {
                        Label(account.kind.usesAPIKey ? "Crear API key en \(account.kind.shortName)" : loginTitle, systemImage: account.kind.usesAPIKey ? "key" : "person.badge.key")
                    }
                    .disabled(launch == nil)
                    Button {
                        store.refreshUsage(account.id)
                    } label: {
                        Label("Comprobar", systemImage: "arrow.clockwise")
                    }
                    Spacer()
                }
                Text(LocalizedStringKey(loginHelp))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let s, !s.windows.isEmpty {
                    ForEach(s.windows) { w in UsageBar(window: w) }
                }
                if let err = s?.error { Text(err).font(.caption).foregroundStyle(.orange) }
            }
            Section("Configuración") {
                TextField("Nombre", text: $name)
                    .onSubmit { store.updateAccount(account.id) { $0.name = name } }
                if let label = account.kind.info.isolation?.label {
                    TextField(label, text: $configDir, prompt: Text("Predeterminada"))
                        .onSubmit { store.updateAccount(account.id) { $0.configDir = configDir.isEmpty ? nil : configDir } }
                    Text("Opcional: una carpeta propia aísla esta sesión de la CLI que usas fuera de Relevo (otra cuenta, otros ajustes). Vacío = la de siempre.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                TextField("Ruta del ejecutable", text: $binaryPath, prompt: Text(launch?.executable ?? "No encontrado"))
                    .onSubmit { store.updateAccount(account.id) { $0.binaryPath = binaryPath.isEmpty ? nil : binaryPath } }
                if let launch {
                    Text(abbreviateHome(launch.executable))
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                } else {
                    Text(AgentStartError.binaryNotFound(account.kind).errorDescription ?? "")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Button("Guardar cambios") {
                    store.updateAccount(account.id) {
                        $0.name = name.isEmpty ? $0.name : name
                        $0.configDir = configDir.isEmpty ? nil : configDir
                        $0.binaryPath = binaryPath.isEmpty ? nil : binaryPath
                    }
                    store.refreshUsage(account.id)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            name = account.name
            configDir = account.configDir ?? ""
            binaryPath = account.binaryPath ?? ""
            hasKey = account.kind.usesAPIKey && Keychain.get(Keychain.apiKeyName(account.id)) != nil
        }
    }

    private var loginTitle: String {
        store.status[account.id]?.loggedIn == true ? "Volver a iniciar sesión" : "Iniciar sesión"
    }

    private var loginHelp: String { account.kind.info.authHelp }
}

struct GeneralSettings: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Relevo entre agentes") {
                Toggle(isOn: Binding(get: { store.settings.autoRelay }, set: { v in store.updateSettings { $0.autoRelay = v } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Relevo automático al alcanzar un límite")
                        Text("Si un agente se queda sin cuota, Relevo reenvía la petición (con todo el contexto) a la suscripción con más cuota libre.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Picker("Suscripción por defecto", selection: Binding(get: { store.settings.defaultAccountId }, set: { v in store.updateSettings { $0.defaultAccountId = v } })) {
                    Text("La que tenga más cuota libre").tag(UUID?.none)
                    ForEach(store.enabledAccounts) { a in Text(a.name).tag(UUID?.some(a.id)) }
                }
            }
            Section("Relevo sugiere") {
                Picker(selection: Binding(get: { store.settings.suggestMode }, set: { v in store.updateSettings { $0.suggestMode = v } })) {
                    ForEach(SuggestMode.allCases) { Text($0.label).tag($0) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Elegir modelo según la tarea")
                        Text("Mientras escribes, propone la suscripción, el modelo y el razonamiento justos para la tarea, gastando antes la cuota que se iba a perder. A mitad de un hilo solo propone cambiar si compensa el traspaso.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Toggle(isOn: Binding(get: { store.settings.suggestWithAI }, set: { v in store.updateSettings { $0.suggestWithAI = v } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Clasificar la tarea con IA")
                        Text("Usa el modelo auxiliar de los títulos, con una llamada corta tras una pausa al escribir. Si lo desactivas, una heurística local y gratuita.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(store.settings.suggestMode == .off)
                HStack {
                    Text("Potencia de cada modelo, esfuerzo por tarea y palabras clave: en model-tiers.json.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Personalizar…") {
                        NSWorkspace.shared.activateFileViewerSelecting([ModelCatalog.exportDefaultsIfNeeded()])
                    }
                    .controlSize(.small)
                }
            }
            Section("Títulos de conversación") {
                Toggle(isOn: Binding(get: { store.settings.autoTopics }, set: { v in store.updateSettings { $0.autoTopics = v } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Poner el tema como título con IA")
                        Text("Un modelo barato y sin razonamiento resume de qué va el hilo. Si el primer mensaje no aclara nada, espera al siguiente.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Picker("Modelo auxiliar (títulos y sugerencias)", selection: Binding(get: { store.settings.topicAccountId }, set: { v in store.updateSettings { $0.topicAccountId = v } })) {
                    Text("Automático (el más barato disponible)").tag(UUID?.none)
                    ForEach(store.enabledAccounts.filter { $0.kind.provider.quickModelName != nil }) { a in
                        Text("\(a.name) · \(a.kind.provider.quickModelName ?? "")").tag(UUID?.some(a.id))
                    }
                }
                .disabled(!store.settings.autoTopics && (store.settings.suggestMode == .off || !store.settings.suggestWithAI))
                if let (acc, provider) = store.topicProvider() {
                    Text("Ahora mismo: \(acc.name) · \(provider.quickModelName ?? "")").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Agentes") {
                Picker("Permisos por defecto", selection: Binding(get: { store.settings.defaultMode }, set: { v in store.updateSettings { $0.defaultMode = v } })) {
                    ForEach(PermissionMode.allCases) { Text($0.label).tag($0) }
                }
                Picker("Actualizar límites cada", selection: Binding(get: { store.settings.refreshMinutes }, set: { v in store.updateSettings { $0.refreshMinutes = v } })) {
                    ForEach([5, 10, 15, 30, 60], id: \.self) { Text("\($0) min").tag($0) }
                }
            }
            Section("Datos") {
                HStack {
                    Text(abbreviateHome(AppStore.supportDirectory.path))
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Mostrar") { NSWorkspace.shared.open(AppStore.supportDirectory) }
                }
                Text("Los hilos, las transcripciones de traspaso y la configuración se guardan solo en este Mac. Relevo no guarda tokens: usa las sesiones de cada CLI oficial.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct NewProjectSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var mode = 0
    @State private var name = ""
    @State private var parent = ""
    @State private var gitInit = true
    @State private var sharedMemory = true
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Añadir proyecto").font(.title2.weight(.semibold))
            Picker("", selection: $mode) {
                Text("Abrir carpeta existente").tag(0)
                Text("Crear proyecto nuevo").tag(1)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if mode == 0 {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Elige la carpeta del proyecto. Los agentes trabajarán dentro de ella.")
                        .foregroundStyle(.secondary)
                    Toggle("Configurar memoria compartida (AGENTS.md) si no existe", isOn: $sharedMemory)
                }
            } else {
                Form {
                    TextField("Nombre", text: $name, prompt: Text("mi-proyecto"))
                    HStack {
                        TextField("Ubicación", text: $parent)
                        Button("Elegir…") { if let url = pickFolder() { parent = abbreviateHome(url.path) } }
                    }
                    Toggle("Inicializar repositorio git", isOn: $gitInit)
                    Toggle("Memoria compartida para todos los agentes (AGENTS.md)", isOn: $sharedMemory)
                }
                .formStyle(.columns)
            }
            if let error {
                Text(error).foregroundStyle(.red).font(.caption)
            }
            HStack {
                Spacer()
                Button("Cancelar") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(mode == 0 ? "Elegir carpeta…" : "Crear") { mode == 0 ? openExisting() : create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(mode == 1 && name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 520)
        .onAppear { parent = store.settings.newProjectsParent }
    }

    private func pickFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Elegir"
        return panel.runModal() == .OK ? panel.url : nil
    }

    private func openExisting() {
        guard let url = pickFolder() else { return }
        let project = store.addProject(path: url.path)
        if sharedMemory && !FileManager.default.fileExists(atPath: "\(project.path)/AGENTS.md") {
            store.setupSharedMemory(project)
        }
        store.newThread(in: project)
        dismiss()
    }

    private func create() {
        let clean = name.trimmingCharacters(in: .whitespaces)
        let base = expandTilde(parent.isEmpty ? "~/Projects" : parent)
        let path = (base as NSString).appendingPathComponent(clean)
        do {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        } catch {
            self.error = error.localizedDescription
            return
        }
        if gitInit {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["init", "-q"]
            p.currentDirectoryURL = URL(fileURLWithPath: path)
            try? p.run()
            p.waitUntilExit()
        }
        store.updateSettings { $0.newProjectsParent = parent }
        let project = store.addProject(path: path, name: clean)
        if sharedMemory { store.setupSharedMemory(project) }
        store.newThread(in: project)
        dismiss()
    }
}
