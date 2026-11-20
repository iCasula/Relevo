import SwiftUI
import ImageIO

/// Thumbnails of the images a reply mentions. Each app supplies how to load one (from disk on the Mac,
/// from the Mac over the companion connection on the iPhone) and what tapping does.
public struct ImageStrip: View {
    let paths: [String]
    /// What the strip belongs to (the message's id): a preview you close stays closed for that message.
    let key: String
    let load: (String) async -> CGImage?
    let open: (String) -> Void
    /// Previews you closed, «key|path», newest last.
    @AppStorage("hiddenImagePreviews") private var hiddenList = ""

    public init(paths: [String], key: String = "", load: @escaping (String) async -> CGImage?, open: @escaping (String) -> Void) {
        self.paths = Array(paths.prefix(12))
        self.key = key
        self.load = load
        self.open = open
    }

    private var hidden: Set<String> { Set(hiddenList.split(separator: "\n").map(String.init)) }

    private func hide(_ path: String) {
        let lines = hiddenList.split(separator: "\n").map(String.init) + ["\(key)|\(path)"]
        hiddenList = lines.suffix(500).joined(separator: "\n")
    }

    public var body: some View {
        let shown = paths.filter { !hidden.contains("\(key)|\($0)") }
        if !shown.isEmpty {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(shown, id: \.self) { path in
                    Button { open(path) } label: { Thumbnail(path: path, load: load) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Imagen \((path as NSString).lastPathComponent)")
                        .help((path as NSString).lastPathComponent)
                        .overlay(alignment: .topTrailing) {
                            Button { withAnimation(.snappy(duration: 0.2)) { hide(path) } } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.55))
                                    .font(.system(size: 18))
                                    .padding(5)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Quitar la vista previa")
                            .help("Quitar la vista previa")
                        }
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
    }
}

private struct Thumbnail: View {
    let path: String
    let load: (String) async -> CGImage?
    @State private var image: CGImage?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.fill.quaternary)
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else if !failed {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(width: thumbWidth, height: 150)
            Text((path as NSString).lastPathComponent)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: thumbWidth, alignment: .leading)
        }
        // Only named, not there (a file on another machine, a name in an explanation): no preview at all.
        .opacity(failed ? 0 : 1)
        .frame(width: failed ? 0 : nil, height: failed ? 0 : nil)
        .clipped()
        .task(id: path) {
            image = await load(path)
            failed = image == nil
        }
    }

    /// Keep the image's proportions within 150 pt of height (portrait screenshots stay narrow).
    private var thumbWidth: CGFloat {
        guard let image, image.height > 0 else { return 110 }
        return min(260, max(70, 150 * CGFloat(image.width) / CGFloat(image.height)))
    }
}

/// Downsampled image from encoded data or a file (ImageIO, without decoding the full-size image).
public enum ThumbnailMaker {
    public static func image(data: Data, maxPixel: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return thumbnail(source, maxPixel: maxPixel)
    }

    public static func image(url: URL, maxPixel: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return thumbnail(source, maxPixel: maxPixel)
    }

    private static func thumbnail(_ source: CGImageSource, maxPixel: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary)
    }
}
