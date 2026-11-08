import Foundation
import Network
import RelevoProtocol

/// `Relevo --selftest remotehost <pairing link> [prompt] [mode]`: talks to a Relevo host (the Mac app or the
/// headless host) exactly as the iPhone does, over a direct address, and checks that every message decodes.
/// With a prompt it opens a thread in the first project, sends it, approves what the agent asks and waits for
/// the reply.
extension SelfTest {
    static func remoteHost(link: String, prompt: String?, mode: String?) async {
        var failures = 0
        func check(_ ok: Bool, _ what: String) {
            print((ok ? "ok   " : "FAIL ") + what)
            if !ok { failures += 1 }
        }
        defer { print(failures == 0 ? "TODO OK" : "\(failures) FALLOS") }
        guard let url = URL(string: link), let pairing = PairingInfo(url: url) else { check(false, "pairing link"); return }
        guard let route = pairing.endpoints.first(where: { $0.label != "red local" }) else { check(false, "the link has an address"); return }
        print("connecting to \(route.label):\(pairing.port ?? CompanionTransport.defaultPort) as \(pairing.serverId)")

        let channel = MessageChannel(connection: NWConnection(to: route.endpoint, using: CompanionTransport.parameters(secret: pairing.secret, identity: pairing.serverId)))
        var ready = false, welcome: String?, addresses: [String]?, snapshot: RemoteSnapshot?, thread: RemoteThread?
        var created: UUID?, activity: RelevoActivityState?, decodeFailures = 0, patches = 0
        channel.onStateChange = { state in if case .ready = state { ready = true } }
        channel.onMessage = { data in
            do {
                switch try CompanionCoding.decode(ServerMessage.self, from: data) {
                case .welcome(let name, _): welcome = name
                case .addresses(let hosts, _): addresses = hosts
                case .snapshot(let s): snapshot = s
                case .thread(let t): thread = t
                case .threadPatch(let p):
                    patches += 1
                    guard var t = thread, t.id == p.id else { return }
                    for item in p.upserts {
                        if let i = t.items.firstIndex(where: { $0.id == item.id }) { t.items[i] = item } else { t.items.append(item) }
                    }
                    t.title = p.title
                    t.totalItems = p.totalItems
                    t.runtime = p.runtime
                    thread = t
                case .created(_, let id): created = id
                case .activity(let a): activity = a
                case .toast(let text): print("toast: \(text)")
                case .image: break
                }
            } catch {
                decodeFailures += 1
                print("DECODE FAIL \(error)\n  \(String(decoding: data.prefix(600), as: UTF8.self))")
            }
        }
        channel.start()
        func wait(_ seconds: Double, until done: () -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            while !done() && Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
            return done()
        }
        check(await wait(10) { ready }, "TLS-PSK + WebSocket over \(route.label)")
        guard ready else { return }
        channel.send(ClientMessage.hello(device: "Selftest", version: CompanionCoding.version))
        check(await wait(5) { welcome != nil && snapshot != nil && activity != nil }, "welcome, snapshot and activity (\(welcome ?? "-"))")
        check(addresses?.isEmpty == false, "addresses \(addresses ?? [])")
        guard let snap = snapshot else { return }
        let account = snap.accounts.first
        print("host «\(snap.macName)»: \(snap.accounts.count) cuentas, \(snap.projects.count) proyectos, \(snap.threads.count) hilos")
        if let account {
            let s = account.status
            print("  \(account.name): sesión \(s?.loggedIn.map { $0 ? "sí" : "no" } ?? "?"), plan \(s?.plan ?? "-"), \(s?.windows.map { "\($0.label) \(Int($0.percent)) %" }.joined(separator: ", ") ?? "-"), modelos \(account.models.map(\.id))\(s?.error.map { " · \($0)" } ?? "")")
        }
        guard let prompt else { channel.cancel(); return }
        guard let project = snap.projects.first, let account else { check(false, "a project and an account to try a turn"); return }

        let requestId = UUID()
        channel.send(ClientMessage.newThread(projectId: project.id, requestId: requestId))
        check(await wait(5) { created != nil }, "new thread in «\(project.name)»")
        guard let threadId = created else { return }
        channel.send(ClientMessage.subscribe(threadId: threadId))
        check(await wait(5) { thread?.id == threadId }, "thread transcript")
        if let mode, let m = RemoteMode(rawValue: mode) { channel.send(ClientMessage.setMode(threadId: threadId, mode: m)) }
        channel.send(ClientMessage.select(threadId: threadId, accountId: account.id, model: ProcessInfo.processInfo.environment["RELEVO_TEST_MODEL"] ?? "haiku"))
        try? await Task.sleep(nanoseconds: 300_000_000)
        channel.send(ClientMessage.send(threadId: threadId, text: prompt))
        check(await wait(10) { thread?.runtime.isRunning == true || thread?.items.contains { $0.kind == .assistant } == true }, "turn started")

        var approved = Set<String>()
        let finished = await wait(180) {
            if let t = thread {
                for item in t.items where item.kind == .approval && item.resolution == nil && !approved.contains(item.id) {
                    approved.insert(item.id)
                    if let allow = item.options?.first(where: \.isAllow) {
                        print("  permiso: \(item.title ?? item.text) → \(allow.label)")
                        channel.send(ClientMessage.approve(threadId: threadId, itemId: item.id, optionId: allow.id))
                    }
                }
            }
            return thread?.runtime.isRunning == false && thread?.items.contains { $0.kind == .assistant || $0.kind == .error } == true
        }
        check(finished, "turn finished (\(patches) patches)")
        if let t = thread {
            for item in t.items {
                let text = item.kind == .tool ? "\(item.title ?? item.text) [\(item.toolState?.rawValue ?? "-")]" : item.text
                print("  \(item.kind.rawValue): \(text.prefix(300).replacingOccurrences(of: "\n", with: " ⏎ "))\(item.usage.map { " · \($0.tokens) tokens" } ?? "")")
            }
            check(t.items.contains { $0.kind == .assistant && !$0.text.isEmpty }, "assistant replied")
            check(!t.items.contains { $0.kind == .error }, "no errors in the thread")
        }
        check(snapshot?.threads.contains { $0.id == threadId && $0.title != "Nuevo hilo" } == true, "thread titled in the snapshot")
        check(decodeFailures == 0, "every message decoded")
        channel.cancel()
    }
}
