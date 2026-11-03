import Foundation

/// Builds the context package handed to a different agent when the user switches provider,
/// so the conversation continues without losing what was said and done.
@MainActor
enum Handoff {
    static let inlineBudget = 45_000

    struct Package {
        var text: String
        var file: String?
    }

    static func build(thread: ThreadModel, items: [ChatItem], project: Project, store: AppStore, target: Account, pendingRequest: Bool, git: GitSnapshot?) -> Package {
        let state = WorkState.markdown(thread: thread, project: project, store: store, git: git)
        let full = transcript(items: items, store: store, toolOutputLimit: 4_000)
        let file = save(state: state, transcript: full, thread: thread)
        var body = transcript(items: items, store: store, toolOutputLimit: 600)
        if body.count > inlineBudget {
            body = compact(items: items, store: store)
        }
        let agents = Set(thread.segments.compactMap { store.account($0.accountId)?.kind.agentName }).sorted().joined(separator: ", ")
        var text = """
        <relevo_handoff>
        Retomas una conversación que empezó con otro agente de IA (\(agents.isEmpty ? "otro agente" : agents)). El usuario ha cambiado de proveedor desde Relevo (normalmente porque el anterior se quedó sin cuota) y ahora continúas tú, como \(target.kind.agentName), con el mismo contexto.
        - Proyecto: \(project.path)
        - Los cambios en ficheros ya están aplicados en disco. Empieza por el apartado «Dónde se quedó»: si hay acciones a medias, comprueba su resultado antes de repetirlas.
        - No repitas trabajo ya hecho; continúa desde donde se quedó el agente anterior.
        """
        if let file { text += "\n- Transcripción completa y traza: \(file)" }
        text += """


        <estado_de_trabajo>
        \(state)
        </estado_de_trabajo>

        <transcripcion>
        \(body)
        </transcripcion>
        </relevo_handoff>


        """
        text += pendingRequest
            ? "La última petición del usuario quedó sin terminar. Continúa con ella desde donde se quedó:\n\n"
            : "Nuevo mensaje del usuario:\n\n"
        return Package(text: text, file: file)
    }

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
                var line = "- [herramienta \(item.toolName ?? "")] \(item.title ?? "")"
                if item.status == .failed { line += " → ERROR" }
                if let output = item.output?.trimmingCharacters(in: .whitespacesAndNewlines), !output.isEmpty, toolOutputLimit > 0 {
                    let clipped = output.count > toolOutputLimit ? String(output.prefix(toolOutputLimit)) + " …" : output
                    line += "\n  ```\n  " + clipped.replacingOccurrences(of: "\n", with: "\n  ") + "\n  ```"
                }
                out.append(line)
            case .error:
                out.append("- [error] \(item.text.prefix(500))")
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

    /// Drastic reduction for very long threads: every user message (trimmed), the last assistant
    /// answers in full and only tool titles.
    private static func compact(items: [ChatItem], store: AppStore) -> String {
        let tailStart = max(0, items.count - 40)
        var parts: [String] = []
        for (i, item) in items.enumerated() {
            if i >= tailStart {
                parts.append(transcript(items: [item], store: store, toolOutputLimit: i >= items.count - 12 ? 400 : 0))
                continue
            }
            switch item.kind {
            case .user: parts.append("### Usuario\n\(item.text.prefix(1200))")
            case .assistant: parts.append("### Asistente (\(authorName(item, store: store)))\n\(item.text.prefix(600))\(item.text.count > 600 ? " …" : "")")
            case .tool: parts.append("- [herramienta] \(item.title ?? "")")
            default: continue
            }
        }
        var text = parts.joined(separator: "\n\n")
        if text.count > inlineBudget {
            text = "…(principio omitido, consulta la transcripción completa)…\n\n" + String(text.suffix(inlineBudget))
        }
        return text
    }

    private static func authorName(_ item: ChatItem, store: AppStore) -> String {
        guard let id = item.accountId, let acc = store.account(id) else { return "agente" }
        return "\(acc.kind.shortName) · \(store.modelName(acc, item.model ?? ""))"
    }

    private static func save(state: String, transcript: String, thread: ThreadModel) -> String? {
        let dir = AppStore.supportDirectory.appendingPathComponent("handoffs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = dir.appendingPathComponent("\(thread.id.uuidString.prefix(8))-\(stamp).md")
        let doc = "# Relevo · \(thread.title)\n\n# Estado de trabajo\n\n\(state)\n\n---\n\n# Transcripción\n\n\(transcript)\n"
        do {
            try doc.write(to: url, atomically: true, encoding: .utf8)
            return url.path
        } catch {
            return nil
        }
    }
}

