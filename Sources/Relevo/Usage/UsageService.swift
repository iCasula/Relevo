import Foundation

struct AccountProbe {
    var status: AccountStatus
    var models: [ModelOption]?
}

/// Limits and logins are provider-specific; this only dispatches to the provider definition.
@MainActor
enum UsageService {
    static func probe(_ account: Account) async -> AccountProbe {
        var result = await account.kind.provider.probe(account)
        result.status.updatedAt = Date()
        return result
    }

    static func login(_ account: Account, store: AppStore) {
        account.kind.provider.login(account, store: store)
    }
}

/// Runs a CLI to completion and captures its output (used for read-only probes).
enum ProcessRunner {
    /// `abortWhen`: stop the process as soon as its stderr shows this text (e.g. a CLI waiting for a sign-in).
    static func capture(_ launch: Launch, _ args: [String], timeout: TimeInterval = 40, abortWhen: String? = nil) async -> (out: String, err: String) {
        await Task.detached { run(launch, args, timeout: timeout, abortWhen: abortWhen) }.value
    }

    private static func run(_ launch: Launch, _ args: [String], timeout: TimeInterval, abortWhen: String?) -> (out: String, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launch.executable)
        p.arguments = launch.prefixArgs + args
        p.environment = launch.environment
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return ("", error.localizedDescription) }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if p.isRunning { p.terminate() } }
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            let handle = err.fileHandleForReading
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                errData.append(chunk)
                if let abortWhen, p.isRunning, String(decoding: errData.suffix(8192), as: UTF8.self).contains(abortWhen) { p.terminate() }
            }
            group.leave()
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        p.waitUntilExit()
        return (String(decoding: outData, as: UTF8.self), String(decoding: errData, as: UTF8.self))
    }
}
