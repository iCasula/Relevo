// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Relevo",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Relevo",
            path: "Sources/Relevo"
        )
    ]
)
