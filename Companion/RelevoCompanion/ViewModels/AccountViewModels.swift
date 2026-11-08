import Foundation
import Observation
import RelevoProtocol
import VisionKit

@Observable
final class LimitsViewModel {
    let client: CompanionClient

    init(client: CompanionClient) {
        self.client = client
    }

    var accounts: [RemoteAccount] { client.snapshot?.accounts ?? [] }
    var hasSnapshot: Bool { client.snapshot != nil }

    func refresh() async {
        client.send(.refreshUsage)
        try? await Task.sleep(for: .seconds(1.5))
    }
}

@Observable
final class SettingsViewModel {
    let client: CompanionClient
    var host: String
    var port: String

    init(client: CompanionClient) {
        self.client = client
        host = client.pairing?.host ?? ""
        port = client.pairing?.port.map(String.init) ?? ""
    }

    var macName: String { client.snapshot?.macName ?? client.pairing?.name ?? "Mac" }

    var liveActivitiesEnabled: Bool {
        get { client.liveActivities.isEnabled }
        set { client.liveActivities.isEnabled = newValue }
    }
    var systemAllowsLiveActivities: Bool { client.liveActivities.systemAllowsActivities }
    var state: CompanionClient.ConnectionState { client.state }
    var autoRelay: Bool { client.snapshot?.autoRelay ?? false }
    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–"
    }

    /// How the current connection reaches the Mac.
    var route: String? {
        guard client.state == .connected, let via = client.connectedVia else { return nil }
        return via == "red local" ? "Red local" : via
    }

    /// The Mac's addresses this iPhone knows (they update by themselves on every connection).
    var knownAddresses: String? {
        guard let list = client.pairing?.addresses, !list.isEmpty else { return nil }
        return list.joined(separator: ", ")
    }

    var stateDescription: String {
        switch client.state {
        case .connected: "Conectado"
        case .connecting: "Conectando…"
        case .offline(let reason): reason
        case .unpaired: "Sin emparejar"
        }
    }

    func saveAddress() {
        client.setManualAddress(host: host, port: UInt16(port.trimmingCharacters(in: .whitespaces)))
    }

    func reconnect() { client.reconnect() }
    func unpair() { client.unpair() }
}

@Observable
final class PairingViewModel {
    let client: CompanionClient
    var errorMessage: String?
    var isScanning = false

    init(client: CompanionClient) {
        self.client = client
    }

    var canScan: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    /// Accepts a scanned code or pasted link (`relevocompanion://pair?...`).
    func handle(_ text: String?) {
        guard let text, let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let info = PairingInfo(url: url) else {
            errorMessage = "Ese enlace no es un código de emparejamiento de Relevo."
            return
        }
        errorMessage = nil
        isScanning = false
        client.pair(with: info)
    }
}
