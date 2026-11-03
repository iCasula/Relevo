import Foundation

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
