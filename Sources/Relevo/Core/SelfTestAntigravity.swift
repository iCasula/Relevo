import Foundation

/// `Relevo --selftest agylogin`: the Antigravity login guard, against a fake `agy` (no network, no browser).
extension SelfTest {
    static func agyLogin() async {
        var failures = 0
        func check(_ ok: Bool, _ what: String) {
            print((ok ? "ok   " : "FAIL ") + what)
            if !ok { failures += 1 }
        }

        // 1. Finding the end of the first JSON object.
        check(AntigravityLogin.firstObjectLength(Data(#"{"a":1}"#.utf8)) == 7, "plain object")
        check(AntigravityLogin.firstObjectLength(Data(#"{"a":"}"}}"#.utf8)) == 9, "brace inside a string, leftover brace")
        check(AntigravityLogin.firstObjectLength(Data(#"{"a":"\"}"}x"#.utf8)) == 11, "escaped quote inside a string")
        check(AntigravityLogin.firstObjectLength(Data("garbage".utf8)) == nil, "not JSON")

        // 2. Login state and in-place repair.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("relevo-agylogin-\(UUID().uuidString.prefix(6))").path
        let home = "\(root)/home"
        let tokenPath = AntigravityLogin.tokenPath(home: home)
        try? FileManager.default.createDirectory(atPath: (tokenPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: root) }
        func writeToken(expiry: Date, trailing: String = "") {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let json = #"{"token":{"access_token":"a","token_type":"Bearer","refresh_token":"r","expiry":"\#(f.string(from: expiry))"},"auth_method":"consumer"}"#
            FileManager.default.createFile(atPath: tokenPath, contents: Data((json + trailing).utf8), attributes: [.posixPermissions: 0o600])
        }
        check(AntigravityLogin.state(home: home) == .missing, "no file: missing")
        FileManager.default.createFile(atPath: tokenPath, contents: Data(#"{"token":"#.utf8))
        check(AntigravityLogin.state(home: home) == .unreadable, "truncated file: unreadable")
        let later = Date().addingTimeInterval(3600)
        writeToken(expiry: later, trailing: "}")
        if case .valid(let expiry?) = AntigravityLogin.state(home: home) {
            check(abs(expiry.timeIntervalSince(later)) < 1, "leftover brace: repaired, expiry read")
        } else {
            check(false, "leftover brace: repaired")
        }
        let repaired = FileManager.default.contents(atPath: tokenPath) ?? Data()
        check(JSONUtil.parseAny(repaired) is JSONObject, "repaired file is valid JSON")
        let perms = (try? FileManager.default.attributesOfItem(atPath: tokenPath))?[.posixPermissions] as? Int
        check(perms == 0o600, "repaired file keeps 0600 (got \(String(perms ?? 0, radix: 8)))")
        check(!AntigravityLogin.needsRefresh(home: home), "fresh token needs no refresh")

        // 3. Background runs: one at a time, browser blocked.
        let fake = "\(root)/agy"
        let log = "\(root)/runs.log"
        let script = """
        #!/bin/sh
        echo "start $$" >> \(shellQuote(log))
        if [ "$FAKE_MODE" = auth ]; then echo "Authentication required. Please visit the URL to log in:" >&2; exec sleep 20; fi
        open "https://accounts.google.com/o/oauth2/auth" 2>/dev/null; echo "open=$?"
        sleep 0.6
        echo "end $$" >> \(shellQuote(log))
        """
        FileManager.default.createFile(atPath: fake, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])
        let account = Account(kind: .gemini, name: "agy test", configDir: home)
        let launch = Launch(executable: fake, environment: ["HOME": home, "PATH": "/usr/bin:/bin"])

        async let r1 = AntigravityRuns.background(account, launch, ["-p=/usage"])
        async let r2 = AntigravityRuns.background(account, launch, ["models"])
        async let r3 = AntigravityRuns.background(account, launch, ["models"])
        let results = await [r1, r2, r3]
        let lines = ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").split(separator: "\n").map { $0.split(separator: " ")[0] }
        check(lines == ["start", "end", "start", "end", "start", "end"], "three concurrent runs never overlap (\(lines.joined(separator: ",")))")
        let outputs = results.compactMap { if case .output(let out, _) = $0 { out } else { nil } }
        check(outputs.count == 3 && outputs.allSatisfy { $0.contains("open=1") }, "`open` is blocked in background runs")

        // 4. No usable login: agy isn't even started.
        try? FileManager.default.removeItem(atPath: tokenPath)
        try? FileManager.default.removeItem(atPath: log)
        let missing = await AntigravityRuns.background(account, launch, ["-p=/usage"])
        if case .signedOut = missing { check(!FileManager.default.fileExists(atPath: log), "signed out: agy not launched") } else { check(false, "signed out: agy not launched") }

        // 5. agy asking for a sign-in is stopped right away.
        writeToken(expiry: later)
        var authLaunch = launch
        authLaunch.environment["FAKE_MODE"] = "auth"
        let t0 = Date()
        let auth = await AntigravityRuns.background(account, authLaunch, ["-p=/usage"])
        let took = Date().timeIntervalSince(t0)
        if case .signedOut = auth { check(took < 5, String(format: "sign-in prompt stopped after %.1fs", took)) } else { check(false, "sign-in prompt reported as signed out") }

        // 6. A turn that will refresh the token holds the gate until the token is fresh.
        writeToken(expiry: Date().addingTimeInterval(-60))
        let start = await AntigravityRuns.beginTurn(account, home: home)
        guard case .go(true) = start else {
            check(false, "expired token: turn holds the gate")
            print(failures == 0 ? "TODO OK" : "\(failures) FALLOS")
            return
        }
        check(true, "expired token: turn holds the gate")
        try? FileManager.default.removeItem(atPath: log)
        let refreshedAt = Date().addingTimeInterval(1.5)
        let waiting = Task { await AntigravityRuns.background(account, launch, ["models"]) }
        AntigravityRuns.releaseAfterRefresh(home: home) { true }
        try? await Task.sleep(for: .seconds(1.5))
        check(!FileManager.default.fileExists(atPath: log), "background run waits while the turn refreshes")
        writeToken(expiry: Date().addingTimeInterval(3600))  // what agy does once it has refreshed
        _ = await waiting.value
        let ranAt = (try? FileManager.default.attributesOfItem(atPath: log))?[.creationDate] as? Date
        check(ranAt.map { $0 >= refreshedAt } == true, "background run goes once the token is fresh")
        AntigravityRuns.endTurn(home: home)

        print(failures == 0 ? "TODO OK" : "\(failures) FALLOS")
    }
}
