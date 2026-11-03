import SwiftUI
import AppKit

/// Shows the trace-based work state — exactly what another agent receives on a handoff.
struct WorkStateSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let thread: ThreadModel
    let project: Project
    @State private var text: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Estado del trabajo").font(.title3.weight(.semibold))
                    Text("Grabado en vivo en SQLite: sirve aunque el agente se haya quedado sin cuota")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    if let text {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                    }
                } label: {
                    Label("Copiar", systemImage: "doc.on.doc")
                }
                .disabled(text == nil)
                Button("Cerrar") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()
            ScrollView {
                if let text {
                    MarkdownText(text: text.isEmpty ? "Todavía no hay traza para este hilo." : text)
                        .padding(20)
                } else {
                    ProgressView("Leyendo traza y git…")
                        .frame(maxWidth: .infinity)
                        .padding(40)
                }
            }
        }
        .frame(width: 720, height: 620)
        .task {
            let git = await GitSnapshot.capture(project.path)
            text = WorkState.markdown(thread: thread, project: project, store: store, git: git)
        }
    }
}
