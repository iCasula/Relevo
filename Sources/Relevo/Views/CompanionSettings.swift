import SwiftUI
import AppKit
import CoreImage.CIFilterBuiltins

/// Settings › iPhone: turn on remote control and pair Relevo Companion with a QR code.
struct CompanionSettings: View {
    @Environment(AppStore.self) private var store
    @State private var server = CompanionServer.shared
    @State private var confirmUnpair = false
    @State private var pairingVersion = 0

    var body: some View {
        Form {
            Section {
                Toggle(isOn: Binding(get: { store.settings.companionEnabled }, set: { v in store.updateSettings { $0.companionEnabled = v } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Permitir controlar Relevo desde el iPhone")
                        Text("Relevo Companion se conecta por la red local con cifrado TLS y una clave que solo tiene el iPhone emparejado. Desde el iPhone se pueden enviar mensajes, aprobar permisos y activar el acceso total.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if store.settings.companionEnabled {
                    LabeledContent("Estado") {
                        if server.isListening, let port = server.port {
                            Label("Esperando conexiones en el puerto \(String(port))", systemImage: "dot.radiowaves.left.and.right")
                                .foregroundStyle(.green)
                        } else {
                            Text(server.lastError ?? "Arrancando…").foregroundStyle(.orange)
                        }
                    }
                    if let error = server.lastError, server.isListening {
                        Text(error).font(.caption).foregroundStyle(.orange)
                    }
                }
            }

            if store.settings.companionEnabled, let pairing = server.pairing {
                Section("Emparejar un iPhone") {
                    HStack(alignment: .top, spacing: 18) {
                        QRCodeView(text: pairing.url.absoluteString)
                            .frame(width: 168, height: 168)
                            .id(pairingVersion)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("1. Abre la Cámara del iPhone y apunta a este código.")
                            Text("2. Toca el aviso para abrirlo en la app Relevo.")
                            Text("También puedes enviarte el enlace (AirDrop, Mensajes) y abrirlo o pegarlo en la app.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HStack {
                                Button("Copiar enlace") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(pairing.url.absoluteString, forType: .string)
                                    store.flash("Enlace de emparejamiento copiado")
                                }
                                Button("Desvincular iPhones…", role: .destructive) { confirmUnpair = true }
                            }
                            .padding(.top, 4)
                        }
                        .font(.callout)
                    }
                    .padding(.vertical, 4)
                }

                Section("Fuera de casa (opcional)") {
                    TextField("Dirección fija", text: Binding(get: { store.settings.companionHost ?? "" },
                                                              set: { v in store.updateSettings { $0.companionHost = v.isEmpty ? nil : v } }),
                              prompt: Text("p. ej. 100.64.0.12 o mac.tailnet.ts.net"))
                    Text("En la misma Wi‑Fi el iPhone encuentra el Mac solo. Para conectarte desde fuera, usa una VPN como Tailscale y pon aquí su dirección; después vuelve a escanear el código. Direcciones de este Mac: \(CompanionCredentials.localAddresses().joined(separator: ", ")).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                LiveActivitySettings()

                Section("iPhones conectados") {
                    if server.devices.isEmpty {
                        Text("Ninguno ahora mismo").foregroundStyle(.secondary)
                    } else {
                        ForEach(server.devices) { device in
                            LabeledContent {
                                Text(device.connectedAt, style: .relative)
                            } label: {
                                Label(device.name, systemImage: "iphone")
                            }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("¿Desvincular todos los iPhones?", isPresented: $confirmUnpair) {
            Button("Desvincular", role: .destructive) {
                server.unpairAll()
                pairingVersion += 1
            }
        } message: {
            Text("Se genera una clave nueva. Tendrás que volver a escanear el código en cada iPhone.")
        }
    }
}

struct QRCodeView: View {
    let text: String

    var body: some View {
        if let image = Self.image(for: text) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .padding(8)
                .background(.white, in: RoundedRectangle(cornerRadius: 10))
        } else {
            Image(systemName: "qrcode").font(.largeTitle)
        }
    }

    static func image(for text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

/// APNs key so the Mac can keep the iPhone Live Activity current while the app is closed.
private struct LiveActivitySettings: View {
    @Environment(AppStore.self) private var store
    @State private var pusher = LiveActivityPusher.shared

    var body: some View {
        Section {
            Text("Para que la pantalla bloqueada y la Dynamic Island del iPhone sigan al día con la app cerrada, el Mac envía las actualizaciones por el servicio de notificaciones de Apple (APNs) con tu propia clave. Sin ella, la actividad solo se actualiza con la app abierta.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Team ID", text: binding(\.apnsTeamId), prompt: Text("10 caracteres, p. ej. ABCDE12345"))
            TextField("Key ID", text: binding(\.apnsKeyId), prompt: Text("ID de la clave APNs"))
            LabeledContent("Clave APNs (.p8)") {
                HStack {
                    if pusher.hasKey {
                        Label("Guardada en el Llavero", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                        Button("Quitar", role: .destructive) { pusher.removeKey() }
                    }
                    Button(pusher.hasKey ? "Cambiar…" : "Elegir fichero…") { chooseKey() }
                }
            }
            if !pusher.registrations.isEmpty {
                ForEach(pusher.registrations, id: \.deviceId) { r in
                    LabeledContent {
                        Text([r.activityToken != nil ? "actividad en curso" : nil,
                              r.pushToStartToken != nil ? "puede iniciarse sola" : nil,
                              r.environment == "production" ? "producción" : "desarrollo"]
                            .compactMap { $0 }.joined(separator: " · "))
                            .foregroundStyle(.secondary)
                    } label: {
                        Label(r.deviceName, systemImage: "iphone")
                    }
                }
            }
            HStack {
                Button("Enviar estado ahora") { pusher.sendTest() }
                    .disabled(!pusher.isConfigured)
                if let result = pusher.lastResult {
                    Text(result).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        } header: {
            Text("Actividad en directo (Live Activities)")
        } footer: {
            Text("Crea la clave en developer.apple.com › Certificates, Identifiers & Profiles › Keys › «+» › Apple Push Notifications service (APNs). El Team ID aparece en Membership. La clave se guarda en tu Llavero y solo se usa para hablar con APNs.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func binding(_ keyPath: WritableKeyPath<AppSettings, String?>) -> Binding<String> {
        Binding(get: { store.settings[keyPath: keyPath] ?? "" },
                set: { v in store.updateSettings { $0[keyPath: keyPath] = v.trimmingCharacters(in: .whitespaces).isEmpty ? nil : v.trimmingCharacters(in: .whitespaces) } })
    }

    private func chooseKey() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "p8") ?? .data]
        panel.allowsOtherFileTypes = true
        panel.message = "Elige la clave APNs (AuthKey_XXXXXXXXXX.p8) que descargaste de developer.apple.com"
        guard panel.runModal() == .OK, let url = panel.url, let pem = try? String(contentsOf: url, encoding: .utf8) else { return }
        if pusher.saveKey(pem: pem) {
            // AuthKey_<KEYID>.p8: fill the Key ID if it's still empty.
            let name = url.deletingPathExtension().lastPathComponent
            if (store.settings.apnsKeyId ?? "").isEmpty, name.hasPrefix("AuthKey_") {
                store.updateSettings { $0.apnsKeyId = String(name.dropFirst("AuthKey_".count)) }
            }
        }
    }
}
