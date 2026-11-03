import Foundation
import AppKit
import Observation

/// Live state of a thread: the running agent session, approvals, the limit banner —
/// and the continuous SQLite trace that makes handoffs know where the work stopped.
@Observable
@MainActor
final class ThreadRuntime {
    let thread: ThreadModel
    @ObservationIgnored unowned let store: AppStore

    var isRunning = false
    var statusLine: String?
    var limit: LimitNotice?
    /// «Relevo sugiere» for the draft being written.
    let suggester: Suggester
    /// Tool/reasoning rows the user opened, by item id (not view @State: lazy rows get recycled).
    var expandedItems = Set<String>()

    struct QueuedMessage: Identifiable, Equatable {
        let id = UUID()
        var text: String
    }
    /// File shown in Quick Look (an image or path the agent mentioned).
    var previewURL: URL?

    /// Opens a path from a reply: files in Quick Look, folders in Finder.
    func openReference(_ reference: String, nearText: String? = nil) {
        guard let url = FilePaths.resolve(reference, thread: thread, projectPath: project?.path, nearText: nearText) else {
            store.flash("No encuentro «\(reference)» en este Mac")
            return
        }
        if FilePaths.isDirectory(url) { NSWorkspace.shared.open(url) } else { previewURL = url }
    }

    /// Messages sent while the agent works: one goes out each time a turn finishes normally.
    var queue: [QueuedMessage] = []
    /// After an error, a limit or a stop the queue waits for you instead of firing at the wrong moment.
    var queuePaused = false

    func toggleExpanded(_ id: String) {
        if expandedItems.remove(id) == nil { expandedItems.insert(id) }
    }

    @ObservationIgnored private var session: AgentSession?
    @ObservationIgnored private var sessionAccountId: UUID?
    @ObservationIgnored private var approvals: [String: (String) -> Void] = [:]
    @ObservationIgnored private var lastDispatch: (text: String, accountId: UUID, model: String)?
    @ObservationIgnored private var recoveringLostSession = false
    @ObservationIgnored private var autoRelayed = Set<UUID>()
    @ObservationIgnored private var sessionNonce = "s0"
    @ObservationIgnored private var resumingApprovals = Set<String>()
    // Trace bookkeeping for the current turn.
    @ObservationIgnored private var turnStartIndex = 0
    @ObservationIgnored private var turnFailed = false
    @ObservationIgnored private var stoppedByUser = false
    @ObservationIgnored private var tracedTools = Set<String>()
    @ObservationIgnored private var runningToolRefs = Set<String>()
    // Outcome of the current request, so «Relevo sugiere» learns which models finish each kind of task.
    @ObservationIgnored private var turnProfile: TaskProfile?
    @ObservationIgnored private var turnFailureKind: AgentFailure.Kind?
    // Watchdog: notices when a working agent goes quiet or its process disappears.
    @ObservationIgnored private var lastActivity = Date()
    @ObservationIgnored private var watchdog: Task<Void, Never>?
    @ObservationIgnored private var agentStatus: String?
    @ObservationIgnored private var stopSource: StopSource?
    @ObservationIgnored private var redirectText: String?

    init(thread: ThreadModel, store: AppStore) {
        self.thread = thread
        self.store = store
        self.suggester = Suggester(thread: thread, store: store)
        suggester.runtime = self
    }

    private var project: Project? { store.project(thread.projectId) }
    private var trace: TraceStore { store.trace }

    private enum SegmentPlan {
        case direct
        case handoff(noticeId: String)
    }

    // MARK: - Sending

    func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if isRunning {
            queue.append(QueuedMessage(text: text))
            return
        }
        guard let account = store.account(thread.selectedAccountId) ?? store.preferredAccount() else {
            append(ChatItem(id: UUID().uuidString, kind: .error, text: "No hay ninguna suscripción activa. Añade una en Ajustes › Suscripciones."))
            return
        }
        let model = thread.selectedModel ?? store.defaultModel(for: account)
        // Moving to another model by hand right after a turn suggests the previous one fell short.
        if let last = thread.segments.last, last.accountId != account.id || last.model != model, !suggester.selectionFromSuggestion {
            trace.markLastOutcomeSwitched(thread: thread.id)
        }
        turnProfile = suggester.didSend(text)
        thread.selectedAccountId = account.id
        thread.selectedModel = model
        if thread.title == ThreadModel.untitled {
            thread.title = String(text.replacingOccurrences(of: "\n", with: " ").prefix(70))
        }
        autoRelayed.removeAll()
        let history = thread.items
        let plan = prepareSegment(account: account, model: model, history: history)
        let userItem = ChatItem(id: UUID().uuidString, kind: .user, text: text, accountId: account.id, model: model)
        append(userItem)
        TopicNamer.maybeName(thread, store: store)
        record(ref: "u:" + userItem.id, kind: "request", title: String(text.prefix(200)), detail: String(text.prefix(8000)), accountId: account.id)
        captureStartHeadIfNeeded()
        launch(plan, request: text, history: history, pending: false, account: account, model: model)
    }

    /// Interrupts the agent and sends this right away in the same conversation (redirecting it).
    /// The rest of the queue keeps going afterwards: this stop was on purpose.
    func sendNow(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard isRunning else { send(text); return }
        redirectText = text
        stop(from: .redirect)
    }

    func sendQueuedNow(_ id: UUID) {
        guard let index = queue.firstIndex(where: { $0.id == id }) else { return }
        sendNow(queue.remove(at: index).text)
    }

    /// After a stop (by the CLI's answer or the fallback), the redirected message goes out at once.
    private func sendRedirectIfNeeded() -> Bool {
        guard let text = redirectText else { return false }
        redirectText = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.send(text) }
        return true
    }

    func removeQueued(_ id: UUID) {
        queue.removeAll { $0.id == id }
        if queue.isEmpty { queuePaused = false }
    }

    func resumeQueue() {
        queuePaused = false
        sendNextQueued()
    }

    private func sendNextQueued() {
        guard !isRunning, !queuePaused, !queue.isEmpty else { return }
        send(queue.removeFirst().text)
    }

    /// Re-sends the last user request to another subscription, carrying the whole context and the trace.
    func relay(to account: Account, model: String) {
        if isRunning { stop(from: .relay) }
        queuePaused = false   // the queue continues once the new agent finishes this request
        thread.selectedAccountId = account.id
        thread.selectedModel = model
        if let effort = thread.selectedEffort, !(store.efforts(for: account, model: model)?.contains(effort) ?? false) {
            thread.selectedEffort = nil
        }
        guard let lastUser = thread.items.last(where: { $0.kind == .user }) else { return }
        limit = nil
        let plan = prepareSegment(account: account, model: model, history: thread.items)
        launch(plan, request: lastUser.text, history: thread.items, pending: true, account: account, model: model)
    }

    private func launch(_ plan: SegmentPlan, request: String, history: [ChatItem], pending: Bool, account: Account, model: String) {
        switch plan {
        case .direct:
            dispatch(request, account: account, model: model)
        case .handoff(let noticeId):
            guard let project else { dispatch(request, account: account, model: model); return }
            isRunning = true
            statusLine = "Preparando el traspaso de contexto…"
            Task { @MainActor in
                let base = self.trace.checkpoints(thread: self.thread.id, limit: 500).last(where: { $0.reason == "inicio" })?.detail
                let git = await GitSnapshot.capture(project.path, since: base)
                let package = Handoff.build(thread: self.thread, items: history, project: project, store: self.store,
                                            target: account, pendingRequest: pending, git: git)
                if let idx = self.thread.items.lastIndex(where: { $0.id == noticeId }) { self.thread.items[idx].output = package.file }
                self.dispatch(package.text + request, account: account, model: model)
            }
        }
    }

    /// Makes sure the active segment matches the chosen subscription/model.
    private func prepareSegment(account: Account, model: String, history: [ChatItem]) -> SegmentPlan {
        if let last = thread.segments.indices.last, thread.segments[last].accountId == account.id {
            if thread.segments[last].model != model {
                thread.segments[last].model = model
                session?.setModel(model)
                session?.setEffort(validEffort(account: account, model: model))
                append(ChatItem(id: UUID().uuidString, kind: .notice, text: "Modelo cambiado a \(store.modelName(account, model))", accountId: account.id, model: model))
            }
            return .direct
        }
        closeSession()
        let previous = thread.segments.last
        let segment = Segment(accountId: account.id, kind: account.kind, model: model, startItem: thread.items.count)
        var plan = SegmentPlan.direct
        let hasHistory = history.contains { $0.kind == .user || $0.kind == .assistant }
        if let previous, hasHistory, project != nil {
            let fromAccount = store.account(previous.accountId)
            let fromName = fromAccount.map { "\($0.name) · \(store.modelName($0, previous.model))" } ?? "otro agente"
            let toName = "\(account.name) · \(store.modelName(account, model))"
            trace.checkpoint(thread: thread.id, reason: "Relevo a \(toName)", context: fromAccount.map { context($0, model: previous.model) })
            record(ref: "h:" + UUID().uuidString, kind: "handoff", title: "Relevo: \(fromName) → \(toName)", accountId: account.id)
            let notice = ChatItem(id: UUID().uuidString, kind: .notice, text: "Relevo: \(fromName) → \(toName) · contexto y traza traspasados", accountId: account.id, model: model)
            append(notice)
            plan = .handoff(noticeId: notice.id)
        }
        thread.segments.append(segment)
        store.updateAccount(account.id) { $0.lastModel = model }
        return plan
    }

    private func dispatch(_ text: String, account: Account, model: String) {
        limit = nil
        lastDispatch = (text, account.id, model)
        isRunning = true
        turnStartIndex = thread.items.count
        turnFailed = false
        turnFailureKind = nil
        stoppedByUser = false
        stopSource = nil
        startWatchdog()
        statusLine = "Iniciando \(account.kind.agentName)…"
        do {
            let s = try ensureSession(account: account, model: model)
            s.send(text)
        } catch {
            isRunning = false
            statusLine = nil
            append(ChatItem(id: UUID().uuidString, kind: .error, text: error.localizedDescription, accountId: account.id))
        }
        store.save(thread)
    }

    private func ensureSession(account: Account, model: String) throws -> AgentSession {
        if let session, sessionAccountId == account.id {
            if session.isAlive { return session }
            // The CLI exited since the last turn: start again resuming the same conversation.
            append(ChatItem(id: UUID().uuidString, kind: .notice, text: "\(account.kind.agentName) se había cerrado; lo reabro retomando la conversación", accountId: account.id))
        }
        closeSession()
        guard let project else { throw AgentFailure(kind: .other, message: "Proyecto no encontrado") }
        let resume = thread.segments.last?.accountId == account.id ? thread.segments.last?.nativeSessionId : nil
        let effort = validEffort(account: account, model: model)
        let s = AgentFactory.make(account: account, cwd: project.path, model: model, effort: effort, mode: thread.mode, resumeId: resume)
        let accountId = account.id
        let nonce = String(UUID().uuidString.prefix(6))
        sessionNonce = nonce
        s.onEvent = { [weak self] event in self?.handle(event, accountId: accountId, nonce: nonce) }
        try s.start()
        session = s
        sessionAccountId = account.id
        return s
    }

    private func validEffort(account: Account, model: String) -> String? {
        guard let effort = thread.selectedEffort, store.efforts(for: account, model: model)?.contains(effort) == true else { return nil }
        return effort
    }

    /// Where a stop came from: shown in the thread and kept in the trace, so an unexpected stop can be traced.
    enum StopSource {
        case mac, shortcut, relay, redirect
        case iphone(String)

        var label: String {
            switch self {
            case .mac: "desde el Mac"
            case .shortcut: "con ⌘."
            case .relay: "para relevar a otro agente"
            case .redirect: "para enviar tu mensaje ya"
            case .iphone(let name): "desde el iPhone (\(name))"
            }
        }
    }

    func stop(from source: StopSource = .mac) {
        stoppedByUser = true
        stopSource = source
        session?.interrupt()
        statusLine = "Deteniendo…"
        let current = session
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self, self.isRunning, self.session === current else { return }
            self.closeSession()
            self.isRunning = false
            self.statusLine = nil
            self.finishTraceTurn(accountId: self.sessionAccountId ?? self.thread.selectedAccountId)
            self.append(ChatItem(id: UUID().uuidString, kind: .notice, text: "Detenido \(source.label)"))
            _ = self.sendRedirectIfNeeded()
        }
    }

    func setMode(_ mode: PermissionMode) {
        thread.mode = mode
        session?.setMode(mode)
        store.save(thread)
    }

    func setEffort(_ effort: String?) {
        thread.selectedEffort = effort
        if let account = store.account(sessionAccountId), let model = thread.segments.last?.model {
            session?.setEffort(validEffort(account: account, model: model))
        }
        store.save(thread)
    }

    func resolveApproval(itemId: String, option: ApprovalOption) {
        guard let idx = thread.items.lastIndex(where: { $0.id == itemId }) else { return }
        let key = String(itemId.dropFirst(2))
        thread.items[idx].resolution = option.label
        record(ref: "a:" + key, kind: "approval", title: "", status: option.label, accountId: thread.items[idx].accountId)
        if resumingApprovals.remove(key) != nil, option.isAllow {
            isRunning = true
            statusLine = "Reintentando con permiso…"
            turnStartIndex = thread.items.count
            turnFailed = false
        }
        approvals.removeValue(forKey: key)?(option.id)
    }

    /// Answers the agent's questions (question → chosen option(s) or free text).
    func answerQuestions(itemId: String, answers: [String: String]) {
        guard let idx = thread.items.lastIndex(where: { $0.id == itemId }), thread.items[idx].resolution == nil else { return }
        let key = String(itemId.dropFirst(2))
        thread.items[idx].resolution = "Respondido"
        thread.items[idx].answers = answers
        record(ref: "a:" + key, kind: "approval", title: "", detail: answers.map { "\($0.key) → \($0.value)" }.joined(separator: "\n"),
               status: "Respondido", accountId: thread.items[idx].accountId, appendDetail: true)
        statusLine = nil
        approvals.removeValue(forKey: key)?(ApprovalRequest.answers(answers))
        store.save(thread)
    }

    func closeSession() {
        session?.close()
        session = nil
        sessionAccountId = nil
        for (key, respond) in approvals {
            respond("deny")
            if let idx = thread.items.lastIndex(where: { $0.id == "a:" + key }) { thread.items[idx].resolution = "Cancelado" }
        }
        approvals.removeAll()
    }

    // MARK: - Agent events

    private func handle(_ event: AgentEvent, accountId: UUID, nonce: String) {
        let model = thread.segments.last?.model
        lastActivity = Date()
        if case .status(let s) = event { agentStatus = s }
        if let line = statusLine, line.hasPrefix("Lleva ") || line.hasPrefix("Sin actividad") { statusLine = nil }   // activity again
        let n = nonce + ":"
        switch event {
        case .sessionStarted(let id):
            if let last = thread.segments.indices.last, thread.segments[last].accountId == accountId {
                thread.segments[last].nativeSessionId = id
            }
            store.save(thread)
        case .textDelta(let key, let text):
            statusLine = nil
            upsert("m:" + n + key, kind: .assistant, accountId: accountId, model: model) { $0.text += text }
        case .textFinal(let key, let text):
            upsert("m:" + n + key, kind: .assistant, accountId: accountId, model: model) { $0.text = text }
        case .reasoningDelta(let key, let text):
            statusLine = "Pensando…"
            upsert("r:" + n + key, kind: .reasoning, accountId: accountId, model: model) { $0.text += text }
        case .reasoningFinal(let key, let text):
            upsert("r:" + n + key, kind: .reasoning, accountId: accountId, model: model) { $0.text = text }
        case .toolStarted(let key, let name, let title, let input):
            statusLine = nil
            let ref = "t:" + n + key
            upsert(ref, kind: .tool, accountId: accountId, model: model) {
                $0.toolName = name
                $0.title = title
                if $0.status == nil { $0.status = .running }
                if let input, $0.text.isEmpty { $0.text = input }
            }
            if tracedTools.insert(ref).inserted {
                runningToolRefs.insert(ref)
                let label = title.hasPrefix(name) || title.hasPrefix("Nueva tarea") || title.hasPrefix("Tarea #") ? title : "\(name): \(title)"
                record(ref: ref, kind: "tool", title: label, detail: input.map { String($0.prefix(1500)) }, status: "running", accountId: accountId)
                traceFiles(tool: name, title: title, input: input)
            }
        case .toolOutput(let key, let text):
            upsert("t:" + n + key, kind: .tool, accountId: accountId, model: model) {
                $0.output = ToolSummary.cap(($0.output ?? "") + text)
                if $0.status == nil { $0.status = .running }
            }
        case .toolFinished(let key, let status, let output):
            let ref = "t:" + n + key
            upsert(ref, kind: .tool, accountId: accountId, model: model) {
                $0.status = status
                if let output, !output.isEmpty { $0.output = output }
                if $0.title == nil { $0.title = $0.toolName ?? "Herramienta" }
            }
            runningToolRefs.remove(ref)
            let summary = output.map { status == .failed ? String($0.suffix(1200)) : String($0.prefix(500)) }
            if !tracedTools.contains(ref), let item = thread.items.last(where: { $0.id == ref }) {
                tracedTools.insert(ref)
                record(ref: ref, kind: "tool", title: "\(item.toolName ?? "Herramienta"): \(item.title ?? "")", accountId: accountId)
            }
            record(ref: ref, kind: "tool", title: "", detail: summary, status: status == .failed ? "failed" : "done", accountId: accountId, appendDetail: true)
        case .approval(let request):
            approvals[request.key] = request.respond
            if request.resumesTurn { resumingApprovals.insert(request.key) }
            else { statusLine = request.questions == nil ? "Esperando tu aprobación…" : "Esperando tu respuesta…" }
            append(ChatItem(id: "a:" + request.key, kind: .approval, text: request.detail, title: request.title,
                            accountId: accountId, model: model, options: request.options, questions: request.questions))
            record(ref: "a:" + request.key, kind: "approval", title: request.title, detail: request.detail, status: "pendiente", accountId: accountId)
            store.notifyApproval(thread: thread, title: request.title)
        case .usage(let windows, let plan):
            store.mergeUsage(accountId, windows: windows, plan: plan)
        case .models(let list):
            store.setModels(accountId, list)
        case .plan(let steps):
            if let account = store.account(accountId) {
                trace.setPlan(thread: thread.id, provider: "\(account.name) · \(store.modelName(account, model ?? ""))", steps: steps)
            }
        case .status(let s):
            statusLine = s
        case .notice(let text):
            append(ChatItem(id: UUID().uuidString, kind: .notice, text: text, accountId: accountId))
        case .failure(let failure):
            handleFailure(failure, accountId: accountId)
        case .turnFinished:
            isRunning = false
            statusLine = nil
            watchdog?.cancel()
            let interrupted = turnFailed || stoppedByUser
            for i in thread.items.indices where thread.items[i].kind == .tool && thread.items[i].status == .running {
                thread.items[i].status = interrupted ? .failed : .done
            }
            for (key, respond) in approvals where !resumingApprovals.contains(key) {
                respond("deny")
                approvals.removeValue(forKey: key)
                if let idx = thread.items.lastIndex(where: { $0.id == "a:" + key }) { thread.items[idx].resolution = "Expirado" }
            }
            finishTraceTurn(accountId: accountId)
            recordOutcome(accountId: accountId)
            if stoppedByUser { append(ChatItem(id: UUID().uuidString, kind: .notice, text: "Detenido \((stopSource ?? .mac).label)")) }
            thread.updatedAt = Date()
            store.save(thread)
            store.refreshUsageSoon(accountId)
            store.notifyTurnFinished(thread: thread)
            suggester.draftChanged()   // the next message may have been written while the agent worked
            if sendRedirectIfNeeded() {
                // Redirected on purpose: the remaining queue continues after this message.
            } else if !queue.isEmpty {
                if interrupted {
                    queuePaused = true
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.sendNextQueued() }
                }
            }
        }
    }

    private func handleFailure(_ failure: AgentFailure, accountId: UUID) {
        // Stopping makes some CLIs end the turn with an "error" (Claude Code: "[ede_diagnostic] …"):
        // that's the stop itself, already shown as "Detenido", not a failure of the agent.
        if stoppedByUser, failure.kind == .other || failure.kind == .unavailable {
            turnFailed = true
            return
        }
        if failure.kind == .sessionLost, !recoveringLostSession, let last = lastDispatch, let account = store.account(last.accountId), let project {
            // Native session could not be resumed: start fresh carrying transcript + trace instead.
            recoveringLostSession = true
            closeSession()
            if let i = thread.segments.indices.last { thread.segments[i].nativeSessionId = nil }
            let history = Array(thread.items)
            let request = thread.items.last(where: { $0.kind == .user })?.text ?? last.text
            append(ChatItem(id: UUID().uuidString, kind: .notice, text: "La sesión anterior no se pudo reanudar; continúo con el contexto traspasado", accountId: account.id))
            isRunning = true
            Task { @MainActor in
                let git = await GitSnapshot.capture(project.path)
                let package = Handoff.build(thread: self.thread, items: history, project: project, store: self.store, target: account, pendingRequest: true, git: git)
                self.dispatch(package.text + request, account: account, model: last.model)
                self.recoveringLostSession = false
            }
            return
        }
        turnFailed = true
        turnFailureKind = failure.kind
        append(ChatItem(id: UUID().uuidString, kind: .error, text: failure.message, accountId: accountId))
        let account = store.account(accountId)
        let kindName: String
        switch failure.kind {
        case .limit: kindName = "limit"
        default: kindName = "error"
        }
        record(ref: "e:" + UUID().uuidString, kind: kindName, title: String(failure.message.prefix(200)), detail: failure.message, accountId: accountId)
        let reason: String
        switch failure.kind {
        case .limit: reason = "Límite de uso alcanzado en \(account?.name ?? "la suscripción")"
        case .unavailable: reason = "Modelo no disponible (saturado)"
        case .auth: reason = "Sesión caducada o sin login"
        case .noPlan: reason = "El plan de \(account?.name ?? "la suscripción") no incluye el servicio"
        default: reason = "Error del agente"
        }
        var detail = failure.message
        if let r = failure.resetsAt { detail += " · se reinicia \(Formatters.reset(r) ?? "")" }
        trace.checkpoint(thread: thread.id, reason: reason, context: account.map { context($0, model: thread.segments.last?.model) }, detail: detail)
        switch failure.kind {
        case .limit:
            limit = LimitNotice(accountId: accountId, message: failure.message, resetsAt: failure.resetsAt)
            store.markExhausted(accountId, until: failure.resetsAt)
            if store.settings.autoRelay { autoRelay(from: accountId) }
        case .unavailable:
            limit = LimitNotice(accountId: accountId, message: failure.message, resetsAt: nil, isCapacity: true)
            if store.settings.autoRelay { autoRelay(from: accountId) }
        case .noPlan:
            limit = LimitNotice(accountId: accountId, message: failure.message, resetsAt: nil, isNoPlan: true)
            store.markNoPlan(accountId)
            if store.settings.autoRelay { autoRelay(from: accountId) }
        case .auth:
            let hint = account?.kind.usesAPIKey == true
                ? "Añade tu API key en Ajustes › Suscripciones › \(account?.name ?? "")"
                : "Inicia sesión en esta suscripción desde Ajustes › Suscripciones"
            append(ChatItem(id: UUID().uuidString, kind: .notice, text: hint, accountId: accountId))
            store.setLoggedOut(accountId)
        default:
            break
        }
    }

    private func autoRelay(from accountId: UUID) {
        autoRelayed.insert(accountId)
        guard let next = store.relayCandidates(excluding: autoRelayed).first else {
            append(ChatItem(id: UUID().uuidString, kind: .notice, text: "Relevo automático: no hay otra suscripción con cuota disponible"))
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, !self.isRunning else { return }
            self.relay(to: next.account, model: next.model)
        }
    }

    // MARK: - Trace

    private func context(_ account: Account, model: String?) -> TraceContext {
        TraceContext(provider: account.kind.shortName, account: account.name, model: store.modelName(account, model ?? ""))
    }

    private func record(ref: String, kind: String, title: String, detail: String? = nil, status: String? = nil, accountId: UUID?, appendDetail: Bool = false) {
        guard let project else { return }
        let ctx = store.account(accountId).map { context($0, model: thread.segments.last?.model) }
        trace.record(thread: thread.id, project: project.path, ref: ref, kind: kind, context: ctx, title: title, detail: detail, status: status, appendDetail: appendDetail)
    }

    /// Commits made during the thread are reported against the HEAD it started from.
    private func captureStartHeadIfNeeded() {
        guard let project, !trace.checkpoints(thread: thread.id, limit: 500).contains(where: { $0.reason == "inicio" }) else { return }
        let threadId = thread.id
        let trace = self.trace
        Task {
            if let head = await GitSnapshot.head(project.path) {
                trace.checkpoint(thread: threadId, reason: "inicio", context: nil, detail: head)
            }
        }
    }

    /// Records the agent's replies of this turn and marks tools that never finished.
    private func finishTraceTurn(accountId: UUID?) {
        let start = min(turnStartIndex, thread.items.count)
        for item in thread.items[start...] where item.kind == .assistant && !item.text.isEmpty {
            record(ref: item.id, kind: "reply", title: String(item.text.prefix(160)), detail: String(item.text.prefix(4000)), accountId: item.accountId ?? accountId)
        }
        let interrupted = turnFailed || stoppedByUser
        for ref in runningToolRefs {
            record(ref: ref, kind: "tool", title: "", status: interrupted ? "interrumpida" : "done", accountId: accountId)
        }
        runningToolRefs.removeAll()
        if stoppedByUser {
            trace.checkpoint(thread: thread.id, reason: "Detenido por el usuario \((stopSource ?? .mac).label)", context: store.account(accountId).map { context($0, model: thread.segments.last?.model) })
        } else if !turnFailed {
            trace.checkpoint(thread: thread.id, reason: "Turno completado", context: store.account(accountId).map { context($0, model: thread.segments.last?.model) })
        }
        turnStartIndex = thread.items.count
    }

    /// While a turn runs: after 2 quiet minutes the status line says so (you may want to stop or hand off);
    /// if the agent's process is gone, the turn is closed with an error instead of "working" forever.
    private func startWatchdog() {
        watchdog?.cancel()
        lastActivity = Date()
        watchdog = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, self.isRunning else { return }
                if let session = self.session, !session.isAlive {
                    self.handleFailure(AgentFailure(kind: .other, message: "El agente dejó de responder (su proceso terminó). Vuelve a enviar el mensaje o relévalo a otro agente."),
                                       accountId: self.sessionAccountId ?? self.thread.selectedAccountId ?? UUID())
                    self.closeSession()
                    self.isRunning = false
                    self.statusLine = nil
                    self.finishTraceTurn(accountId: self.thread.selectedAccountId)
                    if !self.queue.isEmpty { self.queuePaused = true }
                    return
                }
                let quiet = Date().timeIntervalSince(self.lastActivity)
                let waitingForYou = self.thread.items.suffix(5).contains { $0.kind == .approval && $0.resolution == nil }
                if quiet >= 120, !waitingForYou {
                    let minutes = Int(quiet / 60)
                    // A long command (builds, tests) is work, not a hang: say which one is running.
                    if let tool = self.thread.items.suffix(30).last(where: { $0.kind == .tool && $0.status == .running }) {
                        let name = String((tool.title ?? tool.toolName ?? "un comando").prefix(60))
                        self.statusLine = "Lleva \(minutes) min ejecutando: \(name)"
                    } else {
                        self.statusLine = "Sin actividad desde hace \(minutes) min · puedes detenerlo o relevarlo a otro agente"
                    }
                }
            }
        }
    }

    private func recordOutcome(accountId: UUID) {
        guard let profile = turnProfile, let account = store.account(accountId), let model = thread.segments.last?.model else { return }
        let result: String
        if stoppedByUser { result = "stopped" }
        else if turnFailed { result = [.limit, .unavailable, .noPlan].contains(turnFailureKind) ? "limit" : "error" }
        else { result = "ok" }
        trace.recordOutcome(thread: thread.id, level: profile.level.rawValue, task: profile.kind, provider: account.kind.rawValue, model: model, result: result)
    }

    private func traceFiles(tool: String, title: String, input: String?) {
        let name = tool.lowercased()
        let writes = ["edit", "write", "patch", "replace", "create", "notebook", "edición", "multiedit", "move", "delete", "rename"]
        guard writes.contains(where: { name.contains($0) }), !name.contains("read") else { return }
        var paths: [String] = []
        if let input, let o = JSONUtil.parse(input) {
            for key in ["file_path", "path", "filePath", "TargetFile", "AbsolutePath", "notebook_path", "target_file", "destination"] {
                if let p = o.str(key) { paths.append(p) }
            }
            paths += o.strs("files") + o.strs("paths")
        }
        if paths.isEmpty, name == "edición", title.hasPrefix("Editar ") {
            paths = title.dropFirst("Editar ".count).components(separatedBy: ", ")
        }
        let action = name.contains("write") || name.contains("create") ? "creado/escrito" : name.contains("delete") ? "borrado" : "editado"
        for p in paths where !p.isEmpty {
            let full = p.hasPrefix("/") || p.hasPrefix("~") ? expandTilde(p) : ((project?.path ?? "") as NSString).appendingPathComponent(p)
            trace.touch(thread: thread.id, path: full, action: action)
        }
    }

    // MARK: - Items

    private func append(_ item: ChatItem) {
        thread.items.append(item)
    }

    private func upsert(_ id: String, kind: ChatItem.Kind, accountId: UUID, model: String?, _ mutate: (inout ChatItem) -> Void) {
        let scan = thread.items.indices.reversed().prefix(400)
        if let idx = scan.first(where: { thread.items[$0].id == id }) {
            mutate(&thread.items[idx])
        } else {
            var item = ChatItem(id: id, kind: kind, accountId: accountId, model: model)
            mutate(&item)
            thread.items.append(item)
        }
    }
}
