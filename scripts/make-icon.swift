import AppKit

// Renders the Relevo app icon: four provider-coloured quadrants behind a swap glyph.
let out = CommandLine.arguments[1]
let sizes = [16, 32, 64, 128, 256, 512, 1024]
let fm = FileManager.default
try? fm.createDirectory(atPath: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = s * 0.09
    let rect = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let path = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.225, yRadius: rect.width * 0.225)
    NSGraphicsContext.current?.saveGraphicsState()
    let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.25); shadow.shadowBlurRadius = s * 0.02; shadow.shadowOffset = NSSize(width: 0, height: -s * 0.01)
    shadow.set()
    NSColor(calibratedWhite: 0.12, alpha: 1).setFill(); path.fill()
    NSGraphicsContext.current?.restoreGraphicsState()
    path.addClip()
    let colors: [NSColor] = [
        NSColor(calibratedRed: 0.85, green: 0.47, blue: 0.34, alpha: 1),
        NSColor(calibratedRed: 0.07, green: 0.64, blue: 0.50, alpha: 1),
        NSColor(calibratedRed: 0.27, green: 0.52, blue: 0.96, alpha: 1),
        NSColor(calibratedRed: 0.52, green: 0.38, blue: 0.95, alpha: 1),
    ]
    let half = rect.width / 2
    let quads = [NSRect(x: rect.minX, y: rect.midY, width: half, height: half), NSRect(x: rect.midX, y: rect.midY, width: half, height: half),
                 NSRect(x: rect.minX, y: rect.minY, width: half, height: half), NSRect(x: rect.midX, y: rect.minY, width: half, height: half)]
    for (q, c) in zip(quads, colors) { c.setFill(); q.fill() }
    NSGradient(starting: NSColor.white.withAlphaComponent(0.18), ending: NSColor.black.withAlphaComponent(0.18))!.draw(in: rect, angle: -90)
    let cfg = NSImage.SymbolConfiguration(pointSize: s * 0.42, weight: .bold)
    if let sym = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
        let tinted = NSImage(size: sym.size, flipped: false) { r in
            sym.draw(in: r); NSColor.white.set(); r.fill(using: .sourceAtop); return true
        }
        let w = tinted.size.width, h = tinted.size.height
        tinted.draw(in: NSRect(x: (s - w) / 2, y: (s - h) / 2, width: w, height: h))
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for px in sizes {
    let data = render(px)
    if px <= 512 { try! data.write(to: URL(fileURLWithPath: "\(out)/icon_\(px)x\(px).png")) }
    if px >= 32 { try! data.write(to: URL(fileURLWithPath: "\(out)/icon_\(px / 2)x\(px / 2)@2x.png")) }
}
