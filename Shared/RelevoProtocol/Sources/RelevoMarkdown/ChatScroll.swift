import SwiftUI

/// Chat-style scrolling, the same on the Mac and the iPhone: the conversation stays on its last line while
/// you're there (new output, a growing reply, the keyboard or a resized window keep it pinned), lets go as
/// soon as you scroll up to read, and picks up again when you scroll back to the bottom. Setting `following`
/// to true from outside (you sent a message, or tapped the arrow) goes back to the last line.
@available(macOS 15, iOS 18, *)
public struct FollowsBottom: ViewModifier {
    @Binding var following: Bool
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var userScrolling = false
    /// Where the content is now (to move the position off "bottom" without moving anything).
    @State private var offset: CGFloat = 0

    /// How close to the end still counts as "at the bottom".
    static let slack: CGFloat = 24
    /// `-debugScroll YES` prints each geometry change.
    static let debug = UserDefaults.standard.bool(forKey: "debugScroll")

    public func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(following ? .bottom : nil, for: .sizeChanges)
            .onScrollPhaseChange { _, phase in
                switch phase {
                case .tracking, .interacting, .decelerating: userScrolling = true
                default: userScrolling = false
                }
            }
            .onScrollGeometryChange(for: BottomProbe.self) { g in
                // The offset starts at -insets.top (under the navigation bar) and the container excludes the
                // insets, so the end is at contentHeight - containerHeight - insets.top (measured on an iPhone:
                // content 9039, container 587, insets 113/152 → 8339; on the Mac the insets are 0).
                BottomProbe(offset: g.contentOffset.y, contentHeight: g.contentSize.height,
                            frame: g.containerSize.height + g.contentInsets.top * 1_000 + g.contentInsets.bottom * 1_000_000,
                            distance: g.contentSize.height - g.containerSize.height - g.contentInsets.top - g.contentOffset.y)
            } action: { old, new in
                offset = new.offset
                if new.distance <= Self.slack {
                    if !following { following = true }
                    return
                }
                guard following else { return }
                // Moved up by you (a drag, the trackpad, or a mouse wheel, which has no scroll phases), not by
                // content arriving or the keyboard and composer resizing the view: stop following.
                let scrolledUp = new.offset < old.offset - 0.5 && abs(new.contentHeight - old.contentHeight) < 0.5 && new.frame == old.frame
                if userScrolling || scrolledUp { following = false }
            }
            .onChange(of: following) { wasFollowing, isFollowing in
                if isFollowing && !wasFollowing { scrollToBottom() }
            }
    }

    /// The position may still read "bottom" from before (scrolling with a mouse wheel doesn't always update it),
    /// and setting the same value does nothing: so it's first moved off that value, without moving the content,
    /// and the bottom is asked for on the next pass.
    private func scrollToBottom() {
        position.scrollTo(y: offset)
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
        }
    }
}

private struct BottomProbe: Equatable {
    var offset: CGFloat
    var contentHeight: CGFloat
    /// Container height and insets: when they change (keyboard, composer), the offset moves without you.
    var frame: CGFloat
    var distance: CGFloat
}

@available(macOS 15, iOS 18, *)
public extension View {
    /// See `FollowsBottom`.
    func followsBottom(_ following: Binding<Bool>) -> some View {
        modifier(FollowsBottom(following: following))
    }
}

/// Shown while the conversation isn't following: back to the last line.
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
