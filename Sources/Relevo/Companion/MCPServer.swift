import Foundation
import Network

/// Relevo as an MCP server (Streamable HTTP, JSON responses) so agents Relevo didn't start — Claude Code or Codex
/// in a terminal, for instance — can read your threads and, if you allow it, start and steer them.
/// Listens only on 127.0.0.1, needs a bearer token, and is read-only unless "full access" is on.
@MainActor
final class MCPServer {
    static let shared = MCPServer()
    static let tokenKey = "mcp-token"
    private var listener: NWListener?
    private weak var store: AppStore?
    private(set) var listeningPort: Int?
    private(set) var lastError: String?

    var token: String {
        if let t = ProcessInfo.processInfo.environment["RELEVO_MCP_TOKEN"], !t.isEmpty { return t }
        if let t = Keychain.get(Self.tokenKey) { return t }
        return regenerateToken()
    }

    @discardableResult
    func regenerateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let t = bytes.map { String(format: "%02x", $0) }.joined()
        _ = Keychain.set(t, for: Self.tokenKey)
        return t
    }

    func attach(_ store: AppStore) {
        self.store = store
        settingsChanged()
    }

    func settingsChanged() {
        guard let store else { return }
        if store.settings.mcpEnabled {
            if listeningPort != store.settings.mcpPort { start(port: store.settings.mcpPort) }
        } else {
            stop()
        }
    }

    var url: String { "http://127.0.0.1:\(store?.settings.mcpPort ?? 47821)/mcp" }

    private func start(port: Int) {
        stop()
        guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: p)
        params.allowLocalEndpointReuse = true
        do {
            let l = try NWListener(using: params)
            l.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.accept(connection) }
            }
            l.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    if case .failed(let error) = state { self?.lastError = error.localizedDescription; self?.listeningPort = nil }
                    if case .ready = state { self?.lastError = nil }
                }
            }
            l.start(queue: .main)
            listener = l
            listeningPort = port
        } catch {
            lastError = error.localizedDescription
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        listeningPort = nil
    }

    // MARK: - HTTP

    struct Request {
        var method: String
        var path: String
        var headers: [String: String]
        var body: Data
    }

    /// A full request out of the bytes received so far, or nil if more are needed.
    static func parse(_ data: Data) -> Request? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[end.upperBound...]
        guard body.count >= length else { return nil }
        return Request(method: String(first[0]), path: String(first[1]), headers: headers, body: Data(body.prefix(length)))
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            Task { @MainActor in
                guard let self else { return }
                var buf = buffer
                if let data { buf.append(data) }
                if let request = Self.parse(buf) {
                    let (status, headers, body) = await self.respond(request)
                    self.send(connection, status: status, headers: headers, body: body)
                } else if done || error != nil || buf.count > 8 << 20 {
                    connection.cancel()
                } else {
                    self.receive(connection, buffer: buf)
                }
            }
        }
    }

    private func send(_ connection: NWConnection, status: Int, headers: [String: String], body: Data) {
        let reason = [200: "OK", 202: "Accepted", 204: "No Content", 400: "Bad Request", 401: "Unauthorized",
                      403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed"][status] ?? "OK"
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var data = Data(head.utf8)
        data.append(body)
        connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func respond(_ r: Request) async -> (Int, [String: String], Data) {
        guard r.path.split(separator: "?").first.map(String.init)?.hasSuffix("/mcp") == true else { return (404, [:], Data()) }
        // Browsers can reach localhost: refuse pages from other origins (DNS rebinding).
        if let origin = r.headers["origin"], !(origin.hasPrefix("http://127.0.0.1") || origin.hasPrefix("http://localhost")) {
            return (403, [:], Data())
        }
        guard r.headers["authorization"] == "Bearer \(token)" else {
            return (401, ["WWW-Authenticate": "Bearer realm=\"relevo\""], Data("Relevo: token incorrecto".utf8))
        }
        switch r.method {
        case "POST": break
        case "DELETE": return (200, [:], Data())
        case "OPTIONS": return (204, ["Allow": "POST, DELETE"], Data())
        default: return (405, ["Allow": "POST, DELETE"], Data())
        }
        guard let json = try? JSONSerialization.jsonObject(with: r.body) else { return (400, [:], Data()) }
        var extra: [String: String] = ["Content-Type": "application/json"]
        let messages: [JSONObject] = (json as? [JSONObject]) ?? [(json as? JSONObject) ?? [:]]
        var replies: [JSONObject] = []
        for m in messages {
            if m.str("method") == "initialize" { extra["Mcp-Session-Id"] = UUID().uuidString }
            if let reply = await handle(m) { replies.append(reply) }
        }
        guard !replies.isEmpty else { return (202, [:], Data()) }
        let body: Any = json is [Any] ? replies : replies[0]
        return (200, extra, (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
    }

    // MARK: - JSON-RPC

    private func handle(_ m: JSONObject) async -> JSONObject? {
        guard let method = m.str("method") else { return nil }
        guard let id = m["id"] else { return nil }   // notifications need no answer
        let params = m.obj("params") ?? [:]
        func reply(_ result: Any) -> JSONObject { ["jsonrpc": "2.0", "id": id, "result": result] }
        switch method {
        case "initialize":
            return reply([
                "protocolVersion": params.str("protocolVersion") ?? "2025-06-18",
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "relevo", "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"],
                "instructions": "Relevo runs several AI coding agents (Claude Code, Codex, Gemini, GLM…) on the user's own subscriptions, "
                    + "one thread per conversation. Use these tools to see projects, threads and usage"
                    + (fullAccess ? ", and to start, message, stop or relay threads." : ". Access is read-only."),
            ] as JSONObject)
        case "ping":
            return reply([String: Any]())
        case "tools/list":
            return reply(["tools": MCPTools.definitions(full: fullAccess)])
        case "tools/call":
            guard let store, let name = params.str("name") else { return error(id, -32602, "Missing tool name") }
            let args = params.obj("arguments") ?? [:]
            let (text, isError) = await MCPTools.call(name, args, full: fullAccess, store: store)
            return reply(["content": [["type": "text", "text": text]], "isError": isError] as JSONObject)
        default:
            return error(id, -32601, "Method not found: \(method)")
        }
    }

    private var fullAccess: Bool { store?.settings.mcpFullAccess ?? false }

    private func error(_ id: Any, _ code: Int, _ message: String) -> JSONObject {
        ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message] as JSONObject]
    }
}

/// The tools Relevo offers to outside agents.
@MainActor
enum MCPTools {
    static let readOnly: Set<String> = ["list_projects", "list_threads", "read_thread", "get_usage", "list_accounts"]

    static func definitions(full: Bool) -> [JSONObject] {
        func tool(_ name: String, _ description: String, _ properties: JSONObject = [:], required: [String] = []) -> JSONObject {
            ["name": name, "description": description,
             "inputSchema": ["type": "object", "properties": properties, "required": required] as JSONObject]
        }
        let str: (String) -> JSONObject = { ["type": "string", "description": $0] }
        var tools: [JSONObject] = [
            tool("list_projects", "Projects (folders) Relevo works in, with their thread counts."),
            tool("list_threads", "Threads, newest first: id, title, project, whether an agent is working, agent and model, worktree branch and PR.",
                 ["project": str("Project id or name (optional)"), "limit": ["type": "integer", "description": "Max threads (default 30)"]]),
            tool("read_thread", "The latest messages of a thread (user, agent, tools, notices).",
                 ["thread_id": str("Thread id"), "last": ["type": "integer", "description": "How many items (default 20)"]], required: ["thread_id"]),
            tool("get_usage", "Tokens and API-equivalent cost by model, and what model or provider switches cost.",
                 ["period": ["type": "string", "enum": ["today", "week", "month", "all"]] as JSONObject]),
            tool("list_accounts", "Subscriptions Relevo can use, their models and how much quota is left."),
        ]
        if full {
            tools += [
                tool("create_thread", "Starts a new thread in a project and sends it a first message.",
                     ["project": str("Project id or name"), "prompt": str("First message"),
                      "account": str("Subscription name or provider (optional; default: Relevo's choice)"),
                      "model": str("Model id (optional)"), "worktree": ["type": "boolean", "description": "Work in a new git worktree (default false)"]],
                     required: ["project", "prompt"]),
                tool("send_message", "Sends a message to a thread (queued if its agent is busy; with now=true it interrupts and sends at once).",
                     ["thread_id": str("Thread id"), "text": str("Message"), "now": ["type": "boolean"]], required: ["thread_id", "text"]),
                tool("stop_thread", "Stops the agent working in a thread.", ["thread_id": str("Thread id")], required: ["thread_id"]),
                tool("relay_thread", "Hands a thread to another subscription/model, with its context.",
                     ["thread_id": str("Thread id"), "account": str("Subscription name or provider"), "model": str("Model id (optional)")],
                     required: ["thread_id", "account"]),
            ]
        }
        return tools
    }

    static func call(_ name: String, _ a: JSONObject, full: Bool, store: AppStore) async -> (String, Bool) {
        guard readOnly.contains(name) || full else {
            return ("Relevo only allows read access. The user can enable full access in Relevo › Ajustes › Integraciones.", true)
        }
        switch name {
        case "list_projects":
            let lines = store.projects.map { p in "- \(p.name) (id \(p.id.uuidString)) — \(p.path) — \(store.threads(in: p.id).count) threads" }
            return (lines.isEmpty ? "No projects." : lines.joined(separator: "\n"), false)
        case "list_threads":
            var threads = store.threads.sorted { $0.updatedAt > $1.updatedAt }
            if let p = a.str("project"), let project = findProject(p, store: store) { threads = threads.filter { $0.projectId == project.id } }
            let lines = threads.prefix(a.int("limit") ?? 30).map { t -> String in
                let rt = store.existingRuntime(t.id)
                let state = rt?.isRunning == true ? "working" : rt?.limit != nil ? "out of quota" : "idle"
                let agent = store.account(t.selectedAccountId).map { "\($0.name) · \(store.modelName($0, t.selectedModel ?? ""))" } ?? "-"
                var line = "- \(t.title) (id \(t.id.uuidString)) — \(store.project(t.projectId)?.name ?? "?") — \(state) — \(agent) — updated \(t.updatedAt.formatted(.iso8601))"
                if let w = t.worktree { line += " — worktree \(w.branch)" }
                if let pr = t.pullRequest { line += " — PR #\(pr.number) \(pr.state)" }
                return line
            }
            return (lines.isEmpty ? "No threads." : lines.joined(separator: "\n"), false)
        case "read_thread":
            guard let t = findThread(a.str("thread_id"), store: store) else { return ("Thread not found.", true) }
            let items = t.items.suffix(max(1, min(200, a.int("last") ?? 20)))
            let text = items.map { i -> String in
                switch i.kind {
                case .user: return "[user] " + String(i.text.prefix(4000))
                case .assistant: return "[agent\(i.model.map { " · \($0)" } ?? "")] " + String(i.text.prefix(4000))
                case .tool: return "[tool] \(i.title ?? i.toolName ?? "") → \(i.status?.rawValue ?? "")"
                case .reasoning: return "[thinking] " + String(i.text.prefix(600))
                case .notice: return "[notice] " + i.text
                case .error: return "[error] " + i.text
                case .approval: return "[approval] \(i.title ?? "") → \(i.resolution ?? "pending")"
                }
            }.joined(separator: "\n\n")
            return ("Thread «\(t.title)»\n\n" + text, false)
        case "get_usage":
            let period = UsagePeriod(rawValue: a.str("period") ?? "week") ?? .week
            let r = UsageAnalytics.report(period, store: store)
            var out = "\(period.label): \(r.turns) turns, \(r.tokens.total) tokens (\(Int((r.tokens.cacheShare ?? 0) * 100))% from cache), ≈ $\(String(format: "%.2f", r.cost)) API equivalent.\n"
            out += "Switches: \(r.switches.count), \(r.switchOverhead) tokens re-processed, ≈ $\(String(format: "%.2f", r.switchCost)).\n"
            for m in r.models { out += "- \(UsageAnalytics.providerName(m.provider)) · \(m.name): \(m.turns) turns, \(m.tokens.total) tokens, ≈ $\(String(format: "%.2f", m.cost))\n" }
            return (out, false)
        case "list_accounts":
            let lines = store.enabledAccounts.map { acc -> String in
                let s = store.status[acc.id]
                let quota = (s?.windows ?? []).map { "\($0.label) \(Int($0.percent))% used" }.joined(separator: ", ")
                let models = store.modelsFor(acc).map(\.id).prefix(12).joined(separator: ", ")
                return "- \(acc.name) (\(acc.kind.rawValue)) — \(s?.isUsable == false ? "not usable now" : "usable")" + (quota.isEmpty ? "" : " — \(quota)") + " — models: \(models)"
            }
            return (lines.joined(separator: "\n"), false)
        case "create_thread":
            guard let p = a.str("project"), let project = findProject(p, store: store), let prompt = a.str("prompt") else { return ("Project not found or prompt missing.", true) }
            let account = a.str("account").flatMap { findAccount($0, store: store) }
            let thread: ThreadModel
            if a.bool("worktree") == true {
                let t = ThreadModel(projectId: project.id, mode: store.settings.defaultMode, accountId: account?.id ?? store.preferredAccount()?.id, model: nil)
                store.threads.insert(t, at: 0)
                do { _ = try await Worktrees.create(for: t, project: project, store: store) }
                catch { return ("Could not create the worktree: \(error.localizedDescription)", true) }
                thread = t
            } else {
                guard let t = store.newThread(in: project, select: false) else { return ("Could not create the thread.", true) }
                thread = t
            }
            if let account { thread.selectedAccountId = account.id; thread.selectedModel = a.str("model") ?? store.defaultModel(for: account) }
            else if let model = a.str("model") { thread.selectedModel = model }
            store.runtime(for: thread).send(prompt)
            return ("Started thread \(thread.id.uuidString) in \(project.name).", false)
        case "send_message":
            guard let t = findThread(a.str("thread_id"), store: store), let text = a.str("text") else { return ("Thread not found or text missing.", true) }
            let rt = store.runtime(for: t)
            let busy = rt.isRunning
            if a.bool("now") == true { rt.sendNow(text) } else { rt.send(text) }
            return (busy && a.bool("now") != true ? "Queued: the agent is busy." : "Sent.", false)
        case "stop_thread":
            guard let t = findThread(a.str("thread_id"), store: store) else { return ("Thread not found.", true) }
            store.runtime(for: t).stop(from: .external("agente externo"))
            return ("Stopping.", false)
        case "relay_thread":
            guard let t = findThread(a.str("thread_id"), store: store), let acc = a.str("account").flatMap({ findAccount($0, store: store) }) else {
                return ("Thread or subscription not found.", true)
            }
            store.runtime(for: t).relay(to: acc, model: a.str("model") ?? store.defaultModel(for: acc))
            return ("Relayed to \(acc.name).", false)
        default:
            return ("Unknown tool \(name).", true)
        }
    }

    private static func findProject(_ key: String, store: AppStore) -> Project? {
        store.projects.first { $0.id.uuidString == key } ?? store.projects.first { $0.name.lowercased() == key.lowercased() }
    }

    private static func findThread(_ key: String?, store: AppStore) -> ThreadModel? {
        guard let key else { return nil }
        return store.threads.first { $0.id.uuidString.lowercased() == key.lowercased() }
    }

    private static func findAccount(_ key: String, store: AppStore) -> Account? {
        let k = key.lowercased()
        return store.enabledAccounts.first { $0.id.uuidString.lowercased() == k || $0.name.lowercased() == k || $0.kind.rawValue == k }
    }
}
