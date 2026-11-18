// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Relevo",
    platforms: [.macOS("15.0")],
    dependencies: [
        .package(path: "Shared/RelevoProtocol"),
    ],
    targets: [
        .executableTarget(
            name: "Relevo",
            dependencies: [
                .product(name: "RelevoProtocol", package: "RelevoProtocol"),
                .product(name: "RelevoMarkdown", package: "RelevoProtocol"),
            ],
            path: "Sources/Relevo"
        ),
        // Relevo Hosts: the cross-platform desktop app in a native menu-bar shell (scripts/build-hosts-app.sh).
        .executableTarget(
            name: "RelevoHosts",
            path: "Sources/RelevoHosts"
        ),
    ]
)
