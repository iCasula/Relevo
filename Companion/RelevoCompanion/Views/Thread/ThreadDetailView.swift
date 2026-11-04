import SwiftUI
import QuickLook
import RelevoMarkdown
import RelevoProtocol

struct ThreadDetailView: View {
    @State private var viewModel: ThreadViewModel
    /// On the last line, moving with new output; off once you scroll up to read.
    @State private var following = true
    @AppStorage("showTurnUsage") private var showTurnUsage = true

    init(client: CompanionClient, threadId: UUID) {
        _viewModel = State(initialValue: ThreadViewModel(client: client, threadId: threadId))
    }

    var body: some View {
        transcript
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ComposerArea(viewModel: viewModel)
            }
            .navigationTitle(viewModel.title)
            .navigationSubtitle(viewModel.subtitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.hidden, for: .tabBar)
            .toolbar { toolbar }
            .onAppear { viewModel.onAppear() }
            .onDisappear { viewModel.onDisappear() }
            // Paths in replies: images open here, everything else can be shown on the Mac.
            .environment(\.openURL, OpenURLAction { url in
                guard let path = FileReference.path(from: url) else { return .systemAction }
                viewModel.open(path: path)
                return .handled
            })
            .quickLookPreview($viewModel.previewURL)
            .overlay {
                if viewModel.loadingPreview {
                    ProgressView("Trayendo la imagen del Mac…")
                        .padding(20)
                        .glassEffect(.regular, in: .rect(cornerRadius: 20))
                }
            }
            .confirmationDialog("Abrir en el Mac", isPresented: Binding(get: { viewModel.pathToOpenOnMac != nil },
                                                                        set: { if !$0 { viewModel.pathToOpenOnMac = nil } }),
                                titleVisibility: .visible, presenting: viewModel.pathToOpenOnMac) { path in
                Button("Mostrar en el Mac") { viewModel.openOnMac(path) }
            } message: { path in
                Text("«\(path)» está en tu Mac. Relevo lo abrirá allí (Vista Rápida, o el Finder si es una carpeta).")
            }
            .sensoryFeedback(.warning, trigger: viewModel.pendingApprovals) { old, new in new > old }
            .sensoryFeedback(.success, trigger: viewModel.isRunning) { old, new in old && !new }
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if viewModel.hiddenCount > 0 {
                    Text("\(viewModel.hiddenCount) mensajes anteriores están solo en el Mac")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
                let headers = viewModel.authorHeaders
                ForEach(viewModel.rows) { row in
                    switch row {
                    case .item(let item):
                        TranscriptItemView(item: item, viewModel: viewModel, showsAuthor: headers.contains(item.id))
                    case .group(let group):
                        VStack(alignment: .leading, spacing: 6) {
                            ActivityGroupRow(group: group, isExpanded: viewModel.expanded.contains(group.id)) { viewModel.toggle(group) }
                            // A turn that ended on a tool: its usage shows under the folded group.
                            if showTurnUsage, !viewModel.expanded.contains(group.id), let usage = group.items.last(where: { $0.usage != nil })?.usage {
                                TurnUsageLine(usage: usage)
                            }
                        }
                    }
                }
                if viewModel.isRunning {
                    WorkingRow(text: viewModel.runtime?.statusLine)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .followsBottom($following)
        .scrollDismissesKeyboard(.interactively)
        // A tap anywhere in the conversation puts the keyboard away (links and buttons still work).
        .simultaneousGesture(TapGesture().onEnded {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        })
        // Sending always brings you back to the last line.
        .onChange(of: viewModel.sentCount) { following = true }
        .overlay(alignment: .bottomTrailing) {
            ZStack {
                if !following {
                    JumpToBottomButton { following = true }
                        .padding(.trailing, 16)
                        .padding(.bottom, 10)
                }
            }
            .animation(.snappy(duration: 0.2), value: following)
        }
        .overlay {
            if viewModel.isLoading {
                ProgressView("Cargando conversación…")
            } else if viewModel.items.isEmpty {
                ContentUnavailableView("Hilo nuevo", systemImage: "bubble.left.and.text.bubble.right",
                                       description: Text("Pide un cambio, haz una pregunta o arranca un proyecto."))
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                withAnimation(.snappy) { viewModel.showTools.toggle() }
            } label: {
                Label(viewModel.showTools ? "Ocultar herramientas" : "Mostrar herramientas",
                      systemImage: viewModel.showTools ? "wrench.and.screwdriver.fill" : "wrench.and.screwdriver")
            }
            .accessibilityHint("Muestra u oculta los comandos y herramientas que ejecuta el agente")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                let candidates = viewModel.runtime?.relayCandidates ?? []
                Section("Continuar con otro agente") {
                    if candidates.isEmpty {
                        Text("No hay otras suscripciones con cuota")
                    }
                    ForEach(candidates, id: \.self) { candidate in
                        if let account = viewModel.account(candidate.accountId) {
                            Button {
                                viewModel.relay(to: candidate)
                            } label: {
                                Text("\(account.name) · \(account.modelName(candidate.model))")
                                if let note = account.availabilityNote { Text(note) }
                            }
                        }
                    }
                }
            } label: {
                Label("Relevar", systemImage: "arrow.triangle.2.circlepath")
            }
            .disabled(!viewModel.isConnected || viewModel.items.isEmpty)
        }
    }
}

private struct WorkingRow: View {
    let text: String?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(text ?? "Trabajando…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

/// Banners and composer pinned above the keyboard.
private struct ComposerArea: View {
    let viewModel: ThreadViewModel

    var body: some View {
        VStack(spacing: 10) {
            if let limit = viewModel.runtime?.limit {
                LimitCard(limit: limit, viewModel: viewModel)
            } else if let suggestion = viewModel.runtime?.suggestion {
                SuggestionCard(suggestion: suggestion, viewModel: viewModel)
            }
            if !viewModel.queued.isEmpty {
                QueueCard(viewModel: viewModel)
            }
            ComposerBar(viewModel: viewModel)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .animation(.snappy, value: viewModel.runtime?.suggestion)
        .animation(.snappy, value: viewModel.runtime?.limit)
        .animation(.snappy, value: viewModel.queued)
    }
}
