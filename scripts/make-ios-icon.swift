import AppKit

// Renders the 1024 px iOS icon for Relevo Companion: same quadrants and swap glyph as the Mac icon,
// full-bleed and opaque (iOS applies its own mask), with a small iPhone badge.
let out = CommandLine.arguments[1]
let px = 1024
let s = CGFloat(px)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                           isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let rect = NSRect(x: 0, y: 0, width: s, height: s)
let colors: [NSColor] = [
    NSColor(calibratedRed: 0.85, green: 0.47, blue: 0.34, alpha: 1),
    NSColor(calibratedRed: 0.07, green: 0.64, blue: 0.50, alpha: 1),
    NSColor(calibratedRed: 0.27, green: 0.52, blue: 0.96, alpha: 1),
    NSColor(calibratedRed: 0.52, green: 0.38, blue: 0.95, alpha: 1),
]
let half = s / 2
let quads = [NSRect(x: 0, y: half, width: half, height: half), NSRect(x: half, y: half, width: half, height: half),
             NSRect(x: 0, y: 0, width: half, height: half), NSRect(x: half, y: 0, width: half, height: half)]
for (q, c) in zip(quads, colors) { c.setFill(); q.fill() }
NSGradient(starting: NSColor.white.withAlphaComponent(0.18), ending: NSColor.black.withAlphaComponent(0.22))!.draw(in: rect, angle: -90)

func drawSymbol(_ name: String, size: CGFloat, center: NSPoint) {
    let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: .bold)
    guard let sym = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg) else { return }
    let tinted = NSImage(size: sym.size, flipped: false) { r in
        sym.draw(in: r); NSColor.white.set(); r.fill(using: .sourceAtop); return true
    }
    tinted.draw(in: NSRect(x: center.x - tinted.size.width / 2, y: center.y - tinted.size.height / 2, width: tinted.size.width, height: tinted.size.height))
}
drawSymbol("arrow.triangle.2.circlepath", size: s * 0.40, center: NSPoint(x: s / 2, y: s / 2))
drawSymbol("iphone.gen3", size: s * 0.15, center: NSPoint(x: s / 2, y: s / 2))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
