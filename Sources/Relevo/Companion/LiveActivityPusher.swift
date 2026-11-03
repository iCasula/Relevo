import Foundation
import CryptoKit
import Observation
import RelevoProtocol

/// Keeps the iPhone Live Activity current while the companion app is closed: the Mac itself sends
/// ActivityKit push notifications to APNs, authenticated with the user's own APNs key (.p8).
/// No third-party server is involved.
@Observable
@MainActor
final class LiveActivityPusher {
    static let shared = LiveActivityPusher()
    static let keyName = "apns-key"
    static let attributesType = "RelevoActivityAttributes"

    private(set) var registrations: [LiveActivityRegistration] = []
    private(set) var lastResult: String?
    private(set) var hasKey = false

    @ObservationIgnored private weak var store: AppStore?
    @ObservationIgnored private var lastSent: [String: (state: RelevoActivityState, at: Date)] = [:]
    @ObservationIgnored private var pending = false
    @ObservationIgnored private var jwt: (token: String, issued: Date, keyId: String)?

    private var fileURL: URL { AppStore.supportDirectory.appendingPathComponent("live-activities.json") }

    func attach(_ store: AppStore) {
        self.store = store
        if let data = try? Data(contentsOf: fileURL), let list = try? JSONDecoder().decode([LiveActivityRegistration].self, from: data) {
            registrations = list
        }
        hasKey = Keychain.get(Self.keyName) != nil
        observe()
    }

    var isConfigured: Bool {
        guard let s = store?.settings else { return false }
        return hasKey && !(s.apnsTeamId ?? "").isEmpty && !(s.apnsKeyId ?? "").isEmpty
    }

    // MARK: - Configuration

    func saveKey(pem: String) -> Bool {
        guard (try? P256.Signing.PrivateKey(pemRepresentation: pem)) != nil else {
            lastResult = "Ese fichero no es una clave APNs (.p8) válida"
            return false
        }
        Keychain.set(pem, for: Self.keyName)
        hasKey = true
        jwt = nil
        lastResult = "Clave guardada en el Llavero"
        return true
    }

    func removeKey() {
        Keychain.delete(Self.keyName)
        hasKey = false
        jwt = nil
    }

    /// Tokens from an iPhone. An activity token replaces the previous one; nil means the activity ended.
    func register(_ registration: LiveActivityRegistration) {
        if let i = registrations.firstIndex(where: { $0.deviceId == registration.deviceId }) {
            if registrations[i].activityToken != registration.activityToken { lastSent.removeValue(forKey: registration.deviceId) }
            registrations[i] = registration
        } else {
            registrations.append(registration)
        }
        persist()
    }

    func forget(_ deviceId: String) {
        registrations.removeAll { $0.deviceId == deviceId }
        lastSent.removeValue(forKey: deviceId)
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(registrations) { try? data.write(to: fileURL, options: .atomic) }
    }

    // MARK: - Delivery

    private func observe() {
        guard let store else { return }
        let state = withObservationTracking {
            CompanionMapper.activity(store)
        } onChange: { [weak self] in
            Task { @MainActor in self?.schedule(after: 1) }
        }
        deliver(state)
    }

    private func schedule(after seconds: Double) {
        guard !pending else { return }
        pending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self else { return }
            self.pending = false
            self.observe()
        }
    }

    /// Sends the state to every registered iPhone that hasn't seen it yet. Minor changes are throttled
    /// (iOS budgets Live Activity updates); a phase change — especially "needs you" — goes out at once.
    private func deliver(_ state: RelevoActivityState, force: Bool = false) {
        guard let store, store.settings.companionEnabled, isConfigured else { return }
        let connected = CompanionServer.shared.connectedDeviceIds
        for registration in registrations {
            let last = lastSent[registration.deviceId]
            if !force, let last, last.state.sameContent(as: state) { continue }
            let phaseChanged = last?.state.phase != state.phase
            if !force, !phaseChanged, let last, Date().timeIntervalSince(last.at) < 8 {
                schedule(after: 8 - Date().timeIntervalSince(last.at))
                continue
            }
            if let token = registration.activityToken {
                if state.phase == .idle {
                    send(event: "end", token: token, state: last?.state ?? state, registration: registration, priority: 5)
                } else {
                    let important = phaseChanged && [.needsYou, .finished, .limit].contains(state.phase)
                    send(event: "update", token: token, state: state, registration: registration, priority: important ? 10 : 5,
                         alert: important ? alert(for: state) : nil)
                }
            } else if let token = registration.pushToStartToken, [.needsYou, .working, .limit].contains(state.phase),
                      !connected.contains(registration.deviceId) {
                // The app starts it by itself while it's open; push-to-start covers the phone being closed.
                send(event: "start", token: token, state: state, registration: registration, priority: 10,
                     alert: alert(for: state) ?? ("Relevo", state.threadTitle))
            } else {
                continue
            }
            lastSent[registration.deviceId] = (state, Date())
        }
    }

    /// Pushes the current state now, ignoring throttling (Settings › iPhone › "Enviar ahora").
    func sendTest() {
        guard let store else { return }
        guard isConfigured else { lastResult = "Falta la clave, el Team ID o el Key ID"; return }
        guard !registrations.isEmpty else { lastResult = "Ningún iPhone ha registrado todavía su Live Activity"; return }
        lastSent.removeAll()
        deliver(CompanionMapper.activity(store), force: true)
    }

    private func alert(for state: RelevoActivityState) -> (title: String, body: String)? {
        switch state.phase {
        case .needsYou: return ("\(state.threadTitle) te necesita", state.approval?.title ?? "Hay un permiso pendiente")
        case .limit: return ("\(state.threadTitle): límite alcanzado", state.statusLine ?? "Relévalo a otro agente")
        case .finished: return ("\(state.threadTitle) ha terminado", String((state.statusLine ?? "").prefix(120)))
        default: return nil
        }
    }

    private func send(event: String, token: String, state: RelevoActivityState, registration: LiveActivityRegistration,
                      priority: Int, alert: (title: String, body: String)? = nil) {
        guard let store, let teamId = store.settings.apnsTeamId, let keyId = store.settings.apnsKeyId,
              let auth = authorization(teamId: teamId, keyId: keyId) else { return }
        let now = Date().timeIntervalSince1970
        guard let stateData = try? JSONEncoder().encode(state), let contentState = try? JSONSerialization.jsonObject(with: stateData) else { return }
        var aps: [String: Any] = ["timestamp": Int(now), "event": event, "content-state": contentState]
        if state.phase == .working { aps["stale-date"] = Int(now + 30 * 60) }
        if event == "end" { aps["dismissal-date"] = Int(now + 10 * 60) }
        if event == "start" {
            aps["attributes-type"] = Self.attributesType
            aps["attributes"] = ["macName": CompanionCredentials.macName]
        }
        if let alert { aps["alert"] = ["title": alert.title, "body": alert.body, "sound": "default"] }
        guard let body = try? JSONSerialization.data(withJSONObject: ["aps": aps]) else { return }

        let host = registration.environment == "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com"
        var request = URLRequest(url: URL(string: "https://\(host)/3/device/\(token)")!)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 20
        request.setValue("bearer \(auth)", forHTTPHeaderField: "authorization")
        request.setValue("liveactivity", forHTTPHeaderField: "apns-push-type")
        request.setValue("\(registration.bundleId ?? store.settings.companionBundleId).push-type.liveactivity", forHTTPHeaderField: "apns-topic")
        request.setValue(String(priority), forHTTPHeaderField: "apns-priority")
        let deviceId = registration.deviceId
        let deviceName = registration.deviceName
        Task { @MainActor [weak self] in
            let result = await Self.post(request)
            guard let self else { return }
            let time = Date().formatted(date: .omitted, time: .shortened)
            if result.status == 200 {
                self.lastResult = "\(time) · \(deviceName): \(event) enviado"
                if event == "end", let i = self.registrations.firstIndex(where: { $0.deviceId == deviceId }) {
                    self.registrations[i].activityToken = nil
                    self.persist()
                }
            } else {
                self.lastResult = "\(time) · \(deviceName): APNs respondió \(result.status) \(result.reason ?? "")"
                if result.status == 410 || ["BadDeviceToken", "Unregistered", "ExpiredToken"].contains(result.reason ?? ""),
                   let i = self.registrations.firstIndex(where: { $0.deviceId == deviceId }) {
                    if event == "start" { self.registrations[i].pushToStartToken = nil } else { self.registrations[i].activityToken = nil }
                    self.persist()
                }
                if ["InvalidProviderToken", "ExpiredProviderToken"].contains(result.reason ?? "") { self.jwt = nil }
            }
        }
    }

    nonisolated static func post(_ request: URLRequest) async -> (status: Int, reason: String?) {
        guard let (data, response) = try? await URLSession.shared.data(for: request) else { return (0, "sin conexión con APNs") }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let reason = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["reason"] as? String
        return (status, reason)
    }

    // MARK: - Provider token (JWT, ES256)

    /// APNs accepts the same token for up to an hour; it is renewed after 40 minutes.
    private func authorization(teamId: String, keyId: String) -> String? {
        if let jwt, jwt.keyId == keyId, Date().timeIntervalSince(jwt.issued) < 40 * 60 { return jwt.token }
        guard let pem = Keychain.get(Self.keyName), let key = try? P256.Signing.PrivateKey(pemRepresentation: pem),
              let token = Self.makeJWT(teamId: teamId, keyId: keyId, key: key) else {
            lastResult = "No se pudo usar la clave APNs"
            return nil
        }
        jwt = (token, Date(), keyId)
        return token
    }

    nonisolated static func makeJWT(teamId: String, keyId: String, key: P256.Signing.PrivateKey, issuedAt: Date = Date()) -> String? {
        func b64(_ data: Data) -> String {
            data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        guard let header = try? JSONSerialization.data(withJSONObject: ["alg": "ES256", "kid": keyId]),
              let claims = try? JSONSerialization.data(withJSONObject: ["iss": teamId, "iat": Int(issuedAt.timeIntervalSince1970)]) else { return nil }
        let input = b64(header) + "." + b64(claims)
        guard let signature = try? key.signature(for: Data(input.utf8)) else { return nil }
        return input + "." + b64(signature.rawRepresentation)
    }
}
