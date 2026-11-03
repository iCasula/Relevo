import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Renders an agent reply. Same component on Mac and iPhone, so both clients show the same thing.
public struct MarkdownView: View {
    private let blocks: [MarkdownBlock]

    public init(_ text: String) {
        blocks = MarkdownParser.parse(text)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            inline(text)
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 6 : 3)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            inline(text)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        case .listItem(let indent, let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                markerView(marker)
                    .frame(minWidth: 16, alignment: .trailing)
                inline(text)
                    .lineSpacing(2)
                    .strikethrough(marker == .task(done: true), color: .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, CGFloat(indent) * 18)
        case .quote(let text):
            inline(text)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Capsule().fill(.tertiary).frame(width: 3)
                }
                .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .table(let header, let alignments, let rows):
            TableView(header: header, alignments: alignments, rows: rows)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    private func inline(_ s: String) -> Text { Text(MarkdownInline.attributed(s)) }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.bold)
        case 2: .title3.weight(.semibold)
        case 3: .headline
        default: .subheadline.weight(.semibold)
        }
    }

    @ViewBuilder
    private func markerView(_ marker: MarkdownBlock.Marker) -> some View {
        switch marker {
        case .bullet:
            Text("•").foregroundStyle(.secondary)
        case .number(let n):
            Text(n).monospacedDigit().foregroundStyle(.secondary)
        case .task(let done):
            Image(systemName: done ? "checkmark.square.fill" : "square")
                .foregroundStyle(done ? Color.accentColor : Color.secondary)
                .accessibilityLabel(done ? "Hecho" : "Pendiente")
        }
    }
}

private struct TableView: View {
    // On the iPhone cells wrap sooner so ordinary tables fit the screen; only very wide ones scroll.
    #if os(iOS)
    static let maxCellWidth: CGFloat = 190
    static let cellPadding: CGFloat = 8
    static let cellFont: Font = .subheadline
    #else
    static let maxCellWidth: CGFloat = 300
    static let cellPadding: CGFloat = 10
    static let cellFont: Font = .callout
    #endif

    let header: [String]
    let alignments: [MarkdownBlock.Alignment]
    let rows: [[String]]

    var body: some View {
        // Natural width (cells wrap past a max width); scrolls sideways only when it doesn't fit.
        ScrollView(.horizontal) {
            grid.padding(1)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    private var grid: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(header.indices, id: \.self) { c in cell(header[c], column: c, bold: true) }
            }
            .background(.fill.tertiary)
            ForEach(rows.indices, id: \.self) { r in
                Divider()
                GridRow {
                    ForEach(rows[r].indices, id: \.self) { c in cell(rows[r][c], column: c, bold: false) }
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.quaternary))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func cell(_ text: String, column: Int, bold: Bool) -> some View {
        let alignment = column < alignments.count ? alignments[column] : .leading
        return ClampedWidth(max: Self.maxCellWidth - 2 * Self.cellPadding) {
            Text(MarkdownInline.attributed(text))
                .font(bold ? Self.cellFont.weight(.semibold) : Self.cellFont)
                .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
        }
        .padding(.horizontal, Self.cellPadding)
        .padding(.vertical, 7)
        // Fill the column (so the header background has no gaps) and align inside it.
        .frame(maxWidth: .infinity, alignment: alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
    }
}

/// Natural width up to `max`, and the height measured at that width — even when the parent offers
/// unlimited width (as a horizontal ScrollView does), so wrapped table cells get their full height.
private struct ClampedWidth: Layout {
    let max: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        var width = min(view.sizeThatFits(.unspecified).width, max)
        if let available = proposal.width { width = min(width, available) }
        return CGSize(width: width, height: view.sizeThatFits(ProposedViewSize(width: width, height: nil)).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

private struct CodeBlockView: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "código" : language)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copy(code)
                    copied = true
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copiado" : "Copiar", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .labelStyle(.iconOnly)
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .help("Copiar")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            Divider()
            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .padding(10)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .scrollIndicators(.hidden)
        }
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.quaternary))
    }

    private func copy(_ s: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = s
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #endif
    }
}
