import SwiftUI

/// Chat-style scrolling, the same on the Mac and the iPhone, done by the scroll view itself: with a bottom
/// default anchor it starts on the last line, stays there while replies stream in or the keyboard and window
/// change size, and leaves you where you are when you've scrolled up to read.
///
/// The one catch: that anchoring stops working when the scroll view has a top safe-area inset (the Mac's
/// toolbar, the iPhone's navigation bar), so the scroll view ignores it and `ChatTopSpacer` keeps the first
/// message clear of the bar instead.
@available(macOS 15, iOS 18, *)
public struct FollowsBottom: ViewModifier {
    /// True while the last line is in view: show a "go to the end" button when it isn't.
    @Binding var atBottom: Bool
    /// Changing it goes to the last line (you sent a message, or tapped the button).
    let jump: Int
    /// Empty except right after asking for the end: a position left on "bottom" would be applied again
    /// whenever the content changes size, pulling you back down while you scroll up.
    @State private var position = ScrollPosition(idType: Int.self)
    @State private var topInset: CGFloat = 0

    /// How close to the end still counts as "at the bottom".
    static let slack: CGFloat = 24
    /// `-debugScroll YES` prints each geometry change.
    static let debug = UserDefaults.standard.bool(forKey: "debugScroll")

    public func body(content: Content) -> some View {
        content
            .defaultScrollAnchor(.bottom)
            .scrollPosition($position)
            .environment(\.chatTopInset, topInset)
            .onScrollGeometryChange(for: CGFloat.self) { g in
                g.contentSize.height + g.contentInsets.bottom - g.visibleRect.maxY
            } action: { _, distance in
                if Self.debug { print("followsBottom distance=\(Int(distance)) topInset=\(Int(topInset))") }
                let bottom = distance <= Self.slack
                if bottom != atBottom { atBottom = bottom }
            }
            .ignoresSafeArea(.container, edges: .top)
            .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { topInset = $0 }
            .onChange(of: jump) { scrollToBottom() }
    }

    /// Goes to the end, then empties the position again so it doesn't keep pulling there.
    private func scrollToBottom() {
        position = ScrollPosition(idType: Int.self)
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { position = ScrollPosition(idType: Int.self) }
        }
    }
}

@available(macOS 15, iOS 18, *)
public extension View {
    /// See `FollowsBottom`. Put a `ChatTopSpacer` first in the scroll content.
    func followsBottom(atBottom: Binding<Bool>, jump: Int) -> some View {
        modifier(FollowsBottom(atBottom: atBottom, jump: jump))
    }
}

private struct ChatTopInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    var chatTopInset: CGFloat {
        get { self[ChatTopInsetKey.self] }
        set { self[ChatTopInsetKey.self] = newValue }
    }
}

/// First thing in a `followsBottom` scroll view's content: the room the bar above takes, so the first message
/// isn't under it (the scroll view runs under the bar; see `FollowsBottom`).
public struct ChatTopSpacer: View {
    @Environment(\.chatTopInset) private var inset

    public init() {}

    public var body: some View {
        Color.clear.frame(height: inset)
    }
}

/// Shown while the last line isn't in view: back to it.
public struct JumpToBottomButton: View {
    let action: () -> Void

    public init(action: @escaping () -> Void) { self.action = action }

    public var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 36, height: 36)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .background(.regularMaterial, in: .circle)
        .overlay(Circle().stroke(.quaternary))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        .help("Ir al último mensaje")
        .accessibilityLabel("Ir al último mensaje")
        .transition(.scale(scale: 0.6).combined(with: .opacity))
    }
}
