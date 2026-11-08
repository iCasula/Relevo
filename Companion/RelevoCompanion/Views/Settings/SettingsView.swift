import SwiftUI

struct SettingsView: View {
    @State private var viewModel: SettingsViewModel
    @AppStorage("showTurnUsage") private var showTurnUsage = true
    @State private var confirmUnpair = false
    @State private var addingHost = false

    init(client: CompanionClient) {
        _viewModel = State(initialValue: SettingsViewModel(client: client))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(viewModel.hosts, id: \.serverId) { host in
                        Button {
                            viewModel.switchHost(to: host.serverId)
                        } label: {
                            HStack {
                                Label(host.name, systemImage: "server.rack")
                                Spacer()
                                if host.serverId == viewModel.activeHostId {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                    Button("Añadir otro host", systemImage: "plus") { addingHost = true }
                } header: {
                    Text("Hosts")
                } footer: {
                    Text("Cada Mac o servidor con Relevo es un host con sus propios proyectos e hilos. El que está en uso es el que ves en Hilos; toca el título para cambiar.")
                }

                Section("En uso") {
                    LabeledContent("Nombre", value: viewModel.macName)
                    LabeledContent("Estado") {
                        Text(viewModel.stateDescription)
                            .foregroundStyle(viewModel.state == .connected ? .green : .secondary)
                            .multilineTextAlignment(.trailing)
                    }
                    if let route = viewModel.route {
                        LabeledContent("Conectado por", value: route)
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
                    if let addresses = viewModel.knownAddresses {
                        Text("Con una VPN que llegue a la red del Mac (WireGuard, Tailscale…), el iPhone prueba solo sus direcciones: \(addresses). Pon aquí otra solo si tu VPN usa una distinta.")
                    } else {
                        Text("En la misma Wi‑Fi el iPhone encuentra el Mac solo. Conéctate una vez en casa para que aprenda sus direcciones; después también llegará por una VPN (WireGuard, Tailscale…). O pon aquí la dirección del Mac.")
                    }
                }

                Section {
                    Button("Desvincular \(viewModel.macName)", role: .destructive) { confirmUnpair = true }
                } footer: {
                    Text("Olvida este host en el iPhone. Para quitar el acceso a todos los iPhones de un Mac, usa «Desvincular iPhones…» en Relevo › Ajustes › iPhone.")
                }

                Section {
                    LabeledContent("Versión", value: viewModel.appVersion)
                } footer: {
                    Text("La conexión va cifrada (TLS) con una clave que solo tienen tu Mac y este iPhone. Relevo no usa ningún servidor externo.")
                }
            }
            .navigationTitle("Ajustes")
            .confirmationDialog("¿Desvincular \(viewModel.macName)?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Desvincular", role: .destructive, action: viewModel.unpair)
            } message: {
                Text("Tendrás que volver a escanear su código para conectarte.")
            }
            .sheet(isPresented: $addingHost) {
                PairingView(client: viewModel.client)
            }
            .onChange(of: viewModel.activeHostId) {
                addingHost = false
                viewModel.reloadAddress()
            }
        }
    }
}
