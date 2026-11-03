// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Relevo",
    platforms: [.macOS(.v14)],
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
        )
    ]
)
