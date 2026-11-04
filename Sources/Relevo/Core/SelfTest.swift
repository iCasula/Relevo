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
            case "tokens" where rest.count >= 2: await tokens(cwd: rest[1])
            case "usagereport": await usageReport()
            case "usageui" where rest.count >= 2: await usageUI(out: rest[1])
            case "workspace" where rest.count >= 2: await workspace(dir: rest[1])
            case "mcp": await mcp()
            case "mcpserve" where rest.count >= 2: await mcpServe(seconds: Double(rest[1]) ?? 120, full: rest.count > 2 && rest[2] == "full")
            case "prwatch": prWatch()
            case "followscroll": await followScroll()
            case "background" where rest.count >= 2: await background(cwd: rest[1])
            case "limitplan" where rest.count >= 2: await limitPlan(cwd: rest[1])
            case "commitmsg" where rest.count >= 2: await commitMessage(dir: rest[1])
            case "turnchanges" where rest.count >= 2: await turnChanges(dir: rest[1])
            case "workspaceui" where rest.count >= 3: await workspaceUI(dir: rest[1], out: rest[2])
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
            case .tokens(let parts):
                out("TOKENS " + parts.map { "\($0.model ?? "-"): in=\($0.input) read=\($0.cacheRead) write=\($0.cacheWrite) out=\($0.output) think=\($0.reasoning) cost=\($0.costUSD.map { String(format: "%.5f", $0) } ?? "-")" }.joined(separator: " | "))
            case .context(let used, let window): out("CONTEXT \(used)/\(window.map(String.init) ?? "?")")
            case .models(let m): out("MODELS \(m.map(\.id))")
            case .plan(let steps): out("PLAN " + steps.map { "[\($0.status)] \($0.text)" }.joined(separator: " | "))
            case .status(let s): if let s { out("STATUS \(s)") }
            case .notice(let n): out("NOTICE \(n)")
            case .failure(let f): out("\nFAILURE \(f.kind) \(f.message.prefix(400))")
            case .turnFinished: out("\nTURN FINISHED"); done = true
            case .backgroundTasks(let tasks): out("BACKGROUND \(tasks.map(\.description))")
            case .turnStarted(let reason): out("TURN STARTED BY THE AGENT \(reason ?? "")")
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

        // The redirected turn outlives the stop's 6 s fallback: it must not be killed by it.
        out("== 3: Enviar ya con un turno redirigido largo ==")
        rt.setMode(.full)
        rt.send("Ejecuta con Bash `sleep 30` y después responde solo: dormido")
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        let noticesBefore = thread.items.filter { $0.kind == .notice }.count
        rt.sendNow("Olvida lo anterior. Ejecuta con Bash `sleep 10; echo listo` y después responde solo con la palabra: despierto")
        await waitIdle(120)
        try? await Task.sleep(nanoseconds: 800_000_000)
        await waitIdle(120)
        let newNotices = thread.items.filter { $0.kind == .notice }.dropFirst(noticesBefore).map(\.text)
        out("avisos nuevos: \(newNotices) · errores: \(thread.items.filter { $0.kind == .error }.count)")
        out("última respuesta: \(thread.items.last { $0.kind == .assistant }?.text.prefix(40) ?? "-") · sesión viva: \(newNotices.filter { $0.hasPrefix("Detenido") }.count == 1)")
        rt.closeSession()
    }

    /// Token metering against a real agent: two Haiku turns, then a switch to Sonnet in the same session.
    ///   --selftest tokens <cwd>   (RELEVO_TEST_CONFIG_DIR = Claude config folder)
    static func tokens(cwd: String) async {
        let store = AppStore.shared
        let account = Account(kind: .claude, name: "Claude test", configDir: ProcessInfo.processInfo.environment["RELEVO_TEST_CONFIG_DIR"])
        store.accounts = [account]
        let project = Project(name: "tokens-test", path: cwd)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: account.id, model: "haiku")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        func waitIdle() async {
            let deadline = Date().addingTimeInterval(120)
            try? await Task.sleep(nanoseconds: 600_000_000)
            while rt.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 200_000_000) }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        for (model, text) in [("haiku", "Responde solo: uno"), ("haiku", "Responde solo: dos"), ("sonnet", "Responde solo: tres")] {
            thread.selectedModel = model
            rt.send(text)
            await waitIdle()
        }
        for item in thread.items {
            if let u = item.usage {
                let t = u.tokens
                out("\(item.kind.rawValue) «\(item.text.prefix(20))» in=\(t.input) read=\(t.cacheRead) write=\(t.cacheWrite) out=\(t.output) "
                    + "coste=\(u.cost.map { String(format: "%.5f", $0) } ?? "-") estimado=\(u.costEstimated) contexto=\(u.context ?? 0)/\(u.contextWindow ?? 0) "
                    + "cambio=\(u.switchKind?.rawValue ?? "-") \(u.switchDetail ?? "") sobrecoste=\(u.overhead ?? 0) (\(u.overheadCost.map { String(format: "%.5f", $0) } ?? "-"))")
            } else if item.kind == .notice {
                out("aviso: \(item.text)")
            }
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
        let report = UsageAnalytics.report(.today, store: store)
        out("informe: turnos=\(report.turns) tokens=\(report.tokens.total) coste=\(String(format: "%.5f", report.cost)) cambios=\(report.switches.count) sobrecoste=\(report.switchOverhead)")
        for m in report.models { out("  modelo \(m.name): turnos=\(m.turns) tokens=\(m.tokens.total) coste=\(String(format: "%.5f", m.cost))") }
        rt.closeSession()
    }

    /// Imports the Claude transcripts and prints the usage report of the data folder (use a copy of the real one):
    ///   --selftest usagereport   (RELEVO_DATA_DIR = copy of ~/Library/Application Support/Relevo)
    static func usageReport() async {
        let store = AppStore.shared
        let started = Date()
        await UsageImporter.run(store: store)
        out("importado en \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
        for period in UsagePeriod.allCases {
            let r = UsageAnalytics.report(period, store: store)
            out("== \(period.label): turnos=\(r.turns) tokens=\(TokenFormat.short(r.tokens.total)) (caché \(r.tokens.cacheShare.map(TokenFormat.percent) ?? "-")) coste≈\(TokenFormat.usd(r.cost)) días=\(Set(r.days.map(\.day)).count) celdas=\(r.hours.count)")
            guard period == .all else { continue }
            for m in r.models.prefix(8) {
                out("  \(UsageAnalytics.providerName(m.provider)) · \(m.name): \(m.turns) turnos, \(TokenFormat.short(m.tokens.total)) tokens, \(TokenFormat.usd(m.cost)), ok \(m.okRate.map(TokenFormat.percent) ?? "-")")
            }
            out("  cambios: \(r.switches.count) · \(TokenFormat.short(r.switchOverhead)) tokens sin caché · \(TokenFormat.usd(r.switchCost))")
            for s in r.switchSummary { out("    \(s.kind.label): \(s.count) · \(TokenFormat.short(s.overhead)) · \(TokenFormat.usd(s.cost))") }
            for sw in r.switches.prefix(5) { out("    · \(sw.switchDetail ?? "") +\(TokenFormat.short(sw.overhead ?? 0)) \(TokenFormat.usd(sw.overheadCost ?? 0)) «\((sw.request ?? "").prefix(50))»") }
            for d in r.downgrades.prefix(6) {
                out("  más barato: \(d.fromName) → \(d.toName): \(d.turns.count) turnos, \(TokenFormat.usd(d.actualCost)) → \(TokenFormat.usd(d.cheaperCost)) (ahorro \(TokenFormat.percent(d.share)), cambio \(TokenFormat.usd(d.switchCost))) tipos=\(d.kinds)")
                for t in d.turns.prefix(3) { out("      «\((t.request ?? "").replacingOccurrences(of: "\n", with: " ").prefix(70))» herramientas=\(t.tools) salida=\(t.tokens.output)") }
            }
        }
    }

    /// Renders the usage window and a reply footer off-screen, light and dark:  --selftest usageui <png prefix>
    ///   (RELEVO_DATA_DIR = copy of the data folder; RELEVO_USAGE_PERIOD = today|week|month|all)
    static func usageUI(out prefix: String) async {
        let store = AppStore.shared
        await UsageImporter.run(store: store)
        if let p = ProcessInfo.processInfo.environment["RELEVO_USAGE_PERIOD"] { UserDefaults.standard.set(p, forKey: "usagePeriod") }
        let sample = TurnUsage(parts: [TokenUsage(model: "claude-sonnet-5-5", input: 4, cacheRead: 10_562, cacheWrite: 41_305, output: 812, reasoning: 120)],
                               cost: 0.1724, switchKind: .model, switchDetail: "Opus 5.5 → Sonnet 5.5", overhead: 38_400, overheadCost: 0.146,
                               context: 52_683, contextWindow: 1_000_000, durationMs: 14_200, tools: 3)
        for scheme in [ColorScheme.light, .dark] {
            let name = scheme == .light ? "light" : "dark"
            await render(UsageView(scrolls: false).environment(store).frame(width: 1040), scheme: scheme, to: "\(prefix)-window-\(name).png", wait: 2)
            await render(VStack(alignment: .leading, spacing: 12) {
                Text("Ejemplo de respuesta del agente.").font(.body)
                TurnUsageFooter(usage: sample)
                TurnUsageDetail(usage: sample)
            }.environment(store).padding(20).frame(width: 360), scheme: scheme, to: "\(prefix)-footer-\(name).png", wait: 0.6)
        }
    }

    private static func render<V: View>(_ view: V, scheme: ColorScheme, to path: String, wait: Double) async {
        let root = view.environment(\.colorScheme, scheme).background(scheme == .dark ? Color(white: 0.12) : Color.white)
        let hosting = NSHostingView(rootView: root)
        hosting.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1000, height: 1000), styleMask: .borderless, backing: .buffered, defer: false)
        window.appearance = hosting.appearance
        window.contentView = hosting
        window.orderFrontRegardless()
        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        let size = hosting.fittingSize
        window.setContentSize(size)
        hosting.frame = NSRect(origin: .zero, size: size)
        try? await Task.sleep(nanoseconds: 500_000_000)
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { out("no se pudo renderizar"); return }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        window.orderOut(nil)
        out("PNG \(path) \(Int(size.width))×\(Int(size.height))")
    }

    /// Worktrees, per-turn snapshots, diff, restore and commit on a scratch repository (no agent):
    ///   --selftest workspace <empty dir>
    static func workspace(dir: String) async {
        let store = AppStore.shared
        let repo = (dir as NSString).appendingPathComponent("repo")
        try? FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        func sh(_ args: [String]) async -> String { await Git.run(repo, args).out.trimmingCharacters(in: .whitespacesAndNewlines) }
        _ = await sh(["init", "-q", "-b", "main"])
        _ = await sh(["config", "user.email", "test@example.com"])
        _ = await sh(["config", "user.name", "Test"])
        try? "uno\ndos\n".write(toFile: repo + "/a.txt", atomically: true, encoding: .utf8)
        _ = await sh(["add", "-A"])
        _ = await sh(["commit", "-q", "-m", "Initial commit"])
        let project = Project(name: "ws-test", path: repo)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: nil, model: nil)
        store.threads = [thread]
        do {
            let info = try await Worktrees.create(for: thread, project: project, store: store)
            out("worktree: \(info.branch) en \(info.path) desde \(info.baseBranch ?? "-") \(info.baseCommit.prefix(7))")
            let wt = info.path
            guard let before = await Git.snapshot(wt, ref: "refs/relevo/test/before", message: "before") else { out("sin snapshot"); return }
            try? "uno\nDOS\ntres\n".write(toFile: wt + "/a.txt", atomically: true, encoding: .utf8)
            try? "nuevo\n".write(toFile: wt + "/b.txt", atomically: true, encoding: .utf8)
            guard let after = await Git.snapshot(wt, ref: "refs/relevo/test/after", message: "after") else { out("sin snapshot after"); return }
            let stat = await Git.diffStat(wt, from: before, to: after)
            out("cambios del turno: \(stat.files) ficheros +\(stat.added) −\(stat.removed)")
            let files = DiffParser.parse(await Git.diff(wt, from: before, to: after))
            out("diff: " + files.map { "\($0.change.rawValue) \($0.path) +\($0.added) −\($0.removed)" }.joined(separator: " · "))
            let status = await Git.run(wt, ["status", "--porcelain"]).out
            out("índice intacto: \(!status.contains("A ") && status.contains("??"))")
            try await Git.restore(wt, to: before)
            let a = (try? String(contentsOfFile: wt + "/a.txt", encoding: .utf8)) ?? "?"
            out("tras restaurar: a.txt=\(a.replacingOccurrences(of: "\n", with: "|")) b.txt existe=\(FileManager.default.fileExists(atPath: wt + "/b.txt"))")
            try await Git.restore(wt, to: after)
            out("deshacer: b.txt existe=\(FileManager.default.fileExists(atPath: wt + "/b.txt"))")
            try await Git.commitAll(wt, message: Git.strippingAgentAttribution("Update a and add b\n\nCo-Authored-By: Claude <noreply@anthropic.com>"))
            out("commit: \(await Git.run(wt, ["log", "-1", "--format=%s|%b"]).out.trimmingCharacters(in: .whitespacesAndNewlines))")
            let merged = try await Worktrees.merge(thread, store: store)
            out("fusionado en main: \(merged.split(separator: "\n").first ?? "") · main tiene b.txt=\(FileManager.default.fileExists(atPath: repo + "/b.txt"))")
            try await Worktrees.remove(thread, store: store, deleteBranch: true)
            out("worktree eliminado: \(!FileManager.default.fileExists(atPath: wt)) · ramas: \(await sh(["branch", "--format=%(refname:short)"]).replacingOccurrences(of: "\n", with: ","))")
        } catch {
            out("ERROR \(error.localizedDescription)")
        }
    }

    /// The workspace views rendered offscreen, light and dark, on a scratch repository (no agent):
    ///   --selftest workspaceui <empty dir> <png prefix>   (RELEVO_DATA_DIR with a copy of state.json for real accounts)
    static func workspaceUI(dir: String, out prefix: String) async {
        let store = AppStore.shared
        let repo = (dir as NSString).appendingPathComponent("repo")
        try? FileManager.default.createDirectory(atPath: repo + "/Sources", withIntermediateDirectories: true)
        func sh(_ path: String, _ args: [String]) async { _ = await Git.run(path, args) }
        await sh(repo, ["init", "-q", "-b", "main"])
        await sh(repo, ["config", "user.email", "test@example.com"])
        await sh(repo, ["config", "user.name", "Test"])
        let original = """
        import Foundation

        final class LoginViewModel {
            var email = ""
            var password = ""
            private let api: AuthAPI

            init(api: AuthAPI) { self.api = api }

            func login() async throws -> Session {
                try await api.login(email: email, password: password)
            }
        }

        """
        try? original.write(toFile: repo + "/Sources/LoginViewModel.swift", atomically: true, encoding: .utf8)
        try? "# Proclubs\n".write(toFile: repo + "/README.md", atomically: true, encoding: .utf8)
        await sh(repo, ["add", "-A"])
        await sh(repo, ["commit", "-q", "-m", "Initial commit"])

        var project = Project(name: "Proclubs-iOS", path: repo)
        project.actions = [QuickAction(name: "Tests", command: "echo 'Test Suite LoginTests started'; sleep 0.2; echo 'Executed 42 tests, with 0 failures'", symbol: "checkmark.diamond"),
                           QuickAction(name: "Lint", command: "echo 'Sources/Login.swift:12: warning: line too long'; exit 1", symbol: "text.badge.checkmark"),
                           QuickAction(name: "XcodeGen", command: "echo 'Generated project'", symbol: "hammer", runOnWorktreeCreate: true)]
        store.projects = [project]
        store.accounts.removeAll { $0.kind.usesAPIKey }   // their keys are in the Keychain, which would ask for permission
        let claude = store.accounts.first { $0.kind == .claude }
        let codex = store.accounts.first { $0.kind == .codex }
        let gemini = store.accounts.first { $0.kind == .gemini }
        func makeThread(_ title: String, _ account: Account?, _ model: String) -> ThreadModel {
            let t = ThreadModel(projectId: project.id, mode: .ask, accountId: account?.id, model: model)
            t.title = title
            t.titleSource = .manual
            return t
        }
        let thread = makeThread("Arreglar el test de login", claude, "claude-opus-5-5")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        do {
            let info = try await Worktrees.create(for: thread, project: project, store: store)
            let wt = info.path
            guard let before = await Git.snapshot(wt, ref: "refs/relevo/\(thread.id.uuidString)/1-before", message: "before") else { out("sin snapshot"); return }
            let fixed = original
                .replacingOccurrences(of: "    func login() async throws -> Session {\n        try await api.login(email: email, password: password)\n    }",
                                      with: "    var canSubmit: Bool { email.contains(\"@\") && password.count >= 8 }\n\n    func login() async throws -> Session {\n        guard canSubmit else { throw LoginError.invalidInput }\n        let session = try await api.login(email: email, password: password)\n        await MainActor.run { self.session = session }\n        return session\n    }")
                .replacingOccurrences(of: "    var password = \"\"\n", with: "    var password = \"\"\n    private(set) var session: Session?\n")
            try? fixed.write(toFile: wt + "/Sources/LoginViewModel.swift", atomically: true, encoding: .utf8)
            try? FileManager.default.createDirectory(atPath: wt + "/Sources/Validation", withIntermediateDirectories: true)
            try? "enum LoginError: Error {\n    case invalidInput\n}\n".write(toFile: wt + "/Sources/Validation/LoginError.swift", atomically: true, encoding: .utf8)
            guard let after = await Git.snapshot(wt, ref: "refs/relevo/\(thread.id.uuidString)/1-after", message: "after") else { out("sin snapshot after"); return }
            let stat = await Git.diffStat(wt, from: before, to: after)
            let usage = TurnUsage(parts: [TokenUsage(model: "claude-opus-5-5", input: 12, cacheRead: 38_410, cacheWrite: 2_210, output: 940, reasoning: 210)],
                                  cost: 0.043, context: 41_572, contextWindow: 1_000_000, durationMs: 48_000, tools: 6)
            thread.items = [
                ChatItem(id: "u1", kind: .user, text: "Revisa por qué falla el test de login en el simulador"),
                ChatItem(id: "a1", kind: .assistant,
                         text: "El test falla porque `LoginViewModel` publica la sesión antes de validar. He añadido `canSubmit`, un `LoginError` y guardo la sesión en el hilo principal. Los 42 tests pasan.",
                         accountId: claude?.id, model: "claude-opus-5-5", usage: usage,
                         changes: TurnChanges(before: before, after: after, files: stat.files, added: stat.added, removed: stat.removed)),
            ]
            let item = thread.items[1]
            store.actions.run(project.actions![0], thread: thread, store: store)
            store.actions.run(project.actions![1], thread: thread, store: store)

            // Two more agents on the same task, for the comparison.
            let rivals = [makeThread("Arreglar el test de login · GPT-5.5", codex, "gpt-5.5"), makeThread("Arreglar el test de login · Gemini 3.5 Pro", gemini, "gemini-3.5-pro")]
            var comparison = Comparison(projectId: project.id, prompt: "Arregla el test de login que falla en el simulador", threadIds: [], baseCommit: info.baseCommit)
            for (n, t) in rivals.enumerated() {
                t.comparisonId = comparison.id
                store.threads.append(t)
                let w = try await Worktrees.create(for: t, project: project, store: store)
                let text = n == 0 ? fixed : original.replacingOccurrences(of: "    func login()", with: "    @MainActor\n    func login()")
                try? text.write(toFile: w.path + "/Sources/LoginViewModel.swift", atomically: true, encoding: .utf8)
                comparison.threadIds.append(t.id)
            }
            comparison.threadIds.insert(thread.id, at: 0)
            thread.comparisonId = comparison.id
            store.comparisons = [comparison]
            store.settings.mcpEnabled = true
            store.settings.captureEnabled = true
            try? await Task.sleep(nanoseconds: 1_000_000_000)

            for scheme in [ColorScheme.light, .dark] {
                let name = scheme == .light ? "light" : "dark"
                await render(VStack(alignment: .leading, spacing: 8) {
                    Text(item.text).font(.body)
                    TurnFooter(item: item, runtime: rt, showUsage: true)
                }.environment(store).padding(20).frame(width: 560), scheme: scheme, to: "\(prefix)-footer-\(name).png", wait: 0.6)
                await render(VStack(alignment: .leading, spacing: 12) {
                    Text("Duo: estoy repitiendo con el arreglo los 6 tests de UI. Te aviso en cuanto tenga el resultado.").font(.body)
                    WaitingIndicator(tasks: [BackgroundTask(id: "b1", description: "Run the 6 UI tests with the fix", startedAt: Date().addingTimeInterval(-370))])
                }.environment(store).padding(20).frame(width: 560), scheme: scheme, to: "\(prefix)-waiting-\(name).png", wait: 0.6)
                if let codex = store.accounts.first(where: { $0.kind == .codex }), let gemini = store.accounts.first(where: { $0.kind == .gemini }) {
                    await render(LimitPlanEditor(title: "Si se acaba la cuota en este hilo",
                                                 plan: LimitPlan(mode: .chain, targets: [FallbackTarget(accountId: codex.id, model: store.defaultModel(for: codex)),
                                                                                         FallbackTarget(accountId: gemini.id, model: store.defaultModel(for: gemini))]),
                                                 onSave: { _ in }).environment(store), scheme: scheme, to: "\(prefix)-limitplan-\(name).png", wait: 0.6)
                    if let claude = claude {
                        rt.limit = LimitNotice(accountId: claude.id, message: "You've hit your limit", resetsAt: Date().addingTimeInterval(3 * 3600))
                        rt.pendingRelay = ThreadRuntime.PendingRelay(accountId: codex.id, model: store.defaultModel(for: codex), at: Date().addingTimeInterval(8))
                        await render(LimitBanner(limit: rt.limit!, runtime: rt).environment(store).padding(20).frame(width: 760), scheme: scheme, to: "\(prefix)-limit-relay-\(name).png", wait: 0.6)
                        rt.pendingRelay = nil
                        thread.resumeAt = Date().addingTimeInterval(3 * 3600 + 60)
                        await render(LimitBanner(limit: rt.limit!, runtime: rt).environment(store).padding(20).frame(width: 760), scheme: scheme, to: "\(prefix)-limit-wait-\(name).png", wait: 0.6)
                        thread.resumeAt = nil
                        rt.limit = nil
                    }
                }
                await render(DiffSheet(title: "Cambios de este turno", path: wt, from: before, to: after, runtime: rt, turnItem: item)
                    .environment(store).frame(width: 1040, height: 600), scheme: scheme, to: "\(prefix)-diff-\(name).png", wait: 1.5)
                await render(CommitSheet(thread: thread, runtime: rt).environment(store).frame(width: 640), scheme: scheme, to: "\(prefix)-commit-\(name).png", wait: 1.5)
                await render(CompareLaunchSheet(source: thread, projectId: project.id, prompt: comparison.prompt).environment(store).frame(width: 640),
                       scheme: scheme, to: "\(prefix)-launch-\(name).png", wait: 1)
                await render(ComparisonSheet(comparison: comparison).environment(store).frame(width: 980), scheme: scheme, to: "\(prefix)-compare-\(name).png", wait: 2)
                await render(ActionRunsSheet(thread: thread).environment(store).frame(width: 820, height: 460), scheme: scheme, to: "\(prefix)-runs-\(name).png", wait: 1)
                await render(QuickActionsEditor(project: project).environment(store), scheme: scheme, to: "\(prefix)-actions-\(name).png", wait: 0.8)
                await render(IntegrationsSettings().formStyle(.grouped).environment(store).frame(width: 620), scheme: scheme, to: "\(prefix)-integrations-\(name).png", wait: 0.8)
            }
        } catch {
            out("ERROR \(error.localizedDescription)")
        }
    }

    /// Per-turn changes with a real agent (the Claude account of RELEVO_DATA_DIR's state, Haiku): the turn
    /// records what it changed, restoring puts the files back, the agent is told, and the restore can be undone.
    ///   --selftest turnchanges <empty dir>
    static func turnChanges(dir: String) async {
        let store = AppStore.shared
        guard let account = store.accounts.first(where: { $0.kind == .claude }) else { out("sin cuenta Claude"); return }
        store.accounts = [account]
        let repo = (dir as NSString).appendingPathComponent("repo")
        try? FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        for args in [["init", "-q", "-b", "main"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]] { _ = await Git.run(repo, args) }
        try? "uno\ndos\n".write(toFile: repo + "/a.txt", atomically: true, encoding: .utf8)
        _ = await Git.run(repo, ["add", "-A"])
        _ = await Git.run(repo, ["commit", "-q", "-m", "Initial commit"])
        let project = Project(name: "turn-test", path: repo)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .full, accountId: account.id, model: "haiku")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        func waitIdle() async {
            let deadline = Date().addingTimeInterval(150)
            try? await Task.sleep(nanoseconds: 800_000_000)
            while rt.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 200_000_000) }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
        func exists(_ f: String) -> Bool { FileManager.default.fileExists(atPath: repo + "/" + f) }
        func read(_ f: String) -> String { ((try? String(contentsOfFile: repo + "/" + f, encoding: .utf8)) ?? "-").replacingOccurrences(of: "\n", with: "|") }

        rt.send("Crea un fichero hola.txt con el texto «hola» y añade una línea «tres» al final de a.txt. No hagas nada más y responde solo «hecho».")
        await waitIdle()
        guard let item = thread.items.last(where: { $0.changes != nil }), let c = item.changes else {
            out("SIN CAMBIOS REGISTRADOS · items: " + thread.items.map { "\($0.kind.rawValue): \($0.text.prefix(40))" }.joined(separator: " | "))
            rt.closeSession()
            return
        }
        out("turno: \(c.files) ficheros +\(c.added) −\(c.removed) en «\(item.text.prefix(30))» · hola.txt=\(read("hola.txt")) a.txt=\(read("a.txt"))")
        do {
            try await rt.restoreBefore(item)
            out("restaurado: hola.txt existe=\(exists("hola.txt")) a.txt=\(read("a.txt")) · git status: \(await Git.run(repo, ["status", "--porcelain"]).out.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: ","))")
        } catch { out("ERROR restaurando: \(error.localizedDescription)") }
        rt.send("¿Existe ahora el fichero hola.txt y qué contiene a.txt? Compruébalo en disco y responde en una línea.")
        await waitIdle()
        out("el agente dice: \(thread.items.last { $0.kind == .assistant }?.text.prefix(160) ?? "-")")
        if let notice = thread.items.last(where: { $0.title == "restore" }) {
            do {
                try await rt.undoRestore(notice)
                out("deshecho: hola.txt=\(read("hola.txt")) a.txt=\(read("a.txt")) · aviso «\(thread.items.first { $0.id == notice.id }?.text ?? "")»")
            } catch { out("ERROR deshaciendo: \(error.localizedDescription)") }
        }
        rt.closeSession()
    }

    /// Commit message and PR text from the utility model, on a scratch repository with a change:
    ///   --selftest commitmsg <empty dir>   (RELEVO_DATA_DIR with a copy of state.json)
    static func commitMessage(dir: String) async {
        let store = AppStore.shared
        store.accounts.removeAll { $0.kind.usesAPIKey }   // their keys are in the Keychain, which would ask for permission
        let repo = (dir as NSString).appendingPathComponent("repo")
        try? FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        for args in [["init", "-q", "-b", "main"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]] { _ = await Git.run(repo, args) }
        let before = "final class LoginViewModel {\n    var email = \"\"\n    var password = \"\"\n\n    func login() async throws -> Session {\n        try await api.login(email: email, password: password)\n    }\n}\n"
        try? before.write(toFile: repo + "/LoginViewModel.swift", atomically: true, encoding: .utf8)
        _ = await Git.run(repo, ["add", "-A"])
        _ = await Git.run(repo, ["commit", "-q", "-m", "Initial commit"])
        let after = before.replacingOccurrences(of: "    func login() async throws -> Session {\n        try await",
                                                with: "    var canSubmit: Bool { email.contains(\"@\") && password.count >= 8 }\n\n    func login() async throws -> Session {\n        guard canSubmit else { throw LoginError.invalidInput }\n        return try await")
        try? after.write(toFile: repo + "/LoginViewModel.swift", atomically: true, encoding: .utf8)
        try? "enum LoginError: Error {\n    case invalidInput\n}\n".write(toFile: repo + "/LoginError.swift", atomically: true, encoding: .utf8)
        let project = Project(name: "commit-test", path: repo)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: nil, model: nil)
        thread.items = [
            ChatItem(id: "u1", kind: .user, text: "El login deja enviar el formulario vacío y el test testEmptyFormIsRejected falla. Arréglalo."),
            ChatItem(id: "t1", kind: .tool, text: "{}", title: "cd ~/Projects/proclubs && xcodebuild test -scheme Proclubs -only-testing LoginTests", toolName: "Bash", status: .done),
            ChatItem(id: "t2", kind: .tool, text: "", title: "/bin/zsh -lc \"swiftlint lint --strict\"", toolName: "Shell", status: .done),
            ChatItem(id: "t3", kind: .tool, text: "", title: "cat LoginViewModel.swift", toolName: "Bash", status: .done),
            ChatItem(id: "a1", kind: .assistant, text: "Añadido `canSubmit` y `LoginError.invalidInput`; `login()` valida antes de llamar a la API. LoginTests pasa (12 tests)."),
        ]
        store.threads = [thread]
        out("modelo de utilidad: \(store.topicProvider().map { "\($0.0.name)" } ?? "ninguno")")
        let start = Date()
        guard let message = await CommitWriter.message(for: thread, path: repo, store: store) else { out("sin mensaje"); return }
        out("mensaje (\(String(format: "%.1f", Date().timeIntervalSince(start))) s):\n---\n\(message)\n---")
        let pr = CommitWriter.pullRequest(from: message, thread: thread, store: store)
        out("PR: \(pr.title)\n\(pr.body)\n---")
    }

    /// What a thread does when its agent runs out of quota, with simulated limits on a real Claude thread (Haiku):
    /// a list in order skipping one that's also out, the one with most quota, waiting for the reset (and carrying
    /// on for real), and a list with nothing left.   --selftest limitplan <cwd>   (RELEVO_DATA_DIR with a state.json copy)
    static func limitPlan(cwd: String) async {
        let store = AppStore.shared
        store.accounts.removeAll { $0.kind.usesAPIKey }   // their keys are in the Keychain, which would ask for permission
        guard let claude = store.accounts.first(where: { $0.kind == .claude }),
              let codex = store.accounts.first(where: { $0.kind == .codex }),
              let gemini = store.accounts.first(where: { $0.kind == .gemini }) else { out("faltan cuentas"); return }
        let project = Project(name: "limit-test", path: cwd)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: claude.id, model: "haiku")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        func waitIdle() async {
            let deadline = Date().addingTimeInterval(120)
            try? await Task.sleep(nanoseconds: 800_000_000)
            while rt.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 200_000_000) }
        }
        func name(_ id: UUID?) -> String { store.account(id).map(\.name) ?? "-" }
        func limitHit(resetsIn: TimeInterval) {
            rt.simulateFailure(AgentFailure(kind: .limit, message: "You've hit your limit", resetsAt: Date().addingTimeInterval(resetsIn)), accountId: claude.id)
        }
        rt.send("Responde solo con la palabra: uno")
        await waitIdle()
        out("turno inicial: \(thread.items.last { $0.kind == .assistant }?.text ?? "-")")
        let codexModel = store.defaultModel(for: codex), geminiModel = store.defaultModel(for: gemini)

        thread.limitPlan = LimitPlan(mode: .chain, targets: [FallbackTarget(accountId: codex.id, model: codexModel), FallbackTarget(accountId: gemini.id, model: geminiModel)])
        store.markExhausted(codex.id, until: Date().addingTimeInterval(3600))
        limitHit(resetsIn: 3600)
        out("A lista Codex→Gemini con Codex también agotado: propone \(name(rt.pendingRelay?.accountId)) · \(rt.pendingRelay?.model ?? "-") en \(Int((rt.pendingRelay?.at.timeIntervalSinceNow ?? 0).rounded())) s")
        rt.cancelPendingRelay()
        try? await Task.sleep(nanoseconds: 300_000_000)
        out("  «No relevar»: pendiente=\(rt.pendingRelay != nil) · sigue en \(name(thread.selectedAccountId))")

        thread.limitPlan = LimitPlan(mode: .mostQuota)
        limitHit(resetsIn: 3600)
        out("B la de más cuota: propone \(name(rt.pendingRelay?.accountId))")
        rt.cancelPendingRelay()

        thread.limitPlan = LimitPlan(mode: .chain, targets: [FallbackTarget(accountId: codex.id, model: codexModel)])
        limitHit(resetsIn: 600)
        out("C lista sin ninguna con cuota: pendiente=\(rt.pendingRelay != nil) · espera hasta \(thread.resumeAt.map { Formatters.reset($0) ?? "" } ?? "-") · aviso «\(thread.items.last { $0.kind == .notice }?.text ?? "-")»")
        rt.cancelResume()

        thread.limitPlan = LimitPlan(mode: .wait)
        limitHit(resetsIn: 120)
        let saved = (try? JSONDecoder().decode(ThreadRecord.self, from: Data(contentsOf: AppStore.supportDirectory.appendingPathComponent("threads/\(thread.id.uuidString).json"))))?.resumeAt
        out("D esperar: seguirá \(thread.resumeAt.map { Formatters.reset($0) ?? "" } ?? "-") (en \(Int((thread.resumeAt?.timeIntervalSinceNow ?? 0) / 60)) min) · guardado en disco=\(saved != nil || thread.resumeAt != nil)")
        await rt.resumeAfterReset(force: true)
        await waitIdle()
        out("  «Retomar ahora»: límite=\(rt.limit != nil) · espera=\(thread.resumeAt != nil) · últimos: " + thread.items.suffix(3).map { "\($0.kind.rawValue): \($0.text.prefix(60))" }.joined(separator: " | "))
        rt.closeSession()
    }

    /// A Claude agent that leaves a command running in the background: the thread shows it as waiting, and
    /// when the command ends the agent's own turn shows as working and is recorded like any other.
    ///   --selftest background <cwd>   (RELEVO_TEST_CONFIG_DIR = Claude config folder)
    static func background(cwd: String) async {
        let store = AppStore.shared
        let account = Account(kind: .claude, name: "Claude test", configDir: ProcessInfo.processInfo.environment["RELEVO_TEST_CONFIG_DIR"])
        store.accounts = [account]
        let project = Project(name: "background-test", path: cwd)
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .full, accountId: account.id, model: "haiku")
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        rt.send("Ejecuta en segundo plano (run_in_background) el comando `sleep 15; echo HECHO-BG` y termina tu turno diciendo solo «lanzado». Cuando el comando termine, responde solo con su salida.")
        var sawWaiting = false, sawAgentTurn = false
        let deadline = Date().addingTimeInterval(120)
        var wasRunning = true
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if !rt.isRunning, !rt.backgroundTasks.isEmpty, !sawWaiting {
                sawWaiting = true
                out("esperando: \(rt.backgroundTasks.map(\.description)) · trabajando=\(rt.isRunning)")
            }
            if rt.isRunning, !wasRunning, sawWaiting {
                sawAgentTurn = true
                out("el agente retoma solo: trabajando=true · aviso «\(thread.items.last { $0.kind == .notice }?.text ?? "-")»")
            }
            wasRunning = rt.isRunning
            if sawAgentTurn, !rt.isRunning { break }
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
        let replies = thread.items.filter { $0.kind == .assistant }.map { String($0.text.prefix(40)) }
        out("respuestas: \(replies) · en segundo plano ahora: \(rt.backgroundTasks.count) · turnos con consumo: \(thread.items.filter { $0.usage != nil }.count)")
        rt.closeSession()
    }

    /// The transcript's follow-the-last-line behaviour in a real (offscreen) window:  --selftest followscroll
    static func followScroll() async {
        let store = AppStore.shared
        let project = Project(name: "scroll-test", path: NSTemporaryDirectory())
        store.projects = [project]
        let thread = ThreadModel(projectId: project.id, mode: .ask, accountId: nil, model: nil)
        thread.items = (0..<40).map { i in
            ChatItem(id: "i\(i)", kind: i % 2 == 0 ? .user : .assistant, text: String(repeating: "Línea \(i) de la conversación de prueba. ", count: i % 2 == 0 ? 2 : 9))
        }
        store.threads = [thread]
        let rt = store.runtime(for: thread)
        let hosting = NSHostingView(rootView: TranscriptView(thread: thread, runtime: rt).environment(store).frame(width: 760, height: 520))
        // On screen (animations only run there) but invisible and click-through.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 520), styleMask: .borderless, backing: .buffered, defer: false)
        window.alphaValue = 0.01
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: NSWindow.Level.normal.rawValue - 1)
        window.contentView = hosting
        window.orderFrontRegardless()
        func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func scrollView(_ v: NSView) -> NSScrollView? {
            if let s = v as? NSScrollView { return s }
            for sub in v.subviews { if let s = scrollView(sub) { return s } }
            return nil
        }
        await wait(1)
        guard let sv = scrollView(hosting), let doc = sv.documentView else { out("sin NSScrollView"); return }
        func distance() -> Int { Int(doc.frame.height - sv.contentView.bounds.height - sv.contentView.bounds.origin.y) }
        func offset() -> Int { Int(sv.contentView.bounds.origin.y) }
        out("1 al abrir: distancia al final=\(distance())")
        thread.items.append(ChatItem(id: "s", kind: .assistant, text: ""))
        for _ in 0..<12 { thread.items[thread.items.count - 1].text += "Texto que va llegando en streaming poco a poco. "; await wait(0.08) }
        await wait(0.4)
        out("2 tras streaming: distancia=\(distance())")
        thread.items.append(ChatItem(id: "n1", kind: .user, text: "Mensaje nuevo"))
        await wait(0.5)
        out("3 tras mensaje nuevo: distancia=\(distance())")
        // Scroll up like a mouse wheel (no scroll phases).
        sv.contentView.scroll(to: NSPoint(x: 0, y: max(0, sv.contentView.bounds.origin.y - 400)))
        sv.reflectScrolledClipView(sv.contentView)
        await wait(0.4)
        let readingAt = offset()
        out("4 subo 400 pt: distancia=\(distance()) offset=\(readingAt)")
        for i in 0..<3 {
            thread.items.append(ChatItem(id: "r\(i)", kind: .assistant, text: String(repeating: "Respuesta que llega mientras lees. ", count: 10)))
            await wait(0.3)
        }
        for _ in 0..<8 { thread.items[thread.items.count - 1].text += "Más texto en streaming. "; await wait(0.08) }
        await wait(0.4)
        out("5 llegan respuestas mientras leo: offset=\(offset()) (antes \(readingAt)) distancia=\(distance()) → \(abs(offset() - readingAt) <= 2 ? "no me mueve" : "¡ME HA MOVIDO!")")
        rt.composerSends += 1
        await wait(0.8)
        out("6 envío desde el composer: distancia=\(distance())")
        thread.items.append(ChatItem(id: "n2", kind: .assistant, text: String(repeating: "Y sigue siguiendo. ", count: 12)))
        await wait(0.5)
        out("7 nueva respuesta: distancia=\(distance())")
        sv.contentView.scroll(to: NSPoint(x: 0, y: max(0, sv.contentView.bounds.origin.y - 300)))
        sv.reflectScrolledClipView(sv.contentView)
        await wait(0.3)
        sv.contentView.scroll(to: NSPoint(x: 0, y: doc.frame.height - sv.contentView.bounds.height))
        sv.reflectScrolledClipView(sv.contentView)
        await wait(0.3)
        thread.items.append(ChatItem(id: "n3", kind: .assistant, text: String(repeating: "Bajé yo solo hasta el final. ", count: 12)))
        await wait(0.5)
        out("8 subo y vuelvo a bajar a mano, llega otra: distancia=\(distance())")
        window.orderOut(nil)
    }

    /// The PR watcher's decisions over a sequence of PR states (no network):  --selftest prwatch
    static func prWatch() {
        func check(_ name: String, _ conclusion: String, _ status: String = "COMPLETED", at time: String = "10:00") -> String {
            #"{"name":"\#(name)","conclusion":"\#(conclusion)","status":"\#(status)","completedAt":"\#(time)"}"#
        }
        func pr(_ checks: [String], comments: [String] = [], reviews: [(String, String)] = [], mergeable: String = "MERGEABLE", state: String = "OPEN") -> JSONObject {
            let c = comments.map { #"{"author":{"login":"ana"},"body":"\#($0)"}"# }.joined(separator: ",")
            let r = reviews.map { #"{"author":{"login":"luis"},"state":"\#($0.0)","body":"\#($0.1)"}"# }.joined(separator: ",")
            return JSONUtil.parse(#"{"number":42,"state":"\#(state)","mergeable":"\#(mergeable)","statusCheckRollup":[\#(checks.joined(separator: ","))],"comments":[\#(c)],"reviews":[\#(r)]}"#) ?? [:]
        }
        let steps: [(String, JSONObject)] = [
            ("primera vista, checks en curso", pr([check("build", "", "IN_PROGRESS"), check("lint", "SUCCESS")])),
            ("build falla", pr([check("build", "FAILURE"), check("lint", "SUCCESS")])),
            ("sigue igual", pr([check("build", "FAILURE"), check("lint", "SUCCESS")])),
            ("push y vuelve a fallar (otra ejecución)", pr([check("build", "FAILURE", at: "10:20"), check("lint", "SUCCESS")])),
            ("un comentario y una revisión", pr([check("build", "FAILURE", at: "10:20"), check("lint", "SUCCESS")], comments: ["¿Por qué este cambio?"], reviews: [("CHANGES_REQUESTED", "Falta un test")])),
            ("conflicto", pr([check("build", "FAILURE", at: "10:20"), check("lint", "SUCCESS")], comments: ["¿Por qué este cambio?"], reviews: [("CHANGES_REQUESTED", "Falta un test")], mergeable: "CONFLICTING")),
            ("todo en verde", pr([check("build", "SUCCESS", at: "10:40"), check("lint", "SUCCESS")], comments: ["¿Por qué este cambio?"], reviews: [("CHANGES_REQUESTED", "Falta un test")])),
            ("sigue en verde", pr([check("build", "SUCCESS", at: "10:40"), check("lint", "SUCCESS")], comments: ["¿Por qué este cambio?"], reviews: [("CHANGES_REQUESTED", "Falta un test")])),
            ("fusionado", pr([check("build", "SUCCESS", at: "10:40"), check("lint", "SUCCESS")], comments: ["¿Por qué este cambio?"], reviews: [("CHANGES_REQUESTED", "Falta un test")], state: "MERGED")),
        ]
        var info = PullRequestInfo(number: 42, url: "https://github.com/x/y/pull/42", state: "OPEN", watching: true)
        for (label, o) in steps {
            let r = PRWatcher.evaluate(o, pr: &info)
            let agent = r.tellAgent.map { String($0.split(separator: "\n").first ?? "").prefix(70) }
            out("· \(label): agente=\(agent.isEmpty ? "—" : agent.joined(separator: " / ")) · notas=\(r.notes.isEmpty ? "—" : r.notes.joined(separator: " / ")) · vigilando=\(info.watching)")
        }
    }

    /// Keeps the MCP server up (port 47899) for a real client to try:  --selftest mcpserve <seconds> [full]
    static func mcpServe(seconds: Double, full: Bool) async {
        let store = AppStore.shared
        store.settings.mcpEnabled = true
        store.settings.mcpFullAccess = full
        store.settings.mcpPort = 47899
        MCPServer.shared.attach(store)
        out("MCP en \(MCPServer.shared.url) · \(full ? "acceso completo" : "solo lectura") · \(store.threads.count) hilos")
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        MCPServer.shared.stop()
    }

    /// The MCP server over real HTTP: initialize, tools, a call, and a wrong token.  --selftest mcp
    ///   (RELEVO_MCP_TOKEN overrides the Keychain token; port 47899)
    static func mcp() async {
        let store = AppStore.shared
        store.settings.mcpEnabled = true
        store.settings.mcpPort = 47899
        MCPServer.shared.attach(store)
        try? await Task.sleep(nanoseconds: 500_000_000)
        let token = MCPServer.shared.token
        func post(_ body: String, token: String) async -> (Int, String) {
            var req = URLRequest(url: URL(string: "http://127.0.0.1:47899/mcp")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.httpBody = Data(body.utf8)
            guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return (-1, "") }
            return ((resp as? HTTPURLResponse)?.statusCode ?? -1, String(decoding: data, as: UTF8.self))
        }
        let i = await post(#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#, token: token)
        out("initialize: \(i.0) \(i.1.prefix(140))")
        let n = await post(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, token: token)
        out("initialized: \(n.0)")
        let l = await post(#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, token: token)
        let names = (JSONUtil.parse(l.1)?.obj("result")?.objs("tools") ?? []).compactMap { $0.str("name") }
        out("tools/list: \(l.0) \(names)")
        let c = await post(#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}"#, token: token)
        out("list_projects: \(c.0) \(c.1.prefix(160))")
        let w = await post(#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_message","arguments":{"thread_id":"x","text":"hola"}}}"#, token: token)
        out("send_message en solo lectura: \(w.1.contains("\"isError\":true") ? "rechazado" : "¡permitido!")")
        let bad = await post(#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#, token: "mal")
        out("token incorrecto: \(bad.0)")
        MCPServer.shared.stop()
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

        out("== B0: detener antes de que el mensaje llegue al agente ==")
        rt.send("Responde solo con la palabra: nunca")
        rt.stop()
        out("al momento: trabajando=\(rt.isRunning) · último: \(thread.items.last.map { "\($0.kind.rawValue): \($0.text)" } ?? "-")")
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        rt.send("Responde solo con la palabra: sigue")
        await waitIdle(90)
        out("después: \(thread.items.suffix(2).map { "\($0.kind.rawValue): \($0.text.prefix(30))" })")

        out("== B: detener con un mensaje en cola ==")
        rt.send("Escribe los números del 1 al 300 separados por comas, sin nada más")
        try? await Task.sleep(nanoseconds: 300_000_000)
        rt.send("Responde solo con la palabra: cuatro")
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        rt.stop()
        let stopDeadline = Date().addingTimeInterval(12)
        while rt.isRunning && Date() < stopDeadline { try? await Task.sleep(nanoseconds: 200_000_000) }
        try? await Task.sleep(nanoseconds: 800_000_000)
        out("tras detener: pausada=\(rt.queuePaused) cola=\(rt.queue.map(\.text)) · últimos: \(thread.items.suffix(4).map { "\($0.kind.rawValue): \($0.text.prefix(30))…\($0.text.suffix(12))" })")
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
