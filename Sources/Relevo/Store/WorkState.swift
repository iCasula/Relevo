import Foundation

/// "Where was the agent when it stopped?" — built from the SQLite trace (no model calls),
/// so it works even when the outgoing subscription has no quota left.
@MainActor
enum WorkState {
    static let budget = 14_000

    static func markdown(thread: ThreadModel, project: Project, store: AppStore, git: GitSnapshot?) -> String {
        let trace = store.trace
        var out: [String] = []
        let lastRequest = trace.lastEvent(thread: thread.id, kind: "request")
        let requestText = thread.items.last(where: { $0.kind == .user })?.text ?? lastRequest?.detail ?? ""

        // 1. Current request
        if !requestText.isEmpty {
            out.append("## Petición en curso\n" + quote(String(requestText.prefix(3000))))
        }

        // 2. The agent's own plan / todo list
        if let plan = trace.plan(thread: thread.id), !plan.steps.isEmpty {
            let done = plan.steps.filter { $0.status == "completed" }.count
            var block = "## Plan del agente (\(plan.provider ?? "agente"), \(Formatters.relative(plan.ts)) · \(done)/\(plan.steps.count) hecho)"
            if let handoff = trace.lastEvent(thread: thread.id, kind: "handoff"), handoff.ts > plan.ts {
                block += "\n_Plan anterior al último relevo (\(handoff.title.replacingOccurrences(of: "Relevo: ", with: ""))). El agente que siguió no lo ha actualizado: contrástalo con el disco._"
            }
            for step in plan.steps {
                switch step.status {
                case "completed": block += "\n- [x] \(step.text)"
                case "in_progress": block += "\n- [ ] **EN CURSO →** \(step.text)"
                default: block += "\n- [ ] \(step.text)"
                }
            }
            out.append(block)
        }

        // 3. Where it stopped
        let turnEvents = lastRequest.map { trace.events(thread: thread.id, after: $0.id - 1) } ?? trace.recentEvents(thread: thread.id, limit: 40)
        var stop: [String] = []
        if let cp = trace.checkpoints(thread: thread.id, limit: 1).first {
            var line = "- Motivo de la parada: \(cp.reason)"
            if let p = cp.provider { line += " (\(p)\(cp.model.map { " · \($0)" } ?? ""))" }
            line += " · \(cp.ts.formatted(date: .omitted, time: .shortened))"
            stop.append(line)
            if let d = cp.detail, !d.isEmpty { stop.append("  > " + d.replacingOccurrences(of: "\n", with: " ").prefix(500)) }
        }
        let interrupted = turnEvents.filter { $0.kind == "tool" && ($0.status == "running" || $0.status == "interrumpida") }
        if !interrupted.isEmpty {
            stop.append("- Acciones que quedaron a medias (compruébalas antes de seguir):")
            for e in interrupted.suffix(5) { stop.append("  - \(e.title)" + (e.detail.map { " — " + oneLine($0, 200) } ?? "")) }
        }
        let actions = turnEvents.filter { ["tool", "error", "limit", "approval", "handoff"].contains($0.kind) }.suffix(14)
        if !actions.isEmpty {
            stop.append("- Últimas acciones de esta petición:")
            for e in actions { stop.append("  - " + actionLine(e)) }
        }
        if let reply = turnEvents.last(where: { $0.kind == "reply" }) ?? trace.lastEvent(thread: thread.id, kind: "reply") {
            stop.append("- Último mensaje del agente (\(reply.provider ?? "")):\n" + quote(String((reply.detail ?? reply.title).suffix(1500))))
        } else if let last = thread.items.last(where: { $0.kind == .assistant }) {
            stop.append("- Último mensaje del agente:\n" + quote(String(last.text.suffix(1500))))
        }
        if !stop.isEmpty { out.append("## Dónde se quedó\n" + stop.joined(separator: "\n")) }

        // 4. Files touched in this thread
        let files = trace.files(thread: thread.id)
        if !files.isEmpty {
            var block = "## Ficheros modificados en este hilo"
            for f in files.prefix(40) {
                block += "\n- \(relative(f.path, project)) — \(f.action)\(f.count > 1 ? " ×\(f.count)" : "")"
            }
            if files.count > 40 { block += "\n- … y \(files.count - 40) más" }
            out.append(block)
        }

        // 5. Repository state right now
        if let git {
            var block = "## Repositorio (git, ahora mismo)\n- Rama `\(git.branch)` · HEAD `\(git.head)` \(git.headSubject)"
            if !git.commitsSince.isEmpty {
                block += "\n- Commits hechos durante este hilo:\n" + git.commitsSince.map { "  - \($0)" }.joined(separator: "\n")
            }
            if git.status.isEmpty {
                block += "\n- Sin cambios pendientes de commit."
            } else {
                block += "\n- Cambios sin commit (`git status --porcelain`):\n```\n" + git.status.joined(separator: "\n") + "\n```"
                if let summary = git.diffStat.last { block += "\n- Resumen: \(summary.trimmingCharacters(in: .whitespaces))" }
            }
            out.append(block)
        }

        // 6. Older history related to the current request (FTS5 over the whole thread trace)
        let related = trace.search(thread: thread.id, terms: keywords(requestText), excludingNewest: 30, limit: 10)
        if !related.isEmpty {
            out.append("## Historial antiguo relacionado con la petición\n" + related.map { "- " + actionLine($0, withDetail: true) }.joined(separator: "\n"))
        }

        var text = out.joined(separator: "\n\n")
        if text.count > budget { text = String(text.prefix(budget)) + "\n…(estado recortado)" }
        return text
    }

    /// One-line summary for the limit banner: what the agent was doing when it stopped.
    static func whereLeftOff(thread: ThreadModel, store: AppStore) -> String? {
        let trace = store.trace
        if let plan = trace.plan(thread: thread.id), let step = plan.steps.first(where: { $0.status == "in_progress" }) {
            let done = plan.steps.filter { $0.status == "completed" }.count
            return "\(step.text) (paso \(done + 1) de \(plan.steps.count))"
        }
        if let tool = trace.recentEvents(thread: thread.id, limit: 30, kinds: ["tool"]).last {
            return tool.title + (tool.status == "interrumpida" ? " (a medias)" : "")
        }
        return nil
    }

    // MARK: - Helpers

    private static func actionLine(_ e: TraceEvent, withDetail: Bool = false) -> String {
        let time = e.ts.formatted(date: .omitted, time: .shortened)
        let mark: String
        switch (e.kind, e.status) {
        case ("tool", "failed"?): mark = "✗"
        case ("tool", "interrumpida"?), ("tool", "running"?): mark = "…"
        case ("tool", _): mark = "✓"
        case ("error", _), ("limit", _): mark = "⚠︎"
        case ("approval", _): mark = "?"
        default: mark = "•"
        }
        var line = "\(time) \(mark) \(e.title)"
        if let p = e.provider { line += " [\(p)]" }
        if let d = e.detail, !d.isEmpty, withDetail || e.status == "failed" || e.kind == "error" {
            let output = d.components(separatedBy: "\n→ ").last ?? d
            line += " — " + oneLine(e.status == "failed" ? String(output.suffix(400)) : output, 300)
        }
        if e.kind == "approval", let s = e.status { line += " → \(s)" }
        return line
    }

    private static func quote(_ s: String) -> String {
        s.split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }.joined(separator: "\n")
    }

    private static func oneLine(_ s: String, _ max: Int) -> String {
        let flat = s.replacingOccurrences(of: "\n", with: " ⏎ ")
        return flat.count > max ? String(flat.prefix(max)) + "…" : flat
    }

    static func relative(_ path: String, _ project: Project) -> String {
        let full = expandTilde(path)
        return full.hasPrefix(project.path + "/") ? String(full.dropFirst(project.path.count + 1)) : abbreviateHome(full)
    }

    private static let stopwords: Set<String> = [
        "para", "como", "esto", "este", "esta", "pero", "porque", "cuando", "donde", "desde", "hasta", "sobre", "entre", "todo", "todos",
        "hacer", "haz", "quiero", "puedes", "podrias", "favor", "también", "tambien", "ahora", "luego", "antes", "después", "despues",
        "with", "that", "this", "from", "have", "what", "when", "where", "which", "there", "their", "would", "could", "should", "please",
        "make", "into", "then", "than", "them", "your", "about", "solo", "cada", "algo", "mismo", "misma", "otro", "otra",
    ]

    static func keywords(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_.-")).inverted)
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".-")) }
            .filter { $0.count >= 4 && !stopwords.contains($0) && seen.insert($0).inserted }
            .prefix(10)
            .map { $0 }
    }
}

/// Spanish labels for reasoning effort levels.
enum EffortLabel {
    static func name(_ effort: String) -> String {
        switch effort.lowercased() {
        case "none": return "Sin razonamiento"
        case "minimal": return "Mínimo"
        case "low": return "Bajo"
        case "medium": return "Medio"
        case "high": return "Alto"
        case "xhigh": return "Muy alto"
        case "max": return "Máximo"
        case "disabled": return "Desactivado"
        case "enabled": return "Activado"
        default: return effort.capitalized
        }
    }
}
