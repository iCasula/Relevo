import SwiftUI
import Charts
import AppKit

/// Window with what the agents consumed: totals, per day and hour, per model and provider, what model and
/// provider switches cost, and which tasks a cheaper model could have done.
struct UsageView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @AppStorage("usagePeriod") private var period: UsagePeriod = .week
    @AppStorage("usageMetric") private var metric: UsageMetric = .tokens
    @State private var report = UsageReport()
    @State private var reviewing = Set<String>()
    @State private var reviews: [String: Set<String>] = [:]
    /// Off for the self-test snapshot, which needs the whole page laid out.
    var scrolls = true

    var body: some View {
        if scrolls {
            ScrollView { page }
                .frame(minWidth: 780, minHeight: 620)
                .navigationTitle("Consumo")
                .task(id: period) { reload() }
                .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in reload() }
        } else {
            page.onAppear { reload() }
        }
    }

    private var page: some View {
            VStack(alignment: .leading, spacing: 28) {
                header
                if report.isEmpty {
                    ContentUnavailableView {
                        Label("Aún no hay datos de consumo", systemImage: "chart.bar.xaxis")
                    } description: {
                        Text("Relevo apunta los tokens de cada turno desde esta versión (y ha importado lo que guardaba Claude Code de tus hilos anteriores). Vuelve cuando hayas trabajado un poco.")
                    }
                    .frame(maxWidth: .infinity, minHeight: 320)
                } else {
                    tiles
                    if !report.insights.isEmpty { InsightsSection(insights: report.insights, open: openThread) }
                    DailyChart(report: report, metric: metric, period: period)
                    HourHeatmap(report: report, metric: metric)
                    ModelsTable(report: report)
                    SwitchesSection(report: report, open: openThread)
                    DowngradesSection(report: report, reviewing: reviewing, reviews: reviews, review: review)
                    footer
                }
            }
            .padding(28)
            .frame(maxWidth: 1100, alignment: .leading)
            .frame(maxWidth: .infinity)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Consumo").font(.largeTitle.weight(.semibold))
                Text("Tokens y coste por mensaje, modelo y proveedor").foregroundStyle(.secondary)
            }
            Spacer()
            Picker("Periodo", selection: $period) {
                ForEach(UsagePeriod.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 280)
            Picker("Medida", selection: $metric) {
                ForEach(UsageMetric.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 150)
        }
    }

    private var tiles: some View {
        let t = report.tokens
        return HStack(spacing: 14) {
            StatTile(title: "Tokens", value: TokenFormat.short(t.total),
                     detail: "\(report.turns) turnos · \(TokenFormat.short(t.output)) de salida")
            StatTile(title: "Coste equivalente en API", value: "≈ " + TokenFormat.usd(report.cost),
                     detail: report.paidCost > 0 ? "de ello \(TokenFormat.usd(report.paidCost)) gasto real (pago por uso)" : "tus suscripciones no cobran así; sirve para comparar")
            StatTile(title: "Leído de caché", value: t.cacheShare.map(TokenFormat.percent) ?? "—",
                     detail: "\(TokenFormat.short(t.cold)) tokens de entrada sin caché")
            StatTile(title: "Cambios de modelo o proveedor", value: TokenFormat.usd(report.switchCost),
                     detail: report.switches.isEmpty ? "ningún cambio en el periodo" :
                        "\(report.switches.count) cambios · \(TokenFormat.short(report.switchOverhead)) tokens re-procesados"
                        + (report.cost > 0 ? " · \(TokenFormat.percent(report.switchCost / report.cost))" : ""),
                     tint: report.switchCost > 0 ? .orange : nil)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack(alignment: .firstTextBaseline) {
                Text("Costes con precios de lista a \(ModelPricing.shared.asOf) (Claude: los que calcula Claude Code). Para una suscripción es un equivalente para comparar modelos, no lo que pagas."
                     + (report.hasImported ? " Incluye turnos anteriores importados del historial de Claude Code." : ""))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Editar precios…") { NSWorkspace.shared.open(ModelPricing.exportTemplateIfNeeded()) }
                    .controlSize(.small)
            }
        }
    }

    private func reload() {
        var r = UsageAnalytics.report(period, store: store)
        for i in r.downgrades.indices { r.downgrades[i].confirmed = reviews[r.downgrades[i].id] }
        report = r
    }

    private func openThread(_ id: UUID) {
        store.select(id)
        openWindow(id: "main")
    }

    private func review(_ d: Downgrade) {
        reviewing.insert(d.id)
        Task {
            let result = await UsageAnalytics.review(d, store: store)
            reviewing.remove(d.id)
            reviews[d.id] = result ?? []
            reload()
        }
    }
}

enum UsageMetric: String, CaseIterable, Identifiable {
    case tokens, cost
    var id: String { rawValue }
    var label: String { self == .tokens ? "Tokens" : "Coste" }

    func value(tokens: Int, cost: Double) -> Double { self == .tokens ? Double(tokens) : cost }

    func format(_ v: Double) -> String { self == .tokens ? TokenFormat.short(Int(v)) : TokenFormat.usd(v) }
}

struct StatTile: View {
    let title: String
    let value: String
    let detail: String
    var tint: Color? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 26, weight: .semibold, design: .rounded)).monospacedDigit()
                .foregroundStyle(tint ?? .primary)
            Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12))
    }
}

private struct SectionTitle: View {
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.title3.weight(.semibold))
            if let subtitle { Text(subtitle).font(.callout).foregroundStyle(.secondary) }
        }
    }
}

// MARK: - Insights

private struct InsightsSection: View {
    let insights: [Insight]
    let open: (UUID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(title: "Conclusiones")
            ForEach(insights) { insight in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: insight.symbol)
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .frame(width: 26)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(insight.title).font(.callout.weight(.semibold))
                        Text(insight.detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        if let id = insight.threadId {
                            Button("Abrir el hilo") { open(id) }.buttonStyle(.link).font(.caption)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 10))
            }
        }
    }
}

// MARK: - Per day

private struct DailyChart: View {
    let report: UsageReport
    let metric: UsageMetric
    let period: UsagePeriod
    @State private var selected: Date?

    private var providers: [String] {
        Array(Set(report.days.map(\.provider))).sorted { UsageAnalytics.order($0) < UsageAnalytics.order($1) }
    }

    var body: some View {
        let names = providers.map(UsageAnalytics.providerName)
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Por día", subtitle: metric == .tokens ? "Tokens por proveedor" : "Coste equivalente en API por proveedor")
            Chart {
                ForEach(report.days) { b in
                    BarMark(x: .value("Día", b.day, unit: .day), y: .value(metric.label, metric.value(tokens: b.tokens, cost: b.cost)))
                        .foregroundStyle(by: .value("Proveedor", UsageAnalytics.providerName(b.provider)))
                }
                if let selected {
                    RuleMark(x: .value("Día", selected, unit: .day))
                        .foregroundStyle(.secondary.opacity(0.35))
                        .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                            DayTooltip(day: selected, buckets: report.days.filter { Calendar.current.isDate($0.day, inSameDayAs: selected) }, metric: metric)
                        }
                }
            }
            .chartForegroundStyleScale(domain: names, range: providers.map(UsageColors.provider))
            .chartLegend(position: .top, alignment: .leading, spacing: 10)
            .chartXSelection(value: $selected)
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: max(1, Set(report.days.map(\.day)).count / 10))) { _ in
                    AxisGridLine().foregroundStyle(.quaternary)
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                }
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine().foregroundStyle(.quaternary)
                    AxisValueLabel { if let v = value.as(Double.self) { Text(metric.format(v)) } }
                }
            }
            .frame(height: 230)
        }
    }
}

private struct DayTooltip: View {
    let day: Date
    let buckets: [UsageReport.DayBucket]
    let metric: UsageMetric

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(day.formatted(.dateTime.weekday(.wide).day().month())).font(.caption.weight(.semibold))
            ForEach(buckets.sorted { UsageAnalytics.order($0.provider) < UsageAnalytics.order($1.provider) }) { b in
                HStack(spacing: 6) {
                    Circle().fill(UsageColors.provider(b.provider)).frame(width: 7, height: 7)
                    Text(UsageAnalytics.providerName(b.provider))
                    Spacer(minLength: 12)
                    Text(metric.format(metric.value(tokens: b.tokens, cost: b.cost))).monospacedDigit()
                }
                .font(.caption)
            }
            if buckets.isEmpty { Text("Sin uso").font(.caption).foregroundStyle(.secondary) }
        }
        .padding(8)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .frame(minWidth: 150)
    }
}

// MARK: - Per hour

private struct HourHeatmap: View {
    let report: UsageReport
    let metric: UsageMetric
    @State private var hour: Double?
    @State private var day: Double?

    private static let days = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]

    var body: some View {
        // Rows run Monday (top) to Sunday: row r holds weekday 7 - r.
        let selectedCell = hour.flatMap { h in day.flatMap { d in report.hours.first { $0.hour == Int(h) && $0.weekday == 7 - Int(d) } } }
        let values = report.hours.map { metric.value(tokens: $0.tokens, cost: $0.cost) }
        let maxValue = values.max() ?? 0
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom) {
                SectionTitle(title: "Por hora", subtitle: "Cuándo trabajan tus agentes (día de la semana × hora)")
                Spacer()
                // Sequential legend: one hue, light → dark, with the range it covers.
                HStack(spacing: 6) {
                    Text(metric.format(0)).font(.caption).foregroundStyle(.secondary)
                    LinearGradient(colors: [UsageColors.heatLow, UsageColors.heatHigh], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 110, height: 8)
                        .clipShape(.capsule)
                    Text(metric.format(maxValue)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Chart {
                ForEach(report.hours) { cell in
                    RectangleMark(xStart: .value("Hora", Double(cell.hour) + 0.06), xEnd: .value("Hora", Double(cell.hour) + 0.94),
                                  yStart: .value("Día", Double(7 - cell.weekday) + 0.08), yEnd: .value("Día", Double(8 - cell.weekday) - 0.08))
                        .foregroundStyle(by: .value(metric.label, metric.value(tokens: cell.tokens, cost: cell.cost)))
                        .cornerRadius(3)
                }
                if let selectedCell {
                    RectangleMark(xStart: .value("Hora", Double(selectedCell.hour)), xEnd: .value("Hora", Double(selectedCell.hour) + 1),
                                  yStart: .value("Día", Double(7 - selectedCell.weekday)), yEnd: .value("Día", Double(8 - selectedCell.weekday)))
                        .foregroundStyle(.clear)
                        .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(Self.days[selectedCell.weekday - 1]) · \(selectedCell.hour):00–\(selectedCell.hour + 1):00").font(.caption.weight(.semibold))
                                Text("\(TokenFormat.short(selectedCell.tokens)) tokens · \(selectedCell.turns) turnos · \(TokenFormat.usd(selectedCell.cost))")
                                    .font(.caption).monospacedDigit()
                            }
                            .padding(8)
                            .background(.regularMaterial, in: .rect(cornerRadius: 8))
                        }
                }
            }
            .chartForegroundStyleScale(range: Gradient(colors: [UsageColors.heatLow, UsageColors.heatHigh]))
            .chartXScale(domain: 0...24)
            .chartYScale(domain: 0...7)
            .chartXSelection(value: $hour)
            .chartYSelection(value: $day)
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: Array(stride(from: 0.5, to: 24, by: 3))) { value in
                    AxisValueLabel { if let v = value.as(Double.self) { Text("\(Int(v)) h") } }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: (0..<7).map { Double($0) + 0.5 }) { value in
                    AxisValueLabel { if let v = value.as(Double.self) { Text(Self.days[6 - min(6, Int(v))]) } }
                }
            }
            .frame(height: 210)
        }
    }
}

// MARK: - Per model

private struct ModelsTable: View {
    let report: UsageReport

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Por modelo", subtitle: "Turnos, tokens y coste; «OK» = turnos terminados sin error")
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                GridRow {
                    Text("Modelo"); Text("Turnos"); Text("Entrada"); Text("Salida"); Text("Caché"); Text("Coste"); Text("Por turno"); Text("OK"); Text("Cambios")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                Divider().gridCellUnsizedAxes(.horizontal)
                ForEach(report.models) { m in
                    GridRow {
                        HStack(spacing: 6) {
                            Circle().fill(UsageColors.provider(m.provider)).frame(width: 8, height: 8)
                            Text(m.name).fontWeight(.medium)
                            Text(UsageAnalytics.providerName(m.provider)).foregroundStyle(.secondary)
                        }
                        Text("\(m.turns)").gridColumnAlignment(.trailing)
                        Text(TokenFormat.short(m.tokens.prompt)).gridColumnAlignment(.trailing)
                        Text(TokenFormat.short(m.tokens.output)).gridColumnAlignment(.trailing)
                        Text(m.tokens.cacheShare.map(TokenFormat.percent) ?? "—").gridColumnAlignment(.trailing)
                        Text(m.priced || m.cost > 0 ? TokenFormat.usd(m.cost) : "—").gridColumnAlignment(.trailing)
                        Text(m.costPerTurn.map(TokenFormat.usd) ?? "—").gridColumnAlignment(.trailing)
                        Text(m.okRate.map(TokenFormat.percent) ?? "—").gridColumnAlignment(.trailing)
                        Text(m.switches > 0 ? "\(m.switches)" : "—").gridColumnAlignment(.trailing)
                    }
                    .font(.callout.monospacedDigit())
                }
            }
            .padding(14)
            .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 10))
        }
    }
}

// MARK: - Switches

private struct SwitchesSection: View {
    @Environment(AppStore.self) private var store
    let report: UsageReport
    let open: (UUID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Lo que costaron los cambios",
                         subtitle: "Al cambiar de modelo o de proveedor el contexto se procesa otra vez sin caché. Se compara con un turno normal del mismo modelo.")
            if report.switches.isEmpty {
                Text("Ningún cambio de modelo ni de proveedor en este periodo.").font(.callout).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    ForEach(report.switchSummary) { s in
                        VStack(alignment: .leading, spacing: 3) {
                            Label(s.kind.label, systemImage: s.kind.symbol).font(.caption.weight(.semibold))
                            Text("\(s.count) · \(TokenFormat.short(s.overhead)) tokens · \(TokenFormat.usd(s.cost))")
                                .font(.callout.monospacedDigit())
                        }
                        .padding(10)
                        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 8))
                    }
                }
                VStack(spacing: 0) {
                    ForEach(report.switches.filter { ($0.overhead ?? 0) >= 1000 }.prefix(10)) { rec in
                        Button { open(rec.threadId) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: rec.switchKind?.symbol ?? "arrow.triangle.swap").foregroundStyle(.orange).frame(width: 18)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(rec.switchDetail ?? rec.switchKind?.label ?? "").font(.callout.weight(.medium))
                                    Text((store.threads.first { $0.id == rec.threadId }?.title ?? "Hilo eliminado") + " · "
                                         + rec.ts.formatted(.dateTime.day().month().hour().minute()))
                                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                Text("+\(TokenFormat.short(rec.overhead ?? 0))").monospacedDigit()
                                Text(TokenFormat.usd(rec.overheadCost ?? 0)).monospacedDigit().foregroundStyle(.secondary).frame(width: 64, alignment: .trailing)
                            }
                            .padding(.vertical, 7)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                }
            }
        }
    }
}

// MARK: - Cheaper models

private struct DowngradesSection: View {
    let report: UsageReport
    let reviewing: Set<String>
    let reviews: [String: Set<String>]
    let review: (Downgrade) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Podían hacerse con un modelo más barato",
                         subtitle: "Tareas sencillas terminadas sin error con un modelo muy por encima de lo que pedían. El coste alternativo incluye lo que habría costado cambiar de modelo.")
            if report.downgrades.isEmpty {
                Text(report.notWorthSwitching > 0
                     ? "Nada que compense: en \(report.notWorthSwitching) tareas sencillas el cambio de modelo habría costado más que el ahorro."
                     : "No hay tareas sencillas hechas con modelos de más en este periodo.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(report.downgrades) { d in
                DowngradeCard(downgrade: d, isReviewing: reviewing.contains(d.id), review: { review(d) })
            }
        }
    }
}

private struct DowngradeCard: View {
    let downgrade: Downgrade
    let isReviewing: Bool
    let review: () -> Void
    @State private var expanded = false

    var body: some View {
        let d = downgrade
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(UsageColors.provider(d.provider)).frame(width: 8, height: 8)
                Text("\(d.fromName) → \(d.toName)").font(.headline)
                Spacer()
                Text("ahorro ≈ \(TokenFormat.usd(d.savings)) (\(TokenFormat.percent(d.share)))").font(.callout.weight(.semibold)).monospacedDigit()
            }
            Text("\(d.turns.count) \(d.turns.count == 1 ? "tarea sencilla" : "tareas sencillas")"
                 + (kindsText.isEmpty ? "" : " (\(kindsText))")
                 + ": \(TokenFormat.usd(d.actualCost)) con \(d.fromName); con \(d.toName) ≈ \(TokenFormat.usd(d.cheaperCost))"
                 + (d.switchCost > 0.0005 ? ", incluidos \(TokenFormat.usd(d.switchCost)) de cambiar de modelo." : "."))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                if let confirmed = d.confirmed {
                    Label("La IA confirma \(confirmed.count) de \(min(d.turns.count, 30))"
                          + (d.confirmedSavings.map { " · ahorro ≈ \(TokenFormat.usd($0))" } ?? ""), systemImage: "checkmark.seal")
                        .font(.caption)
                        .foregroundStyle(confirmed.isEmpty ? Color.secondary : Color.green)
                } else if isReviewing {
                    ProgressView().controlSize(.small)
                    Text("Revisando…").font(.caption).foregroundStyle(.secondary)
                } else {
                    Button("Revisar con IA", systemImage: "sparkles", action: review)
                        .controlSize(.small)
                        .help("Pregunta al modelo de utilidad (el de los títulos) cuáles podían hacerse de verdad con el modelo barato")
                }
                Spacer()
                Button(expanded ? "Ocultar ejemplos" : "Ver ejemplos") { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } }
                    .buttonStyle(.link).font(.caption)
            }
            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(d.turns.sorted { ($0.cost ?? 0) > ($1.cost ?? 0) }.prefix(8)) { t in
                        HStack(alignment: .firstTextBaseline) {
                            if d.confirmed?.contains(t.turn) == true { Image(systemName: "checkmark").foregroundStyle(.green).font(.caption) }
                            Text("«\((t.request ?? "").replacingOccurrences(of: "\n", with: " ").prefix(110))»").lineLimit(1)
                            Spacer()
                            Text(TokenFormat.usd(t.cost ?? 0)).monospacedDigit().foregroundStyle(.secondary)
                        }
                        .font(.caption)
                    }
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 10))
    }

    private var kindsText: String {
        downgrade.kinds.filter { $0.key != "otro" }.sorted { $0.value > $1.value }.prefix(3).map(\.key).joined(separator: ", ")
    }
}
