import Foundation
import Security
import SystemConfiguration
import RelevoProtocol

/// Pairing identity of this Mac: a server id (Bonjour name + TLS-PSK identity) and a 256-bit secret,
/// both in the Keychain. Regenerating them unpairs every iPhone.
enum CompanionCredentials {
    private static let idKey = "companion-server-id"
    private static let secretKey = "companion-secret"

    static var macName: String {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? Host.current().localizedName ?? "Mac"
    }

    /// In-memory credentials for headless tests (nothing is written to the Keychain).
    static var testOverride: (serverId: String, secret: Data)?

    static func current() -> (serverId: String, secret: Data) {
        if let testOverride { return testOverride }
        if let id = Keychain.get(idKey), let s = Keychain.get(secretKey), let secret = Data(base64Encoded: s), secret.count == 32 {
            return (id, secret)
        }
        return regenerate()
    }

    @discardableResult
    static func regenerate() -> (serverId: String, secret: Data) {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let secret = Data(bytes)
        let id = "relevo-" + UUID().uuidString.prefix(8).lowercased()
        Keychain.set(id, for: idKey)
        Keychain.set(secret.base64EncodedString(), for: secretKey)
        return (id, secret)
    }

    static func pairing(port: UInt16?, host: String?) -> PairingInfo {
        let c = current()
        return PairingInfo(serverId: c.serverId, name: macName, secret: c.secret, port: port, host: host, addresses: localAddresses())
    }

    /// IPv4 addresses of this Mac (Wi-Fi, Ethernet, VPNs such as Tailscale): sent to the iPhone and shown as a hint.
    static func localAddresses() -> [String] {
        var result: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
        defer { freeifaddrs(ifaddr) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = ptr.pointee
            guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ifa.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("utun") || name.hasPrefix("bridge") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: host)
                if !ip.hasPrefix("169.254") { result.append(ip) }
            }
        }
        return Array(Set(result)).sorted()
    }
}
