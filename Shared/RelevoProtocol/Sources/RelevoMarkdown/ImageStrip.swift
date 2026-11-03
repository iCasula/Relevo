import SwiftUI
import ImageIO

/// Thumbnails of the images a reply mentions. Each app supplies how to load one (from disk on the Mac,
/// from the Mac over the companion connection on the iPhone) and what tapping does.
public struct ImageStrip: View {
    let paths: [String]
    let load: (String) async -> CGImage?
    let open: (String) -> Void

    public init(paths: [String], load: @escaping (String) async -> CGImage?, open: @escaping (String) -> Void) {
        self.paths = Array(paths.prefix(12))
        self.load = load
        self.open = open
    }

    public var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(paths, id: \.self) { path in
                    Button { open(path) } label: { Thumbnail(path: path, load: load) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Imagen \((path as NSString).lastPathComponent)")
                        .help((path as NSString).lastPathComponent)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
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
                } else if failed {
                    Image(systemName: "photo").font(.title3).foregroundStyle(.secondary)
                } else {
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
