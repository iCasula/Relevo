import Foundation

/// What the iPhone needs to find and trust a Mac: shown by the Mac as a QR code / link
/// `relevocompanion://pair?v=1&id=…&name=…&key=…&port=…&addrs=…`.
public struct PairingInfo: Codable, Hashable, Sendable {
    public static let scheme = "relevocompanion"

    /// Bonjour service name of the Mac and TLS-PSK identity.
    public var serverId: String
    /// Mac name, for display.
    public var name: String
    /// 32 random bytes; the TLS pre-shared key is derived from it.
    public var secret: Data
    public var port: UInt16?
    /// Optional fixed address (e.g. a Tailscale IP) for connecting outside the local network.
    public var host: String?
    /// The Mac's own IPv4 addresses, refreshed on every connection. Bonjour doesn't cross a VPN such as
    /// WireGuard, but these addresses do when the VPN routes the Mac's network.
    public var addresses: [String]?

    public init(serverId: String, name: String, secret: Data, port: UInt16?, host: String?, addresses: [String]? = nil) {
        self.serverId = serverId
        self.name = name
        self.secret = secret
        self.port = port
        self.host = host
        self.addresses = addresses
    }

    public var url: URL {
        var c = URLComponents()
        c.scheme = Self.scheme
        c.host = "pair"
        var items = [
            URLQueryItem(name: "v", value: "1"),
            URLQueryItem(name: "id", value: serverId),
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "key", value: Self.base64URL(secret)),
        ]
        if let port { items.append(URLQueryItem(name: "port", value: String(port))) }
        if let host, !host.isEmpty { items.append(URLQueryItem(name: "host", value: host)) }
        if let addresses, !addresses.isEmpty { items.append(URLQueryItem(name: "addrs", value: addresses.joined(separator: ","))) }
        c.queryItems = items
        return c.url!
    }

    public init?(url: URL) {
        guard url.scheme == Self.scheme, url.host == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard let id = value("id"), !id.isEmpty, let key = value("key"), let secret = Self.data(base64URL: key), secret.count >= 16 else {
            return nil
        }
        self.init(serverId: id, name: value("name") ?? "Mac", secret: secret,
                  port: value("port").flatMap { UInt16($0) }, host: value("host"),
                  addresses: value("addrs")?.split(separator: ",").map(String.init).filter { !$0.isEmpty })
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func data(base64URL s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}
