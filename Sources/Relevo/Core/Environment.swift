import Foundation
import AppKit

/// Captures the user's login-shell environment so CLIs installed via mise/brew/npm are found
/// even though GUI apps start with a minimal PATH.
enum ShellEnvironment {
    private static let lock = NSLock()
    private static var _env: [String: String] = baseline()
    private static var loaded = false

    static var env: [String: String] {
        lock.lock(); defer { lock.unlock() }
        return _env
    }

    static var path: [String] {
        (env["PATH"] ?? "").split(separator: ":").map(String.init)
    }

    private static func baseline() -> [String: String] {
        var e = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.bun/bin", "\(home)/.npm-global/bin", "\(home)/.local/share/mise/shims"]
        var parts = (e["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for p in extra where !parts.contains(p) { parts.append(p) }
        e["PATH"] = parts.joined(separator: ":")
        return sanitize(e)
    }

    /// Removes variables that would make child CLIs believe they run nested inside another agent.
    private static func sanitize(_ input: [String: String]) -> [String: String] {
        var e = input
        for key in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "GEMINI_CLI", "ELECTRON_RUN_AS_NODE", "__CFBundleIdentifier"] {
            e.removeValue(forKey: key)
        }
        e["TERM"] = e["TERM"] ?? "xterm-256color"
        e["NO_COLOR"] = "1"
        e["FORCE_COLOR"] = "0"
        return e
    }

    static func load() async {
        if loaded { return }
        let captured = await Task.detached(priority: .userInitiated) { () -> [String: String]? in
            captureLoginShell()
        }.value
        apply(captured)
    }

    private static func apply(_ captured: [String: String]?) {
        lock.lock()
        defer { lock.unlock() }
        if let captured, let p = captured["PATH"], !p.isEmpty {
            var merged = _env
            for (k, v) in captured { merged[k] = v }
            // keep our extra fallbacks at the end
            var parts = p.split(separator: ":").map(String.init)
            for extra in (_env["PATH"] ?? "").split(separator: ":").map(String.init) where !parts.contains(extra) {
                parts.append(extra)
            }
            merged["PATH"] = parts.joined(separator: ":")
            _env = sanitize(merged)
        }
        loaded = true
    }

    private static func captureLoginShell() -> [String: String]? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let marker = "__RELEVO_ENV_\(UUID().uuidString.prefix(6))__"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-l", "-i", "-c", "printf '\(marker)'; /usr/bin/env -0"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(8)
        var data = Data()
        let reader = out.fileHandleForReading
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            data = reader.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + 8) == .timedOut || Date() > deadline {
            p.terminate()
            return nil
        }
        guard let text = String(data: data, encoding: .utf8), let range = text.range(of: marker) else { return nil }
        var result: [String: String] = [:]
        for entry in text[range.upperBound...].split(separator: "\0") {
            guard let eq = entry.firstIndex(of: "=") else { continue }
            result[String(entry[..<eq])] = String(entry[entry.index(after: eq)...])
        }
        return result.isEmpty ? nil : result
    }

    static func which(_ name: String) -> String? {
        for dir in path {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}

struct Launch {
    var executable: String
    var prefixArgs: [String] = []
    var environment: [String: String]
    /// Env vars that must be re-exported when the same CLI runs in Terminal (logins).
    var exported: [String] = []
}

enum Binaries {
    static func appBundles(_ name: String) -> [String] {
        ["\(NSHomeDirectory())/Applications/\(name)", "/Applications/\(name)"]
    }

    /// Shell environment + the account's optional isolation folder + the provider's own launch rules.
    static func launch(for account: Account) -> Launch? {
        let provider = account.kind.provider
        var env = ShellEnvironment.env
        var exported: [String] = []
        if let dir = account.configDir?.trimmingCharacters(in: .whitespaces), !dir.isEmpty, let isolation = provider.info.isolation {
            let expanded = expandTilde(dir)
            try? FileManager.default.createDirectory(atPath: expanded, withIntermediateDirectories: true)
            let before = env
            isolation.apply(expanded, &env)
            exported = env.keys.filter { env[$0] != before[$0] }.sorted()
        }
        let override = account.binaryPath?.trimmingCharacters(in: .whitespaces)
        guard var launch = provider.launch(for: account, env: env, executableOverride: override?.isEmpty == false ? override : nil) else { return nil }
        launch.exported = Array(Set(launch.exported + exported)).sorted()
        return launch
    }

    /// Shell command line equivalent to a Launch (for Terminal-based login flows).
    static func commandLine(_ launch: Launch, extraArgs: [String]) -> String {
        var parts: [String] = []
        for key in launch.exported {
            if let v = launch.environment[key] { parts.append("\(key)=\(shellQuote(v))") }
        }
        parts.append(shellQuote(launch.executable))
        parts += (launch.prefixArgs + extraArgs).map(shellQuote)
        return parts.joined(separator: " ")
    }
}

/// Isolated HOME for Antigravity: agy stores its session here, while every command the agent runs
/// gets the real HOME back (via .zshenv / BASH_ENV) so git, ssh, Xcode… behave as usual.
enum AntigravityHome {
    private static var prepared = Set<String>()
    private static let lock = NSLock()

    /// With its own HOME there is no keychain for agy to save into: every token refresh (hourly) showed macOS's
    /// «Llavero no encontrado» dialog until agy gave up after 5 s and used its token file. agy goes straight to
    /// the file when it believes it runs over SSH (it then also leaves the browser alone and just prints the URL).
    static let noKeychain = ["SSH_CONNECTION": "127.0.0.1 0 127.0.0.1 0", "RELEVO_AGY_NO_KEYCHAIN": "1"]

    static func prepare(_ dir: String) -> [String: String] {
        let real = NSHomeDirectory()
        let env = ["HOME": dir, "BASH_ENV": "\(dir)/.relevo-bash-env", "RELEVO_REAL_HOME": real].merging(noKeychain) { $1 }
        lock.lock(); defer { lock.unlock() }
        guard !prepared.contains(dir) else { return env }
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let restore = """
        # Relevo: only `agy` uses this folder as HOME (its Google session lives here, isolated from yours).
        # Commands launched by the agent get your real HOME back, and lose the SSH marker meant only for agy.
        export HOME=\(shellQuote(real))
        [ -n "$RELEVO_AGY_NO_KEYCHAIN" ] && unset SSH_CONNECTION RELEVO_AGY_NO_KEYCHAIN
        """
        try? (restore + "\nexport ZDOTDIR=\"$HOME\"\n[ -f \"$HOME/.zshenv\" ] && . \"$HOME/.zshenv\"\n")
            .write(toFile: "\(dir)/.zshenv", atomically: true, encoding: .utf8)
        try? (restore + "\nunset BASH_ENV\n").write(toFile: "\(dir)/.relevo-bash-env", atomically: true, encoding: .utf8)
        // Fallback for shells that skip those files. Never link Library (keychains) or .gemini (sessions).
        for name in [".gitconfig", ".ssh"] {
            let link = "\(dir)/\(name)", target = "\(real)/\(name)"
            if fm.fileExists(atPath: target), (try? fm.destinationOfSymbolicLink(atPath: link)) == nil, !fm.fileExists(atPath: link) {
                try? fm.createSymbolicLink(atPath: link, withDestinationPath: target)
            }
        }
        prepared.insert(dir)
        return env
    }
}

enum TerminalLauncher {
    /// Opens a Terminal window running `command` (used for interactive OAuth logins).
    static func run(_ command: String, title: String) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("relevo", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("login-\(UUID().uuidString.prefix(8)).command")
        let script = """
        #!/bin/zsh -l
        clear
        echo \(shellQuote(title))
        echo
        \(command)
        echo
        echo "Listo. Vuelve a Relevo y pulsa «Actualizar». Puedes cerrar esta ventana."
        """
        do {
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            NSWorkspace.shared.open(url)
        } catch {
            NSSound.beep()
        }
    }
}
