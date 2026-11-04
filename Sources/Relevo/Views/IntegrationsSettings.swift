import SwiftUI
import AppKit

/// Settings › Integraciones: window capture and the MCP server for outside agents.
struct IntegrationsSettings: View {
    @Environment(AppStore.self) private var store
    @State private var showToken = false
    @State private var token = ""

    var body: some View {
        Form {
            Section {
                Toggle("Capturar ventanas con \(WindowCapture.shortcutLabel)", isOn: binding(\.captureEnabled))
                Toggle("Incluir el texto y los controles de la ventana", isOn: binding(\.captureIncludeText))
                    .disabled(!store.settings.captureEnabled)
                HStack {
                    Button("Capturar ahora") { WindowCapture.captureIntoDraft(store: store) }
                    Button("Abrir carpeta de capturas") {
                        try? FileManager.default.createDirectory(at: WindowCapture.folder, withIntermediateDirectories: true)
                        NSWorkspace.shared.open(WindowCapture.folder)
                    }
                }
                Text("Con el atajo, Relevo captura la ventana que tienes delante (el simulador, el navegador…) y la añade al mensaje que estás escribiendo. Con el texto incluido, el agente sabe qué es cada botón y dónde está. Pide permiso de Grabación de pantalla y, para el texto, de Accesibilidad.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("Captura de ventana")
            }

            Section {
                Toggle("Permitir que agentes externos usen Relevo (MCP)", isOn: binding(\.mcpEnabled))
                Picker("Acceso", selection: binding(\.mcpFullAccess)) {
                    Text("Solo lectura: proyectos, hilos, consumo y cuentas").tag(false)
                    Text("Completo: también crear hilos, escribir, detener y relevar").tag(true)
                }
                .disabled(!store.settings.mcpEnabled)
                LabeledContent("Dirección", value: MCPServer.shared.url)
                if let error = MCPServer.shared.lastError, store.settings.mcpEnabled {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.caption)
                }
                LabeledContent("Conectar") {
                    HStack {
                        Button("Copiar para Claude Code") { copy(claudeCommand) }
                            .help("Comando claude mcp add con la dirección y el token")
                        Button("Copiar para Codex") { copy(codexConfig) }
                            .help("Bloque para ~/.codex/config.toml; el token va en la variable RELEVO_MCP_TOKEN")
                    }
                }
                .disabled(!store.settings.mcpEnabled)
                LabeledContent("Token") {
                    HStack {
                        Button(showToken ? "Ocultar" : "Mostrar") {
                            if !showToken { token = MCPServer.shared.token }
                            showToken.toggle()
                        }
                        Button("Nuevo token") {
                            token = MCPServer.shared.regenerateToken()
                            showToken = true
                        }
                        .help("Los agentes ya conectados dejan de tener acceso")
                    }
                }
                .disabled(!store.settings.mcpEnabled)
                if showToken {
                    Text(token).font(.caption.monospaced()).textSelection(.enabled)
                }
                Text("Un Claude Code o un Codex en tu terminal pueden ver tus hilos y, con acceso completo, lanzarlos y dirigirlos. Solo escucha en este Mac (127.0.0.1) y pide el token; con «Nuevo token» los agentes ya conectados dejan de tener acceso.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("Agentes externos (MCP)")
            }
        }
        .formStyle(.grouped)
    }

    private var claudeCommand: String {
        "claude mcp add --transport http relevo \(MCPServer.shared.url) --header \"Authorization: Bearer \(MCPServer.shared.token)\""
    }

    private var codexConfig: String {
        """
        # ~/.codex/config.toml  (and export RELEVO_MCP_TOKEN=\(MCPServer.shared.token))
        [mcp_servers.relevo]
        url = "\(MCPServer.shared.url)"
        bearer_token_env_var = "RELEVO_MCP_TOKEN"
        """
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        store.flash("Copiado")
    }

    private func binding<T>(_ key: WritableKeyPath<AppSettings, T>) -> Binding<T> {
        Binding(get: { store.settings[keyPath: key] }, set: { v in store.updateSettings { $0[keyPath: key] = v } })
    }
}
