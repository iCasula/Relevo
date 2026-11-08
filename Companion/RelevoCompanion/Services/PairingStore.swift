import Foundation
import Security
import RelevoProtocol

/// Keeps the paired hosts (each Mac or headless Relevo host: id + secret) and which one is in use, in the
/// iPhone Keychain, available after first unlock.
enum PairingStore {
    private static let service = "app.relevo.companion"
    /// Before several hosts: a single pairing under this account (moved to `hostsAccount` on first load).
    private static let legacyAccount = "pairing"
    private static let hostsAccount = "pairings"

    private struct Stored: Codable {
        var hosts: [PairingInfo]
        var active: String?
    }

    /// Every paired host and the id of the one in use.
    static func loadAll() -> (hosts: [PairingInfo], active: String?) {
        if let data = read(hostsAccount), let stored = try? JSONDecoder().decode(Stored.self, from: data) {
            return (stored.hosts, stored.active ?? stored.hosts.first?.serverId)
        }
        if let data = read(legacyAccount), let single = try? JSONDecoder().decode(PairingInfo.self, from: data) {
            saveAll([single], active: single.serverId)
            delete(legacyAccount)
            return ([single], single.serverId)
        }
        return ([], nil)
    }

    static func saveAll(_ hosts: [PairingInfo], active: String?) {
        guard let data = try? JSONEncoder().encode(Stored(hosts: hosts, active: active)) else { return }
        write(hostsAccount, data)
    }

    /// The host in use (what the Live Activity buttons answer to).
    static func load() -> PairingInfo? {
        let all = loadAll()
        return all.hosts.first { $0.serverId == all.active } ?? all.hosts.first
    }

    /// Adds or updates a host and makes it the one in use.
    static func save(_ pairing: PairingInfo) {
        var hosts = loadAll().hosts
        if let i = hosts.firstIndex(where: { $0.serverId == pairing.serverId }) { hosts[i] = pairing } else { hosts.append(pairing) }
        saveAll(hosts, active: pairing.serverId)
    }

    static func clear() {
        delete(hostsAccount)
        delete(legacyAccount)
    }

    // MARK: - Keychain

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func read(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func write(_ account: String, _ data: Data) {
        SecItemDelete(query(account) as CFDictionary)
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
