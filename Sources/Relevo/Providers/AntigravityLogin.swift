import Foundation

/// The Google login of an isolated Antigravity account, as agy leaves it on disk.
///
/// In Relevo's isolated HOME agy can't reach the Keychain, so it keeps its login in
/// `.gemini/antigravity-cli/antigravity-oauth-token`. Two agy processes refreshing an expired token at once
/// can leave that file corrupt: a complete JSON object followed by the tail of a longer write. agy then
/// believes nobody is signed in, and every headless run starts the interactive OAuth flow in the browser.
enum AntigravityLogin {
    enum State: Equatable {
        case valid(expiry: Date?)
        case missing
        case unreadable
    }

    static func tokenPath(home: String) -> String { "\(home)/.gemini/antigravity-cli/antigravity-oauth-token" }

    /// The isolated HOME of an account (only there is the token file the source of truth; otherwise it's in the Keychain).
    static func isolatedHome(_ account: Account) -> String? {
        guard let dir = account.configDir?.trimmingCharacters(in: .whitespaces), !dir.isEmpty else { return nil }
        return expandTilde(dir)
    }

    /// Login state of an isolated HOME. Repairs the leftover-bytes corruption in place.
    static func state(home: String) -> State {
        let path = tokenPath(home: home)
        guard let data = FileManager.default.contents(atPath: path), !data.isEmpty else { return .missing }
        if let o = JSONUtil.parseAny(data) as? JSONObject { return state(of: o) }
        guard let length = firstObjectLength(data), length < data.count,
              let o = JSONUtil.parseAny(data.prefix(length)) as? JSONObject, case .valid = state(of: o) else { return .unreadable }
        do {
            let attributes = try? FileManager.default.attributesOfItem(atPath: path)
            try data.prefix(length).write(to: URL(fileURLWithPath: path), options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: attributes?[.posixPermissions] ?? 0o600], ofItemAtPath: path)
        } catch {
            return .unreadable
        }
        return state(of: o)
    }

    /// True when the next agy run will refresh the token (it has expired or is about to).
    static func needsRefresh(home: String, margin: TimeInterval = 30) -> Bool {
        guard case .valid(let expiry?) = state(home: home) else { return false }
        return expiry.timeIntervalSinceNow < margin
    }

    private static func state(of o: JSONObject) -> State {
        let token = o.obj("token") ?? o
        guard token.str("refresh_token")?.isEmpty == false || token.str("access_token")?.isEmpty == false else { return .unreadable }
        return .valid(expiry: DateParse.any(token["expiry"]))
    }

    /// Byte length of the first complete top-level JSON object in `data`, if there is one.
    static func firstObjectLength(_ data: Data) -> Int? {
        var depth = 0, inString = false, escaped = false, started = false
        for (offset, byte) in data.enumerated() {
            if inString {
                if escaped { escaped = false } else if byte == 0x5C { escaped = true } else if byte == 0x22 { inString = false }
                continue
            }
            switch byte {
            case 0x22: inString = true
            case 0x7B, 0x5B: depth += 1; started = true
            case 0x7D, 0x5D:
                depth -= 1
                if depth < 0 { return nil }
                if depth == 0 && started { return offset + 1 }
            case 0x20, 0x09, 0x0A, 0x0D: break
            default: if !started { return nil }
            }
        }
        return nil
    }
}

/// Keeps agy processes that share a HOME from refreshing the token at the same time.
/// Background runs (limits, models, quick completions) go one at a time; a turn that will refresh the token
/// holds the gate until it has.
actor AntigravityGate {
    static let shared = AntigravityGate()

    private var locked = Set<String>()
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var turns: [String: Int] = [:]

    func lock(_ home: String) async {
        if locked.insert(home).inserted { return }
        await withCheckedContinuation { waiters[home, default: []].append($0) }
    }

    func unlock(_ home: String) {
        if var queue = waiters[home], !queue.isEmpty {
            let next = queue.removeFirst()
            waiters[home] = queue
            next.resume()  // the lock passes straight to the next waiter
        } else {
            locked.remove(home)
        }
    }

    func turnStarted(_ home: String) { turns[home, default: 0] += 1 }
    func turnEnded(_ home: String) { turns[home] = max(0, (turns[home] ?? 0) - 1) }
    func turnsRunning(_ home: String) -> Int { turns[home] ?? 0 }
}

/// How Relevo launches agy so that it never opens sign-in pages on its own.
enum AntigravityRuns {
    /// What agy prints when it starts the interactive OAuth flow.
    static let authMarker = "Authentication required"

    enum Background {
        case output(out: String, err: String)
        case signedOut
    }

    enum TurnStart {
        case signedOut
        /// Launch now; call `release` once the process has refreshed the token or exited.
        case go(holdsGate: Bool)
    }

    static func home(of launch: Launch) -> String { launch.environment["HOME"] ?? NSHomeDirectory() }

    /// A short headless run: one at a time per HOME, never alongside a turn that is about to refresh the token,
    /// with the browser blocked and stopped as soon as agy asks for a sign-in.
    static func background(_ account: Account, _ launch: Launch, _ args: [String], timeout: TimeInterval = 40) async -> Background {
        let home = home(of: launch)
        let isolated = AntigravityLogin.isolatedHome(account) != nil
        let gate = AntigravityGate.shared
        await gate.lock(home)
        if isolated {
            guard case .valid = AntigravityLogin.state(home: home) else {
                await gate.unlock(home)
                return .signedOut
            }
            if AntigravityLogin.needsRefresh(home: home), await gate.turnsRunning(home) > 0 {
                await waitForFreshToken(home: home, upTo: 60)
            }
        }
        var quiet = launch
        quiet.environment["PATH"] = NoBrowser.directory + ":" + (launch.environment["PATH"] ?? "/usr/bin:/bin")
        let result = await ProcessRunner.capture(quiet, args, timeout: timeout, abortWhen: authMarker)
        await gate.unlock(home)
        if (result.err + result.out).contains(authMarker) { return .signedOut }
        return .output(out: result.out, err: result.err)
    }

    /// Before a turn: refuses when the saved login is unusable (agy would open the browser), and makes the turn
    /// wait its turn when the token is about to be refreshed.
    static func beginTurn(_ account: Account, home: String) async -> TurnStart {
        let gate = AntigravityGate.shared
        guard AntigravityLogin.isolatedHome(account) != nil else {
            await gate.turnStarted(home)
            return .go(holdsGate: false)
        }
        guard case .valid = AntigravityLogin.state(home: home) else { return .signedOut }
        guard AntigravityLogin.needsRefresh(home: home) else {
            await gate.turnStarted(home)
            return .go(holdsGate: false)
        }
        await gate.lock(home)
        if await gate.turnsRunning(home) > 0 {
            await waitForFreshToken(home: home, upTo: 60)
        }
        await gate.turnStarted(home)
        if AntigravityLogin.needsRefresh(home: home) { return .go(holdsGate: true) }
        await gate.unlock(home)
        return .go(holdsGate: false)
    }

    /// Lets the other agy runs go once this turn's process has refreshed the token (or gave up).
    static func releaseAfterRefresh(home: String, isRunning: @escaping @MainActor () -> Bool) {
        Task { @MainActor in
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline, isRunning(), AntigravityLogin.needsRefresh(home: home) {
                try? await Task.sleep(for: .milliseconds(500))
            }
            await AntigravityGate.shared.unlock(home)
        }
    }

    static func endTurn(home: String) {
        Task { await AntigravityGate.shared.turnEnded(home) }
    }

    private static func waitForFreshToken(home: String, upTo seconds: TimeInterval) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, AntigravityLogin.needsRefresh(home: home) {
            try? await Task.sleep(for: .seconds(1))
        }
    }
}

/// A folder whose `open` refuses to run. Put first in PATH, it stops a headless CLI from opening sign-in
/// pages in the browser by itself (agy opens them with `open <url>`).
enum NoBrowser {
    static let directory: String = {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("relevo/no-browser", isDirectory: true)
        let script = dir.appendingPathComponent("open")
        let body = "#!/bin/sh\necho 'Relevo: a background run tried to open the browser; sign in from Relevo instead.' >&2\nexit 1\n"
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if (try? String(contentsOf: script, encoding: .utf8)) != body {
            try? body.write(to: script, atomically: true, encoding: .utf8)
        }
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return dir.path
    }()
}
