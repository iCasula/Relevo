import SwiftUI
import RelevoMarkdown

/// Agent replies: the shared renderer (same output as Relevo for Mac).
struct MarkdownText: View {
    let text: String

    var body: some View {
        MarkdownView(text)
    }
}
