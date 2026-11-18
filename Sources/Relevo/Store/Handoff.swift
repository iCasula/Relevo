import Foundation

/// Builds the context package handed to a different agent when the user switches provider,
/// so the conversation continues without losing what was said and done.
///
/// A brief, not the conversation (same algorithm as Host/lib/handoff.mjs): the code is already on disk, so
/// the receiving agent gets the goal, where the work stands, what each turn did (files touched and commands
/// run, not their contents) and the latest exchange in more detail. Code blocks are left out; the whole
/// conversation goes to a file the agent can read if it needs a detail. A few thousand tokens however long
/// the thread is.
@MainActor
enum Handoff {
    static let briefBudget = 14_000
    private static let goalMax = 1_500
    private static let stateMax = 2_500
    private static let lastUserMax = 2_500
    private static let lastReplyMax = 3_000
    private static let lastToolsMax = 25

    struct Package {
        var text: String
        var file: String?
    }

    static func build(thread: ThreadModel, items: [ChatItem], project: Project, store: AppStore, target: Account, pendingRequest: Bool, git: GitSnapshot?) -> Package {
        let state = WorkState.markdown(thread: thread, project: project, store: store, git: git)
        let full = transcript(items: items, store: store, toolOutputLimit: 2_000)
        let file = save(state: state, transcript: full, thread: thread)
        let agents = Set(thread.segments.compactMap { store.account($0.accountId)?.kind.agentName }).sorted().joined(separator: ", ")
        let text = brief(items: items, agents: agents, projectPath: project.path, targetName: target.kind.agentName,
                         pendingRequest: pendingRequest, workState: state, traceFile: file) { authorName($0, store: store) }
        return Package(text: text, file: file)
    }

    // MARK: - The brief

    static func brief(items: [ChatItem], agents: String, projectPath: String, targetName: String, pendingRequest: Bool,
                      workState: String?, traceFile: String?, author: (ChatItem) -> String) -> String {
        let turns = turnsOf(items)
        var head = """
        <relevo_handoff>
        Retomas una tarea que llevaba otro agente de IA (\(agents.isEmpty ? "otro agente" : agents)): el usuario ha cambiado de proveedor desde Relevo (normalmente porque el anterior se quedó sin cuota) y ahora sigues tú, como \(targetName). Esto es un resumen, no la conversación entera.
        - Proyecto: \(projectPath)
        - El código y los cambios ya están en disco: léelos de los ficheros (git status, git diff), no esperes encontrarlos aquí.
        - Comprueba lo que quedó a medias antes de repetirlo y no rehagas lo que ya está hecho.
        """
        if let traceFile { head += "\n- Si te falta algún detalle, la conversación completa está en \(traceFile) (léela solo si hace falta)." }

        var sections: [String] = []
        if let goal = turns.first?.user.text {
            sections.append("<objetivo>\n\(clip(elideCode(goal, keep: 15), goalMax))\n</objetivo>")
        }
        if let workState, !workState.isEmpty {
            sections.append("<estado_de_trabajo>\n\(clip(workState, stateMax))\n</estado_de_trabajo>")
        }
        let last = turns.last.map { "<ultimo_intercambio>\n\(lastExchange($0, pendingRequest: pendingRequest, author: author))\n</ultimo_intercambio>" } ?? ""

        // The earlier turns, newest first, as long as they fit; the oldest left out are only counted.
        var room = briefBudget - head.count - sections.joined(separator: "\n\n").count - last.count - 400
        var history: [String] = []
        var i = turns.count - 2
        while i >= 0 {
            let line = turnLine(turns[i], number: i + 1, isFirst: i == 0, author: author)
            if line.count > room {
                let n = i + 1
                history.insert("- (\(n) turno\(n == 1 ? "" : "s") anterior\(n == 1 ? "" : "es") sin resumir aquí\(traceFile != nil ? ": están en la traza" : ""))", at: 0)
                break
            }
            history.insert(line, at: 0)
            room -= line.count + 1
            i -= 1
        }
        if !history.isEmpty { sections.append("<historial>\n\(history.joined(separator: "\n"))\n</historial>") }
        if !last.isEmpty { sections.append(last) }

        return """
        \(head)

        \(sections.joined(separator: "\n\n"))
        </relevo_handoff>

        \(pendingRequest ? "La última petición del usuario quedó sin terminar. Continúa con ella desde donde se quedó:" : "Nuevo mensaje del usuario:")


        """
    }

    struct Turn {
        var user: ChatItem
        var items: [ChatItem]
    }

    static func turnsOf(_ items: [ChatItem]) -> [Turn] {
        var turns: [Turn] = []
        for item in items {
            if item.kind == .user { turns.append(Turn(user: item, items: [])) }
            else if !turns.isEmpty { turns[turns.count - 1].items.append(item) }
        }
        return turns
    }

    private static func replies(_ turn: Turn) -> [ChatItem] {
        turn.items.filter { $0.kind == .assistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private static func turnLine(_ turn: Turn, number: Int, isFirst: Bool, author: (ChatItem) -> String) -> String {
        let errors = turn.items.filter { $0.kind == .error }
        var lines = ["- Turno \(number) · Usuario: \(isFirst ? "(el objetivo)" : clip(oneLine(elideCode(turn.user.text, keep: 0)), 260))"]
        if let last = replies(turn).last {
            lines.append("  \(author(last)): \(clip(oneLine(elideCode(last.text, keep: 0)), 360))")
        } else if errors.isEmpty {
            lines.append("  (sin respuesta)")
        }
        let tools = summaryLine(toolSummary(turn.items), maxCommands: 4)
        if !tools.isEmpty { lines.append("  \(tools)") }
        if let e = errors.last { lines.append("  Error: \(clip(oneLine(e.text), 160))") }
        return lines.joined(separator: "\n")
    }

    private static func lastExchange(_ turn: Turn, pendingRequest: Bool, author: (ChatItem) -> String) -> String {
        var out = ["### Usuario\n\(clip(elideCode(turn.user.text, keep: 15), lastUserMax))"]
        let said = replies(turn)
        if let last = said.last {
            let text = said.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: "\n\n")
            out.append("### \(author(last))\n\(headTail(elideCode(text, keep: 10), lastReplyMax))")
        }
        let tools = turn.items.filter { $0.kind == .tool && $0.toolName != "TodoWrite" }
        if !tools.isEmpty {
            let shown = tools.suffix(lastToolsMax)
            let lines = shown.map { t -> String in
                let state = t.status == .failed ? " → ERROR" : t.status == .running ? " → sin terminar" : ""
                var line = "- \(clip(oneLine(t.title ?? t.text), 120))\(state)"
                if t.status == .failed || t.status == .running, let output = t.output?.trimmingCharacters(in: .whitespacesAndNewlines), !output.isEmpty {
                    line += "\n  " + clip(String(output.suffix(400)), 400).replacingOccurrences(of: "\n", with: "\n  ")
                }
                return line
            }
            out.append("### Acciones\(tools.count > shown.count ? " (últimas \(shown.count) de \(tools.count))" : "")\n\(lines.joined(separator: "\n"))")
        }
        let errors = turn.items.filter { $0.kind == .error }
        if !errors.isEmpty { out.append("### Errores\n" + errors.suffix(3).map { "- \(clip($0.text, 400))" }.joined(separator: "\n")) }
        let open = turn.items.filter { $0.kind == .approval && $0.resolution == nil }
        if !open.isEmpty { out.append("### Sin responder\n" + open.map { "- \(clip($0.title ?? $0.text, 200))" }.joined(separator: "\n")) }
        if pendingRequest { out.append("(Este turno se cortó antes de terminar.)") }
        return out.joined(separator: "\n\n")
    }

    // MARK: - Tools

    struct ToolSummary {
        var files: [(String, String)] = []   // path, «editado» | «nuevo» | «borrado»
        var commands: [String] = []
        var reads = 0
        var web = 0
    }

    static func toolSummary(_ items: [ChatItem]) -> ToolSummary {
        var s = ToolSummary()
        let commandTools: Set<String> = ["Bash", "Shell", "commandExecution", "execute", "run_command", "shell"]
        for item in items where item.kind == .tool {
            let title = oneLine(item.title ?? item.text)
            let failed = item.status == .failed ? " ✗" : ""
            if let space = title.firstIndex(of: " "), ["Editar", "Crear", "Borrar"].contains(String(title[..<space])) {
                let verb = String(title[..<space])
                let kind = verb == "Crear" ? "nuevo" : verb == "Borrar" ? "borrado" : "editado"
                for f in title[title.index(after: space)...].components(separatedBy: ", ") {
                    if let i = s.files.firstIndex(where: { $0.0 == f }) {
                        if kind != "editado" { s.files[i].1 = kind }
                    } else {
                        s.files.append((f, kind))
                    }
                }
            } else if (item.toolName ?? "").range(of: "web", options: .caseInsensitive) != nil || title.hasPrefix("Buscar en la web") || title.hasPrefix("Abrir http") {
                s.web += 1
            } else if title.hasPrefix("Leer ") || title.hasPrefix("Buscar ") || title.hasPrefix("Abrir ") {
                s.reads += 1
            } else if item.toolName != "TodoWrite" {
                let limit = commandTools.contains(item.toolName ?? "") ? 80 : 60
                s.commands.append(clip(title, limit) + failed)
            }
        }
        return s
    }

    private static func summaryLine(_ s: ToolSummary, maxCommands: Int) -> String {
        var parts: [String] = []
        if !s.files.isEmpty {
            let list = s.files.map { $0.1 == "editado" ? $0.0 : "\($0.0) (\($0.1))" }
            parts.append("Ficheros: \(list.prefix(12).joined(separator: ", "))\(list.count > 12 ? " y \(list.count - 12) más" : "")")
        }
        if !s.commands.isEmpty {
            parts.append("Comandos: \(s.commands.suffix(maxCommands).joined(separator: " · "))\(s.commands.count > maxCommands ? " (+\(s.commands.count - maxCommands))" : "")")
        }
        if s.reads > 0 { parts.append("\(s.reads) lecturas/búsquedas") }
        if s.web > 0 { parts.append("\(s.web) consultas web") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Text helpers

    private static let fence = try! NSRegularExpression(pattern: "```([\\w+#.-]*)[^\\n]*\\n([\\s\\S]*?)(?:\\n```|$)")

    /// Fenced code blocks longer than `keep` lines become a one-line mention (the code is on disk).
    static func elideCode(_ text: String, keep: Int = 6) -> String {
        let ns = text as NSString
        var out = ""
        var cursor = 0
        for m in fence.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let body = ns.substring(with: m.range(at: 2))
            let lines = body.components(separatedBy: "\n").count
            out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            if lines <= keep {
                out += ns.substring(with: m.range)
            } else {
                let lang = ns.substring(with: m.range(at: 1))
                out += "[código\(lang.isEmpty ? "" : " \(lang)"), \(lines) líneas: omitido, está en disco o en la traza]"
            }
            cursor = m.range.location + m.range.length
        }
        out += ns.substring(from: cursor)
        return out
    }

    /// At most `n` characters, cut at a word, with a mark when something was left out.
    static func clip(_ text: String, _ n: Int) -> String {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count > n else { return s }
        var cut = String(s.prefix(n))
        if let space = cut.lastIndex(where: { $0.isWhitespace }), space > cut.startIndex { cut = String(cut[..<space]) }
        return cut + " …"
    }

    /// The start and, mostly, the end of a long reply (where the conclusion and next steps are).
    private static func headTail(_ text: String, _ n: Int) -> String {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count > n else { return s }
        let head = n * 3 / 10
        return "\(clip(s, head))\n[…]\n\(s.suffix(n - head))"
    }

    private static func oneLine(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    // MARK: - The full trace

    static func transcript(items: [ChatItem], store: AppStore, toolOutputLimit: Int) -> String {
        var out: [String] = []
        var lastAuthor: String?
        for item in items {
            switch item.kind {
            case .user:
                out.append("### Usuario\n\(item.text)")
                lastAuthor = nil
            case .assistant:
                guard !item.text.isEmpty else { continue }
                let author = authorName(item, store: store)
                if author != lastAuthor {
                    out.append("### Asistente (\(author))\n\(item.text)")
                } else {
                    out.append(item.text)
                }
                lastAuthor = author
            case .tool:
                var line = "- [\(item.toolName ?? "herramienta")] \(item.title ?? "")"
                if item.status == .failed { line += " → ERROR" }
                if let output = item.output?.trimmingCharacters(in: .whitespacesAndNewlines), !output.isEmpty, toolOutputLimit > 0 {
                    let clipped = output.count > toolOutputLimit ? String(output.prefix(toolOutputLimit)) + " …" : output
                    line += "\n  ```\n  " + clipped.replacingOccurrences(of: "\n", with: "\n  ") + "\n  ```"
                }
                out.append(line)
            case .error:
                out.append("- [error] \(item.text.prefix(1000))")
            case .notice:
                out.append("_(\(item.text))_")
            case .approval:
                if let r = item.resolution { out.append("- [permiso] \(item.title ?? "") → \(r)") }
            case .reasoning:
                continue
            }
        }
        return out.joined(separator: "\n\n")
    }

    private static func authorName(_ item: ChatItem, store: AppStore) -> String {
        guard let id = item.accountId, let acc = store.account(id) else { return "agente" }
        return "\(acc.kind.shortName) · \(store.modelName(acc, item.model ?? ""))"
    }

    private static let keepTraces = 30

    private static func save(state: String, transcript: String, thread: ThreadModel) -> String? {
        let dir = AppStore.supportDirectory.appendingPathComponent("handoffs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = dir.appendingPathComponent("\(thread.id.uuidString.prefix(8))-\(stamp).md")
        let doc = "# Relevo · \(thread.title)\n\n# Estado de trabajo\n\n\(state)\n\n---\n\n# Transcripción\n\n\(transcript)\n"
        do {
            try doc.write(to: url, atomically: true, encoding: .utf8)
            prune(dir)
            return url.path
        } catch {
            return nil
        }
    }

    /// Only the latest traces stay (they used to pile up, one per switch).
    private static func prune(_ dir: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let dated = files.filter { $0.pathExtension == "md" }.map { url -> (URL, Date) in
            (url, (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }.sorted { $0.1 > $1.1 }
        for (url, _) in dated.dropFirst(keepTraces) { try? fm.removeItem(at: url) }
    }
}
