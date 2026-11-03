// swift-tools-version:5.10
import PackageDescription

/// Code shared by Relevo for Mac and Relevo Companion for iPhone: the wire protocol and the Markdown renderer.
let package = Package(
    name: "RelevoProtocol",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "RelevoProtocol", targets: ["RelevoProtocol"]),
        .library(name: "RelevoMarkdown", targets: ["RelevoMarkdown"]),
    ],
    targets: [
        .target(name: "RelevoProtocol"),
        .target(name: "RelevoMarkdown"),
    ]
)
