import SwiftUI
import AppKit

/// Colours for usage charts: the validated categorical palette (fixed slot per provider) and a one-hue
/// sequential ramp, each with its own light and dark steps.
enum UsageColors {
    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let v = isDark ? dark : light
            return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                           blue: CGFloat(v & 0xFF) / 255, alpha: 1)
        })
    }

    /// Slots 1–5 and 7 of the reference palette, in the order validated as adjacent pairs (see UsageAnalytics.providerOrder).
    static let slots: [Color] = [
        adaptive(0x2a78d6, 0x3987e5),   // gemini · blue
        adaptive(0xeb6834, 0xd95926),   // claude · orange
        adaptive(0x1baf7a, 0x199e70),   // codex · aqua
        adaptive(0xeda100, 0xc98500),   // deepseek · yellow
        adaptive(0xe87ba4, 0xd55181),   // kimi · magenta
        adaptive(0x6250d6, 0x9085e9),   // zai · violet
    ]
    static let other = adaptive(0xe34948, 0xe66767)

    static func provider(_ raw: String) -> Color {
        let i = UsageAnalytics.order(raw)
        return i < slots.count ? slots[i] : other
    }

    /// Sequential blue for magnitude: near zero recedes toward the surface in each mode.
    static let heatLow = adaptive(0xcde2fb, 0x104281)
    static let heatHigh = adaptive(0x184f95, 0x86b6ef)
    static let warning = Color(red: 0.98, green: 0.70, blue: 0.10)
}

/// One line under a reply: tokens, cache share and cost of the turn; a badge when it started cold after a switch.
struct TurnUsageFooter: View {
    let usage: TurnUsage
    @State private var showDetail = false

    var body: some View {
        let t = usage.tokens
        Button {
            showDetail.toggle()
        } label: {
            HStack(spacing: 8) {
                if let kind = usage.switchKind, let overhead = usage.overhead, overhead >= 1000 {
                    Label("\(kind.label): +\(TokenFormat.short(overhead))" + (usage.overheadCost.map { " · \(TokenFormat.usd($0))" } ?? ""),
                          systemImage: kind.symbol)
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                }
                if usage.hasTokens {
                    Text("\(TokenFormat.short(t.total)) tokens")
                    if let share = t.cacheShare, t.prompt > 0 { Text("\(TokenFormat.percent(share)) caché") }
                    if let cost = usage.cost { Text((usage.costEstimated ? "≈ " : "") + TokenFormat.usd(cost)) }
                } else if let context = usage.context {
                    Text("contexto \(TokenFormat.short(context))")
                }
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.tertiary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Consumo de este turno")
        .popover(isPresented: $showDetail, arrowEdge: .bottom) {
            TurnUsageDetail(usage: usage)
        }
    }
}

struct TurnUsageDetail: View {
    @Environment(AppStore.self) private var store
    let usage: TurnUsage

    var body: some View {
        let t = usage.tokens
        VStack(alignment: .leading, spacing: 12) {
            Text("Consumo del turno").font(.headline)
            if let kind = usage.switchKind {
                VStack(alignment: .leading, spacing: 4) {
                    Label(kind.label, systemImage: kind.symbol).font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                    if let detail = usage.switchDetail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                    if let overhead = usage.overhead {
                        Text("Re-procesó ≈ \(TokenFormat.short(overhead)) tokens que, sin el cambio, se habrían leído de caché"
                             + (usage.overheadCost.map { " (≈ \(TokenFormat.usd($0)))" } ?? "") + ".")
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Divider()
            }
            if usage.hasTokens {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    row("Entrada sin caché", t.input)
                    row("Leída de caché", t.cacheRead)
                    row("Escrita en caché", t.cacheWrite)
                    row("Salida", t.output)
                    if t.reasoning > 0 { row("  de ella, razonamiento", t.reasoning) }
                    Divider().gridCellUnsizedAxes(.horizontal)
                    row("Total", t.total, bold: true)
                }
                .font(.callout.monospacedDigit())
                if usage.parts.count > 1 {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Por modelo").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(usage.parts, id: \.self) { part in
                            Text("\(ModelNames.display(part.model ?? "?", account: nil, store: store)): \(TokenFormat.short(part.total))")
                                .font(.caption.monospacedDigit())
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                if let cost = usage.cost {
                    Text((usage.paid ? "Gasto" : "Coste equivalente en API") + ": " + (usage.costEstimated ? "≈ " : "") + TokenFormat.usd(cost))
                        .font(.callout.weight(.medium))
                    Text(usage.paid ? "Pago por uso: estimado con los precios de lista." :
                            usage.costEstimated ? "Estimado con los precios de lista; tu suscripción no cobra por token." :
                            "Calculado por el propio CLI a precios de lista; tu suscripción no cobra por token.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let context = usage.context {
                    let window = usage.contextWindow.map { " de \(TokenFormat.short($0))" } ?? ""
                    Text("Contexto al terminar: \(TokenFormat.short(context))\(window)").font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 10) {
                    if let ms = usage.durationMs { Text(TokenFormat.duration(Double(ms) / 1000)) }
                    if usage.tools > 0 { Text(usage.tools == 1 ? "1 herramienta" : "\(usage.tools) herramientas") }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 300)
    }

    private func row(_ label: String, _ value: Int, bold: Bool = false) -> some View {
        GridRow {
            Text(label).foregroundStyle(bold ? .primary : .secondary)
            Text(value.formatted()).fontWeight(bold ? .semibold : .regular).gridColumnAlignment(.trailing)
        }
    }
}

/// Toolbar popover: what this thread has consumed, its context now, and the switches it paid for.
struct ThreadUsageButton: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    let thread: ThreadModel
    let runtime: ThreadRuntime
    @State private var show = false

    var body: some View {
        Button {
            show.toggle()
        } label: {
            Label("Consumo", systemImage: "chart.bar.xaxis")
        }
        .help("Tokens y coste de este hilo")
        .popover(isPresented: $show, arrowEdge: .bottom) {
            let report = UsageAnalytics.build(store.trace.usageRecords(since: nil, thread: thread.id), store: store)
            VStack(alignment: .leading, spacing: 12) {
                Text("Consumo del hilo").font(.headline)
                if let context = runtime.context {
                    VStack(alignment: .leading, spacing: 4) {
                        let window = runtime.contextWindow ?? 0
                        Text("Contexto: \(TokenFormat.short(context))" + (window > 0 ? " de \(TokenFormat.short(window))" : ""))
                            .font(.callout)
                        if window > 0 { ProgressView(value: min(1, Double(context) / Double(window))) }
                    }
                }
                if report.isEmpty {
                    Text("Aún no hay turnos con datos de tokens en este hilo.").font(.callout).foregroundStyle(.secondary)
                } else {
                    Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                        GridRow { Text("Turnos").foregroundStyle(.secondary); Text("\(report.turns)") }
                        GridRow { Text("Tokens").foregroundStyle(.secondary); Text(TokenFormat.short(report.tokens.total)) }
                        GridRow { Text("Leído de caché").foregroundStyle(.secondary); Text(report.tokens.cacheShare.map(TokenFormat.percent) ?? "—") }
                        GridRow { Text("Coste (equiv. API)").foregroundStyle(.secondary); Text("≈ " + TokenFormat.usd(report.cost)) }
                        if report.switchOverhead > 0 {
                            GridRow {
                                Text("Por cambios").foregroundStyle(.secondary)
                                Text("\(report.switches.count) · \(TokenFormat.short(report.switchOverhead)) · \(TokenFormat.usd(report.switchCost))")
                                    .foregroundStyle(.orange)
                            }
                        }
                    }
                    .font(.callout.monospacedDigit())
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(report.models) { m in
                            HStack {
                                Circle().fill(UsageColors.provider(m.provider)).frame(width: 7, height: 7)
                                Text(m.name)
                                Spacer()
                                Text("\(m.turns) · \(TokenFormat.usd(m.cost))").monospacedDigit().foregroundStyle(.secondary)
                            }
                            .font(.caption)
                        }
                    }
                }
                Button("Abrir estadísticas de consumo") {
                    show = false
                    openWindow(id: "usage")
                }
                .controlSize(.small)
            }
            .padding(16)
            .frame(width: 300)
        }
    }
}
