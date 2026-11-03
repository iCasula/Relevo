import Foundation

/// A child process that speaks newline-delimited text (JSON lines) over stdio.
/// All callbacks are delivered on the main queue, in order.
final class LineProcess {
    private let process = Process()
    private let inPipe = Pipe()
    private let outPipe = Pipe()
    private let errPipe = Pipe()
    private var outBuffer = Data()
    private var errBuffer = Data()
    private let lock = NSLock()
    private(set) var stderrTail = ""

    var onLine: ((String) -> Void)?
    var onStderrLine: ((String) -> Void)?
    var onExit: ((Int32) -> Void)?

    let executable: String
    let arguments: [String]

    init(executable: String, arguments: [String], cwd: String?, environment: [String: String]) {
        self.executable = executable
        self.arguments = arguments
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let cwd, FileManager.default.fileExists(atPath: cwd) {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }
        process.environment = environment
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = errPipe
    }

    var isRunning: Bool { process.isRunning }
    var pid: Int32 { process.processIdentifier }

    func start() throws {
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                self?.flush(isError: false)
                return
            }
            self?.consume(data, isError: false)
        }
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                self?.flush(isError: true)
                return
            }
            self?.consume(data, isError: true)
        }
        process.terminationHandler = { [weak self] p in
            let code = p.terminationStatus
            // Give the pipes a moment to drain before reporting the exit.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                self?.onExit?(code)
            }
        }
        try process.run()
    }

    private func consume(_ data: Data, isError: Bool) {
        var lines: [String] = []
        lock.lock()
        if isError { errBuffer.append(data) } else { outBuffer.append(data) }
        while true {
            let buffer = isError ? errBuffer : outBuffer
            guard let nl = buffer.firstIndex(of: 0x0A) else { break }
            let lineData = buffer[buffer.startIndex..<nl]
            lines.append(String(decoding: lineData, as: UTF8.self))
            let rest = buffer[buffer.index(after: nl)...]
            if isError { errBuffer = Data(rest) } else { outBuffer = Data(rest) }
        }
        lock.unlock()
        guard !lines.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for line in lines { self.deliver(line, isError: isError) }
        }
    }

    private func flush(isError: Bool) {
        lock.lock()
        let rest = isError ? errBuffer : outBuffer
        if isError { errBuffer = Data() } else { outBuffer = Data() }
        lock.unlock()
        guard !rest.isEmpty else { return }
        let line = String(decoding: rest, as: UTF8.self)
        DispatchQueue.main.async { [weak self] in self?.deliver(line, isError: isError) }
    }

    private func deliver(_ line: String, isError: Bool) {
        if isError {
            stderrTail += line + "\n"
            if stderrTail.count > 6000 { stderrTail = String(stderrTail.suffix(4000)) }
            onStderrLine?(line)
        } else {
            onLine?(line)
        }
    }

    @discardableResult
    func write(json: Any) -> Bool {
        guard var data = JSONUtil.encode(json) else { return false }
        data.append(0x0A)
        return write(data: data)
    }

    @discardableResult
    func write(data: Data) -> Bool {
        guard process.isRunning else { return false }
        do {
            try inPipe.fileHandleForWriting.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }

    func closeInput() {
        try? inPipe.fileHandleForWriting.close()
    }

    func terminate() {
        guard process.isRunning else { return }
        process.terminate()
        let p = process
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
    }

    func interruptSignal() {
        guard process.isRunning else { return }
        kill(process.processIdentifier, SIGINT)
    }
}

/// Minimal JSON-RPC 2.0 client over a LineProcess (used for Codex app-server and ACP agents).
@MainActor
final class RPCClient {
    struct RPCError: Error, CustomStringConvertible {
        let code: Int
        let message: String
        let data: Any?
        var description: String { message }
    }

    let process: LineProcess
    private let includeVersion: Bool
    private var nextId = 1
    private var pending: [Int: (Result<Any, RPCError>) -> Void] = [:]

    var onNotification: ((String, JSONObject) -> Void)?
    var onRequest: ((Any, String, JSONObject) -> Void)?
    var onExit: ((Int32, String) -> Void)?
    var onRawLine: ((String) -> Void)?

    init(process: LineProcess, includeVersion: Bool) {
        self.process = process
        self.includeVersion = includeVersion
        process.onLine = { [weak self] line in self?.handle(line) }
        process.onExit = { [weak self] code in
            guard let self else { return }
            let tail = self.process.stderrTail
            let callbacks = self.pending
            self.pending.removeAll()
            for (_, cb) in callbacks {
                cb(.failure(RPCError(code: -32099, message: "El proceso terminó (\(code)). \(tail.suffix(400))", data: nil)))
            }
            self.onExit?(code, tail)
        }
    }

    func start() throws { try process.start() }

    func request(_ method: String, _ params: Any? = nil, _ completion: @escaping (Result<Any, RPCError>) -> Void) {
        let id = nextId
        nextId += 1
        var message: JSONObject = ["id": id, "method": method]
        if includeVersion { message["jsonrpc"] = "2.0" }
        if let params { message["params"] = params }
        pending[id] = completion
        if !process.write(json: message) {
            pending.removeValue(forKey: id)
            completion(.failure(RPCError(code: -32098, message: "No se pudo escribir en el proceso", data: nil)))
        }
    }

    func request(_ method: String, _ params: Any? = nil) async -> Result<Any, RPCError> {
        await withCheckedContinuation { cont in
            request(method, params) { cont.resume(returning: $0) }
        }
    }

    func notify(_ method: String, _ params: Any? = nil) {
        var message: JSONObject = ["method": method]
        if includeVersion { message["jsonrpc"] = "2.0" }
        if let params { message["params"] = params }
        process.write(json: message)
    }

    func respond(id: Any, result: Any) {
        var message: JSONObject = ["id": id, "result": result]
        if includeVersion { message["jsonrpc"] = "2.0" }
        process.write(json: message)
    }

    func respondError(id: Any, code: Int = -32601, message text: String) {
        var message: JSONObject = ["id": id, "error": ["code": code, "message": text]]
        if includeVersion { message["jsonrpc"] = "2.0" }
        process.write(json: message)
    }

    private func handle(_ line: String) {
        onRawLine?(line)
        guard let o = JSONUtil.parse(line) else { return }
        if let method = o.str("method") {
            let params = o.obj("params") ?? [:]
            if let id = o["id"], !(id is NSNull) {
                onRequest?(id, method, params)
            } else {
                onNotification?(method, params)
            }
            return
        }
        guard let id = o.int("id"), let cb = pending.removeValue(forKey: id) else { return }
        if let err = o.obj("error") {
            cb(.failure(RPCError(code: err.int("code") ?? -1, message: err.str("message") ?? "Error", data: err["data"])))
        } else {
            cb(.success(o["result"] ?? NSNull()))
        }
    }

    func terminate() { process.terminate() }
}
