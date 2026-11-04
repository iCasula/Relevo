import SwiftUI

struct SettingsView: View {
    @State private var viewModel: SettingsViewModel
    @AppStorage("showTurnUsage") private var showTurnUsage = true
    @State private var confirmUnpair = false

    init(client: CompanionClient) {
        _viewModel = State(initialValue: SettingsViewModel(client: client))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Mac") {
                    LabeledContent("Nombre", value: viewModel.macName)
                    LabeledContent("Estado") {
                        Text(viewModel.stateDescription)
                            .foregroundStyle(viewModel.state == .connected ? .green : .secondary)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Relevo automático", value: viewModel.autoRelay ? "Activado" : "Desactivado")
                    Button("Reconectar", systemImage: "arrow.clockwise", action: viewModel.reconnect)
                }

                Section {
                    Toggle("Consumo de cada mensaje", isOn: $showTurnUsage)
                } header: {
                    Text("Conversación")
                } footer: {
                    Text("Tokens, caché y coste (equivalente en API) bajo cada respuesta, y lo que costó cambiar de modelo o de proveedor.")
                }

                Section {
                    Toggle("Actividad en directo", isOn: $viewModel.liveActivitiesEnabled)
                    if !viewModel.systemAllowsLiveActivities {
                        Label("Las Live Activities están desactivadas para Relevo en Ajustes del iPhone.", systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                } header: {
                    Text("Pantalla bloqueada")
                } footer: {
                    Text("Muestra en la pantalla bloqueada y la Dynamic Island qué hace el agente y si te necesita; los permisos se pueden responder desde ahí. Con la app cerrada, se actualiza si en el Mac has puesto tu clave APNs (Ajustes › iPhone).")
                }

                Section {
                    TextField("Dirección (p. ej. 100.64.0.12)", text: $viewModel.host)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Puerto (47820)", text: $viewModel.port)
                        .keyboardType(.numberPad)
                    Button("Guardar dirección", action: viewModel.saveAddress)
                } header: {
                    Text("Fuera de casa")
                } footer: {
                    Text("En la misma Wi‑Fi el iPhone encuentra el Mac solo. Para conectarte desde fuera, usa una VPN como Tailscale y pon la dirección del Mac.")
                }

                Section {
                    Button("Desvincular este iPhone", role: .destructive) { confirmUnpair = true }
                } footer: {
                    Text("Para quitar el acceso a todos los iPhones, usa «Desvincular iPhones…» en Relevo › Ajustes › iPhone del Mac.")
                }

                Section {
                    LabeledContent("Versión", value: viewModel.appVersion)
                } footer: {
                    Text("La conexión va cifrada (TLS) con una clave que solo tienen tu Mac y este iPhone. Relevo no usa ningún servidor externo.")
                }
            }
            .navigationTitle("Ajustes")
            .confirmationDialog("¿Desvincular este iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Desvincular", role: .destructive, action: viewModel.unpair)
            } message: {
                Text("Tendrás que volver a escanear el código del Mac para conectarte.")
            }
        }
    }
}
