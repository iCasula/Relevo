import Foundation
import RelevoMarkdown
import AppKit
import SwiftUI
import Network
import CryptoKit
import RelevoProtocol

/// Headless checks against the real CLIs:
///   Relevo --selftest usage
///   Relevo --selftest agent <claude|codex|gemini|zai> <model> <cwd> <mode> <prompt>
///   Relevo --selftest relay <fromKind> <fromModel> <toKind> <toModel> <cwd> <prompt> <followUp>
@MainActor
enum SelfTest {
    static func runIfRequested() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--selftest"), i + 1 < args.count else { return }
        let rest = Array(args[(i + 1)...])
        var finished = false
        Task { @MainActor in
            await ShellEnvironment.load()
            switch rest[0] {
            case "usage": await usage(only: rest.count > 1 ? rest[1] : nil)
            case "agent" where rest.count >= 6: await agent(kind: rest[1], model: rest[2], cwd: rest[3], mode: rest[4], prompt: rest[5], effort: rest.count > 6 ? rest[6] : nil)
            case "relay" where rest.count >= 8: await relay(rest)
            case "handoff" where rest.count >= 6: await handoffAfterStop(rest)
            case "topic" where rest.count >= 4: await topic(rest)
            case "suggest" where rest.count >= 4: await suggest(rest)
            case "markdown" where rest.count >= 2: markdown(out: rest[1])
            case "queue" where rest.count >= 2: await queue(cwd: rest[1])
            case "interactive" where rest.count >= 2: await interactive(cwd: rest[1])
            case "revive" where rest.count >= 2: await revive(cwd: rest[1])
            case "images" where rest.count >= 2: images(threadTitle: rest[1])
            case "apns": await apns()
            case "serve": await serve(port: rest.count > 1 ? UInt16(rest[1]) ?? 47899 : 47899, seconds: rest.count > 2 ? Double(rest[2]) ?? 600 : 600)
            case "companion": await companion(port: rest.count > 1 ? UInt16(rest[1]) ?? 47899 : 47899)
            case "modeswitch" where rest.count >= 4: await modeSwitch(kind: rest[1], model: rest[2], cwd: rest[3], switchMode: rest.count < 5 || rest[4] != "noswitch")
            default: print("uso: --selftest usage | agent … | relay …")
            }
            finished = true
        }
        while !finished { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        exit(0)
    }

    private static func out(_ s: String) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }

    static func usage(only: String? = nil) async {
        for kind in ProviderKind.allCases where only == nil || kind.rawValue == only {
            let account = Account(kind: kind, name: kind.shortName)
            guard Binaries.launch(for: account) != nil else { out("[\(kind.rawValue)] CLI no encontrada"); continue }
            let start = Date()
            let probe = await UsageService.probe(account)
            let s = probe.status
            out("[\(kind.rawValue)] \(String(format: "%.1fs", Date().timeIntervalSince(start))) loggedIn=\(s.loggedIn.map(String.init) ?? "?") plan=\(s.plan ?? "-") email=\(s.email ?? "-") error=\(s.error ?? "-") note=\(s.note ?? "-")")
            for w in s.windows { out("    \(w.label): \(Int(w.percent))%  reset=\(w.resetsAt.map { "\($0)" } ?? "-") \(w.detail ?? "")") }
            if let m = probe.models { out("    modelos: " + m.map { "\($0.id)=\($0.name)" }.joined(separator: ", ")) }
        }
    }

    static func agent(kind: String, model: String, cwd: String, mode: String, prompt: String, effort: String? = nil) async {
        guard let k = ProviderRegistry.find(kind)?.kind else { out("tipo desconocido"); return }
        let account = Account(kind: k, name: k.shortName, configDir: ProcessInfo.processInfo.environment["RELEVO_TEST_CONFIG_DIR"])
        let session = AgentFactory.make(account: account, cwd: cwd, model: model == "-" ? "" : model, effort: effort, mode: PermissionMode(rawValue: mode) ?? .ask, resumeId: nil)
        var done = false
        session.onEvent = { event in
            switch event {
            case .sessionStarted(let id): out("SESSION \(id)")
            case .textDelta(_, let t): FileHandle.standardOutput.write(t.data(using: .utf8)!)
            case .textFinal(let k, let t): out("\nTEXT[\(k)] \(t.prefix(300))")
            case .reasoningDelta: break
            case .reasoningFinal(_, let t): out("\nREASONING \(t.prefix(120))")
            case .toolStarted(let k, let n, let title, _): out("\nTOOL+ [\(k.prefix(12))] \(n): \(title)")
            case .toolOutput(let k, let t): out("TOOL~ [\(k.prefix(12))] \(t.prefix(80))")
            case .toolFinished(let k, let st, let o): out("TOOL✓ [\(k.prefix(12))] \(st.rawValue) \((o ?? "").prefix(120).replacingOccurrences(of: "\n", with: " ⏎ "))")
            case .approval(let r):
                out("\nAPPROVAL \(r.title) | opciones: \(r.options.map(\.id)) → aprobando")
                r.respond(r.options.first(where: \.isAllow)?.id ?? r.options[0].id)
            case .usage(let w, let p): out("USAGE plan=\(p ?? "-") " + w.map { "\($0.label)=\(Int($0.percent))%" }.joined(separator: " "))
            case .models(let m): out("MODELS \(m.map(\.id))")
            case .plan(let steps): out("PLAN " + steps.map { "[\($0.status)] \($0.text)" }.joined(separator: " | "))
            case .status(let s): if let s { out("STATUS \(s)") }
            case .notice(let n): out("NOTICE \(n)")
            case .failure(let f): out("\nFAILURE \(f.kind) \(f.message.prefix(400))")
            case .turnFinished: out("\nTURN FINISHED"); done = true
            }
        }
        do { try session.start() } catch { out("START ERROR \(error.localizedDescription)"); return }
        session.send(prompt)
        let deadline = Date().addingTimeInterval(180)
        while !done && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
        if !done { out("TIMEOUT") }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        session.close()
    }

    /// Ranks every subscription/model for each prompt with the real state (accounts, limits, models, trace):
    ///   --selftest suggest <ai|local> <current kind:model | -> <prompt>…
    static func suggest(_ a: [String]) async {
        let store = AppStore.shared
        let project = store.projects.first ?? Project(name: "selftest", path: NSTemporaryDirectory())
        let catalog = ModelCatalog.shared
        for acc in store.enabledAccounts {
            let c = catalog.candidates(acc.kind, store.modelsFor(acc)).map { "\($0.model.name)=\(Int($0.power))" }
            out("[catálogo] \(acc.name): " + (c.isEmpty ? "(sin modelos con potencia)" : c.joined(separator: ", ")))
        }
        for prompt in a.dropFirst(3) {
            let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: nil, model: nil)
            if a[2] != "-", let colon = a[2].firstIndex(of: ":"),
               let acc = store.enabledAccounts.first(where: { $0.kind.rawValue == String(a[2][..<colon]) }) {
                let model = String(a[2][a[2].index(after: colon)...])
                thread.selectedAccountId = acc.id
                thread.selectedModel = model
                thread.segments = [Segment(accountId: acc.id, kind: acc.kind, model: model, startItem: 0)]
            }
            var profile = Advisor.heuristic(prompt)
            var source = "heurística"
            if a[1] == "ai" {
                let start = Date()
                if let p = await Advisor.classify(prompt, threadTitle: nil, store: store) {
                    profile = p
                    source = String(format: "IA %.1fs", Date().timeIntervalSince(start))
                } else {
                    source = "heurística (la IA no respondió)"
                }
            }
            out("\n» \(prompt.prefix(90))")
            out("  \(profile.level.rawValue) · \(profile.kind ?? "-") · \(source)")
            for o in Advisor.rank(profile, thread: thread, store: store).prefix(5) {
                out(String(format: "  %.3f  fit %.2f  cuota %.2f  aprendido %+.2f  fijo %.2f  ", o.score, o.fit, o.quota, o.learned, o.sticky)
                    + "\(o.account.name) · \(o.model.name)" + (o.effort.map { " · \($0)" } ?? ""))
            }
            if let s = Advisor.suggest(profile, thread: thread, store: store), let acc = store.account(s.accountId) {
                out("  ⇒ Sugerido: \(acc.name) · \(store.modelName(acc, s.model))" + (s.effort.map { " · \(EffortLabel.name($0))" } ?? ""))
                out("    " + s.reasons.joined(separator: " · "))
            } else {
                out("  ⇒ Sin sugerencia (la selección actual ya encaja)")
            }
        }
    }

    /// Starts in "ask", switches to full access mid-session, then runs a shell command: it must not ask for permission.
    ///   --selftest modeswitch <kind> <model> <cwd> [noswitch]   (noswitch = control run that stays in "ask")
    static func modeSwitch(kind: String, model: String, cwd: String, switchMode: Bool = true) async {
        guard let k = ProviderRegistry.find(kind)?.kind else { out("tipo desconocido"); return }
        let account = Account(kind: k, name: k.shortName, configDir: ProcessInfo.processInfo.environment["RELEVO_TEST_CONFIG_DIR"])
        let session = AgentFactory.make(account: account, cwd: cwd, model: model, effort: nil, mode: .ask, resumeId: nil)
        var done = false
        var approvals: [String] = []
        session.onEvent = { event in
            switch event {
            case .approval(let r):
                approvals.append(r.title)
                out("APPROVAL \(r.title)")
                r.respond(r.options.first(where: \.isAllow)?.id ?? r.options[0].id)
            case .toolFinished(_, let st, let o): out("TOOL \(st.rawValue) \((o ?? "").prefix(80).replacingOccurrences(of: "\n", with: " "))")
            case .notice(let n): out("NOTICE \(n)")
            case .failure(let f): out("FAILURE \(f.kind) \(f.message.prefix(200))")
            case .turnFinished: done = true
            default: break
            }
        }
        func turn(_ text: String) async {
            done = false
            session.send(text)
            let deadline = Date().addingTimeInterval(120)
            while !done && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
        do { try session.start() } catch { out("START ERROR \(error.localizedDescription)"); return }
        await turn("Responde solo con la palabra: listo")
        out(switchMode ? "== cambio a Acceso total a mitad de sesión ==" : "== control: sigue en Pedir permiso ==")
        if switchMode { session.setMode(.full) }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let before = approvals.count
        await turn("Usa la herramienta Bash para ejecutar exactamente: touch relevo-mode-probe.txt && echo hecho. Después responde 'ok'.")
        let created = FileManager.default.fileExists(atPath: "\(cwd)/relevo-mode-probe.txt")
        out("RESULTADO: peticiones de permiso tras el cambio = \(approvals.count - before) · fichero creado = \(created)")
        try? FileManager.default.removeItem(atPath: "\(cwd)/relevo-mode-probe.txt")
        session.close()
    }

    /// Renders sample Markdown (tables, lists, code…) to a PNG with the shared renderer, without opening a window:
    ///   --selftest markdown <out.png>
    static func markdown(out path: String) {
        // A real (off-screen) window, so scroll views and controls draw exactly as in the app.
        // With RELEVO_MD_THREAD=<title>, renders that thread's first reply with images, strip included.
        var text = MarkdownSample.text
        var images: [String] = []
        if let title = ProcessInfo.processInfo.environment["RELEVO_MD_THREAD"],
           let t = AppStore.shared.threads.first(where: { $0.title.hasPrefix(title) }),
           let item = t.items.first(where: { $0.kind == .assistant && !FileReference.imageReferences(in: $0.text).isEmpty }) {
            text = String(item.text.prefix(900))
            images = FileReference.imageReferences(in: item.text)
        }
        let view = VStack(alignment: .leading, spacing: 8) {
            MarkdownView(text)
            if !images.isEmpty {
                ImageStrip(paths: images, load: { path in ThumbnailMaker.image(url: URL(fileURLWithPath: path), maxPixel: 400) }, open: { _ in })
            }
        }
            .frame(width: 720)
            .padding(24)
            .background(Color.white)
            .environment(\.colorScheme, .light)
        let hosting = NSHostingView(rootView: view)
        let size = hosting.fittingSize
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = hosting
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(images.isEmpty ? 1 : 3))
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { out("no se pudo renderizar"); return }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        window.orderOut(nil)
        out("PNG \(path) \(Int(size.width))×\(Int(size.height))")
    }

    /// The agent's CLI dies between turns (as after a Claude Code internal error); the next message must
    /// reopen it resuming the conversation instead of hanging:  --selftest revive <cwd>
    static func revive(cwd: String) async {
        let store = AppStore.shared
        let account = Account(kind: .claude, name: "Claude test", configDir: ProcessInfo.processInfo.environment["RELEVO_TEST_CONFIG_DIR"])
        store.accounts = [account]
        let project = Project(name: "revive-test", path: cwd)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: account.id, model: "haiku")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        func waitIdle(_ seconds: Double) async -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            try? await Task.sleep(nanoseconds: 600_000_000)
            while rt.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 200_000_000) }
            return !rt.isRunning
        }
        rt.send("Recuerda la palabra clave: albaricoque. Responde solo: vale")
        _ = await waitIdle(90)
        out("1ª respuesta: \(thread.items.last { $0.kind == .assistant }?.text.prefix(40) ?? "-")")
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kill.arguments = ["-TERM", "-P", String(getpid())]
        try? kill.run()
        kill.waitUntilExit()
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        out("== CLI de Claude matada entre turnos ==")
        rt.send("¿Cuál era la palabra clave? Responde solo con ella")
        let finished = await waitIdle(90)
        out("terminó=\(finished) · avisos=\(thread.items.filter { $0.kind == .notice }.map(\.text)) · 2ª respuesta: \(thread.items.last { $0.kind == .assistant }?.text.prefix(40) ?? "-")")
        rt.closeSession()
    }

    /// AskUserQuestion answered through the runtime, and "send now" redirecting a running agent:
    ///   --selftest interactive <cwd>
    static func interactive(cwd: String) async {
        let store = AppStore.shared
        let account = Account(kind: .claude, name: "Claude test", configDir: ProcessInfo.processInfo.environment["RELEVO_TEST_CONFIG_DIR"])
        store.accounts = [account]
        let project = Project(name: "interactive-test", path: cwd)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: account.id, model: "haiku")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        func waitIdle(_ seconds: Double) async {
            let deadline = Date().addingTimeInterval(seconds)
            try? await Task.sleep(nanoseconds: 600_000_000)
            while rt.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 200_000_000) }
        }
        out("== 1: AskUserQuestion ==")
        rt.send("Usa la herramienta AskUserQuestion para preguntarme qué color prefiero (opciones Rojo y Azul). Después responde solo: elegiste <color>.")
        let deadline = Date().addingTimeInterval(90)
        var question: ChatItem?
        while question == nil && Date() < deadline {
            question = thread.items.last { $0.kind == .approval && $0.questions != nil && $0.resolution == nil }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard let q = question, let first = q.questions?.first else { out("no llegó la pregunta"); rt.closeSession(); return }
        out("pregunta: «\(first.question)» opciones=\(first.options.map(\.label)) multiple=\(first.multiSelect)")
        rt.answerQuestions(itemId: q.id, answers: [first.question: "Azul"])
        await waitIdle(90)
        out("respuesta del agente: \(thread.items.last { $0.kind == .assistant }?.text.prefix(60) ?? "-")")

        out("== 2: Enviar ya ==")
        rt.send("Escribe los números del 1 al 400 separados por comas, sin nada más")
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        rt.sendNow("Olvida lo anterior y responde solo con la palabra: redirigido")
        await waitIdle(90)
        try? await Task.sleep(nanoseconds: 800_000_000)
        await waitIdle(90)
        out("avisos: \(thread.items.filter { $0.kind == .notice }.map(\.text)) · errores: \(thread.items.filter { $0.kind == .error }.count)")
        out("última respuesta: \(thread.items.last { $0.kind == .assistant }?.text.prefix(40) ?? "-")")
        rt.closeSession()
    }

    /// Message queue against a real agent (Claude Haiku):
    ///   --selftest queue <cwd>   (RELEVO_TEST_CONFIG_DIR = Claude config folder)
    static func queue(cwd: String) async {
        let store = AppStore.shared
        let account = Account(kind: .claude, name: "Claude test", configDir: ProcessInfo.processInfo.environment["RELEVO_TEST_CONFIG_DIR"])
        store.accounts = [account]
        let project = Project(name: "queue-test", path: cwd)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: account.id, model: "haiku")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        func waitIdle(_ seconds: Double) async {
            let deadline = Date().addingTimeInterval(seconds)
            try? await Task.sleep(nanoseconds: 600_000_000)
            while (rt.isRunning || (!rt.queue.isEmpty && !rt.queuePaused)) && Date() < deadline {
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
        out("== A: un mensaje y dos en cola ==")
        rt.send("Responde solo con la palabra: uno")
        try? await Task.sleep(nanoseconds: 300_000_000)
        rt.send("Responde solo con la palabra: dos")
        rt.send("Responde solo con la palabra: tres")
        out("en cola tras enviar: \(rt.queue.map(\.text))")
        await waitIdle(150)
        out("orden: " + thread.items.filter { $0.kind == .user || $0.kind == .assistant }
            .map { "\($0.kind == .user ? "→" : "←") \($0.text.prefix(40))" }.joined(separator: " | "))

        out("== B: detener con un mensaje en cola ==")
        rt.send("Escribe los números del 1 al 300 separados por comas, sin nada más")
        try? await Task.sleep(nanoseconds: 300_000_000)
        rt.send("Responde solo con la palabra: cuatro")
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        rt.stop()
        let stopDeadline = Date().addingTimeInterval(12)
        while rt.isRunning && Date() < stopDeadline { try? await Task.sleep(nanoseconds: 200_000_000) }
        try? await Task.sleep(nanoseconds: 800_000_000)
        out("tras detener: pausada=\(rt.queuePaused) cola=\(rt.queue.map(\.text)) · últimos: \(thread.items.suffix(3).map { "\($0.kind.rawValue): \($0.text.prefix(30))" })")
        rt.resumeQueue()
        await waitIdle(90)
        out("tras reanudar: pausada=\(rt.queuePaused) cola=\(rt.queue.count) última respuesta=\(thread.items.last { $0.kind == .assistant }?.text.prefix(40) ?? "-")")
        rt.closeSession()
    }

    /// Images and paths a thread mentions: what resolves, and that unmentioned files are refused.
    ///   --selftest images <thread title prefix>
    static func images(threadTitle: String) {
        let store = AppStore.shared
        guard let t = store.threads.first(where: { $0.title.hasPrefix(threadTitle) }) else { out("hilo no encontrado"); return }
        let project = store.project(t.projectId)?.path
        out("hilo «\(t.title)» · proyecto \(project.map(abbreviateHome) ?? "-")")
        var refs: [String] = []
        for item in t.items where item.kind == .assistant { for r in FileReference.imageReferences(in: item.text) where !refs.contains(r) { refs.append(r) } }
        for r in refs.prefix(5) {
            let url = FilePaths.resolve(r, thread: t, projectPath: project)
            let jpeg = url.flatMap { FilePaths.jpeg($0, maxPixel: 480) }
            out("  imagen \((r as NSString).lastPathComponent): mencionada=\(FilePaths.isMentioned(r, in: t)) resuelta=\(url != nil) jpeg480=\(jpeg?.count ?? 0) bytes")
        }
        // Code-span paths in replies, resolved relative to the project or folders seen in the thread.
        var paths: [String] = []
        for item in t.items where item.kind == .assistant {
            var a = MarkdownInline.attributed(item.text)
            for run in a.runs { if let link = run.link, let p = FileReference.path(from: link), !paths.contains(p) { paths.append(p) } }
            _ = a.characters.count; a = AttributedString()
        }
        let resolved = paths.filter { FilePaths.resolve($0, thread: t, projectPath: project) != nil }
        out("  rutas enlazadas: \(paths.count) · resuelven: \(resolved.count) · ej. \(resolved.prefix(4))")
        let secret = "\(NSHomeDirectory())/.ssh/id_ed25519"
        out("  fichero no mencionado (\(abbreviateHome(secret))): mencionado=\(FilePaths.isMentioned(secret, in: t)) → el iPhone no puede pedirlo")
    }

    /// Checks the APNs provider token (JWT ES256) with a throwaway key and that APNs answers the request:
    ///   --selftest apns   (expected answer: 403 InvalidProviderToken, since the key isn't registered with Apple)
    static func apns() async {
        let key = P256.Signing.PrivateKey()
        guard let jwt = LiveActivityPusher.makeJWT(teamId: "ABCDE12345", keyId: "KEY1234567", key: key) else { out("JWT: fallo"); return }
        let parts = jwt.split(separator: ".").map(String.init)
        func data(_ s: String) -> Data? {
            var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            while b.count % 4 != 0 { b += "=" }
            return Data(base64Encoded: b)
        }
        let header = data(parts[0]).flatMap { String(data: $0, encoding: .utf8) } ?? "?"
        let claims = data(parts[1]).flatMap { String(data: $0, encoding: .utf8) } ?? "?"
        let valid = data(parts[2]).flatMap { try? P256.Signing.ECDSASignature(rawRepresentation: $0) }
            .map { key.publicKey.isValidSignature($0, for: Data((parts[0] + "." + parts[1]).utf8)) } ?? false
        out("JWT header=\(header) claims=\(claims) firma válida=\(valid)")
        var request = URLRequest(url: URL(string: "https://api.sandbox.push.apple.com/3/device/" + String(repeating: "ab", count: 32))!)
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"aps":{"timestamp":0,"event":"update","content-state":{}}}"#.utf8)
        request.setValue("bearer \(jwt)", forHTTPHeaderField: "authorization")
        request.setValue("liveactivity", forHTTPHeaderField: "apns-push-type")
        request.setValue("app.relevo.companion.push-type.liveactivity", forHTTPHeaderField: "apns-topic")
        let result = await LiveActivityPusher.post(request)
        out("APNs sandbox → \(result.status) \(result.reason ?? "-")")
    }

    /// Runs only the companion server (test credentials in memory) so a simulator can connect:
    ///   --selftest serve [port] [seconds]
    static func serve(port: UInt16, seconds: Double) async {
        CompanionCredentials.testOverride = ("relevo-sim", Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
        let store = AppStore.shared
        store.settings.companionEnabled = true
        store.settings.companionPort = Int(port)
        CompanionServer.shared.attach(store)
        for _ in 0..<50 where !CompanionServer.shared.isListening { try? await Task.sleep(nanoseconds: 100_000_000) }
        out("LISTENING \(CompanionServer.shared.port.map(String.init) ?? "-")")
        if let url = CompanionServer.shared.pairing?.url { out("PAIR \(url.absoluteString)") }
        let end = Date().addingTimeInterval(seconds)
        var lastDevices: [String] = []
        while Date() < end {
            let devices = CompanionServer.shared.devices.map(\.name)
            if devices != lastDevices { out("DEVICES \(devices)"); lastDevices = devices }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    /// Starts the companion server on the current data and connects to it like the iPhone would (Bonjour + TLS-PSK):
    ///   --selftest companion [port]
    static func companion(port: UInt16) async {
        CompanionCredentials.testOverride = ("relevo-selftest", Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
        let store = AppStore.shared
        store.settings.companionEnabled = true
        store.settings.companionPort = Int(port)
        CompanionServer.shared.attach(store)
        let server = CompanionServer.shared
        for _ in 0..<50 where !server.isListening { try? await Task.sleep(nanoseconds: 100_000_000) }
        out("SERVER listening=\(server.isListening) port=\(server.port.map(String.init) ?? "-") error=\(server.lastError ?? "-")")
        guard let pairing = server.pairing else { out("sin pairing"); return }
        out("PAIRING \(pairing.url.absoluteString.prefix(60))…")
        guard let parsed = PairingInfo(url: pairing.url), parsed.secret == pairing.secret else { out("PAIRING URL no se puede leer"); return }

        for (label, secret) in [("clave correcta", parsed.secret), ("clave incorrecta", Data(repeating: 7, count: 32))] {
            let endpoint = NWEndpoint.service(name: parsed.serverId, type: CompanionTransport.serviceType, domain: "local.", interface: nil)
            let channel = MessageChannel(connection: NWConnection(to: endpoint, using: CompanionTransport.parameters(secret: secret, identity: parsed.serverId)))
            var got: [String] = []
            var threadItems: Int?
            var ready = false
            var failed: String?
            channel.onStateChange = { state in
                switch state {
                case .ready: ready = true
                case .failed(let e): failed = "\(e)"
                case .waiting(let e): failed = "waiting: \(e)"
                default: break
                }
            }
            channel.onMessage = { data in
                guard let m = try? CompanionCoding.decode(ServerMessage.self, from: data) else { got.append("??"); return }
                switch m {
                case .welcome(let name, let v): got.append("welcome(\(name), v\(v))")
                case .snapshot(let s):
                    got.append("snapshot(\(s.accounts.count) cuentas, \(s.projects.count) proyectos, \(s.threads.count) hilos)")
                    if let first = s.threads.first, threadItems == nil {
                        threadItems = -1
                        channel.send(ClientMessage.subscribe(threadId: first.id))
                    }
                case .thread(let t):
                    threadItems = t.items.count
                    got.append("thread(«\(t.title)», \(t.items.count) elementos, modo \(t.runtime.mode.rawValue), candidatos \(t.runtime.relayCandidates.count))")
                    // Live update path: a command from the phone changes the Mac, which sends back only a patch.
                    let next: RemoteMode = t.runtime.mode == .plan ? .ask : .plan
                    channel.send(ClientMessage.setMode(threadId: t.id, mode: next))
                case .threadPatch(let p): got.append("patch(\(p.upserts.count) elementos, modo \(p.runtime.mode.rawValue))")
                case .activity(let a): got.append("activity(\(a.phase.rawValue))")
                case .image(_, let data, let error): got.append("image(\(data?.count ?? 0) bytes, \(error ?? "-"))")
                case .created: got.append("created")
                case .toast(let t): got.append("toast(\(t))")
                }
            }
            channel.start()
            let deadline = Date().addingTimeInterval(10)
            while !ready && failed == nil && Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
            if ready { channel.send(ClientMessage.hello(device: "Selftest", version: CompanionCoding.version)) }
            let end = Date().addingTimeInterval(4)
            while Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
            out("[\(label)] ready=\(ready) fallo=\(failed ?? "-") mensajes=\(got.isEmpty ? "ninguno" : got.joined(separator: " · ")) dispositivos=\(server.devices.map(\.name))")
            channel.cancel()
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    /// --selftest topic <kind> <configDir|-> <mensaje1> [mensaje2]
    static func topic(_ a: [String]) async {
        guard let kind = ProviderRegistry.find(a[1])?.kind else { return }
        let account = Account(kind: kind, name: kind.shortName, configDir: a[2] == "-" ? nil : a[2])
        var messages: [String] = []
        for msg in a.dropFirst(3) {
            messages.append(msg)
            let prompt = "Mensajes del usuario, en orden:\n" + messages.map { "- " + $0 }.joined(separator: "\n")
            let start = Date()
            let raw = await kind.provider.quickCompletion(account: account, system: TopicNamer.system, prompt: prompt)
            out("[\(String(format: "%.1fs", Date().timeIntervalSince(start)))] \(messages.count) msg → raw=\(raw.map { "\"\($0)\"" } ?? "nil") → título=\(raw.flatMap(TopicNamer.clean) ?? "(esperar)")")
        }
    }

    /// Simulates an agent stopping mid-plan (as when it runs out of quota), then hands off:
    ///   --selftest handoff <fromKind> <fromModel> <toKind> <toModel> <cwd> [stopAfterFile]
    static func handoffAfterStop(_ a: [String]) async {
        guard let fromKind = ProviderRegistry.find(a[1])?.kind, let toKind = ProviderRegistry.find(a[3])?.kind else { return }
        let cwd = a[5]
        let stopFile = a.count > 6 ? a[6] : "paso1.txt"
        let store = AppStore.shared
        let from = Account(kind: fromKind, name: "Origen \(fromKind.shortName)")
        let to = Account(kind: toKind, name: "Destino \(toKind.shortName)")
        store.accounts = [from, to]
        let project = Project(name: "handoff-test", path: cwd)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .full, accountId: from.id, model: a[2])
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        for f in ["paso1.txt", "paso2.txt", "paso3.txt"] { try? FileManager.default.removeItem(atPath: "\(cwd)/\(f)") }
        let task = [
            "Tarea en 3 pasos. Primero registra el plan con tu herramienta de tareas/todos (3 tareas).",
            "Luego hazlas una a una, marcando cada tarea como completada al terminarla:",
            "1) crea paso1.txt con el texto 'uno' (comando: echo uno > paso1.txt)",
            "2) ejecuta 'sleep 25' y después crea paso2.txt con 'dos'",
            "3) crea paso3.txt con 'tres'",
            "Al final responde 'terminado'.",
        ].joined(separator: "\n")
        rt.send(task)
        let deadline = Date().addingTimeInterval(150)
        while !FileManager.default.fileExists(atPath: "\(cwd)/\(stopFile)") && Date() < deadline {
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        out("== Parando a \(fromKind.rawValue) tras crear \(stopFile) (simula quedarse sin cuota) ==")
        rt.stop()
        let stopDeadline = Date().addingTimeInterval(10)
        while rt.isRunning && Date() < stopDeadline { try? await Task.sleep(nanoseconds: 200_000_000) }
        try? await Task.sleep(nanoseconds: 500_000_000)
        out("== Estado de trabajo que verá el siguiente agente ==")
        let git = await GitSnapshot.capture(cwd)
        out(WorkState.markdown(thread: thread, project: project, store: store, git: git))
        out("== Relevo a \(toKind.rawValue) ==")
        rt.relay(to: to, model: a[4])
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        let relayDeadline = Date().addingTimeInterval(200)
        while rt.isRunning && Date() < relayDeadline { try? await Task.sleep(nanoseconds: 200_000_000) }
        for item in thread.items.suffix(12) {
            let who = store.account(item.accountId)?.kind.rawValue ?? "-"
            out("[\(item.kind.rawValue)/\(who)] \((item.title.map { $0 + " · " } ?? ""))\(item.text.prefix(200).replacingOccurrences(of: "\n", with: " ⏎ "))")
        }
        for f in ["paso1.txt", "paso2.txt", "paso3.txt"] {
            let c = (try? String(contentsOfFile: "\(cwd)/\(f)", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "(no existe)"
            out("\(f): \(c)")
        }
        out("FTS5: \(store.trace.hasFTS)")
        rt.closeSession()
    }

    /// End-to-end handoff through ThreadRuntime: talk to one provider, then switch and ask a follow-up.
    static func relay(_ a: [String]) async {
        guard let fromKind = ProviderRegistry.find(a[1])?.kind, let toKind = ProviderRegistry.find(a[3])?.kind else { return }
        let store = AppStore.shared
        let from = Account(kind: fromKind, name: "Origen \(fromKind.shortName)")
        let to = Account(kind: toKind, name: "Destino \(toKind.shortName)")
        store.accounts = [from, to]
        let project = Project(name: "selftest", path: a[5])
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .autoEdit, accountId: from.id, model: a[2])
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        func wait() async {
            let deadline = Date().addingTimeInterval(180)
            try? await Task.sleep(nanoseconds: 300_000_000)
            while rt.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
        rt.send(a[6])
        await wait()
        thread.selectedAccountId = to.id
        thread.selectedModel = a[4]
        rt.send(a[7])
        await wait()
        for item in thread.items {
            let who = store.account(item.accountId)?.kind.rawValue ?? "-"
            out("[\(item.kind.rawValue)/\(who)] \((item.title.map { $0 + " · " } ?? ""))\(item.text.prefix(400).replacingOccurrences(of: "\n", with: " ⏎ "))")
        }
        out("SEGMENTS " + thread.segments.map { "\($0.kind.rawValue):\($0.model):\($0.nativeSessionId ?? "-")" }.joined(separator: " | "))
        rt.closeSession()
    }
}
