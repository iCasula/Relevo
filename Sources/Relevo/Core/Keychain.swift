import Foundation
import Security

/// Relevo's own secrets (only API keys the user pastes, e.g. DeepSeek) in the macOS Keychain.
/// Relevo never stores or reads other apps' tokens here.
enum Keychain {
    private static let service = "app.relevo.mac"
    /// Values already read this session: each item is read from the Keychain (and authorised) at most once per launch.
    private static var cache: [String: String] = [:]
    private static let lock = NSLock()

    static func get(_ account: String) -> String? {
        lock.lock()
        let cached = cache[account]
        lock.unlock()
        if let cached { return cached }
        guard let value = read(account) else { return nil }
        lock.lock()
        cache[account] = value
        lock.unlock()
        return value
    }

    private static func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func set(_ value: String, for account: String) -> Bool {
        lock.lock()
        cache[account] = value
        lock.unlock()
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let data = Data(value.utf8)
        if SecItemCopyMatching(base as CFDictionary, nil) == errSecSuccess {
            return SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess
        }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Relevo · \(account)"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: String) {
        lock.lock()
        cache.removeValue(forKey: account)
        lock.unlock()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func apiKeyName(_ accountId: UUID) -> String { "api-key-\(accountId.uuidString)" }
}
